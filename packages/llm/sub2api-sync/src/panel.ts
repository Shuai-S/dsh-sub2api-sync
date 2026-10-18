/**
 * Panel (控制台) API client and credential gateway for one sub2api instance.
 *
 * Shapes verified against a live instance (2026-09-30, NexaRelay):
 * - envelope `{code, message, data}` on success; errors carry code/message;
 * - `GET /keys` answers a paginated envelope whose items embed the relay-key
 *   **plaintext** and the nested group object;
 * - `GET /groups/available` answers `data` as a **bare array** (not paginated)
 *   with `platform` on every element — Mode A reads the platform directly.
 *
 * Reading discipline: take the known fields, ignore the rest (the deployment
 * is a fork whose DTO is a superset of upstream).
 *
 * @module sub2api-sync/panel
 */

import type { CredentialsLike } from './types.ts'
import { panelPasswordRef, panelRefreshRef, panelTokenRef, oauthRefreshRef, oauthTokenRef } from './types.ts'
import {
  discoverOAuthEndpoints,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  type OAuthEndpoints,
  type OAuthTokenPair,
} from './oauth.ts'

/** Loud panel failure with the HTTP status and envelope message attached. */
export class PanelError extends Error {
  readonly status: number
  readonly code?: unknown

  constructor(status: number, message: string, code?: unknown) {
    super(message)
    this.name = 'PanelError'
    this.status = status
    this.code = code
  }
}

/** One panel group as the plugin consumes it (tolerant subset). */
export interface PanelGroup {
  id: number
  name: string
  description?: string
  platform: string
  rateMultiplier?: number
  status?: string
  isExclusive?: boolean
  claudeCodeOnly?: boolean
}

/** One panel relay key (plaintext present only when the API returns it). */
export interface PanelKey {
  id: number
  name: string
  groupId: number
  status?: string
  /** Plaintext relay key; absent when the panel masked it. */
  key?: string
  quota?: number
  expiresAt?: string
}

/** The signed-in account's panel identity (card header rendering). */
export interface PanelProfile {
  /** The account's set username, when one exists. */
  username?: string
  /** The account's email (raw — the caller masks it before display). */
  email?: string
  /** The account's balance in USD (profile `balance`; absent when not numeric). */
  balance?: number
}

/** One page of the panel's native key listing. */
export interface PanelKeyPage {
  items: PanelKey[]
  total: number
  pages: number
}

/** The deployment's display timezone for the panel's list endpoints. */
function timeZoneOf(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export type LoginOutcome =
  | { kind: 'ok'; accessToken: string; refreshToken?: string }
  | { kind: '2fa'; tempToken: string }
  | { kind: 'captcha'; message: string }

export interface PanelClientOptions {
  baseURL: string
  fetchImpl?: typeof fetch
}

interface Envelope {
  code?: unknown
  message?: unknown
  data?: unknown
}

/** Extract the envelope payload or throw a loud PanelError. */
function unwrap(response: Response, payload: unknown): unknown {
  const envelope = payload as Envelope | null | undefined
  if (envelope === null || envelope === undefined || typeof envelope !== 'object') {
    throw new PanelError(response.status, `面板响应不是标准信封（HTTP ${response.status}）`)
  }
  const code = envelope.code
  if (code !== 0 && code !== '0') {
    const message = typeof envelope.message === 'string' && envelope.message.length > 0 ? envelope.message : '未知错误'
    throw new PanelError(response.status, `面板错误：${message}（code=${String(code)}）`, code)
  }
  return envelope.data
}

/** Best-effort captcha interception check (A4: contract still unverified). */
function looksLikeCaptcha(status: number, payload: unknown): boolean {
  if (status !== 403 && status !== 400) return false
  const text = JSON.stringify(payload ?? '').toLowerCase()
  return text.includes('turnstile') || text.includes('captcha')
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '')
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Loud failure for non-envelope HTTP failures (Cloudflare pages, 500s, …). */
async function fail(response: Response, what: string): Promise<never> {
  const payload = await readBody(response)
  const message = typeof payload === 'string' && payload.length > 0
      ? payload.slice(0, 200)
      : (payload as Envelope | undefined)?.message
  const hint = response.status === 403 ? '（若实例前置 Cloudflare，检查 /api/v1/* 的 WAF 放行规则）' : ''
  throw new PanelError(response.status, `${what} 失败：HTTP ${response.status} ${typeof message === 'string' ? message : ''}${hint}`)
}

/** Tolerant group reader. */
function readGroup(item: unknown): PanelGroup | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>
  const id = record.id
  const name = record.name
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof name !== 'string') return undefined
  return {
    id,
    name,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    // Platform is read directly from the panel (Mode A); a missing value
    // surfaces as an empty string that the protocol mapping fails loud on.
    platform: typeof record.platform === 'string' ? record.platform : '',
    ...(typeof record.rate_multiplier === 'number' ? { rateMultiplier: record.rate_multiplier } : {}),
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    ...(typeof record.is_exclusive === 'boolean' ? { isExclusive: record.is_exclusive } : {}),
    ...(typeof record.claude_code_only === 'boolean' ? { claudeCodeOnly: record.claude_code_only } : {}),
  }
}

