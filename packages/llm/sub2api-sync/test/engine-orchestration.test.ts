import { describe, expect, it } from 'vitest'
import {
  DISCOVERY_CONCURRENCY,
  Sub2apiSyncEngine,
  mapWithConcurrency,
  type SettingsLike,
} from '../src/engine.ts'
import type { PanelGateway, PanelGroup, PanelKey } from '../src/panel.ts'
import { routeForKey, type CredentialsLike, type SettingsPathOp } from '../src/types.ts'
import type { Sub2apiSyncConfig } from '../src/config.ts'

/** Wall-clock-ish helpers: the assertions are RATIOS (overlap vs. sum), so a
 * loaded machine slows every number together instead of breaking a threshold. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

class RecordingSettings implements SettingsLike {
  docs: Record<string, Record<string, unknown>> = { 'llm-pi-ai': { providers: {} }, 'sub2api-sync': {} }
  revisions: Record<string, number> = { 'llm-pi-ai': 1, 'sub2api-sync': 1 }
  commits = 0
  /** Every accepted commit, so a test can assert what was NOT written. */
  mutations: Array<{ ns: string; ops: SettingsPathOp[] }> = []

  get providers(): Record<string, unknown> {
    return this.docs['llm-pi-ai'].providers as Record<string, unknown>
  }

  constructor(private readonly mutateDelayMs = 0) {}

  describe(): Array<{ ns: string; revision: number; value?: unknown }> {
    return [
      { ns: 'llm-pi-ai', revision: this.revisions['llm-pi-ai'] ?? 0, value: structuredClone(this.docs['llm-pi-ai']) },
      { ns: 'sub2api-sync', revision: this.revisions['sub2api-sync'] ?? 0, value: structuredClone(this.docs['sub2api-sync']) },
    ]
  }

  async mutate(ns: string, ops: SettingsPathOp[]): Promise<void> {
    if (this.mutateDelayMs > 0) await sleep(this.mutateDelayMs)
    this.commits++
    this.mutations.push({ ns, ops: structuredClone(ops) })
    const doc = this.docs[ns] ?? (this.docs[ns] = {})
    for (const op of ops) applyPath(doc, op)
    this.revisions[ns] = (this.revisions[ns] ?? 0) + 1
  }
}

function applyPath(doc: Record<string, unknown>, op: SettingsPathOp): void {
  const [head, ...rest] = op.path
  if (rest.length === 0) {
    if (op.op === 'set') doc[head] = structuredClone(op.value)
    else delete doc[head]
    return
  }
  const child = doc[head]
  if (typeof child !== 'object' || child === null) {
    if (op.op === 'unset') return
    doc[head] = {}
  }
  applyPath(doc[head] as Record<string, unknown>, { ...op, path: rest })
}

class MemoryCredentials implements CredentialsLike {
  private readonly store = new Map<string, string>()
  async resolve(ref: string) { return this.store.has(ref) ? { value: this.store.get(ref) as string } : undefined }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

const INSTANCE = 'http://gw:8080'
const GROUPS: PanelGroup[] = [
  { id: 1, name: 'Claude 拼车', platform: 'anthropic' },
  { id: 2, name: 'GPT 池', platform: 'openai' },
]

function gatewayOf(options: {
  keys: PanelKey[]
  panelMs?: number
  log?: string[]
}): PanelGateway {
  const panelMs = options.panelMs ?? 0
  const panel = {
    async listAvailableGroups() {
      options.log?.push('groups')
      if (panelMs > 0) await sleep(panelMs)
      return GROUPS
    },
    async listKeys(_token: string, query?: { page?: number }) {
      options.log?.push(`keys:${query?.page ?? 1}`)
      if (panelMs > 0) await sleep(panelMs)
      return { items: options.keys, total: options.keys.length, pages: 1 }
    },
    async revealKey() { return { key: '' } },
    async deleteKey() { /* no removals expected */ },
  }
  return { use: async <T>(fn: (panel: never, token: string) => Promise<T>) => fn(panel as never, 'tok') } as unknown as PanelGateway
}

/** `/v1/models` double: records concurrency and start/end stamps. */
function modelsFetch(options: { latencyMs?: number; answers?: number[] } = {}): {
  fetchImpl: typeof fetch
  calls: () => number
  maxConcurrent: () => number
} {
  const latency = options.latencyMs ?? 0
  let calls = 0
  let active = 0
  let maxActive = 0
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    calls++
    const answer = options.answers?.shift() ?? 200
    active++
    maxActive = Math.max(maxActive, active)
    try {
      if (latency > 0) await sleep(latency)
      if (answer !== 200) {
        return {
          ok: false,
          status: answer,
          json: async () => ({ error: { message: 'rate limited' } }),
          text: async () => '',
        } as unknown as Response
      }
      expect(String(input)).toContain('/v1/models')
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'claude-x' }, { id: 'claude-y' }] }),
      } as unknown as Response
    } finally {
      active--
    }
  }) as typeof fetch
  return { fetchImpl, calls: () => calls, maxConcurrent: () => maxActive }
}

