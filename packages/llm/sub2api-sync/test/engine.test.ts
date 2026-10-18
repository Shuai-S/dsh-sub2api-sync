import { describe, expect, it } from 'vitest'
import { PI_AI_NS, createSyncReportStore, resolveTargets, Sub2apiSyncEngine, type SettingsPathOp, type SettingsLike, type SyncReport } from '../src/engine.ts'
import type { Sub2apiSyncConfig } from '../src/config.ts'
import type { PanelGateway, PanelGroup, PanelKey } from '../src/panel.ts'
import { legacyKeyRef, routeForKey, routeKeyRef } from '../src/types.ts'

/** The instance address every config() below uses; routes derive from it. */
const INSTANCE = 'http://gw:8080'
/** Route + credential ref for the standard test key (id 5) under INSTANCE. */
const ROUTE = routeForKey(INSTANCE, 5)
const REF = routeKeyRef(ROUTE)

/**
 * Settings double: per-namespace documents with generic path-op application
 * (the engine writes both `llm-pi-ai.providers` and its own `groups.*.keyId`),
 * with conflict injection scoped to the namespace revision.
 */
class FakeSettings implements SettingsLike {
  docs: Record<string, Record<string, unknown>> = {
    'llm-pi-ai': { providers: {} },
    'sub2api-sync': {},
  }
  revisions: Record<string, number> = { 'llm-pi-ai': 7, 'sub2api-sync': 1 }
  registered = true
  operations: Array<{ ns: string; ops: SettingsPathOp[]; expectedRevision?: number }> = []
  /** When set, the next N mutate calls throw a conflict instead of applying. */
  conflictTimes = 0

  describe(): Array<{ ns: string; revision: number; value?: unknown }> {
    const descriptors: Array<{ ns: string; revision: number; value?: unknown }> = []
    if (this.registered) {
      descriptors.push({ ns: 'llm-pi-ai', revision: this.revisions['llm-pi-ai'] ?? 0, value: structuredClone(this.docs['llm-pi-ai']) })
    }
    descriptors.push({ ns: 'sub2api-sync', revision: this.revisions['sub2api-sync'] ?? 0, value: structuredClone(this.docs['sub2api-sync']) })
    return descriptors
  }

  async mutate(ns: string, ops: SettingsPathOp[], expectedRevision?: number): Promise<void> {
    const current = this.revisions[ns] ?? 0
    if (expectedRevision !== undefined && expectedRevision !== current) {
      throw conflictError(expectedRevision, current)
    }
    if (this.conflictTimes > 0) {
      this.conflictTimes--
      this.revisions[ns] = current + 1
      throw conflictError(expectedRevision ?? current, current + 1)
    }
    this.operations.push({ ns, ops, expectedRevision })
    const doc = this.docs[ns] ?? (this.docs[ns] = {})
    for (const op of ops) applyPath(doc, op)
    this.revisions[ns] = current + 1
  }

  get providers(): Record<string, unknown> {
    return this.docs['llm-pi-ai'].providers as Record<string, unknown>
  }

  get own(): Record<string, unknown> {
    return this.docs['sub2api-sync']
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

function conflictError(expected: number, actual: number): Error {
  const error = new Error(`conflict: expected ${expected}, actual ${actual}`) as Error & { code: string; name: string }
  error.name = 'SettingsConflictError'
  error.code = 'SETTINGS_CONFLICT'
  return error
}

class FakeCredentials {
  private store = new Map<string, string>()
  unsetCalls: string[] = []

  seed(ref: string, value: string): void {
    this.store.set(ref, value)
  }

  get(ref: string): string | undefined {
    return this.store.get(ref)
  }

  async resolve(ref: string): Promise<{ value: string } | undefined> {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value }
  }

  async set(ref: string, value: string): Promise<void> {
    this.store.set(ref, value)
  }

  async unset(ref: string): Promise<void> {
    this.unsetCalls.push(ref)
    this.store.delete(ref)
  }
}

/** Scripted panel gateway: groups/keys arrays, creation/deletion recorded. */
class FakeGateway {
  signedIn = true
  groups: PanelGroup[]
  keys: PanelKey[]
  created: Array<{ name: string; groupId: number }> = []
  deletedIds: number[] = []
  /** Plaintext answers for the controlled reveal endpoint, by key id. */
  revealed = new Map<number, string>()
  /** When set, reveal rejects with this error (e.g. key not client-owned). */
  revealError: Error | undefined
  private nextKeyId = 100