/** Tolerant key reader; plaintext kept verbatim when present. */
function readKey(item: unknown): PanelKey | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>
  const id = record.id
  const name = record.name
  const groupId = record.group_id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof name !== 'string') return undefined
  if (typeof groupId !== 'number' || !Number.isSafeInteger(groupId)) return undefined
  return {
    id,
    name,
    groupId,
    ...(typeof record.key === 'string' ? { key: record.key } : {}),
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    ...(typeof record.quota === 'number' ? { quota: record.quota } : {}),
    ...(typeof record.expires_at === 'string' ? { expiresAt: record.expires_at } : {}),
  }
}

function readTokenPair(data: unknown): { accessToken: string; refreshToken?: string } {
  if (typeof data !== 'object' || data === null) throw new PanelError(500, '登录响应缺少 data')
  const record = data as Record<string, unknown>
  const accessToken = record.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new PanelError(500, '登录响应缺少 access_token')
  }
  const refreshToken = record.refresh_token
  return { accessToken, ...(typeof refreshToken === 'string' && refreshToken.length > 0 ? { refreshToken } : {}) }
}

/** Raw panel HTTP client; every authed method takes the access token explicitly. */
export class PanelClient {
  readonly baseURL: string
  private readonly fetchImpl: typeof fetch

  constructor(options: PanelClientOptions) {
    const base = options.baseURL.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(base)) throw new Error('sub2api: baseURL 必须是 http(s) 地址')
    this.baseURL = base
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (fetchImpl === undefined) throw new Error('sub2api: 当前环境没有 fetch 可用')
    this.fetchImpl = fetchImpl.bind(globalThis)
  }

  private async call(token: string | undefined, method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseURL}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // Mirror the console web UI's marker: some deployments gate API paths
        // on it, and it is harmless everywhere else.
        'x-user-ui-request': '1',
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const payload = await readBody(response)
    if (!response.ok) {
      if (looksLikeCaptcha(response.status, payload)) {
        const message = (payload as Envelope | undefined)?.message
        throw Object.assign(new PanelError(response.status, `实例开启了人机验证（Turnstile/TCaptcha）——请改用「网页授权」通道`, 'captcha'), {
          kind: 'captcha',
          detail: typeof message === 'string' ? message : undefined,
        })
      }
      if (typeof payload === 'object' && payload !== null && (payload as Envelope).code !== undefined) {
        unwrap(response, payload)
      }
      await fail(response, `面板 ${method} ${path}`)
    }
    return unwrap(response, payload)
  }

  /** Password login; classifies 2FA and captcha outcomes. */
  async login(email: string, password: string): Promise<LoginOutcome> {
    const payload = await this.call(undefined, 'POST', '/auth/login', { email, password })
    const data = payload as Record<string, unknown> | null | undefined
    if (data !== null && typeof data === 'object' && data.requires_2fa === true) {
      const tempToken = data.temp_token
      if (typeof tempToken !== 'string' || tempToken.length === 0) {
        throw new PanelError(500, '2FA 响应缺少 temp_token')
      }
      return { kind: '2fa', tempToken }
    }
    const tokens = readTokenPair(payload)
    return { kind: 'ok', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
  }

  /** Second factor for the pending login. */
  async login2FA(tempToken: string, totpCode: string): Promise<{ accessToken: string; refreshToken?: string }> {
    const payload = await this.call(undefined, 'POST', '/auth/login/2fa', { temp_token: tempToken, totp_code: totpCode })
    return readTokenPair(payload)
  }

  /** Exchange a refresh token for a fresh pair. */
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string }> {
    const payload = await this.call(undefined, 'POST', '/auth/refresh', { refresh_token: refreshToken })
    return readTokenPair(payload)
  }

  /** Groups the account can bind; `data` is a bare array. */
  async listAvailableGroups(token: string): Promise<PanelGroup[]> {
    const data = await this.call(token, 'GET', '/groups/available')
    if (!Array.isArray(data)) throw new PanelError(500, 'groups/available 响应不是数组')
    return data.map(readGroup).filter((group): group is PanelGroup => group !== undefined)
  }

  /**
   * One page of the panel's native key listing (newest first upstream:
   * `sort_by=created_at&sort_order=desc`, mirroring the console call shape).
   * Callers that need every key walk `pages` themselves.
   */
  async listKeys(token: string, options?: { groupId?: number; page?: number; pageSize?: number; search?: string; sortBy?: string; sortOrder?: string }): Promise<PanelKeyPage> {
    const page = options?.page ?? 1
    const pageSize = options?.pageSize ?? 20
    const query = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      sort_by: options?.sortBy ?? 'created_at',
      sort_order: options?.sortOrder ?? 'desc',
      timezone: timeZoneOf(),
    })
    if (options?.groupId !== undefined) query.set('group_id', String(options.groupId))
    const search = options?.search?.trim()
    if (search !== undefined && search.length > 0) query.set('search', search)
    const data = await this.call(token, 'GET', `/keys?${query.toString()}`)
    const record = data as { items?: unknown; total?: unknown; pages?: unknown } | null | undefined
    const items = record?.items
    if (!Array.isArray(items)) throw new PanelError(500, 'keys 响应缺少 items 数组')
    const mapped = items.map(readKey).filter((key): key is PanelKey => key !== undefined)
    const total = typeof record?.total === 'number' ? record.total : mapped.length
    const pages = typeof record?.pages === 'number' && record.pages > 0
      ? record.pages
      : Math.max(1, Math.ceil(total / pageSize))
    return { items: mapped, total, pages }
  }

  /** Create one relay key. */
  async createKey(token: string, input: { name: string; groupId: number; quota?: number; expiresinDays?: number }): Promise<PanelKey> {
    const payload = await this.call(token, 'POST', '/keys', {
      name: input.name,
      group_id: input.groupId,
      ...(input.quota !== undefined && input.quota > 0 ? { quota: input.quota } : {}),
      ...(input.expiresinDays !== undefined && input.expiresinDays > 0 ? { expires_in_days: input.expiresinDays } : {}),
    })
    const key = readKey(payload)
    if (key === undefined) throw new PanelError(500, '创建 key 响应形状异常')
    return key
  }

  /** Revoke one relay key. */
  async deleteKey(token: string, id: number): Promise<void> {
    await this.call(token, 'DELETE', `/keys/${id}`)
  }

  /**
   * Controlled plaintext reveal for one client-owned relay key (OAuth only):
   * the regular OAuth list/get answers are masked, this endpoint is the
   * documented exception — same ownership checks server-side, audited.
   */
  async revealKey(token: string, id: number): Promise<PanelKey> {
    const payload = await this.call(token, 'POST', `/keys/${id}/reveal`)
    const key = readKey(payload)
    if (key === undefined) throw new PanelError(500, 'reveal 响应形状异常')
    return key
  }

  /**
   * The signed-in account's panel identity via the OAuth userinfo endpoint
   * (`GET /auth/me`, scope `profile` — the plugin always requests it). The
   * richer `/user/profile` sits OUTSIDE the OAuth token's path whitelist
   * (`requiredOAuthScope`: only /auth/me, /groups/*, /keys/*) and answers
   * 403 INSUFFICIENT_SCOPE for OAuth sessions. Fields: username, email,
   * balance — all optional.
   */
  async getProfile(token: string): Promise<PanelProfile> {
    const payload = await this.call(token, 'GET', '/auth/me')
    if (payload === null || typeof payload !== 'object') throw new PanelError(500, 'profile 响应形状异常')
    const data = payload as Record<string, unknown>
    const pick = (key: string): string | undefined => {
      const value = data[key]
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
    }
    const balance = data.balance
    return {
      username: pick('username'),
      email: pick('email'),
      ...(typeof balance === 'number' && Number.isFinite(balance) ? { balance } : {}),
    }
  }

  /** OAuth token exchange against the discovered provider (host-side only). */
  async oauthTokenExchange(
    endpoints: OAuthEndpoints,
    input: { code: string; redirectUri: string; verifier: string },
  ): Promise<OAuthTokenPair> {
    return exchangeAuthorizationCode(endpoints, input, this.fetchImpl)
  }

  /** OAuth discovery passthrough for route handlers that need endpoints. */
  async discoverOAuth(): Promise<OAuthEndpoints> {
    return discoverOAuthEndpoints(this.baseURL, this.fetchImpl)
  }
}