function keysOf(count: number): PanelKey[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: 100 + index,
    name: `key-${index}`,
    groupId: index % 2 === 0 ? 1 : 2,
    key: `sk-${index}`,
  }))
}

function makeEngine(options: {
  keys: PanelKey[]
  fetchImpl?: typeof fetch
  settings?: RecordingSettings
  panelMs?: number
  loaderMs?: number
  siteMs?: number
  discoveryConcurrency?: number
  now?: () => number
  log?: string[]
}): { engine: Sub2apiSyncEngine; settings: RecordingSettings; fetchImpl: typeof fetch; calls: () => number } {
  const settings = options.settings ?? new RecordingSettings()
  const probe = modelsFetch()
  const fetchImpl = options.fetchImpl ?? probe.fetchImpl
  const engine = new Sub2apiSyncEngine({
    settings,
    credentials: new MemoryCredentials(),
    gateway: gatewayOf({ keys: options.keys, ...(options.panelMs !== undefined ? { panelMs: options.panelMs } : {}), ...(options.log !== undefined ? { log: options.log } : {}) }),
    fetchImpl,
    siteName: async () => {
      options.log?.push('site')
      if (options.siteMs !== undefined && options.siteMs > 0) await sleep(options.siteMs)
      return 'NexaRelay'
    },
    loadModelIndex: async () => {
      options.log?.push('catalog')
      if (options.loaderMs !== undefined && options.loaderMs > 0) await sleep(options.loaderMs)
      return new Map()
    },
    ...(options.discoveryConcurrency !== undefined ? { discoveryConcurrency: options.discoveryConcurrency } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
  return { engine, settings, fetchImpl, calls: probe.calls }
}

function configOf(count: number, overrides: Partial<Sub2apiSyncConfig> = {}): Sub2apiSyncConfig {
  return {
    baseURL: INSTANCE,
    selectedKeys: Array.from({ length: count }, (_unused, index) => 100 + index),
    ...overrides,
  }
}

describe('sync orchestration', () => {
  it('overlaps the panel walk, the metadata index and the site probe', async () => {
    const log: string[] = []
    const { engine } = makeEngine({ keys: keysOf(1), panelMs: 80, loaderMs: 80, siteMs: 80, log })
    const startedAt = Date.now()
    const report = await engine.sync(configOf(1))
    const elapsed = Date.now() - startedAt

    // Three 80ms reads: serial ≈ 240ms (+discovery), overlapped ≈ 80ms.
    expect(elapsed).toBeLessThan(200)
    // All four reads were IN FLIGHT before any of them answered.
    expect(log.slice(0, 4).sort()).toEqual(['catalog', 'groups', 'keys:1', 'site'])
    expect(report.timing?.panelMs).toBeGreaterThanOrEqual(70)
    expect(report.timing?.catalogMs).toBeGreaterThanOrEqual(70)
  })

  it('discovers in bounded concurrency while keeping the report in selection order', async () => {
    const probe = modelsFetch({ latencyMs: 60 })
    const { engine } = makeEngine({ keys: keysOf(6), fetchImpl: probe.fetchImpl })
    const startedAt = Date.now()
    const report = await engine.sync(configOf(6))
    const elapsed = Date.now() - startedAt

    // 6 × 60ms serial = 360ms; two waves at the default fan-out ≈ 120ms.
    expect(probe.calls()).toBe(6)
    expect(elapsed).toBeLessThan(320)
    expect(probe.maxConcurrent()).toBeLessThanOrEqual(DISCOVERY_CONCURRENCY)
    expect(probe.maxConcurrent()).toBeGreaterThan(1)
    expect(report.entries.map((entry) => entry.keyId)).toEqual([100, 101, 102, 103, 104, 105])
    expect(report.entries.every((entry) => entry.action === 'created')).toBe(true)
  })

  it('reports per-phase timings inside the total', async () => {
    const { engine } = makeEngine({ keys: keysOf(2) })
    const startedAt = Date.now()
    const report = await engine.sync(configOf(2))
    const elapsed = Date.now() - startedAt
    const timing = report.timing
    expect(timing).toBeDefined()
    for (const value of [timing?.panelMs, timing?.catalogMs, timing?.discoveryMs, timing?.writeMs, timing?.totalMs]) {
      expect(typeof value).toBe('number')
      expect(value).toBeGreaterThanOrEqual(0)
    }
    expect(timing?.totalMs).toBeGreaterThanOrEqual((timing?.panelMs ?? 0) + (timing?.discoveryMs ?? 0))
    expect(timing?.totalMs).toBeLessThanOrEqual(elapsed + 10)
  })

  it('publishes the running phase, per-key counts, and goes idle afterwards', async () => {
    const settings = new RecordingSettings(60)
    // Staggered answers: key N finishes ~30ms after key N-1, so the per-key
    // counter advances one step at a time instead of landing in one burst.
    let started = 0
    const staggered = (async () => {
      const wave = ++started
      await sleep(wave * 30)
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }, { id: 'm2' }] }) } as unknown as Response
    }) as unknown as typeof fetch
    const { engine } = makeEngine({ keys: keysOf(3), settings, panelMs: 20, fetchImpl: staggered })
    const seen: Array<{ step: string; done: number; total: number }> = []
    const timer = setInterval(() => {
      const progress = engine.progress()
      if (progress !== undefined) seen.push({ step: progress.step, done: progress.done, total: progress.total })
    }, 2)
    try {
      await engine.sync(configOf(3))
    } finally {
      clearInterval(timer)
    }
    const steps = new Set(seen.map((entry) => entry.step))
    expect([...steps]).toEqual(expect.arrayContaining(['panel', 'models', 'write']))
    const modelFrames = seen.filter((entry) => entry.step === 'models')
    expect(modelFrames.every((entry) => entry.total === 3)).toBe(true)
    const counts = modelFrames.map((entry) => entry.done)
    // The LAST increment and the phase switch happen in the same tick, so a
    // poller may never observe `done === total`; it must observe the counter
    // advancing step by step up to it.
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(2)
    // Never walks backwards: the counter is monotonic within the phase.
    expect(counts).toEqual([...counts].sort((a, b) => a - b))
    expect(engine.progress()).toBeUndefined()
  })

  it('reuses a discovery answer inside the cache window and re-queries when it is off', async () => {
    const cached = makeEngine({ keys: keysOf(1) })
    await cached.engine.sync(configOf(1))
    await cached.engine.sync(configOf(1))
    expect(cached.calls()).toBe(1)

    const fresh = makeEngine({ keys: keysOf(1) })
    const config = configOf(1, { discoveryCacheSeconds: 0 })
    await fresh.engine.sync(config)
    await fresh.engine.sync(config)
    expect(fresh.calls()).toBe(2)
  })

  it('expires the discovery cache after its window', async () => {
    let clock = 1_000
    const probe = modelsFetch()
    const { engine } = makeEngine({ keys: keysOf(1), fetchImpl: probe.fetchImpl, now: () => clock })
    await engine.sync(configOf(1, { discoveryCacheSeconds: 60 }))
    clock += 30_000
    await engine.sync(configOf(1, { discoveryCacheSeconds: 60 }))
    expect(probe.calls()).toBe(1)
    clock += 31_000
    await engine.sync(configOf(1, { discoveryCacheSeconds: 60 }))
    expect(probe.calls()).toBe(2)
  })

  it('retries a rate-limited discovery once instead of failing the key', async () => {
    const probe = modelsFetch({ answers: [429, 200] })
    const { engine } = makeEngine({ keys: keysOf(1), fetchImpl: probe.fetchImpl })
    const report = await engine.sync(configOf(1, { discoveryCacheSeconds: 0 }))
    expect(report.entries[0]?.action).toBe('created')
    expect(report.entries[0]?.models).toBe(2)
    expect(probe.calls()).toBe(2)
  })

  it('skips the route→keyId commit when the map already matches', async () => {
    const settings = new RecordingSettings()
    const { engine } = makeEngine({ keys: keysOf(2), settings })
    await engine.sync(configOf(2))
    // providers + the route→keyId map
    expect(settings.commits).toBe(2)
    await engine.sync(configOf(2))
    // Nothing changed: no provider ops, no map ops — zero commits.
    expect(settings.commits).toBe(2)
  })
})

