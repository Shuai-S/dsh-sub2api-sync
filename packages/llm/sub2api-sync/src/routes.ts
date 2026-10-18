/**
 * HTTP routes between the settings card (browser half) and this plugin's
 * host half, registered on the harness web server.
 *
 * rev.4 split: configuration reads/writes ride the platform's
 * `configForms`/settings seam — the old whole-section `/config` route is
 * gone. These routes carry only **actions, secrets, and state projection**:
 * login (password/2FA), panel group/key listing, paste/clear of a
 * relay key, sync, model discovery, and the status snapshot.
 *
 * Requests are restricted to trusted local origins — the same
 * `trustedRequest` posture the community plugins use — with one explicit
 * escape hatch (`allowRemoteActions`, §11): when the user opts in, peers
 * from private-network ranges are accepted too. Secrets never ride these
 * responses: a relay key is written once via `POST /key`, a panel token
 * never leaves the credentials store, and `/group-keys` answers metadata
 * only. The webserver rejects duplicate (kind, path) registrations, so each
 * path dispatches by method inside one handler.
 *
 * @module sub2api-sync/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SyncReport } from './engine.ts'
import type { IconPayload } from './icon.ts'
import type { AuthKind } from './panel.ts'
import type { CallbackLang } from './oauth.ts'
import { isOwnedRoute, isSettingsConflict } from './types.ts'

/** The hand-back page's locale from the callback request's Accept-Language:
 * the first tag decides (`en*` → en, anything else → zh — matching the
 * browser's preference order without full q-value negotiation). */
export function callbackLangOf(acceptLanguage: string | undefined): CallbackLang {
  const first = acceptLanguage?.split(',')[0]?.trim().toLowerCase() ?? ''
  return first.startsWith('en') ? 'en' : 'zh'
}

export const ROUTES = {
  sync: '/plugins/dsh-sub2api-sync/sync',
  status: '/plugins/dsh-sub2api-sync/status',
  login: '/plugins/dsh-sub2api-sync/login',
  login2fa: '/plugins/dsh-sub2api-sync/login/2fa',
  logout: '/plugins/dsh-sub2api-sync/logout',
  groups: '/plugins/dsh-sub2api-sync/groups',
  keys: '/plugins/dsh-sub2api-sync/keys',
  icon: '/plugins/dsh-sub2api-sync/icon',
  site: '/plugins/dsh-sub2api-sync/site',
  account: '/plugins/dsh-sub2api-sync/account',
  resetSync: '/plugins/dsh-sub2api-sync/reset-sync',
  removeKey: '/plugins/dsh-sub2api-sync/remove-key',
  oauthStart: '/plugins/dsh-sub2api-sync/oauth/start',
  oauthProbe: '/plugins/dsh-sub2api-sync/oauth/probe',
  oauthCallback: '/plugins/dsh-sub2api-sync/oauth/callback',
  oauthStatus: '/plugins/dsh-sub2api-sync/oauth/status',
  oauthCancel: '/plugins/dsh-sub2api-sync/oauth/cancel',
} as const

/** One relay key as the keys card renders it (metadata only, no plaintext). */
export interface PanelKeyMeta {
  id: number
  name: string
  groupId: number
  status?: string
}

/** `GET /keys` — one page of the aggregated key list (newest first). */
export interface KeysResponse {
  ok: true
  keys: PanelKeyMeta[]
  total: number
  pages: number
}

/** One dep-provided key list page (host seam between client and panel). */
export interface KeysListPage {
  keys: PanelKeyMeta[]
  total: number
  pages: number
}

/** `POST /keys` — create one relay key (name defaults to the group name). */
export interface CreateKeyResponse {
  ok: true
  key: PanelKeyMeta
}

/** Auth snapshot the card renders its account block from. */
export interface AuthView {
  signedIn: boolean
  kind: AuthKind
  email?: string
}

export interface StatusRoute {
  route: string
  displayName?: string
  api?: string
  models: number
  modelsPreview: string[]
  /** The panel key id behind this route (from the engine's route→id map);
   * absent for routes synced before the map existed. */
  keyId?: number
}

