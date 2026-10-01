import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { registerRoutes, ROUTES, trustedRequest, type RouteDeps, type StatusResponse } from '../src/routes.ts'

function request(options: { remote?: string; method?: string; url?: string; headers?: Record<string, string>; body?: unknown }): IncomingMessage {
  const { remote = '127.0.0.1', method = 'GET', url = '/', headers = {}, body } = options
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url,
    headers: { host: 'localhost:5173', ...headers },
    socket: { remoteAddress: remote },
    // readJson() iterates the request stream.
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  return req as unknown as IncomingMessage
}

interface Captured {
  status: number
  body: string
}

function response(): Captured & ServerResponse {
  const captured: Captured = { status: 0, body: '' }
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) {
      captured.status = status
      void headers
    },
    end(body?: string) {
      captured.body = body ?? ''
    },
    get status(): number {
      return captured.status
    },
    get body(): string {
      return captured.body
    },
  }
  return res as Captured & ServerResponse
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
type WebServerLike = { register(r: { path: string; handler: RouteHandler }): void }
type CtxWithServer = { inject(deps: unknown, fn: (scope: { webServer: WebServerLike }) => void): void }

function fakeCtx(): { ctx: Context; handlers: Map<string, RouteHandler> } {
  const handlers = new Map<string, RouteHandler>()
  const ctx: CtxWithServer = {
    inject(_deps: unknown, fn: (scope: { webServer: WebServerLike }) => void) {
      fn({ webServer: { register: (r) => { handlers.set(r.path, r.handler) } } })
    },
  }
  return { ctx: ctx as unknown as Context, handlers }
}

function depsStub(overrides: Partial<RouteDeps> = {}): RouteDeps {
  const base: RouteDeps = {
    instance: () => 'http://panel:9000',
    authState: async () => ({ signedIn: false, kind: 'none' }),
    login: async () => ({ ok: true, kind: 'ok' }),
    login2FA: async () => undefined,
    logout: async () => undefined,
    setPat: async () => ({ ok: true, groups: 3 }),
    listGroups: async () => [
      { id: 2, name: 'codex-稳定[号池]', platform: 'openai', status: 'active', rateMultiplier: 0.2, enabled: true },
      { id: 4, name: 'claude-max[号池]', platform: 'anthropic', status: 'active', rateMultiplier: 1.5, enabled: false },
    ],
    sync: async () => ({ entries: [{ groupId: 2, route: 'sub2api-2', displayName: 'NexaRelay(key)', action: 'created', models: 3 }], removed: [], writes: 1, attempts: 1, warnings: [] }),
    lastReport: () => undefined,
    lastReportAt: () => undefined,
    listKeys: async (page: number, _pageSize: number) => ({
      keys: [
        { id: 42, name: 'claude-max[号池]', groupId: 4, status: 'active' },
        ...(page > 1 ? [{ id: 99, name: 'next-page', groupId: 4, status: 'active' }] : []),
      ],
      total: 6,
      pages: 2,
    }),
    createKey: async (input) => ({ id: 43, name: input.name, groupId: input.groupId, status: 'active' }),
    isSyncRunning: () => false,
    ownedRoutes: () => [{ route: 'sub2api-2', displayName: 'NexaRelay(key)', api: 'openai-responses', models: 3, modelsPreview: ['m-1', 'm-2', 'm-3'] }],
    allowRemote: () => false,
  }
  return Object.assign(base, overrides)
}

async function call(handlers: Map<string, RouteHandler>, path: string, init: { url?: string; method?: string; body?: unknown; remote?: string; headers?: Record<string, string> } = {}) {
  const handler = handlers.get(path)
  if (handler === undefined) throw new Error(`route not registered: ${path}`)
  const res = response()
  await handler(request({ url: path, ...init }), res)
  return { status: res.status ?? 0, body: res.body === '' ? undefined : JSON.parse(res.body) as Record<string, unknown> }
}

describe('trustedRequest', () => {
  const headers = { host: 'localhost:5173' }

  it('accepts loopback peers', () => {
    expect(trustedRequest(request({ remote: '127.0.0.1', headers }), false)).toBe(true)
    expect(trustedRequest(request({ remote: '::1', headers }), false)).toBe(true)
    expect(trustedRequest(request({ remote: '::ffff:127.0.0.1', headers }), false)).toBe(true)
  })

  it('rejects private and public peers unless the escape hatch is on', () => {
    expect(trustedRequest(request({ remote: '192.168.1.5', headers }), false)).toBe(false)
    expect(trustedRequest(request({ remote: '192.168.1.5', headers }), true)).toBe(true)
    expect(trustedRequest(request({ remote: '10.0.0.7', headers }), true)).toBe(true)
    expect(trustedRequest(request({ remote: 'fd00::5', headers }), true)).toBe(true)
    expect(trustedRequest(request({ remote: '8.8.8.8', headers }), true)).toBe(false)
  })

  it('rejects cross-site and origin-mismatched requests', () => {
    expect(trustedRequest(request({ headers: { ...headers, 'sec-fetch-site': 'cross-site' } }), false)).toBe(false)
    expect(trustedRequest(request({ headers: { ...headers, origin: 'http://evil.example' } }), false)).toBe(false)
    expect(trustedRequest(request({ headers: { ...headers, origin: 'http://localhost:5173' } }), false)).toBe(true)
  })
})

