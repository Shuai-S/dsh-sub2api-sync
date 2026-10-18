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
type WebServerLike = { register(r: { path: string; handler: RouteHandler }): () => void }
type InjectFiber = { then(onFulfilled: undefined, onRejected: (error: unknown) => void): unknown }
type CtxWithServer = { inject(deps: unknown, fn: (scope: { webServer: WebServerLike; effect(execute: () => () => void): void }) => void): InjectFiber }

function fakeCtx(): { ctx: Context; handlers: Map<string, RouteHandler>; disposers: Array<() => void> } {
  const handlers = new Map<string, RouteHandler>()
  const disposers: Array<() => void> = []
  const ctx: CtxWithServer = {
    inject(_deps: unknown, fn: (scope: { webServer: WebServerLike; effect(execute: () => () => void): void }) => void): InjectFiber {
      fn({
        webServer: {
          register: (r) => {
            handlers.set(r.path, r.handler)
            const unregister = () => { handlers.delete(r.path) }
            disposers.push(unregister)
            return unregister
          },
        },
        // The fix ties each route's disposer to the registering inject fiber.
        effect: (execute) => { execute() },
      })
      // The real inject returns the child fiber (a thenable); it never rejects here.
      return { then: () => undefined }
    },
  }
  return { ctx: ctx as unknown as Context, handlers, disposers }
}

function depsStub(overrides: Partial<RouteDeps> = {}): RouteDeps {
  const base: RouteDeps = {
    instance: () => 'http://panel:9000',
    authState: async () => ({ signedIn: false, kind: 'none' }),
    login: async () => ({ ok: true, kind: 'ok' }),
    login2FA: async () => undefined,
    logout: async () => undefined,
    listGroups: async () => [
      { id: 2, name: 'codex-稳定[号池]', platform: 'openai', status: 'active', rateMultiplier: 0.2 },
      { id: 4, name: 'claude-max[号池]', platform: 'anthropic', status: 'active', rateMultiplier: 1.5 },
    ],
    sync: async () => ({ entries: [{ groupId: 2, route: 'sub2api-2', displayName: 'NexaRelay(key)', action: 'created', models: 3 }], removed: [], writes: 1, attempts: 1, warnings: [] }),
    lastReport: () => undefined,
    lastReportAt: () => undefined,
    listKeys: async (page: number, _pageSize: number, _search?: string) => ({
      keys: [
        { id: 42, name: 'claude-max[号池]', groupId: 4, status: 'active' },
        ...(page > 1 ? [{ id: 99, name: 'next-page', groupId: 4, status: 'active' }] : []),
      ],
      total: 6,
      pages: 2,
    }),
    createKey: async (input) => ({ id: 43, name: input.name, groupId: input.groupId, status: 'active' }),
    icon: async () => undefined,
    siteName: async () => undefined,
    account: async () => undefined,
    resetSync: async () => undefined,
    removeSyncedKey: async () => undefined,
    isSyncRunning: () => false,
    ownedRoutes: () => [{ route: 'sub2api-2', displayName: 'NexaRelay(key)', api: 'openai-responses', models: 3, modelsPreview: ['m-1', 'm-2', 'm-3'] }],
    allowRemote: () => false,
    oauthProbe: async () => false,
    oauthStart: async () => ({ attemptId: 'a-1', authorizeUrl: 'http://panel:9000/api/v1/oauth/authorize?x=1' }),
    oauthCallback: async () => ({ html: '<!doctype html><html><body>ok</body></html>' }),
    oauthStatus: async () => ({ ok: true, attempt: undefined, auth: { signedIn: false, kind: 'none' } }),
    oauthCancel: async () => undefined,
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

  it('projects the panel groups verbatim (checked state rides the config, not this response)', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const { body } = await call(handlers, ROUTES.groups)
    expect(body?.groups).toEqual([
      expect.objectContaining({ id: 2, name: 'codex-稳定[号池]', platform: 'openai' }),
      expect.objectContaining({ id: 4, name: 'claude-max[号池]', platform: 'anthropic' }),
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

  it('forwards the search filter, dropping blank terms', async () => {
    const seen: Array<string | undefined> = []
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub({
      listKeys: async (_page: number, _pageSize: number, search?: string) => {
        seen.push(search)
        return { keys: [], total: 0, pages: 1 }
      },
    }))
    await call(handlers, ROUTES.keys, { url: `${ROUTES.keys}?page=2&pageSize=5&search=${encodeURIComponent('国庆 国模')}` })
    await call(handlers, ROUTES.keys, { url: `${ROUTES.keys}?search=%20%20` })
    expect(seen).toEqual(['国庆 国模', undefined])
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

describe('icon route', () => {
  async function callRaw(handlers: Map<string, RouteHandler>, path: string, method = 'GET'): Promise<{ status: number; body: string | Buffer }> {
    const handler = handlers.get(path)
    if (handler === undefined) throw new Error(`route not registered: ${path}`)
    const res = response()
    await handler(request({ url: path, method }), res)
    return { status: res.status, body: (res as { body: string | Buffer }).body }
  }

  it('streams the icon bytes with the upstream content type', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub({
      icon: async () => ({ contentType: 'image/svg+xml', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }),
    }))
    const { status, body } = await callRaw(handlers, ROUTES.icon)
    expect(status).toBe(200)
    expect(String(body)).toContain('<svg')
  })

  it('answers 404 when the instance exposes no icon', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const { status } = await callRaw(handlers, ROUTES.icon)
    expect(status).toBe(404)
  })

  it('rejects non-GET and untrusted peers', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const post = await callRaw(handlers, ROUTES.icon, 'POST')
    expect(post.status).toBe(405)
    const remoteHandler = handlers.get(ROUTES.icon)
    const res = response()
    await remoteHandler!(request({ url: ROUTES.icon, remote: '8.8.8.8' }), res)
    expect(res.status).toBe(403)
  })
})

describe('site route', () => {
  it('serves the instance site name when the probe resolves one', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub({ siteName: async () => '我的中转' }))
    const { status, body } = await call(handlers, ROUTES.site)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, name: '我的中转' })
  })

  it('answers a null name when the instance exposes none', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const { status, body } = await call(handlers, ROUTES.site)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, name: undefined })
  })

  it('keeps answering when the probe throws', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub({ siteName: async () => { throw new Error('boom') } }))
    const { status, body } = await call(handlers, ROUTES.site)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, name: undefined })
  })
})