export interface StatusResponse {
  ok: true
  auth: AuthView
  instance: string
  syncRunning: boolean
  routes: StatusRoute[]
  lastReport?: SyncReport
  /** Wall-clock ms of the last accepted sync (client renders it relatively). */
  lastReportAt?: number
}

export interface GroupsView {
  id: number
  name: string
  platform: string
  status?: string
  rateMultiplier?: number
  isExclusive?: boolean
  claudeCodeOnly?: boolean
}

export interface GroupsResponse {
  ok: true
  groups: GroupsView[]
}

/** `POST /reset-sync` — purge the plugin's sync state (instance switch). */
export interface ResetSyncResponse {
  ok: true
}

/** `POST /remove-key` — remove one key's synced provider (report entry button). */
export interface RemoveKeyResponse {
  ok: true
}

/** `GET /site` — the instance's configured site name (undefined when unknown). */
export interface SiteResponse {
  ok: true
  name?: string
}

/** `GET /account` — the signed-in panel account's identity (header rendering). */
export interface AccountResponse {
  ok: true
  /** The account's set username, when one exists. */
  username?: string
  /** The account's email (raw — the card masks it before display). */
  email?: string
  /** The account's balance in USD (header pill; absent when not numeric). */
  balance?: number
  /** The upstream failure reason when the profile could not be fetched
   * (the header is cosmetic and falls back, but the cause must be visible). */
  error?: string
}

export interface LoginResponse {
  ok: true
  kind: 'ok' | '2fa'
  requires2FA?: boolean
}

/** `GET /oauth/probe?address=…` — whether the instance publishes OAuth
 * discovery metadata (the sign-in dialog auto-selects its channel from it). */
export interface OAuthProbeResponse {
  ok: true
  supported: boolean
}

export interface SyncResponse {
  ok: true
  report: SyncReport
}

/** `POST /oauth/start` — one authorization attempt, opened in a new tab. */
export interface OAuthStartResponse {
  ok: true
  attemptId: string
  authorizeUrl: string
}

/** `GET /oauth/status?attempt=<id>` — dialog poll for the web channel. */
export interface OAuthAttemptStatusResponse {
  ok: true
  attempt: { phase: 'pending' | 'completed' | 'failed'; error?: string } | undefined
  auth: AuthView
}

/** `POST /oauth/cancel` — drop a pending attempt. */
export interface OAuthCancelResponse {
  ok: true
}

/**
 * Accept only trusted peers: a loopback peer that is not a cross-site
 * request and whose Origin (when present) matches the Host. With
 * `allowRemote` (the user's cross-device escape hatch, §11) private-network
 * peers are accepted under the same origin rules — public peers never are.
 */
export function trustedRequest(req: IncomingMessage, allowRemote = false): boolean {
  const remote = req.socket.remoteAddress
  if (remote === undefined) return false
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const privatePeer = loopback || (allowRemote && isPrivateAddress(remote))
  if (!privatePeer) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (host === undefined) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

/** RFC 1918 / ULA ranges only — never public addresses. */
function isPrivateAddress(address: string): boolean {
  const ipv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1] ?? address
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ipv4)
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || a === 127) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    return false
  }
  const lowered = address.toLowerCase()
  if (lowered === '::1') return true
  return lowered.startsWith('fc') || lowered.startsWith('fd')
}

/** Request bodies here are tiny JSON documents; a larger stream is a broken
 * or hostile peer — refuse it before buffering (same posture as icon.ts's
 * MAX_BYTES). */
const MAX_BODY_BYTES = 1_000_000

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error(`request body 超过 ${MAX_BODY_BYTES} 字节上限`)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  const value: unknown = JSON.parse(text)
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

