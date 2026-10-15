/**
 * OAuth 2.1 Authorization Code + PKCE (S256) client for the sub2api provider.
 *
 * Implements the plugin-side half of the 2026-10-01 design:
 * - endpoint discovery from `/.well-known/oauth-authorization-server`
 *   (RFC 8414) with the `/api/v1/oauth/.well-known` compatibility alias as
 *   the fallback — discovery failure means OAuth is unavailable;
 * - PKCE: 64-char base64url verifier, S256 challenge only (never `plain`);
 * - one-shot authorization attempts: `state` is single-use and expires with
 *   the attempt, the verifier never leaves the host process, and the final
 *   token exchange always re-submits the exact redirect_uri + verifier;
 * - loopback-only redirect derivation: the receiver is this harness's
   * webserver, so the origin must be 127.0.0.1 / [::1] (RFC 8252 §7.3 —
 *   the port may vary, the path is the plugin's fixed callback route).
 *
 * @module sub2api-sync/oauth
 */

/** The public desktop client the sub2api provider seeds for this plugin. */
export const OAUTH_CLIENT_ID = 'dsh-sub2api-sync'

/** The callback path this plugin registers on the harness webserver. */
export const OAUTH_CALLBACK_PATH = '/plugins/dsh-sub2api-sync/oauth/callback'

/** An authorization attempt lives exactly this long, state included. */
export const OAUTH_ATTEMPT_TTL_MS: number = 10 * 60 * 1000

/** Scopes the plugin requests; `keys:revoke` only when orphan revocation is on. */
export function oauthScopesFor(deleteOrphanKeys: boolean | undefined): string {
  return deleteOrphanKeys === true
    ? 'openid profile groups:read keys:read keys:create keys:revoke'
    : 'openid profile groups:read keys:read keys:create'
}

/** Failure with the provider's OAuth error code attached (when present). */
export class OAuthError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'OAuthError'
    this.code = code
  }
}

/** The provider endpoints the plugin talks to (discovered, never hardcoded). */
export interface OAuthEndpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
  revocationEndpoint?: string
}

interface DiscoveryCacheEntry {
  endpoints: OAuthEndpoints | undefined
  fetchedAt: number
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>()
const DISCOVERY_TTL_MS = 5 * 60 * 1000

function absoluteHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().replace(/\/$/, '') : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the provider metadata: the standard RFC 8414 location first, the
 * versioned compatibility alias second. A failed or incomplete document is a
 * loud failure — the caller hides the OAuth channel instead of guessing URLs.
 */
export async function discoverOAuthEndpoints(
  instance: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  now: number = Date.now(),
): Promise<OAuthEndpoints> {
  const key = instance.trim().replace(/\/+$/, '').toLowerCase()
  const cached = discoveryCache.get(key)
  if (cached !== undefined && now - cached.fetchedAt < DISCOVERY_TTL_MS) {
    if (cached.endpoints !== undefined) return cached.endpoints
    throw new OAuthError('discovery_failed', 'sub2api OAuth 发现失败（此前已失败，稍后重试）')
  }
  const base = instance.trim().replace(/\/+$/, '')
  const candidates = [`${base}/.well-known/oauth-authorization-server`, `${base}/api/v1/oauth/.well-known`]
  let endpoints: OAuthEndpoints | undefined
  let lastError = ''
  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(candidate, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        lastError = `HTTP ${response.status} at ${candidate}`
        continue
      }
      const payload = (await response.json()) as Record<string, unknown>
      const authorizationEndpoint = absoluteHttpUrl(payload.authorization_endpoint)
      const tokenEndpoint = absoluteHttpUrl(payload.token_endpoint)
      if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
        lastError = `incomplete metadata at ${candidate}`
        continue
      }
      const revocationEndpoint = absoluteHttpUrl(payload.revocation_endpoint)
      endpoints = {
        authorizationEndpoint,
        tokenEndpoint,
        ...(revocationEndpoint !== undefined ? { revocationEndpoint } : {}),
      }
      break
    } catch (error) {
      lastError = `${candidate}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  discoveryCache.set(key, { endpoints, fetchedAt: now })
  if (endpoints === undefined) {
    throw new OAuthError('discovery_failed', `sub2api OAuth 发现失败：${lastError}`)
  }
  return endpoints
}

/** Test seam: drop the process-wide discovery cache. */
export function resetDiscoveryCache(): void {
  discoveryCache.clear()
}

function randomBase64url(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  let binary = ''
  for (const byte of buffer) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** One PKCE pair: base64url verifier (64 chars, RFC 7636 charset subset) + S256 challenge. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64url(48)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  let binary = ''
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  const challenge = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return { verifier, challenge }
}

/** The exact loopback redirect URI for this harness session, or a loud reason. */
export function loopbackCallbackOrigin(origin: string): string {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new OAuthError('invalid_request', '无法解析回调地址 origin')
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') {
    throw new OAuthError(
      'invalid_request',
      `OAuth 回调只支持本机回环地址（127.0.0.1 / ::1），当前 origin 是 ${parsed.host} —— 请在本机页面上发起网页授权`,
    )
  }
  return `${parsed.protocol}//${parsed.host}${OAUTH_CALLBACK_PATH}`
}