describe('mapWithConcurrency', () => {
  it('keeps input order and never exceeds the cap', async () => {
    let active = 0
    let peak = 0
    const order: number[] = []
    const results = await mapWithConcurrency([5, 4, 3, 2, 1], 2, async (item) => {
      active++
      peak = Math.max(peak, active)
      await sleep(5)
      active--
      order.push(item)
      return item * 10
    })
    expect(results).toEqual([50, 40, 30, 20, 10])
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(1)
    expect(order.length).toBe(5)
  })

  it('answers an empty input without starting a worker', async () => {
    let calls = 0
    const results = await mapWithConcurrency([], 4, async () => { calls++; return 1 })
    expect(results).toEqual([])
    expect(calls).toBe(0)
  })
})
describe('failure semantics', () => {
  it('keeps a previously synced route when that key fails this run', async () => {
    const settings = new RecordingSettings()
    const okProbe = modelsFetch()
    const first = makeEngine({ keys: keysOf(2), settings, fetchImpl: okProbe.fetchImpl })
    const created = await first.engine.sync(configOf(2))
    expect(created.entries.every((entry) => entry.action === 'created')).toBe(true)
    const route = created.entries[0].route
    expect(settings.providers[route]).toBeDefined()

    // Second run: key 100's discovery dies, key 101 stays fine.
    const flaky = modelsFetch({ answers: [500] })
    const second = makeEngine({ keys: keysOf(2), settings, fetchImpl: flaky.fetchImpl })
    const config = configOf(2, { discoveryCacheSeconds: 0 })
    const report = await second.engine.sync(config)

    const failed = report.entries.find((entry) => entry.keyId === 100)
    expect(failed?.action).toBe('failed')
    expect(failed?.error).toContain('模型发现失败')
    // THE POINT: the working route was not deleted by the failure.
    expect(settings.providers[route]).toBeDefined()
    expect(report.removed).toEqual([])
    expect(report.warnings.some((warning) => warning.includes('已保留上次写入的路由'))).toBe(true)
    // …and nothing ever asked to unset it.
    const unset = settings.mutations.flatMap((mutation) => mutation.ops).filter((op) => op.op === 'unset')
    expect(unset).toEqual([])
  })

  it('touches nothing when every selected key fails', async () => {
    const settings = new RecordingSettings()
    const seed = await makeEngine({ keys: keysOf(2), settings }).engine.sync(configOf(2))
    expect(seed.entries).toHaveLength(2)
    const commitsAfterSeed = settings.commits

    const dead = modelsFetch({ answers: [500, 500] })
    const { engine } = makeEngine({ keys: keysOf(2), settings, fetchImpl: dead.fetchImpl })
    const report = await engine.sync(configOf(2, { discoveryCacheSeconds: 0 }))
    expect(report.entries.every((entry) => entry.action === 'failed')).toBe(true)
    expect(report.writes).toBe(0)
    expect(report.removed).toEqual([])
    expect(settings.commits).toBe(commitsAfterSeed)
    expect(Object.keys(settings.providers)).toHaveLength(2)
  })

  it('still removes the route of a key dropped from the selection', async () => {
    const settings = new RecordingSettings()
    await makeEngine({ keys: keysOf(2), settings }).engine.sync(configOf(2))
    const dropped = routeForKey(INSTANCE, 101)
    expect(settings.providers[dropped]).toBeDefined()
    const report = await makeEngine({ keys: keysOf(2), settings }).engine.sync(configOf(1))
    expect(report.removed).toEqual([dropped])
    expect(settings.providers[dropped]).toBeUndefined()
    expect(Object.keys(settings.providers)).toHaveLength(1)
  })
})
describe('destructive-path guards', () => {
  it('refuses to sync when the panel lists no keys but the selection is not empty', async () => {
    const settings = new RecordingSettings()
    const seeded = await makeEngine({ keys: keysOf(2), settings }).engine.sync(configOf(2))
    expect(seeded.entries).toHaveLength(2)
    const commitsAfterSeed = settings.commits
    const routesBefore = Object.keys(settings.providers)

    // The panel answers an empty page (glitch, WAF page, wrong tenant…): every
    // selection would be "invalid", which used to remove every route.
    const blind = makeEngine({ keys: [], settings })
    await expect(blind.engine.sync(configOf(2))).rejects.toThrowError(/面板返回了 0 把 key/)

    expect(Object.keys(settings.providers)).toEqual(routesBefore)
    expect(settings.commits).toBe(commitsAfterSeed)
  })

  it('never removes routes on an empty selection', async () => {
    const settings = new RecordingSettings()
    await makeEngine({ keys: keysOf(2), settings }).engine.sync(configOf(2))
    const routesBefore = Object.keys(settings.providers)
    const commitsAfterSeed = settings.commits

    const report = await makeEngine({ keys: keysOf(2), settings }).engine.sync(configOf(0))
    expect(report.removed).toEqual([])
    expect(report.writes).toBe(0)
    expect(Object.keys(settings.providers)).toEqual(routesBefore)
    expect(settings.commits).toBe(commitsAfterSeed)
    expect(report.warnings.some((warning) => warning.includes('没有选中任何 key'))).toBe(true)
  })

  it('warns when a commit did not land in the settings section', async () => {
    class DroppingSettings extends RecordingSettings {
      drop = false
      override async mutate(ns: string, ops: SettingsPathOp[]): Promise<void> {
        if (this.drop) {
          // Accept the call but persist nothing — a host-side reload can do this.
          this.commits++
          return
        }
        await super.mutate(ns, ops)
      }
    }
    const settings = new DroppingSettings()
    settings.drop = true
    const report = await makeEngine({ keys: keysOf(1), settings }).engine.sync(configOf(1))
    expect(report.warnings.some((warning) => warning.includes('写入未落地'))).toBe(true)
  })
})
describe('registered (refresh) scope', () => {
  it('refreshes only the keys that already own a route', async () => {
    const settings = new RecordingSettings()
    await makeEngine({ keys: keysOf(3), settings }).engine.sync(configOf(2))
    expect(Object.keys(settings.providers)).toHaveLength(2)

    // The card now has THREE keys ticked; a refresh must not create the third.
    const refresh = await makeEngine({ keys: keysOf(3), settings }).engine.sync(configOf(3), undefined, 'registered')
    expect(refresh.entries.map((entry) => entry.keyId)).toEqual([100, 101])
    expect(refresh.removed).toEqual([])
    expect(Object.keys(settings.providers)).toHaveLength(2)
    expect(settings.providers[routeForKey(INSTANCE, 102)]).toBeUndefined()
  })

  it('never removes a route, even when the selection shrank', async () => {
    const settings = new RecordingSettings()
    await makeEngine({ keys: keysOf(2), settings }).engine.sync(configOf(2))
    const before = Object.keys(settings.providers).sort()
    // Both keys unticked — a refresh still re-validates both routes.
    const refresh = await makeEngine({ keys: keysOf(2), settings }).engine.sync(configOf(0), undefined, 'registered')
    expect(refresh.entries).toHaveLength(2)
    expect(refresh.removed).toEqual([])
    expect(Object.keys(settings.providers).sort()).toEqual(before)
  })

  it('refuses to run when nothing is registered', async () => {
    const settings = new RecordingSettings()
    await expect(makeEngine({ keys: keysOf(1), settings }).engine.sync(configOf(1), undefined, 'registered'))
      .rejects.toThrowError(/没有已注册的路由可刷新/)
  })
})