/** The browser-facing hand-back page for the provider's redirect. */
function html(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** The harness origin this request arrived on (host + proto, no path). */
function requestOrigin(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-proto']
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? 'http'
  const host = req.headers.host ?? '127.0.0.1'
  return `${proto}://${host}`
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function conflictStatus(error: unknown): number | undefined {
  return isSettingsConflict(error) ? 409 : undefined
}

export interface RouteDeps {
  /** Instance address as configured (echoed to the card for the header). */
  instance(): string
  /** Current auth snapshot (credential-derived; email rides the config). */
  authState(): Promise<AuthView>
  /** Password login; stores email/password and the token pair on success. */
  login(email: string, password: string | undefined): Promise<LoginResponse>
  /** Complete the pending 2FA login. */
  login2FA(code: string): Promise<void>
  /** Drop panel tokens. */
  logout(): Promise<void>
  /** Live panel groups as the panel reports them (the card's checked state
   * rides the config's `selectedKeys`, not this response). */
  listGroups(): Promise<GroupsView[]>
  /** Run one sync; the implementation serializes and records the report. */
  sync(keyIds?: number[]): Promise<SyncReport>
  lastReport(): SyncReport | undefined
  lastReportAt(): number | undefined
  /** One page of the panel's keys (newest first; page is 1-based), optional
   * server-side `search` over key names. */
  listKeys(page: number, pageSize: number, search?: string): Promise<KeysListPage>
  /** Create one relay key (name defaults to the group name upstream of this seam). */
  createKey(input: { groupId: number; name: string }): Promise<PanelKeyMeta>
  /** The instance's icon bytes (declared `<link rel=icon>` → /favicon.ico), or undefined. */
  icon(): Promise<IconPayload | undefined>
  /** The instance's configured site name (parsed from its HTML title), or undefined. */
  siteName(): Promise<string | undefined>
  /** The signed-in panel account's identity (username/email/balance), or undefined when unavailable. */
  account(): Promise<{ username?: string; email?: string; balance?: number } | undefined>
  /**
   * Purge this plugin's sync state: remove every owned provider route and
   * its relay-key credential, plus (when `previousBaseURL` is given) the
   * old instance's unreachable panel secrets. The card calls it on instance
   * switch; logout and auth-loss purge inside the host.
   */
  resetSync(previousBaseURL?: string): Promise<void>
  /**
   * Remove one key's synced provider: the route derived from the current
   * instance + `keyId` leaves the llm-pi-ai section and its relay-key
   * credential is dropped. Local state only — no panel calls, and the
   * selection drop happens card-side so the next sync cannot resurrect it.
   */
  removeSyncedKey(keyId: number): Promise<void>
  isSyncRunning(): boolean
  /** Owned routes currently registered in the llm-pi-ai section. */
  ownedRoutes(): StatusRoute[]
  /** Whether the cross-device escape hatch is on (Config, default false). */
  allowRemote(): boolean
  /** Begin one OAuth authorization attempt bound to this harness origin. */
  oauthStart(callbackOrigin: string): Promise<{ attemptId: string; authorizeUrl: string }>
  /** Whether the given instance address publishes OAuth discovery metadata
   * (host-side fetch — the browser cannot probe cross-origin). */
  oauthProbe(address: string): Promise<boolean>
  /** Consume the provider's browser redirect: match state, exchange the code.
   * `lang` is the callback request's Accept-Language locale for the page. */
  oauthCallback(query: URLSearchParams, lang: CallbackLang): Promise<{ html: string }>
  /** Project one attempt's phase plus the current auth snapshot. */
  oauthStatus(attemptId: string | undefined): Promise<OAuthAttemptStatusResponse>
  /** Drop a pending attempt (user cancelled the dialog). */
  oauthCancel(attemptId: string): Promise<void>
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** Register all card routes on the web server (no-op without one).
 *
 * Lifecycle: every registration's disposer rides the registering inject fiber
 * (`webCtx.effect`). A plugin reload must remove its routes BEFORE the next
 * apply re-registers them — the webserver rejects duplicate (kind, path)
 * entries, and a dropped disposer would orphan the old entries: the new apply
 * fails silently (an inject child failure does not fail the plugin fiber) and
 * the table keeps serving the disposed fiber's closures, whose every service
 * access then throws `cannot get required service … in inactive context`
 * (the OAuth callback's 授权失败). */
export function registerRoutes(ctx: Context, deps: RouteDeps): void {
  ctx.inject(['webServer'], (webCtx) => {
    const route = (path: string, handler: Handler): void => {
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler }))
    }
    const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
      if (!trustedRequest(req, deps.allowRemote())) {
        json(res, 403, { error: 'forbidden' })
        return false
      }
      return true
    }
    const method = (expected: string, req: IncomingMessage, res: ServerResponse): boolean => {
      if (req.method !== expected) {
        json(res, 405, { error: 'method not allowed' })
        return false
      }
      return true
    }

    route(ROUTES.status, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('GET', req, res)) return
      const auth = await deps.authState()
      json(res, 200, {
        ok: true,
        auth,
        instance: deps.instance(),
        syncRunning: deps.isSyncRunning(),
        routes: deps.ownedRoutes(),
        lastReport: deps.lastReport(),
        lastReportAt: deps.lastReportAt(),
      } satisfies StatusResponse)
    })

    route(ROUTES.sync, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('POST', req, res)) return
      try {
        const body = await readJson(req).catch(() => ({}) as { keyIds?: unknown })
        const keyIds = Array.isArray(body.keyIds) ? body.keyIds.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) : undefined
        const report = await deps.sync(keyIds)
        json(res, 200, { ok: true, report } satisfies SyncResponse)
      } catch (error) {
        json(res, conflictStatus(error) ?? 500, { ok: false, error: safeMessage(error) })
      }
    })

    route(ROUTES.login, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('POST', req, res)) return
      let body: Record<string, unknown>
      try {
        body = await readJson(req)
      } catch {
        return json(res, 400, { error: 'invalid JSON body' })
      }
      const email = typeof body.email === 'string' ? body.email.trim() : ''
      const password = typeof body.password === 'string' ? body.password : undefined
      if (email.length === 0) return json(res, 400, { error: 'email 必填' })
      try {
        json(res, 200, await deps.login(email, password))
      } catch (error) {
        const kind = (error as { kind?: unknown } | null | undefined)?.kind
        json(res, 400, { ok: false, error: safeMessage(error), ...(kind === 'captcha' ? { kind: 'captcha' } : {}) })
      }
    })

    route(ROUTES.login2fa, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('POST', req, res)) return
      let body: Record<string, unknown>
      try {
        body = await readJson(req)
      } catch {
        return json(res, 400, { error: 'invalid JSON body' })
      }
      const code = typeof body.code === 'string' ? body.code.trim() : ''
      if (!/^\d{6}$/.test(code)) return json(res, 400, { error: 'code 必须是 6 位数字' })
      try {
        await deps.login2FA(code)
        json(res, 200, { ok: true, kind: 'ok' } satisfies LoginResponse)
      } catch (error) {
        json(res, 400, { ok: false, error: safeMessage(error) })
      }
    })

    route(ROUTES.logout, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('POST', req, res)) return
      try {
        await deps.logout()
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 500, { ok: false, error: safeMessage(error) })
      }
    })

    route(ROUTES.groups, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('GET', req, res)) return
      try {
        json(res, 200, { ok: true, groups: await deps.listGroups() } satisfies GroupsResponse)
      } catch (error) {
        json(res, 400, { ok: false, error: safeMessage(error) })
      }
    })

    route(ROUTES.keys, async (req, res) => {
      if (!guard(req, res)) return
      if (req.method === 'GET') {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const rawPage = Number(url.searchParams.get('page') ?? '1')
          const rawSize = Number(url.searchParams.get('pageSize') ?? '5')
          const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1
          const pageSize = Number.isSafeInteger(rawSize) && rawSize > 0 ? Math.min(rawSize, 50) : 5
          const rawSearch = (url.searchParams.get('search') ?? '').trim()
          const search = rawSearch.length > 0 ? rawSearch : undefined
          const result = await deps.listKeys(page, pageSize, search)
          json(res, 200, { ok: true, keys: result.keys, total: result.total, pages: result.pages } satisfies KeysResponse)
        } catch (error) {
          json(res, 400, { ok: false, error: safeMessage(error) })
        }
        return
      }
      if (!method('POST', req, res)) return
      try {
        const body = await readJson(req) as { groupId?: unknown; name?: unknown }
        const groupId = parseGroupIdFrom(body.groupId)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (groupId === undefined) return json(res, 400, { ok: false, error: 'groupId 必须是正整数分组 id' })
        if (name.length === 0 || name.length > 128) return json(res, 400, { ok: false, error: 'key 名称必须是 1-128 个字符' })
        json(res, 200, { ok: true, key: await deps.createKey({ groupId, name }) } satisfies CreateKeyResponse)
      } catch (error) {
        json(res, 400, { ok: false, error: safeMessage(error) })
      }
    })

    // Same-origin icon proxy: the webview loads plugin-route imagery only;
    // the host resolves the instance's declared icon and streams the bytes.
    // An unavailable icon answers 404 and the client falls back to its dot.
    route(ROUTES.icon, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('GET', req, res)) return
      const icon = await deps.icon().catch(() => undefined)
      if (icon === undefined) return json(res, 404, { error: 'icon unavailable' })
      res.writeHead(200, {
        'content-type': icon.contentType,
        'cache-control': 'private, max-age=600',
        'x-content-type-options': 'nosniff',
      })
      res.end(icon.body)
    })

    // The instance's configured site name for the identity header. Never
    // throws: an unknown name answers undefined and the card keeps its
    // static fallback label.
    route(ROUTES.site, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('GET', req, res)) return
      const name = await deps.siteName().catch(() => undefined)
      json(res, 200, { ok: true, name } satisfies SiteResponse)
    })

    // The signed-in account's identity for the header (username, else the
    // card-side masked email). An upstream failure rides the response as
    // `error` — the header still falls back, but diagnosably.
    route(ROUTES.account, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('GET', req, res)) return
      try {
        const profile = await deps.account()
        json(res, 200, {
          ok: true,
          ...(profile?.username !== undefined ? { username: profile.username } : {}),
          ...(profile?.email !== undefined ? { email: profile.email } : {}),
          ...(profile?.balance !== undefined ? { balance: profile.balance } : {}),
        } satisfies AccountResponse)
      } catch (error) {
        json(res, 200, { ok: true, error: safeMessage(error) } satisfies AccountResponse)
      }
    })

    // Instance-switch purge: the card detects a baseURL change and hands the
    // previous address over so its unreachable panel secrets are dropped too.
    route(ROUTES.resetSync, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('POST', req, res)) return
      try {
        const body = await readJson(req) as { previousBaseURL?: unknown }
        const previous = typeof body.previousBaseURL === 'string' && body.previousBaseURL.length > 0
          ? body.previousBaseURL
          : undefined
        await deps.resetSync(previous)
        json(res, 200, { ok: true } satisfies ResetSyncResponse)
      } catch (error) {
        json(res, 500, { ok: false, error: safeMessage(error) })
      }
    })

    // Per-entry removal from the sync report: one key's provider route and
    // credential go away without a full re-sync (which the panel could
    // refuse — removal is local state and must not depend on it).
    route(ROUTES.removeKey, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('POST', req, res)) return
      try {
        const body = await readJson(req) as { keyId?: unknown }
        const keyId = parseGroupIdFrom(body.keyId)
        if (keyId === undefined) return json(res, 400, { ok: false, error: 'keyId 必须是正整数 key id' })
        await deps.removeSyncedKey(keyId)
        json(res, 200, { ok: true } satisfies RemoveKeyResponse)
      } catch (error) {
        json(res, 500, { ok: false, error: safeMessage(error) })
      }
    })

    // ==== OAuth web channel (C2) ====

    route(ROUTES.oauthStart, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('POST', req, res)) return
      try {
        const started = await deps.oauthStart(requestOrigin(req))
        json(res, 200, { ok: true, attemptId: started.attemptId, authorizeUrl: started.authorizeUrl } satisfies OAuthStartResponse)
      } catch (error) {
        json(res, 400, { ok: false, error: safeMessage(error) })
      }
    })

    // OAuth channel auto-detection for the sign-in dialog: never throws —
    // a failed discovery answers supported:false and the dialog keeps the
    // password channel.
    route(ROUTES.oauthProbe, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('GET', req, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const address = url.searchParams.get('address') ?? ''
      let supported = false
      if (/^https?:\/\//i.test(address.trim())) {
        supported = await deps.oauthProbe(address).catch(() => false)
      }
      json(res, 200, { ok: true, supported } satisfies OAuthProbeResponse)
    })

    // The callback is the provider's browser redirect — a cross-site
    // navigation by design. `trustedRequest` therefore does NOT apply; the
    // one-shot `state` binding is what makes forged callbacks useless.
    route(ROUTES.oauthCallback, async (req, res) => {
      if (!method('GET', req, res)) return
      try {
        const query = new URL(req.url ?? '/', 'http://localhost').searchParams
        const answer = await deps.oauthCallback(query, callbackLangOf(req.headers['accept-language']))
        html(res, answer.html)
      } catch (error) {
        html(res, oauthFailurePage(safeMessage(error)))
      }
    })

    route(ROUTES.oauthStatus, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('GET', req, res)) return
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const attemptId = url.searchParams.get('attempt') ?? undefined
        json(res, 200, await deps.oauthStatus(attemptId) satisfies OAuthAttemptStatusResponse)
      } catch (error) {
        json(res, 400, { ok: false, error: safeMessage(error) })
      }
    })

    route(ROUTES.oauthCancel, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('POST', req, res)) return
      try {
        const body = await readJson(req) as { attemptId?: unknown }
        if (typeof body.attemptId !== 'string' || body.attemptId.length === 0) {
          return json(res, 400, { ok: false, error: 'attemptId 必填' })
        }
        await deps.oauthCancel(body.attemptId)
        json(res, 200, { ok: true } satisfies OAuthCancelResponse)
      } catch (error) {
        json(res, 400, { ok: false, error: safeMessage(error) })
      }
    })
  }).then(undefined, (error: unknown) => {
    // An inject child's failure does NOT fail the plugin fiber: without this
    // net a registration failure (e.g. a stale duplicate route) would strand
    // dead routes with no visible trace.
    ctx.logger.error(error)
  })
}