export function buildAuthorizeUrl(
  endpoints: OAuthEndpoints,
  input: { redirectUri: string; scope: string; state: string; challenge: string },
): string {
  const url = new URL(endpoints.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', OAUTH_CLIENT_ID)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', input.scope)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

export interface OAuthTokenPair {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  scope?: string
}

function readTokenPair(payload: unknown): OAuthTokenPair {
  if (typeof payload !== 'object' || payload === null) {
    throw new OAuthError('server_error', 'token 端点响应形状异常')
  }
  const record = payload as Record<string, unknown>
  if (typeof record.error === 'string' && record.error.length > 0) {
    throw new OAuthError(record.error, `token 端点返回错误：${record.error}`)
  }
  const accessToken = record.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new OAuthError('server_error', 'token 端点响应缺少 access_token')
  }
  const refreshToken = record.refresh_token
  const expiresIn = record.expires_in
  const scope = record.scope
  return {
    accessToken,
    ...(typeof refreshToken === 'string' && refreshToken.length > 0 ? { refreshToken } : {}),
    ...(typeof expiresIn === 'number' ? { expiresIn } : {}),
    ...(typeof scope === 'string' && scope.length > 0 ? { scope } : {}),
  }
}

async function tokenRequest(
  tokenEndpoint: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<OAuthTokenPair> {
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new OAuthError('server_error', `token 端点响应不是 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const code = (payload as Record<string, unknown> | null)?.error
    throw new OAuthError(
      typeof code === 'string' ? code : 'server_error',
      `token 端点失败（HTTP ${response.status}）`,
    )
  }
  return readTokenPair(payload)
}

/** Exchange the one-time code: verifier + exact redirect_uri ride again. */
export function exchangeAuthorizationCode(
  endpoints: OAuthEndpoints,
  input: { code: string; redirectUri: string; verifier: string },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OAuthTokenPair> {
  return tokenRequest(endpoints.tokenEndpoint, {
    grant_type: 'authorization_code',
    client_id: OAUTH_CLIENT_ID,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  }, fetchImpl)
}

/** Rotating refresh: the provider answers a fresh access+refresh pair. */
export function refreshAccessToken(
  endpoints: OAuthEndpoints,
  refreshToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OAuthTokenPair> {
  return tokenRequest(endpoints.tokenEndpoint, {
    grant_type: 'refresh_token',
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  }, fetchImpl)
}

/** RFC 7009 revocation; best-effort by contract — failures resolve normally. */
export async function revokeToken(
  endpoints: OAuthEndpoints,
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  if (endpoints.revocationEndpoint === undefined) return
  await fetchImpl(endpoints.revocationEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({ token }).toString(),
  }).catch(() => undefined)
}

export type OAuthAttemptPhase = 'pending' | 'completed' | 'failed'

export interface OAuthAttempt {
  id: string
  state: string
  verifier: string
  redirectUri: string
  scope: string
  phase: OAuthAttemptPhase
  error?: string
  createdAt: number
}

/**
 * Host-side attempt registry: `state` is the single-use binding between the
 * browser redirect and the locally held verifier. An attempt is consumed
 * exactly once — by its state — and expires with the TTL.
 */
export class OAuthAttemptStore {
  private readonly attempts = new Map<string, OAuthAttempt>()
  private readonly byState = new Map<string, string>()

  constructor(private readonly ttlMs: number = OAUTH_ATTEMPT_TTL_MS) {}

  create(input: { verifier: string; redirectUri: string; scope: string }, now: number = Date.now()): OAuthAttempt {
    // Lazy GC: a pending attempt abandoned by a closed tab or a lost redirect
    // is never consumed by state, so without this sweep it would live in the
    // registry forever (the host process is long-lived). Deleting during
    // Map iteration is safe.
    for (const [id, attempt] of this.attempts) {
      if (this.expired(attempt, now)) this.drop(attempt)
    }
    const attempt: OAuthAttempt = {
      id: randomBase64url(24),
      state: randomBase64url(32),
      verifier: input.verifier,
      redirectUri: input.redirectUri,
      scope: input.scope,
      phase: 'pending',
      createdAt: now,
    }
    this.attempts.set(attempt.id, attempt)
    this.byState.set(attempt.state, attempt.id)
    return attempt
  }

  private expired(attempt: OAuthAttempt, now: number): boolean {
    return now - attempt.createdAt > this.ttlMs
  }

  /**
   * Take the attempt for one browser redirect — single-use: the `state`
   * binding is consumed by this call, so a replayed redirect finds nothing.
   * The attempt itself stays in the registry for status polls by id until
   * it settles or expires.
   */
  takeByState(state: string, now: number = Date.now()): OAuthAttempt | undefined {
    const id = this.byState.get(state)
    if (id === undefined) return undefined
    this.byState.delete(state)
    const attempt = this.attempts.get(id)
    if (attempt === undefined) return undefined
    if (attempt.phase !== 'pending' || this.expired(attempt, now)) {
      this.drop(attempt)
      return undefined
    }
    return attempt
  }

  /** Mark a consumed attempt terminal (keeps it readable for status polls). */
  settle(id: string, phase: 'completed' | 'failed', error?: string): void {
    const attempt = this.attempts.get(id)
    if (attempt === undefined) return
    attempt.phase = phase
    if (error !== undefined) attempt.error = error
  }

  /** Read-only projection for the dialog's poll; unknown id → undefined. */
  peek(id: string, now: number = Date.now()): { phase: OAuthAttemptPhase; error?: string } | undefined {
    const attempt = this.attempts.get(id)
    if (attempt === undefined) return undefined
    if (this.expired(attempt, now)) {
      this.drop(attempt)
      return undefined
    }
    return { phase: attempt.phase, ...(attempt.error !== undefined ? { error: attempt.error } : {}) }
  }

  cancel(id: string): boolean {
    const attempt = this.attempts.get(id)
    if (attempt === undefined) return false
    this.drop(attempt)
    return true
  }

  private drop(attempt: OAuthAttempt): void {
    this.attempts.delete(attempt.id)
    this.byState.delete(attempt.state)
  }
}

/** Browser language for the hand-back page: the callback request's
 * Accept-Language picks one locale; fixed UI copy renders in that language
 * only (never the bilingual `zh · en` compound). */
export type CallbackLang = 'zh' | 'en'

/** Small HTML hand-back page for the browser redirect (§11.9 of the design).
 * The success variant also attempts to pull the desktop app forward: DSH
 * registers `dsh://` as an OS protocol and its shell focuses the primary
 * window on `dsh://open`. The auto-attempt rides a hidden iframe (fails
 * silently when the scheme is not registered, e.g. plain web UI), and an
 * explicit button keeps a user-gesture fallback. */
export function callbackPageHtml(outcome: 'success' | 'failure', message: string, lang: CallbackLang = 'zh'): string {
  const copy = {
    zh: {
      successTitle: '授权成功',
      failureTitle: '授权失败',
      openApp: '打开应用',
      htmlLang: 'zh',
    },
    en: {
      successTitle: 'Authorization complete',
      failureTitle: 'Authorization failed',
      openApp: 'Open app',
      htmlLang: 'en',
    },
  }[lang]
  const title = outcome === 'success' ? copy.successTitle : copy.failureTitle
  const detail = message.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
  // Visual spec mirrors the official first-party landing page: a two-column
  // split at the official ratio (~65/35 — the content column is visibly
  // wider than the welcome panel; 50/50 reads too symmetric). The left
  // column carries the outcome (wordmark + black badge row, a large gap,
  // title, single-line hint, open-app button), the right column keeps the
  // official dark-gradient welcome panel verbatim. The brand row is a text
  // wordmark and the artwork a CSS gradient — the plugin ships no logo or
  // image asset and does not borrow DeepSeek's artwork. Narrow screens drop
  // the art column.
  const styles = `
  body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; display: flex; min-height: 100vh;
         margin: 0; background: #fff; color: #1a1a1e; }
  .side { flex: 1 1 65%; display: flex; align-items: center; justify-content: center; min-width: 0; }
  main { text-align: center; max-width: 30rem; padding: 2.5rem 1.5rem; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 0.55rem; margin-bottom: 4rem; }
  .wordmark { font-size: 1.65rem; font-weight: 700; letter-spacing: -0.02em; }
  .badge { background: #1a1a1e; color: #fff; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em;
           padding: 0.3rem 0.55rem; border-radius: 0.4rem; }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 1rem; }
  p { font-size: 0.95rem; color: #8a8f9c; line-height: 1.7; margin: 0; }
  .fail { color: #d54941; }
  .art { flex: 1 1 35%; min-width: 0; display: flex; align-items: center; color: #fff;
         background: radial-gradient(120% 90% at 78% 18%, rgba(255,255,255,0.26) 0%, rgba(255,255,255,0) 55%),
                     linear-gradient(155deg, #6b7c92 0%, #46586e 38%, #2c3b4f 72%, #1f2b3a 100%); }
  .art p { color: #fff; font-size: 1.75rem; line-height: 1.8; font-weight: 500; margin: 0; padding: 0 4.5rem;
           max-width: 34rem; text-align: left; }
  @media (max-width: 56rem) { .art { display: none; } }`
  const brand = `<div class="brand" aria-hidden="true"><span class="wordmark">Sub2API</span><span class="badge">SYNC</span></div>`
  const art = `<div class="art" aria-hidden="true"><p>欢迎对话 DeepSeek Harness，<br>共探智能上限</p></div>`
  if (outcome !== 'success') {
    return `<!doctype html>
<html lang="${copy.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${styles}</style>
</head>
<body>
<div class="side">
<main>
  ${brand}
  <h1>${title}</h1>
  <p class="fail">${detail}</p>
</main>
</div>
${art}
<script>try { setTimeout(function () { window.close() }, 1500) } catch (e) {}</script>
</body>
</html>`
  }
  return `<!doctype html>
<html lang="${copy.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${styles}
  button { margin-top: 3rem; font: inherit; font-size: 0.95rem; padding: 0.85rem 2.4rem; border-radius: 0.75rem;
           border: 0; background: #1a1a1e; color: #fff; cursor: pointer; }
  button:hover { background: #33343a; }
</style>
</head>
<body>
<div class="side">
<main>
  ${brand}
  <h1>${title}</h1>
  <p>${detail}</p>
  <button type="button" id="s2s-back">${copy.openApp}</button>
</main>
</div>
${art}
<script>
(function () {
  function pullApp() {
    try {
      var frame = document.createElement('iframe');
      frame.style.display = 'none';
      frame.src = 'dsh://open';
      document.body.appendChild(frame);
      setTimeout(function () { frame.remove() }, 4000);
    } catch (e) {}
  }
  setTimeout(pullApp, 800);
  var button = document.getElementById('s2s-back');
  if (button) button.addEventListener('click', function () { location.href = 'dsh://open' });
  try { setTimeout(function () { window.close() }, 30000) } catch (e) {}
})();
</script>
</body>
</html>`
}
