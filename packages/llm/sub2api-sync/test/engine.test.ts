import { describe, expect, it } from 'vitest'
import { PI_AI_NS, resolveTargets, Sub2apiSyncEngine, type SettingsPathOp, type SettingsLike } from '../src/engine.ts'
import type { Sub2apiSyncConfig } from '../src/config.ts'
import type { PanelGateway, PanelGroup, PanelKey } from '../src/panel.ts'

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
  }, token: string) => Promise<T>): Promise<T> {
    if (!this.signedIn) return Promise.reject(new Error('sub2api-sync: 尚未登录 sub2api 面板——请先在设置卡完成登录或粘贴 PAT'))
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
  modelIndex?: Map<string, { contextWindow?: number; maxTokens?: number; imageInput?: boolean }>
} = {}): { engine: Sub2apiSyncEngine; settings: FakeSettings; credentials: FakeCredentials; gateway: FakeGateway } {
  const settings = options.settings ?? new FakeSettings()
  const credentials = options.credentials ?? new FakeCredentials()
  const gateway = options.gateway ?? new FakeGateway([structuredClone(CLAUDE_GROUP)], [])
  const engine = new Sub2apiSyncEngine({
    settings,
    credentials,
    gateway: asGateway(gateway),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
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
    expect(credentials.get('DSH_SUB2API_KEY_5')).toBe('sk-5')
    expect(report.writes).toBe(1)
    expect(report.entries).toEqual([
      { groupId: 1, route: 'sub2api-5', displayName: 'NexaRelay(Claude 拼车)', action: 'created', models: 1 },
    ])
    const profile = settings.providers['sub2api-5'] as { apiKeyEnv: string; displayName: string }
    expect(profile.apiKeyEnv).toBe('DSH_SUB2API_KEY_5')
    expect(profile.displayName).toBe('NexaRelay(Claude 拼车)')
  })

  it('is idempotent: the second sync writes nothing and keeps the same key', async () => {
    const { engine, settings, credentials } = makeEngine({
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      gateway: new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS)),
    })
    await engine.sync(config({ selectedKeys: [5] }))
    const report = await engine.sync(config({ selectedKeys: [5] }))
    expect(report.writes).toBe(0)
    expect(report.entries[0]).toMatchObject({ route: 'sub2api-5', action: 'unchanged' })
    expect(credentials.get('DSH_SUB2API_KEY_5')).toBe('sk-5')
    expect(Object.keys(settings.providers)).toEqual(['sub2api-5'])
  })

  it('fails a selected key the panel no longer serves', async () => {
    const { engine } = makeEngine({
      gateway: new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS)),
    })
    const report = await engine.sync(config({ selectedKeys: [999] }))
    expect(report.entries[0]).toMatchObject({ action: 'failed' })
    expect(report.entries[0].error).toContain('面板不存在')
  })

  it('reports a group whose platform has no protocol mapping', async () => {
    const gateway = new FakeGateway([{ id: 1, name: 'Coze 组', platform: 'coze' }], [{ id: 5, name: 'k', groupId: 1, key: 'sk-5' }])
    const { engine } = makeEngine({ gateway })
    const report = await engine.sync(config({ selectedKeys: [5] }))
    expect(report.entries[0]).toMatchObject({ action: 'failed' })
    expect(report.entries[0].error).toContain('没有协议映射')
  })

  it('falls back to the stored credential when the panel masks the plaintext', async () => {
    const { engine, settings, credentials } = makeEngine({
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      credentials: (() => {
        const creds = new FakeCredentials()
        creds.set('DSH_SUB2API_KEY_5', 'sk-stored')
        return creds
      })(),
      gateway: new FakeGateway([structuredClone(CLAUDE_GROUP)], [{ id: 5, name: 'Claude 拼车', groupId: 1 }]),
    })
    const report = await engine.sync(config({ selectedKeys: [5] }))
    expect(report.writes).toBe(1)
    expect((settings.providers['sub2api-5'] as { apiKeyEnv: string }).apiKeyEnv).toBe('DSH_SUB2API_KEY_5')
    expect(credentials.get('DSH_SUB2API_KEY_5')).toBe('sk-stored')
  })

  it('removes routes and credentials for keys that left the selection', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS))
    const { engine, settings, credentials } = makeEngine({
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      gateway,
    })
    await engine.sync(config({ selectedKeys: [5] }))
    const report = await engine.sync(config({ selectedKeys: [] }))
    expect(report.removed).toEqual(['sub2api-5'])
    expect(Object.keys(settings.providers)).toEqual([])
    expect(credentials.get('DSH_SUB2API_KEY_5')).toBeUndefined()
  })

  it('honors protocolOverrides keyed by group id', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS))
    const { engine, settings } = makeEngine({
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }] }),
      gateway,
    })
    await engine.sync(config({ selectedKeys: [5], protocolOverrides: { '1': 'openai-completions' } }))
    expect((settings.providers['sub2api-5'] as { api: string }).api).toBe('openai-completions')
  })

  it('enriches model capacity facts from the metadata index (C4)', async () => {
    const gateway = new FakeGateway([structuredClone(CLAUDE_GROUP)], structuredClone(KEYS))
    const modelIndex = new Map([
      ['claude-x', { contextWindow: 200000, maxTokens: 64000, imageInput: true }],
    ])
    const { engine, settings } = makeEngine({
      gateway,
      modelIndex,
      fetchImpl: fetchAnswering({ data: [{ id: 'claude-x' }, { id: 'unknown-model' }] }),
    })
    await engine.sync(config({ selectedKeys: [5] }))
    const profile = settings.providers['sub2api-5'] as { models: Array<Record<string, unknown>> }
    expect(profile.models[0]).toEqual({
      id: 'claude-x',
      contextWindow: 200000,
      maxTokens: 64000,
      input: ['text', 'image'],
    })
    expect(Object.keys(profile.models[1])).toEqual(['id'])
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