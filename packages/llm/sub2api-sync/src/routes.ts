/**
 * HTTP routes between the settings card (browser half) and this plugin's
 * host half, registered on the harness web server.
 *
 * rev.4 split: configuration reads/writes ride the platform's
 * `configForms`/settings seam — the old whole-section `/config` route is
 * gone. These routes carry only **actions, secrets, and state projection**:
 * login (password/2FA), PAT, panel group/key listing, paste/clear of a
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
import type { AuthKind } from './panel.ts'
import { isOwnedRoute } from './types.ts'

export const ROUTES = {
  sync: '/plugins/dsh-sub2api-sync/sync',
  status: '/plugins/dsh-sub2api-sync/status',
  login: '/plugins/dsh-sub2api-sync/login',
  login2fa: '/plugins/dsh-sub2api-sync/login/2fa',
  logout: '/plugins/dsh-sub2api-sync/logout',
  pat: '/plugins/dsh-sub2api-sync/pat',
  groups: '/plugins/dsh-sub2api-sync/groups',
  keys: '/plugins/dsh-sub2api-sync/keys',
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
  /** Whether the group is checked for sync (`enabledGroups`). */
  enabled: boolean
  /** The stored key source (`groups[gid].keyId`), when one is pinned. */
  keyId?: number
}

export interface GroupsResponse {
  ok: true
  groups: GroupsView[]
}

export interface LoginResponse {
  ok: true
  kind: 'ok' | '2fa'
  requires2FA?: boolean
}

export interface PatResponse {
  ok: true
  groups: number
}

export interface SyncResponse {
  ok: true
  report: SyncReport
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
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

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function conflictStatus(error: unknown): number | undefined {
  const shape = error as { code?: unknown; name?: unknown } | null | undefined
  return shape?.code === 'SETTINGS_CONFLICT' || shape?.name === 'SettingsConflictError' ? 409 : undefined
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
  /** Validate + store a PAT; returns how many groups it can see. */
  setPat(token: string): Promise<PatResponse>
  /** Live panel groups annotated with the card's checked/keyId state. */
  listGroups(): Promise<GroupsView[]>
  /** One group's relay keys, metadata only (no plaintext). */
  /** Store or clear one group's pasted relay key (empty/absent clears). */
  /** Model preview for one group: pasted override wins over the stored key. */
  /** Best-effort subscription group-name probe for one group's key. */
  /** Run one sync; the implementation serializes and records the report. */
  sync(keyIds?: number[]): Promise<SyncReport>
  lastReport(): SyncReport | undefined
  lastReportAt(): number | undefined
  /** One page of the panel's keys (newest first; page is 1-based). */
  listKeys(page: number, pageSize: number): Promise<KeysListPage>
  /** Create one relay key (name defaults to the group name upstream of this seam). */
  createKey(input: { groupId: number; name: string }): Promise<PanelKeyMeta>
  isSyncRunning(): boolean
  /** Owned routes currently registered in the llm-pi-ai section. */
  ownedRoutes(): StatusRoute[]
  /** Whether the cross-device escape hatch is on (Config, default false). */
  allowRemote(): boolean
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** Register all card routes on the web server (no-op without one). */
export function registerRoutes(ctx: Context, deps: RouteDeps): void {
  ctx.inject(['webServer'], (webCtx) => {
    const route = (path: string, handler: Handler): void => {
      webCtx.webServer.register({ kind: 'exact', path, handler })
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

    route(ROUTES.pat, async (req, res) => {
      if (!guard(req, res)) return
      if (!method('POST', req, res)) return
      let body: Record<string, unknown>
      try {
        body = await readJson(req)
      } catch {
        return json(res, 400, { error: 'invalid JSON body' })
      }
      const token = typeof body.token === 'string' ? body.token.trim() : ''
      if (token.length === 0) return json(res, 400, { error: 'token 必填' })
      try {
        json(res, 200, await deps.setPat(token))
      } catch (error) {
        json(res, 400, { ok: false, error: safeMessage(error) })
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
          const result = await deps.listKeys(page, pageSize)
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
  })
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