  constructor(groups: PanelGroup[] = [], keys: PanelKey[] = []) {
    this.groups = groups
    this.keys = keys
  }

  use<T>(fn: (panel: {
    listAvailableGroups(token: string): Promise<PanelGroup[]>
    listKeys(token: string, options?: { groupId?: number; page?: number; pageSize?: number }): Promise<{ items: PanelKey[]; total: number; pages: number }>
    createKey(token: string, input: { name: string; groupId: number; quota?: number; expiresinDays?: number }): Promise<PanelKey>
    deleteKey(token: string, id: number): Promise<void>
    revealKey(token: string, id: number): Promise<{ key: string }>
  }, token: string) => Promise<T>): Promise<T> {
    if (!this.signedIn) return Promise.reject(new Error('sub2api-sync: 尚未登录 sub2api 面板——请先在设置卡完成登录'))
    const panel = {
      listAvailableGroups: async (_token: string) => structuredClone(this.groups),
      listKeys: async (_token: string, options?: { groupId?: number; page?: number; pageSize?: number }) => {
        const filtered = this.keys.filter((key) => options?.groupId === undefined || key.groupId === options.groupId)
        const pageSize = options?.pageSize ?? 100
        const pageIndex = (options?.page ?? 1) - 1
        return {
          items: structuredClone(filtered.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize)),
          total: filtered.length,
          pages: Math.max(1, Math.ceil(filtered.length / pageSize)),
        }
      },
      createKey: async (_token: string, input: { name: string; groupId: number; quota?: number; expiresinDays?: number }) => {
        this.created.push({ name: input.name, groupId: input.groupId })
        const key: PanelKey = { id: this.nextKeyId++, name: input.name, groupId: input.groupId, key: `sk-created-${this.nextKeyId}`, status: 'active' }
        this.keys.push(key)
        return structuredClone(key)
      },
      deleteKey: async (_token: string, id: number) => {
        this.deletedIds.push(id)
        this.keys = this.keys.filter((key) => key.id !== id)
      },
      revealKey: async (_token: string, id: number) => {
        if (this.revealError !== undefined) throw this.revealError
        const value = this.revealed.get(id)
        if (value === undefined) throw new Error('key not client-owned')
        return { key: value }
      },
    }
    return fn(panel, 'test-token')
  }
}

function asGateway(fake: FakeGateway): PanelGateway {
  return fake as unknown as PanelGateway
}

function fetchAnswering(payload: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }) as Response) as typeof fetch
}

/** Status/payload script consumed in order; records each call's bearer token. */
function fetchScripted(answers: Array<{ status: number; payload: unknown }>): { fetchImpl: typeof fetch; tokens: string[] } {
  const tokens: string[] = []
  const queue = [...answers]
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    tokens.push(String(new Headers(init?.headers).get('authorization') ?? ''))
    const answer = queue.shift() ?? { status: 500, payload: {} }
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.payload,
    } as Response
  }) as typeof fetch
  return { fetchImpl, tokens }
}


const CLAUDE_GROUP: PanelGroup = {
  id: 1,
  name: 'Claude 拼车',
  platform: 'anthropic',
  rateMultiplier: 0.2,
  status: 'active',
}