export type AuthKind = 'none' | 'panel' | 'oauth'

export interface AuthState {
  signedIn: boolean
  kind: AuthKind
  email?: string
}

/**
 * Credential-backed gateway over {@link PanelClient}: stores login
 * tokens, classifies the auth kind, and wraps authed calls with a
 * single-flight 401 → refresh → retry.
 */
export class PanelGateway {
  private readonly baseURLSource: string | (() => string)
  private readonly credentials: CredentialsLike
  private readonly fetchImpl?: typeof fetch
  private pending2FA?: { tempToken: string; email: string }
  private refreshInFlight?: Promise<string>
  private oauthRefreshInFlight?: Promise<string>

  constructor(options: { baseURL: string | (() => string); credentials: CredentialsLike; fetchImpl?: typeof fetch; onAuthLost?: () => void }) {
    this.baseURLSource = options.baseURL
    this.credentials = options.credentials
    this.fetchImpl = options.fetchImpl
    this.onAuthLost = options.onAuthLost
  }

  /**
   * Fired when the panel session is definitively gone — no refresh token, or
   * the refresh call itself was refused. Never on network failures. The host
   * hooks this to purge the site's sync state (logout/expiry policy).
   */
  private readonly onAuthLost?: () => void

  /** The instance address, re-read per call so a baseURL edit takes effect. */
  private get baseURL(): string {
    return typeof this.baseURLSource === 'function' ? this.baseURLSource() : this.baseURLSource
  }