/** Standalone failure page when the callback handler itself throws. Inline on
 * purpose: routes.ts rides the client bundle, so it must not value-import
 * the host-only oauth module. */
function oauthFailurePage(message: string): string {
  const detail = message.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>授权失败 · Authorization failed</title></head><body><main><h1>授权失败 · Authorization failed</h1><p>${detail}</p></main></body></html>`
}

/** Shared group-id parser over route input (number or decimal string). */
function parseGroupIdFrom(input: unknown): number | undefined {
  if (typeof input === 'number') return Number.isSafeInteger(input) && input > 0 ? input : undefined
  if (typeof input !== 'string') return undefined
  if (!/^\d+$/.test(input)) return undefined
  const id = Number(input)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/**
 * Assemble the `ownedRoutes` view for the status endpoint from the live
 * `llm-pi-ai` section value (same-process caller, no redaction).
 */
export function describeOwnedRoutes(section: unknown): StatusRoute[] {
  const providers = (section as {
    providers?: Record<string, { displayName?: string; api?: string; models?: Array<{ id: string }> }> | undefined
  })?.providers ?? {}
  const routes: StatusRoute[] = []
  for (const [route, profile] of Object.entries(providers)) {
    if (!isOwnedRoute(route)) continue
    const models = profile?.models ?? []
    routes.push({
      route,
      displayName: profile?.displayName,
      api: profile?.api,
      models: models.length,
      modelsPreview: models.slice(0, 20).map((model) => model.id),
    })
  }
  return routes
}