describe('routes', () => {
  it('registers every documented path', () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    for (const path of Object.values(ROUTES)) expect(handlers.has(path)).toBe(true)
  })

  it('answers the status snapshot', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const { status, body } = await call(handlers, ROUTES.status)
    expect(status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      auth: { signedIn: false, kind: 'none' },
      instance: 'http://panel:9000',
      syncRunning: false,
    })
    const snapshot = body as unknown as StatusResponse
    expect(snapshot.routes[0]).toMatchObject({ route: 'sub2api-2', models: 3 })
  })

  it('validates the login body and maps captcha errors', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const missing = await call(handlers, ROUTES.login, { method: 'POST', body: { password: 'x' } })
    expect(missing.status).toBe(400)

    const ok = await call(handlers, ROUTES.login, { method: 'POST', body: { email: 'a@b.c', password: 'pw' } })
    expect(ok.body).toEqual({ ok: true, kind: 'ok' })

    const { ctx: ctx2, handlers: handlers2 } = fakeCtx()
    registerRoutes(ctx2, depsStub({
      login: async () => { const e = new Error('实例开启了人机验证'); (e as Error & { kind?: string }).kind = 'captcha'; throw e },
    }))
    const captcha = await call(handlers2, ROUTES.login, { method: 'POST', body: { email: 'a@b.c', password: 'pw' } })
    expect(captcha.status).toBe(400)
    expect(captcha.body).toMatchObject({ ok: false, kind: 'captcha' })
  })

  it('routes the 2FA completion with a 6-digit guard', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const bad = await call(handlers, ROUTES.login2fa, { method: 'POST', body: { code: '12' } })
    expect(bad.status).toBe(400)
    const ok = await call(handlers, ROUTES.login2fa, { method: 'POST', body: { code: '123456' } })
    expect(ok.body).toEqual({ ok: true, kind: 'ok' })
  })

  it('validates the PAT and reports the visible group count', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const missing = await call(handlers, ROUTES.pat, { method: 'POST', body: {} })
    expect(missing.status).toBe(400)
    const ok = await call(handlers, ROUTES.pat, { method: 'POST', body: { token: 'sk-…' } })
    expect(ok.body).toEqual({ ok: true, groups: 3 })
  })

  it('annotates groups with the checked and keyId state', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const { body } = await call(handlers, ROUTES.groups)
    expect(body?.groups).toEqual([
      expect.objectContaining({ id: 2, enabled: true }),
      expect.objectContaining({ id: 4, enabled: false }),
    ])
  })

  it('wraps sync results and failures', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const ok = await call(handlers, ROUTES.sync, { method: 'POST' })
    expect(ok.body?.report).toMatchObject({ writes: 1, entries: [{ route: 'sub2api-2', action: 'created' }] })

    const { ctx: ctx2, handlers: handlers2 } = fakeCtx()
    registerRoutes(ctx2, depsStub({ sync: async () => { throw new Error('boom') } }))
    const failed = await call(handlers2, ROUTES.sync, { method: 'POST' })
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ ok: false, error: 'boom' })
  })

  it('rejects untrusted peers with 403', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const { status } = await call(handlers, ROUTES.status, { remote: '8.8.8.8' })
    expect(status).toBe(403)
  })

  it('rejects wrong methods with 405', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const { status } = await call(handlers, ROUTES.sync, { method: 'GET' })
    expect(status).toBe(405)
  })

  it('honors the allowRemoteActions escape hatch from config', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub({ allowRemote: () => true }))
    const { status } = await call(handlers, ROUTES.status, { remote: '192.168.1.5' })
    expect(status).toBe(200)
  })
})

describe('keys routes', () => {
  it('aggregates the instance keys for the keys card', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const { status, body } = await call(handlers, ROUTES.keys)
    expect(status).toBe(200)
    expect(body?.keys).toEqual([{ id: 42, name: 'claude-max[号池]', groupId: 4, status: 'active' }])
  })

  it('creates a key with validation', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const bad = await call(handlers, ROUTES.keys, { method: 'POST', body: { name: 'x' } })
    expect(bad.status).toBe(400)
    const empty = await call(handlers, ROUTES.keys, { method: 'POST', body: { groupId: 2, name: '   ' } })
    expect(empty.status).toBe(400)
    const ok = await call(handlers, ROUTES.keys, { method: 'POST', body: { groupId: 2, name: 'claude-max[号池]' } })
    expect(ok.status).toBe(200)
    expect(ok.body?.key).toMatchObject({ id: 43, name: 'claude-max[号池]', groupId: 2 })
  })
})