  private client(): PanelClient {
    return new PanelClient({ baseURL: this.baseURL, fetchImpl: this.fetchImpl })
  }

  private tokenRef(): string {
    return panelTokenRef(this.baseURL)
  }

  private refreshRef(): string {
    return panelRefreshRef(this.baseURL)
  }

  private oauthAccessRef(): string {
    return oauthTokenRef(this.baseURL)
  }

  private oauthRefresh(): string {
    return oauthRefreshRef(this.baseURL)
  }

  /** Current auth state; email rides the caller's config, not credentials. */
  async authState(email?: string): Promise<AuthState> {
    const oauthAccess = await this.credentials.resolve(this.oauthAccessRef())
    if (oauthAccess !== undefined && oauthAccess.value.length > 0) {
      return { signedIn: true, kind: 'oauth', ...(email !== undefined && email.length > 0 ? { email } : {}) }
    }
    const access = await this.credentials.resolve(this.tokenRef())
    if (access === undefined || access.value.length === 0) return { signedIn: false, kind: 'none' }
    return { signedIn: true, kind: 'panel', ...(email !== undefined && email.length > 0 ? { email } : {}) }
  }

  /** Password login; stores the pair and the password for silent re-login. */
  async login(email: string, password: string): Promise<LoginOutcome> {
    const outcome = await this.client().login(email, password)
    if (outcome.kind === '2fa') {
      this.pending2FA = { tempToken: outcome.tempToken, email }
      return outcome
    }
    if (outcome.kind === 'captcha') return outcome
    await this.storeTokens(outcome.accessToken, outcome.refreshToken)
    return outcome
  }

  /** Complete the pending 2FA login. */
  async login2FA(code: string): Promise<void> {
    const pending = this.pending2FA
    if (pending === undefined) throw new Error('sub2api-sync: 没有待完成的 2FA 登录——请先发起登录')
    const tokens = await this.client().login2FA(pending.tempToken, code)
    await this.storeTokens(tokens.accessToken, tokens.refreshToken)
    this.pending2FA = undefined
  }

  /** Sign out: revoke OAuth tokens server-side when present, then drop both channels' secrets. */
  async logout(): Promise<void> {
    await this.oauthSignOut()
    await this.credentials.unset(this.tokenRef())
    await this.credentials.unset(this.refreshRef())
    this.pending2FA = undefined
  }

  /**
   * Run one authed panel call. Tokens resolve per channel — OAuth access
   * token first, then the panel JWT — and a 401 triggers a single-flight
   * refresh (channel-appropriate) and exactly one retry before failing loud.
   */
  async use<T>(fn: (panel: PanelClient, token: string) => Promise<T>): Promise<T> {
    const oauthAccess = await this.credentials.resolve(this.oauthAccessRef())
    if (oauthAccess !== undefined && oauthAccess.value.length > 0) {
      const panel = this.client()
      try {
        return await fn(panel, oauthAccess.value)
      } catch (error) {
        const status = error instanceof PanelError ? error.status : undefined
        if (status !== 401) throw error
        const token = await this.refreshOAuthSingleFlight()
        return await fn(panel, token)
      }
    }
    const access = await this.credentials.resolve(this.tokenRef())
    if (access === undefined || access.value.length === 0) {
      throw new Error('sub2api-sync: 尚未登录 sub2api 面板——请先在设置卡完成登录')
    }
    const panel = this.client()
    try {
      return await fn(panel, access.value)
    } catch (error) {
      const status = error instanceof PanelError ? error.status : undefined
      if (status !== 401) throw error
      const token = await this.refreshSingleFlight()
      return await fn(panel, token)
    }
  }