function makeEngine(options: {
  settings?: FakeSettings
  credentials?: FakeCredentials
  gateway?: FakeGateway
  fetchImpl?: typeof fetch
  modelIndex?: Map<string, { name?: string; contextWindow?: number; maxTokens?: number; imageInput?: boolean; reasoningEfforts?: Record<string, string | null> }>
  siteName?: () => Promise<string | undefined>
} = {}): { engine: Sub2apiSyncEngine; settings: FakeSettings; credentials: FakeCredentials; gateway: FakeGateway } {
  const settings = options.settings ?? new FakeSettings()
  const credentials = options.credentials ?? new FakeCredentials()
  const gateway = options.gateway ?? new FakeGateway([structuredClone(CLAUDE_GROUP)], [])
  const engine = new Sub2apiSyncEngine({
    settings,
    credentials,
    gateway: asGateway(gateway),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.siteName !== undefined ? { siteName: options.siteName } : {}),
    // Hermetic by default: no network fetch for the C4 enrichment.
    loadModelIndex: async () => options.modelIndex ?? new Map(),
  })
  return { engine, settings, credentials, gateway }
}

function config(overrides: Partial<Sub2apiSyncConfig> = {}): Sub2apiSyncConfig {
  return {
    baseURL: 'http://gw:8080',
    selectedKeys: [1],
    ...overrides,
  }
}

describe('resolveTargets', () => {
  it('maps selected key ids to panel key rows and reports missing ones', () => {
    const keyRows: PanelKey[] = [
      { id: 5, name: 'Claude 拼车', groupId: 1, key: 'sk-5' },
      { id: 9, name: 'GPT', groupId: 2, key: 'sk-9' },
    ]
    const targets = resolveTargets(config({ selectedKeys: [5, 99] }), keyRows)
    expect(targets).toEqual([
      { key: keyRows[0] },
      { invalid: 99, error: expect.stringMatching(/面板不存在/) },
    ])
  })
})