describe('account route', () => {
  it('serves the signed-in account identity', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub({ account: async () => ({ username: 'zs', email: 'zs@example.com', balance: 3.2 }) }))
    const { status, body } = await call(handlers, ROUTES.account)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, username: 'zs', email: 'zs@example.com', balance: 3.2 })
  })

  it('answers empty fields when unavailable and rides upstream errors as `error`', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub({ account: async () => undefined }))
    const { status, body } = await call(handlers, ROUTES.account)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
    const failing = fakeCtx()
    registerRoutes(failing.ctx, depsStub({ account: async () => { throw new Error('面板 GET /auth/me: HTTP 403') } }))
    const failed = await call(failing.handlers, ROUTES.account)
    expect(failed.status).toBe(200)
    expect(failed.body).toEqual({ ok: true, error: '面板 GET /auth/me: HTTP 403' })
  })
})

describe('oauthProbe route', () => {
  it('probes the given address and answers its supported verdict', async () => {
    const { ctx, handlers } = fakeCtx()
    const seen: string[] = []
    registerRoutes(ctx, depsStub({ oauthProbe: async (address) => { seen.push(address); return address === 'http://good:8080' } }))
    const good = await call(handlers, ROUTES.oauthProbe, { url: `${ROUTES.oauthProbe}?address=${encodeURIComponent('http://good:8080')}` })
    expect(good.body).toEqual({ ok: true, supported: true })
    const bad = await call(handlers, ROUTES.oauthProbe, { url: `${ROUTES.oauthProbe}?address=${encodeURIComponent('http://old:8080')}` })
    expect(bad.body).toEqual({ ok: true, supported: false })
    expect(seen).toEqual(['http://good:8080', 'http://old:8080'])
  })

  it('answers unsupported for a non-http address without probing', async () => {
    const { ctx, handlers } = fakeCtx()
    const seen: string[] = []
    registerRoutes(ctx, depsStub({ oauthProbe: async (address) => { seen.push(address); return true } }))
    const result = await call(handlers, ROUTES.oauthProbe, { url: `${ROUTES.oauthProbe}?address=${encodeURIComponent('ftp://x')}` })
    expect(result.body).toEqual({ ok: true, supported: false })
    expect(seen).toEqual([])
  })

  it('keeps answering when the probe throws', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub({ oauthProbe: async () => { throw new Error('boom') } }))
    const result = await call(handlers, ROUTES.oauthProbe, { url: `${ROUTES.oauthProbe}?address=${encodeURIComponent('http://x:1')}` })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, supported: false })
  })
})

describe('resetSync route', () => {
  it('purges via the dep with the previous instance when given', async () => {
    const { ctx, handlers } = fakeCtx()
    const seen: Array<string | undefined> = []
    registerRoutes(ctx, depsStub({ resetSync: async (previous) => { seen.push(previous) } }))
    const none = await call(handlers, ROUTES.resetSync, { method: 'POST', body: {} })
    expect(none.status).toBe(200)
    expect(none.body).toEqual({ ok: true })
    const withPrevious = await call(handlers, ROUTES.resetSync, { method: 'POST', body: { previousBaseURL: 'http://old:3000' } })
    expect(withPrevious.status).toBe(200)
    expect(seen).toEqual([undefined, 'http://old:3000'])
  })

  it('rejects non-POST and untrusted peers', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const get = await call(handlers, ROUTES.resetSync)
    expect(get.status).toBe(405)
    const handler = handlers.get(ROUTES.resetSync)
    const res = response()
    await handler!(request({ url: ROUTES.resetSync, method: 'POST', remote: '8.8.8.8' }), res)
    expect(res.status).toBe(403)
  })

  it('answers 500 when the purge fails', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub({ resetSync: async () => { throw new Error('settings unavailable') } }))
    const failed = await call(handlers, ROUTES.resetSync, { method: 'POST', body: {} })
    expect(failed.status).toBe(500)
    expect(failed.body).toMatchObject({ ok: false })
  })
})