  /** Store the pair from a completed browser authorization (C2). */
  async storeOAuthTokens(pair: OAuthTokenPair): Promise<void> {
    await this.credentials.set(this.oauthAccessRef(), pair.accessToken)
    if (pair.refreshToken !== undefined) {
      await this.credentials.set(this.oauthRefresh(), pair.refreshToken)
    } else {
      await this.credentials.unset(this.oauthRefresh())
    }
  }

  /** Revoke OAuth tokens at the provider (best effort) and drop the stored secrets. */
  async oauthSignOut(): Promise<void> {
    const access = await this.credentials.resolve(this.oauthAccessRef())
    const refresh = await this.credentials.resolve(this.oauthRefresh())
    if (access !== undefined || refresh !== undefined) {
      try {
        const endpoints = await discoverOAuthEndpoints(this.baseURL, this.fetchImpl)
        if (refresh !== undefined) await revokeToken(endpoints, refresh.value, this.fetchImpl)
        if (access !== undefined) await revokeToken(endpoints, access.value, this.fetchImpl)
      } catch {
        // Revocation is best effort: dropping the local secrets always wins.
      }
    }
    await this.credentials.unset(this.oauthAccessRef())
    await this.credentials.unset(this.oauthRefresh())
  }

  /** Single-flight OAuth refresh (rotating); concurrent 401s share one wire call. */
  private refreshOAuthSingleFlight(): Promise<string> {
    this.oauthRefreshInFlight ??= this.refreshOAuth().finally(() => {
      this.oauthRefreshInFlight = undefined
    })
    return this.oauthRefreshInFlight
  }

  private async refreshOAuth(): Promise<string> {
    const stored = await this.credentials.resolve(this.oauthRefresh())
    if (stored === undefined || stored.value.length === 0) {
      await this.credentials.unset(this.oauthAccessRef())
      this.onAuthLost?.()
      throw new Error('sub2api-sync: OAuth 登录已过期且无 refresh token——请重新进行网页授权')
    }
    try {
      const endpoints = await discoverOAuthEndpoints(this.baseURL, this.fetchImpl)
      const pair = await refreshAccessToken(endpoints, stored.value, this.fetchImpl)
      await this.storeOAuthTokens(pair)
      return pair.accessToken
    } catch (error) {
      await this.credentials.unset(this.oauthAccessRef())
      await this.credentials.unset(this.oauthRefresh())
      this.onAuthLost?.()
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`sub2api-sync: OAuth 登录已过期且刷新失败——请重新进行网页授权（${reason}）`)
    }
  }

  /** Single-flight refresh; concurrent 401s share one wire call. */
  private refreshSingleFlight(): Promise<string> {
    this.refreshInFlight ??= this.doRefresh().finally(() => {
      this.refreshInFlight = undefined
    })
    return this.refreshInFlight
  }

  private async doRefresh(): Promise<string> {
    const stored = await this.credentials.resolve(this.refreshRef())
    if (stored === undefined || stored.value.length === 0) {
      await this.credentials.unset(this.tokenRef())
      this.onAuthLost?.()
      throw new Error('sub2api-sync: 登录已过期且无 refresh token——请重新登录')
    }
    try {
      const tokens = await this.client().refresh(stored.value)
      await this.storeTokens(tokens.accessToken, tokens.refreshToken)
      return tokens.accessToken
    } catch (error) {
      await this.credentials.unset(this.tokenRef())
      await this.credentials.unset(this.refreshRef())
      this.onAuthLost?.()
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`sub2api-sync: 登录已过期且刷新失败——请重新登录（${reason}）`)
    }
  }

  private async storeTokens(accessToken: string, refreshToken?: string): Promise<void> {
    await this.credentials.set(this.tokenRef(), accessToken)
    if (refreshToken !== undefined) {
      await this.credentials.set(this.refreshRef(), refreshToken)
    } else {
      await this.credentials.unset(this.refreshRef())
    }
  }
}

/** Convenience export: the password credential ref for one instance. */
export { panelPasswordRef }