describe('Sub2apiSyncEngine.sync', () => {
  const KEYS = [{ id: 5, name: 'Claude 拼车', groupId: 1, key: 'sk-5' }]

  it('syncs one selected key into its own provider route and stores its credential', async () => {
    const { engine, settings, credentials, gateway } = makeEngine({
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      gateway: new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS)),
    })

    const report = await engine.sync(config({ selectedKeys: [5] }))

    expect(gateway.created).toEqual([])
    expect(credentials.get(REF)).toBe('sk-5')
    expect(report.writes).toBe(1)
    expect(report.entries).toEqual([
      { groupId: 1, route: ROUTE, keyId: 5, displayName: 'sub2api(Claude 拼车)', action: 'created', models: 1 },
    ])
    const profile = settings.providers[ROUTE] as { apiKeyEnv: string; displayName: string }
    expect(profile.apiKeyEnv).toBe(REF)
    expect(profile.displayName).toBe('sub2api(Claude 拼车)')
    // The route must not leak the panel's sequential key id.
    expect(ROUTE).toMatch(/^sub2api-[0-9a-f]{10}$/)
    expect(ROUTE).not.toContain('5')
  })

  it('warns in the report when the site-name probe fails and the fallback name is used', async () => {
    const { engine } = makeEngine({
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      gateway: new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS)),
      siteName: async () => undefined,
    })
    const report = await engine.sync(config({ selectedKeys: [5], providerNameTemplate: '{siteName}({keyName})' }))
    expect(report.warnings.some((w) => w.includes('回退名 sub2api'))).toBe(true)
    expect(report.entries[0]).toMatchObject({ displayName: 'sub2api(Claude 拼车)' })
  })

  it('renders the probed site name and stays silent when the probe resolves', async () => {
    const { engine } = makeEngine({
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      gateway: new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS)),
      siteName: async () => '我的中转',
    })
    const report = await engine.sync(config({ selectedKeys: [5], providerNameTemplate: '{siteName}({keyName})' }))
    expect(report.warnings).toEqual([])
    expect(report.entries[0]).toMatchObject({ displayName: '我的中转(Claude 拼车)' })
  })

  it('is idempotent: the second sync writes nothing and keeps the same key', async () => {
    const { engine, settings, credentials } = makeEngine({
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      gateway: new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS)),
    })
    await engine.sync(config({ selectedKeys: [5] }))
    const report = await engine.sync(config({ selectedKeys: [5] }))
    expect(report.writes).toBe(0)
    expect(report.entries[0]).toMatchObject({ route: ROUTE, action: 'unchanged' })
    expect(credentials.get(REF)).toBe('sk-5')
    expect(Object.keys(settings.providers)).toEqual([ROUTE])
  })

  it('fails a selected key the panel no longer serves', async () => {
    const { engine } = makeEngine({
      gateway: new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS)),
    })
    const report = await engine.sync(config({ selectedKeys: [999] }))
    expect(report.entries[0]).toMatchObject({ action: 'failed' })
    expect(report.entries[0].error).toContain('面板不存在')
    // The invalid flag is what lets the card auto-drop the stale selection.
    expect(report.entries[0].invalid).toBe(true)
  })

  it('reports a group whose platform has no protocol mapping', async () => {
    const gateway = new FakeGateway([{ id: 1, name: 'Coze 组', platform: 'coze' }], [{ id: 5, name: 'k', groupId: 1, key: 'sk-5' }])
    const { engine } = makeEngine({ gateway })
    const report = await engine.sync(config({ selectedKeys: [5] }))
    expect(report.entries[0]).toMatchObject({ action: 'failed' })
    expect(report.entries[0].error).toContain('没有协议映射')
  })

  it('migrates plaintext from the legacy key-id ref when the panel masks the row', async () => {
    const { engine, settings, credentials } = makeEngine({
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      credentials: (() => {
        const creds = new FakeCredentials()
        creds.set(legacyKeyRef(5), 'sk-stored')
        return creds
      })(),
      gateway: new FakeGateway([structuredClone(CLAUDE_GROUP)], [{ id: 5, name: 'Claude 拼车', groupId: 1 }]),
    })
    const report = await engine.sync(config({ selectedKeys: [5] }))
    expect(report.writes).toBe(1)
    expect((settings.providers[ROUTE] as { apiKeyEnv: string }).apiKeyEnv).toBe(REF)
    // The legacy value is re-persisted under the new slug ref.
    expect(credentials.get(REF)).toBe('sk-stored')
  })

  it('removes routes and credentials for keys that left the selection', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS))
    const { engine, settings, credentials } = makeEngine({
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      gateway,
    })
    await engine.sync(config({ selectedKeys: [5] }))
    const report = await engine.sync(config({ selectedKeys: [] }))
    expect(report.removed).toEqual([ROUTE])
    expect(Object.keys(settings.providers)).toEqual([])
    expect(credentials.get(REF)).toBeUndefined()
  })

  it('revokes the remote key of a removed route via the slug reverse map', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS))
    const { engine } = makeEngine({
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      gateway,
    })
    await engine.sync(config({ selectedKeys: [5], deleteOrphanKeys: true }))
    expect(gateway.deletedIds).toEqual([])
    await engine.sync(config({ selectedKeys: [], deleteOrphanKeys: true }))
    expect(gateway.deletedIds).toEqual([5])
  })

  it('cleans up a legacy digit route (and its ref) on the migration sync', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS))
    const settings = new FakeSettings()
    settings.docs['llm-pi-ai'].providers = { 'sub2api-5': { displayName: 'legacy', api: 'anthropic-messages' } }
    const credentials = new FakeCredentials()
    credentials.seed(legacyKeyRef(5), 'sk-legacy')
    const { engine } = makeEngine({
      settings,
      credentials,
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      gateway,
    })
    await engine.sync(config({ selectedKeys: [5] }))
    // The stale legacy entry is gone; the new slug route replaced it.
    expect(settings.providers['sub2api-5']).toBeUndefined()
    expect(settings.providers[ROUTE]).toBeDefined()
    expect(credentials.unsetCalls).toContain(legacyKeyRef(5))
  })

  it('honors protocolOverrides keyed by group id', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS))
    const { engine, settings } = makeEngine({
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      gateway,
    })
    await engine.sync(config({ selectedKeys: [5], protocolOverrides: { '1': 'openai-completions' } }))
    expect((settings.providers[ROUTE] as { api: string }).api).toBe('openai-completions')
  })

  it('enriches model capacity facts from the metadata index (C4)', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS))
    const modelIndex = new Map([
      ['claude-x', { name: 'Claude X 4.5', contextWindow: 200000, maxTokens: 64000, imageInput: true }],
    ])
    const { engine, settings } = makeEngine({
      gateway,
      modelIndex,
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }, { id: 'unknown-model' }] }),
    })
    await engine.sync(config({ selectedKeys: [5] }))
    const profile = settings.providers[ROUTE] as { models: Array<Record<string, unknown>> }
    expect(profile.models[0]).toEqual({
      id: 'claude-x',
      name: 'Claude X 4.5',
      contextWindow: 200000,
      maxTokens: 64000,
      input: ['text', 'image'],
    })
    // No index match → no name either; the id stays the display name.
    expect(Object.keys(profile.models[1])).toEqual(['id'])
  })

  it('auto-fills per-model reasoning efforts and lets the template override (C4)', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS))
    const modelIndex = new Map([
      ['claude-x', { contextWindow: 200000, reasoningEfforts: { off: null, low: 'low', high: 'high' } }],
    ])
    const { engine, settings } = makeEngine({
      gateway,
      modelIndex,
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }, { id: 'plain-model' }] }),
    })
    // Auto fill lands on the matching model only; the template stays untouched.
    await engine.sync(config({ selectedKeys: [5] }))
    const profile = settings.providers[ROUTE] as { models: Array<Record<string, unknown>> }
    expect(profile.models[0].reasoningEfforts).toEqual({ off: null, low: 'low', high: 'high' })
    expect(profile.models[1]).not.toHaveProperty('reasoningEfforts')

    // An explicit template (map) wins on the next idempotent recompute.
    await engine.sync(config({ selectedKeys: [5], compatTemplate: { reasoningEfforts: { high: 'ultra' } } }))
    const overridden = settings.providers[ROUTE] as { models: Array<Record<string, unknown>> }
    expect(overridden.models[0].reasoningEfforts).toEqual({ high: 'ultra' })

    // And an explicit template false declares every model non-reasoning.
    await engine.sync(config({ selectedKeys: [5], compatTemplate: { reasoningEfforts: false } }))
    const disabled = settings.providers[ROUTE] as { models: Array<Record<string, unknown>> }
    expect(disabled.models[0].reasoningEfforts).toBe(false)
  })

  it('writes the template default effort only when every model supports it', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS))
    const modelIndex = new Map([
      ['claude-x', { contextWindow: 200000, reasoningEfforts: { off: null, low: 'low', high: 'high' } }],
    ])
    const { engine, settings } = makeEngine({
      gateway, modelIndex,
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
    })
    // 'low' is in the model's map → the provider default is written.
    await engine.sync(config({ selectedKeys: [5], compatTemplate: { reasoning: 'low' } }))
    expect((settings.providers[ROUTE] as { reasoning?: string }).reasoning).toBe('low')

    // 'medium' is not → the provider default is stripped and the report says so.
    const report = await engine.sync(config({ selectedKeys: [5], compatTemplate: { reasoning: 'medium' } }))
    expect((settings.providers[ROUTE] as { reasoning?: string }).reasoning).toBeUndefined()
    expect(report.warnings.some((w) => w.includes('compatTemplate.reasoning=medium'))).toBe(true)
  })

  it('strips the default effort when a model has no effort metadata at all', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS))
    const { engine, settings } = makeEngine({
      gateway,
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }, { id: 'plain-model' }] }),
    })
    const report = await engine.sync(config({ selectedKeys: [5], compatTemplate: { reasoning: 'high' } }))
    expect((settings.providers[ROUTE] as { reasoning?: string }).reasoning).toBeUndefined()
    expect(report.warnings.join('\n')).toContain('2 个模型不支持')
  })

  it('retries on a settings conflict after re-reading and recomputing', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS))
    const settings = new FakeSettings()
    let conflicts = 0
    const original = settings.mutate.bind(settings)
    settings.mutate = (ns: string, ops: SettingsPathOp[], revision?: number) => {
      if (ns === PI_AI_NS && conflicts < 2) {
        conflicts++
        throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' })
      }
      return original(ns, ops, revision)
    }
    const { engine } = makeEngine({
      settings,
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      gateway,
    })
    const report = await engine.sync(config({ selectedKeys: [5] }))
    expect(conflicts).toBe(2)
    expect(report.attempts).toBe(3)
    expect(report.writes).toBeGreaterThan(0)
  })

  it('serializes concurrent syncs on one queue', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS))
    // A gated fetch pins the first sync in-flight while the second queues.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const inner = fetchAnswering({ data: [{ id: 'claude-x' }] })
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      gate.then(() => inner(input, init))) as unknown as typeof fetch
    const { engine } = makeEngine({ fetchImpl, gateway })

    const first = engine.sync(config({ selectedKeys: [5] }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(engine.isRunning()).toBe(true)
    const second = engine.sync(config({ selectedKeys: [5] }))
    expect(engine.isRunning()).toBe(true)
    release()
    await Promise.all([first, second])
    expect(engine.isRunning()).toBe(false)
  })
})