describe('removeKey route', () => {
  it('dispatches the positive-integer keyId to the dep', async () => {
    const { ctx, handlers } = fakeCtx()
    const seen: number[] = []
    registerRoutes(ctx, depsStub({ removeSyncedKey: async (keyId) => { seen.push(keyId) } }))
    const ok = await call(handlers, ROUTES.removeKey, { method: 'POST', body: { keyId: 5 } })
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ ok: true })
    const numericString = await call(handlers, ROUTES.removeKey, { method: 'POST', body: { keyId: '7' } })
    expect(numericString.status).toBe(200)
    expect(seen).toEqual([5, 7])
  })

  it('rejects a missing or non-integer keyId', async () => {
    const { ctx, handlers } = fakeCtx()
    const seen: number[] = []
    registerRoutes(ctx, depsStub({ removeSyncedKey: async (keyId) => { seen.push(keyId) } }))
    const missing = await call(handlers, ROUTES.removeKey, { method: 'POST', body: {} })
    expect(missing.status).toBe(400)
    const zero = await call(handlers, ROUTES.removeKey, { method: 'POST', body: { keyId: 0 } })
    expect(zero.status).toBe(400)
    const float = await call(handlers, ROUTES.removeKey, { method: 'POST', body: { keyId: 1.5 } })
    expect(float.status).toBe(400)
    expect(seen).toEqual([])
  })

  it('rejects non-POST, untrusted peers, and dep failures', async () => {
    const { ctx, handlers } = fakeCtx()
    registerRoutes(ctx, depsStub())
    const get = await call(handlers, ROUTES.removeKey)
    expect(get.status).toBe(405)
    const handler = handlers.get(ROUTES.removeKey)
    const res = response()
    await handler!(request({ url: ROUTES.removeKey, method: 'POST', remote: '8.8.8.8' }), res)
    expect(res.status).toBe(403)

    const { ctx: failCtx, handlers: failHandlers } = fakeCtx()
    registerRoutes(failCtx, depsStub({ removeSyncedKey: async () => { throw new Error('settings unavailable') } }))
    const failed = await call(failHandlers, ROUTES.removeKey, { method: 'POST', body: { keyId: 5 } })
    expect(failed.status).toBe(500)
    expect(failed.body).toMatchObject({ ok: false, error: 'settings unavailable' })
  })
})

describe('oauthCallback route locale', () => {
  it('derives the page locale from the request Accept-Language and hands it to the dep', async () => {
    const { ctx, handlers } = fakeCtx()
    const langs: string[] = []
    registerRoutes(ctx, depsStub({
      oauthCallback: async (_query, lang) => { langs.push(lang) ; return { html: '<!doctype html><html><body>ok</body></html>' } },
    }))
    const handler = handlers.get(ROUTES.oauthCallback)
    expect(handler).toBeDefined()
    // The route answers HTML, so invoke the handler directly (call() parses JSON).
    const run = (acceptLanguage?: string): Promise<void> =>
      handler!(request({ url: `${ROUTES.oauthCallback}?code=x&state=y`, headers: acceptLanguage === undefined ? {} : { 'accept-language': acceptLanguage } }), response()).then(() => undefined)
    await run('zh-CN,zh;q=0.9,en;q=0.8')
    await run('en-US,en;q=0.9')
    await run()
    expect(langs).toEqual(['zh', 'en', 'zh'])
  })
})

describe('route lifecycle', () => {
  // Real cordis: the route disposers MUST ride the registering inject fiber.
  // A dropped disposer orphans the entries on plugin reload — the next apply
  // then hits `webserver: duplicate route` and fails silently, and the table
  // keeps serving the disposed fiber's closures, whose service access throws
  // `cannot get required service "credentials" in inactive context` (the
  // OAuth callback's 授权失败). Regression: dispose must empty the table.
  it('removes its routes when the plugin fiber unloads, so a reload re-registers cleanly', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const table = new Map<string, unknown>()
    const root = new Context()
    root.provide('webServer', {
      register(route: { path: string }) {
        table.set(route.path, route)
        return () => { table.delete(route.path) }
      },
    })
    root.provide('credentials', { resolve: async () => undefined, set: async () => {}, unset: async () => {} })

    const makePlugin = () => ({
      name: 'route-lifecycle-under-test',
      inject: ['credentials'],
      apply(pluginCtx: Context): void {
        registerRoutes(pluginCtx, depsStub())
      },
    })

    const fiber = root.plugin(makePlugin())
    await fiber.await()
    expect(table.size).toBe(Object.keys(ROUTES).length)

    // A re-install / HMR reload disposes the old fiber permanently.
    await fiber.dispose()
    expect(table.size).toBe(0)

    // The next apply must register every path again, no duplicates.
    const next = root.plugin(makePlugin())
    await next.await()
    expect(table.size).toBe(Object.keys(ROUTES).length)
  })
})
