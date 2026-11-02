import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerDshGo } from '../src/dshgo.ts'
import type { RouteDeps } from '../src/routes.ts'

/** Bridge service double: records panel/strip registrations. */
function fakeBridge() {
  const panels: Array<[string, any]> = []
  const strips: Array<[string, any]> = []
  const service = {
    panel: vi.fn((id: string, face: any) => { panels.push([id, face]); return undefined }),
    strip: vi.fn((id: string, data: any) => { strips.push([id, data]); return undefined }),
  }
  const ctx = {
    inject: (names: string[], fn: (c: unknown) => void) => {
      if (names.includes('dshGo')) fn({ dshGo: service })
    },
  }
  return { ctx, service, panels, strips }
}

/** Minimal RouteDeps double over in-memory state. */
function fakeDeps(overrides: Partial<RouteDeps> = {}) {
  return {
    authState: vi.fn(async () => ({ signedIn: true, kind: 'panel' as const, email: 'a@b.c' })),
    instance: () => 'https://panel.example.com',
    ownedRoutes: () => [{ route: 'sub2api-abc012', displayName: 'Site(key)', api: 'openai-completions', models: 3, modelsPreview: [] }],
    lastReportAt: () => Date.now() - 120_000,
    isSyncRunning: () => false,
    sync: vi.fn(async () => ({ entries: [], removed: [], writes: 0, warnings: [] })),
    login: vi.fn(async () => ({ ok: true as const, kind: 'ok' as const })),
    logout: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as RouteDeps
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('registerDshGo', () => {
  const cancels: Array<() => void> = []
  afterEach(() => {
    for (const cancel of cancels.splice(0)) cancel()
    vi.restoreAllMocks()
  })

  it('registers the sync-status panel and the sync-strip', () => {
    const { ctx, service, panels, strips } = fakeBridge()
    registerDshGo(ctx as never, fakeDeps(), { email: () => 'a@b.c' })
    expect(service.panel).toHaveBeenCalledOnce()
    expect(service.strip).toHaveBeenCalledOnce()
    expect(panels[0]?.[0]).toBe('sync-status')
    expect(strips[0]?.[0]).toBe('sync-strip')
  })

  it('is a no-op when the host has no dshGo service', () => {
    const ctx = { inject: (names: string[], fn: (c: unknown) => void) => { if (names.includes('dshGo')) fn({}) } }
    expect(() => registerDshGo(ctx as never, fakeDeps(), { email: () => undefined })).not.toThrow()
  })

  it('emits a complete data model and cancels its tick cleanly', async () => {
    const { ctx, panels } = fakeBridge()
    registerDshGo(ctx as never, fakeDeps(), { email: () => 'a@b.c' })
    const face = panels[0]![1] as { data: (s: unknown, e: (d: unknown) => void, c: unknown) => (() => void) | void }
    const emitted: any[] = []
    const cancel = face.data({}, (d) => emitted.push(d), { locale: 'zh-CN' })
    expect(cancel).toBeTypeOf('function')
    await flush()
    expect(emitted.length).toBeGreaterThan(0)
    const model = emitted[0] as any
    expect(model.statusText).toContain('已登录')
    expect(model.instance).toBe('https://panel.example.com')
    expect(model.routeCount).toBe(1)
    expect(model.routes[0].trailing).toBe('3')
    expect(model.actions.map((a: any) => a.action)).toEqual(['sync', 'logout'])
    cancel!()
    const after = emitted.length
    await flush()
    expect(emitted.length).toBe(after)
  })

  it('switches copy to English with the app locale', async () => {
    const { ctx, panels } = fakeBridge()
    registerDshGo(ctx as never, fakeDeps(), { email: () => undefined })
    const face = panels[0]![1] as { data: (s: unknown, e: (d: unknown) => void, c: unknown) => (() => void) | void }
    const emitted: any[] = []
    const cancel = face.data({}, (d) => emitted.push(d), { locale: 'en-US' })
    await flush()
    expect((emitted[0] as any).statusText).toContain('Signed in')
    cancel!()
  })

  it('sync action runs in the background and republishes', async () => {
    const deps = fakeDeps()
    const { ctx, panels } = fakeBridge()
    registerDshGo(ctx as never, deps, { email: () => 'a@b.c' })
    const face = panels[0]![1] as { data: any; actions: Record<string, (s: unknown, e: unknown) => unknown> }
    const emitted: any[] = []
    cancels.push(face.data({}, (d: unknown) => emitted.push(d), { locale: 'zh-CN' }) as () => void)
    await flush()
    const result = face.actions.sync({}, { locale: 'zh-CN' }) as { toast: string }
    expect(result.toast).toContain('立即同步')
    expect(deps.sync).toHaveBeenCalledOnce()
    await flush()
    expect(emitted.length).toBeGreaterThan(1)
  })

  it('login action refuses without a configured email and reaches deps with one', async () => {
    const deps = fakeDeps()
    const { ctx, panels } = fakeBridge()
    registerDshGo(ctx as never, deps, { email: () => undefined })
    const face = panels[0]![1] as { actions: Record<string, (s: unknown, e: unknown) => unknown> }
    const refused = face.actions.login({}, { locale: 'zh-CN' }) as { toast: string }
    expect(refused.toast).toContain('邮箱')
    expect(deps.login).not.toHaveBeenCalled()

    const deps2 = fakeDeps()
    const bridge2 = fakeBridge()
    registerDshGo(bridge2.ctx as never, deps2, { email: () => 'a@b.c' })
    const face2 = (bridge2.panels[0]![1] as any)
    face2.actions.login({}, { locale: 'zh-CN' })
    expect(deps2.login).toHaveBeenCalledWith('a@b.c', undefined)
    await flush()
  })

  it('login action surfaces the 2FA hand-off hint in the next publish', async () => {
    const deps = fakeDeps({ login: vi.fn(async () => ({ ok: true as const, kind: '2fa' as const, requires2FA: true })) })
    const { ctx, panels } = fakeBridge()
    registerDshGo(ctx as never, deps, { email: () => 'a@b.c' })
    const face = panels[0]![1] as any
    const emitted: any[] = []
    cancels.push(face.data({}, (d: unknown) => emitted.push(d), { locale: 'zh-CN' }) as () => void)
    await flush()
    face.actions.login({}, { locale: 'zh-CN' })
    await flush()
    const last = emitted[emitted.length - 1] as any
    expect(last.statusText).toContain('两步验证')
  })

  it('view binds the callout and actions to the data model', () => {
    const { ctx, panels } = fakeBridge()
    registerDshGo(ctx as never, fakeDeps(), { email: () => 'a@b.c' })
    const face = panels[0]![1] as { view: (s: unknown, c: unknown) => any }
    const view = face.view({}, { locale: 'zh-CN' })
    expect(view.type).toBe('stack')
    const callout = view.children.find((c: any) => c.type === 'callout')
    expect(callout.text).toEqual({ $: 'data.statusText' })
    const actions = view.children.find((c: any) => c.type === 'actions')
    expect(actions.items).toEqual({ $: 'data.actions' })
    const enView = face.view({}, { locale: 'en-US' })
    expect(JSON.stringify(enView)).toContain('Routes')
  })
})