describe('createSyncReportStore', () => {
  const report: SyncReport = { entries: [], removed: [], writes: 1, attempts: 1, warnings: [] }

  it('starts empty, records with a wall-clock time, and replaces on the next record', () => {
    const store = createSyncReportStore()
    expect(store.report()).toBeUndefined()
    expect(store.at()).toBeUndefined()

    store.record(report)
    expect(store.report()).toBe(report)
    expect(store.at()).toBeGreaterThan(0)

    const next: SyncReport = { entries: [], removed: ['sub2api-x'], writes: 2, attempts: 1, warnings: [] }
    store.record(next)
    expect(store.report()).toBe(next)
  })

  it('clear() wipes both the report and its timestamp (purge semantics)', () => {
    const store = createSyncReportStore()
    store.record(report)
    store.clear()
    expect(store.report()).toBeUndefined()
    expect(store.at()).toBeUndefined()
    // A later sync records fresh again after the purge.
    store.record(report)
    expect(store.report()).toBe(report)
    expect(store.at()).toBeGreaterThan(0)
  })
})
describe('discovery 401 self-heal', () => {
  const MASKED_ROW = { id: 5, name: 'Claude 拼车', groupId: 1, key: 'sk-1****abcd' }
  const LEGACY_REF = 'DSH_SUB2API_KEY_5'

  it('drops a stale legacy credential and recovers through reveal', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], [{ ...MASKED_ROW }])
    gateway.revealed.set(5, 'sk-fresh')
    const credentials = new FakeCredentials()
    credentials.seed(LEGACY_REF, 'sk-legacy-old')
    const { fetchImpl, tokens } = fetchScripted([
      { status: 401, payload: { code: 'INVALID_API_KEY', message: 'Invalid API key' } },
      { status: 200, payload: { data: [{ id: 'claude-x' }] } },
    ])
    const { engine, settings } = makeEngine({ fetchImpl, gateway, credentials })

    const report = await engine.sync(config({ selectedKeys: [5] }))

    expect(report.entries[0]).toMatchObject({ route: ROUTE, action: 'created', models: 1 })
    expect(tokens[0]).toBe('Bearer sk-legacy-old')
    expect(tokens[1]).toBe('Bearer sk-fresh')
    // The validated value is persisted under the slug ref; the poisoned
    // instance-less legacy ref is gone.
    expect(credentials.get(REF)).toBe('sk-fresh')
    expect(credentials.get(LEGACY_REF)).toBeUndefined()
    expect(credentials.unsetCalls).toContain(LEGACY_REF)
    expect(Object.keys(settings.providers)).toEqual([ROUTE])
  })

  it('rejects a masked stored value at any chain step and still reaches reveal', async () => {
    // An ancient build persisted a masked row into the legacy ref; today the
    // panel blanks the key field entirely. The chain must not stop there.
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], [{ id: 5, name: 'Claude 拼车', groupId: 1, key: '' }])
    gateway.revealed.set(5, 'sk-fresh')
    const credentials = new FakeCredentials()
    credentials.seed(LEGACY_REF, 'sk-1****abcd')
    const { fetchImpl, tokens } = fetchScripted([
      { status: 200, payload: { data: [{ id: 'claude-x' }] } },
    ])
    const { engine } = makeEngine({ fetchImpl, gateway, credentials })

    const report = await engine.sync(config({ selectedKeys: [5] }))

    expect(report.entries[0]).toMatchObject({ route: ROUTE, action: 'created', models: 1 })
    expect(tokens[0]).toBe('Bearer sk-fresh')
    expect(credentials.get(LEGACY_REF)).toBeUndefined()
    expect(credentials.get(REF)).toBe('sk-fresh')
  })

  it('gives up loudly when reveal cannot replace the dropped credential', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], [{ ...MASKED_ROW }])
    gateway.revealError = new Error('key not client-owned')
    const credentials = new FakeCredentials()
    credentials.seed(LEGACY_REF, 'sk-legacy-old')
    const { fetchImpl } = fetchScripted([
      { status: 401, payload: { code: 'INVALID_API_KEY', message: 'Invalid API key' } },
    ])
    const { engine } = makeEngine({ fetchImpl, gateway, credentials })

    // Per-key failures land in the report, not as a rejected sync.
    const report = await engine.sync(config({ selectedKeys: [5] }))
    expect(report.entries[0]).toMatchObject({ action: 'failed' })
    expect(report.entries[0].error).toContain('本地存底已作废，但 reveal 也失败：key not client-owned')
    expect(credentials.get(LEGACY_REF)).toBeUndefined()
  })

  it('keeps the original failure for non-401 discovery errors (no invalidation)', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], [{ ...MASKED_ROW }])
    const credentials = new FakeCredentials()
    credentials.seed(REF, 'sk-stored')
    const { fetchImpl } = fetchScripted([
      { status: 403, payload: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient account balance' } },
    ])
    const { engine } = makeEngine({ fetchImpl, gateway, credentials })

    const report = await engine.sync(config({ selectedKeys: [5] }))
    expect(report.entries[0]).toMatchObject({ action: 'failed' })
    expect(report.entries[0].error).toContain('HTTP 403（INSUFFICIENT_BALANCE: Insufficient account balance）')
    expect(report.entries[0].error).not.toContain('本地存底已作废')
    expect(credentials.get(REF)).toBe('sk-stored')
    expect(credentials.unsetCalls).toEqual([])
  })
})

describe('routeKeyIds map', () => {
  const KEYS_FIXTURE = [{ id: 5, name: 'Claude 拼车', groupId: 1, key: 'sk-5' }]

  it('records route → keyId on success and unsets it when the route is removed', async () => {
    const { engine, settings } = makeEngine({
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      gateway: new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS_FIXTURE)),
    })

    await engine.sync(config({ selectedKeys: [5] }))
    expect((settings.docs['sub2api-sync'] as Record<string, unknown>).routeKeyIds).toEqual({ [ROUTE]: 5 })

    // Drop the key from the selection → route removed → map entry gone.
    await engine.sync(config({ selectedKeys: [] }))
    expect((settings.docs['sub2api-sync'] as Record<string, unknown>).routeKeyIds).toEqual({})
  })
})
