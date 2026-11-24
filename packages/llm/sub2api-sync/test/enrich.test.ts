import { describe, expect, it } from 'vitest'
import { bundledIndex, displayNameOf, loadModelIndex, modelIndexForSync, parseCatalog, parseSnapshot, peekModelIndex, refreshModelIndex, resetCaches, resolveCapacityFact } from '../src/enrich.ts'

const SNAPSHOT = JSON.stringify({
  generatedAt: '2026-09-30',
  source: 'https://models.dev/api.json',
  models: {
    'claude-x': [200000, 64000, 1, 1],
    'text-only': [128000, 8192, 0, 0],
    'no-capacity': [undefined, undefined, 1, 0],
    // 5-tuple: resolved effort levels ('none' = pi-ai off).
    'glm-y': [230000, 32000, 0, 1, ['none', 'high', 'max']],
    // An entry whose only fact is the effort resolution.
    'effort-only': [undefined, undefined, 0, 0, ['low']],
    // 6-tuple: display name rides as the sixth element.
    'named-x': [200000, 64000, 0, 0, undefined, 'Claude X 4.5'],
  },
})

const CATALOG = {
  anthropic: {
    models: {
      'claude-x': { limit: { context: 200000, output: 64000 }, modalities: { input: ['text', 'image'] }, reasoning: true },
    },
  },
  openai: {
    models: {
      // Same id under another provider: merge keeps the larger context.
      'claude-x': { limit: { context: 1000000, output: 32000 }, attachment: true, reasoning: false },
      'gpt-4o': { limit: { context: 128000, output: 16384 }, modalities: { input: ['text', 'image'] } },
    },
  },
}

describe('parseSnapshot', () => {
  it('reads the tuple format and guards positive capacities', () => {
    const index = parseSnapshot(SNAPSHOT)
    expect(index.get('claude-x')).toEqual({ contextWindow: 200000, maxTokens: 64000, imageInput: true, reasoningModel: true })
    expect(index.get('text-only')).toEqual({ contextWindow: 128000, maxTokens: 8192 })
    expect(index.get('no-capacity')).toEqual({ imageInput: true })
    // 4-tuples predate the efforts enrichment: no reasoningEfforts key at all.
    expect(index.get('claude-x')).not.toHaveProperty('reasoningEfforts')
  })

  it('resolves the fifth tuple element into the pi-ai efforts map', () => {
    const index = parseSnapshot(SNAPSHOT)
    expect(index.get('glm-y')).toEqual({
      contextWindow: 230000,
      maxTokens: 32000,
      reasoningModel: true,
      reasoningEfforts: { off: null, high: 'high', max: 'max' },
    })
    expect(index.get('effort-only')).toEqual({ reasoningEfforts: { low: 'low' } })
  })

  it('resolves the sixth tuple element into the display name', () => {
    const index = parseSnapshot(SNAPSHOT)
    expect(index.get('named-x')).toEqual({ contextWindow: 200000, maxTokens: 64000, name: 'Claude X 4.5' })
    // Older tuples predate the name enrichment: no name key at all.
    expect(index.get('claude-x')).not.toHaveProperty('name')
  })

  it('tolerates a malformed snapshot', () => {
    expect(parseSnapshot('not json').size).toBe(0)
    expect(parseSnapshot('{"models": null}').size).toBe(0)
  })
})

describe('parseCatalog', () => {
  it('resolves cross-provider duplicates by capacity policy, ORs the flags', () => {
    const index = parseCatalog(CATALOG)
    // Both providers here are first-party (anthropic, openai); the vendor's own
    // numbers, not the optimistic duplicate, decide (200000 / 64000).
    // Both duplicates are first-party providers here (anthropic + openai), so
    // there is no "vendor" to prefer between them: the contract resolves the
    // disagreement conservatively (lower median) while ORing the flags.
    expect(index.get('claude-x')).toEqual({
      contextWindow: 200000,
      maxTokens: 32000,
      imageInput: true,
      reasoningModel: true,
    })
    expect(index.get('gpt-4o')).toEqual({ contextWindow: 128000, maxTokens: 16384, imageInput: true })
  })

  it('never lets one optimistic aggregator inflate a route', () => {
    const index = parseCatalog({
      // No first-party source: the lower median of the reported values wins.
      'agg-a': { models: { 'm-one': { limit: { context: 1000000, output: 128000 } } } },
      'agg-b': { models: { 'm-one': { limit: { context: 1000000, output: 128000 } } } },
      'agg-c': { models: { 'm-one': { limit: { context: 1050000, output: 1050000 } } } },
    })
    expect(index.get('m-one')).toEqual({ contextWindow: 1000000, maxTokens: 128000 })

    // Two-way disagreement: the conservative side wins, not the larger.
    const pair = parseCatalog({
      'agg-a': { models: { 'm-two': { limit: { output: 64000 } } } },
      'agg-c': { models: { 'm-two': { limit: { output: 1048576 } } } },
    })
    expect(pair.get('m-two')).toEqual({ maxTokens: 64000 })
  })

  it('picks the first-party number over an aggregator majority', () => {
    const index = parseCatalog({
      anthropic: { models: { 'claude-y': { limit: { context: 200000, output: 64000 } } } },
      'agg-a': { models: { 'claude-y': { limit: { context: 1000000, output: 1000000 } } } },
      'agg-b': { models: { 'claude-y': { limit: { context: 1000000, output: 1000000 } } } },
    })
    expect(index.get('claude-y')).toEqual({ contextWindow: 200000, maxTokens: 64000 })
  })

  it('clamps the output budget to the context window', () => {
    const index = parseCatalog({
      'agg-a': { models: { 'm-three': { limit: { context: 32000, output: 64000 } } } },
    })
    expect(index.get('m-three')).toEqual({ contextWindow: 32000, maxTokens: 32000 })
  })

  it('returns an empty index for malformed catalogs', () => {
    expect(parseCatalog(null).size).toBe(0)
    expect(parseCatalog('junk').size).toBe(0)
  })
})

describe('parseCatalog reasoning_options → reasoningEfforts', () => {
  // Fixture providers: `zhipuai`/`openai`/`anthropic` are first-party keys, the
  // rest are aggregators — mirroring the real catalog shapes of 2026-10.
  const CATALOG_EFFORTS = {
    zhipuai: {
      models: {
        'glm-flash': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
      },
    },
    openai: {
      models: {
        // models.dev's `none` becomes pi-ai's `off` with a null wire value.
        'gpt-x': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }] },
        // Out-of-vocabulary effort values cannot travel and are dropped.
        'gpt-weird': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'default', 'null'] }] },
      },
    },
    anthropic: {
      models: {
        // Budget-only first-party: its presence is data — aggregators that
        // publish richer effort vocabularies must not refill the id.
        'claude-x': { reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 0, max: 32000 }] },
      },
    },
    llmgateway: {
      models: {
        'claude-x': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }] },
        // Aggregator-only id (no first-party entry anywhere): the fallback is
        // the intersection of every aggregator's claims.
        'ag-only': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }] },
        'ag-disjoint': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['high', 'max'] }] },
      },
    },
    requesty: {
      models: {
        'ag-only': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'max'] }] },
        'ag-disjoint': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium'] }] },
      },
    },
  }

  it('maps a single first-party entry, none → off:null, out-of-vocab dropped', () => {
    const index = parseCatalog(CATALOG_EFFORTS)
    expect(index.get('glm-flash')?.reasoningEfforts).toEqual({ low: 'low', high: 'high', max: 'max' })
    expect(index.get('gpt-x')?.reasoningEfforts).toEqual({ off: null, low: 'low', medium: 'medium', high: 'high' })
    expect(index.get('gpt-weird')?.reasoningEfforts).toEqual({ low: 'low' })
  })

  it('silences aggregators when a first-party entry exists without effort data', () => {
    const index = parseCatalog(CATALOG_EFFORTS)
    expect(index.get('claude-x')).not.toHaveProperty('reasoningEfforts')
    expect(index.get('claude-x')?.reasoningModel).toBe(true)
  })

  it('intersects aggregator sources when no first-party entry exists', () => {
    const index = parseCatalog(CATALOG_EFFORTS)
    // max survives only in one source; none/low/medium/high in both.
    expect(index.get('ag-only')?.reasoningEfforts).toEqual({ off: null, low: 'low', medium: 'medium', high: 'high' })
    // Disjoint claims resolve to nothing.
    expect(index.get('ag-disjoint')).not.toHaveProperty('reasoningEfforts')
  })

  it('intersects two first-party sources that disagree', () => {
    const index = parseCatalog({
      zhipuai: { models: { 'glm-5': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] } } },
      zai: { models: { 'glm-5': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'high', 'max'] }] } } },
    })
    expect(index.get('glm-5')?.reasoningEfforts).toEqual({ high: 'high', max: 'max' })
  })

  it('treats toggle-only reasoning as not expressible', () => {
    const index = parseCatalog({
      deepseek: { models: { 'v3.2': { reasoning: true, reasoning_options: [{ type: 'toggle' }] } } },
    })
    expect(index.get('v3.2')).toEqual({ reasoningModel: true })
  })
})

describe('parseCatalog display names', () => {
  it('prefers first-party names over aggregator names and strips the (latest) marker', () => {
    const index = parseCatalog({
      llmgateway: {
        models: {
          // Aggregator walks first; its name must not survive the first-party one.
          'claude-x': { name: 'Claude X (latest)', limit: { context: 100000 } },
        },
      },
      anthropic: {
        models: {
          'claude-x': { name: 'Claude X (latest)', limit: { context: 200000 } },
        },
      },
    })
    expect(index.get('claude-x')).toEqual({ name: 'Claude X', contextWindow: 200000 })
  })

  it('keeps a name as an id-only fact and rejects names equal to the id', () => {
    const index = parseCatalog({
      somevendor: {
        models: {
          'named-only': { name: 'Fancy Model' },
          'same-as-id': { name: 'Same-As-Id' },
          '(latest)-only': { name: 'Shiny (latest)' },
        },
      },
    })
    // A display name alone is enough to enrich the selector.
    expect(index.get('named-only')).toEqual({ name: 'Fancy Model' })
    // A name repeating the id carries no information → dropped.
    expect(index.get('same-as-id')).toBeUndefined()
    expect(index.get('(latest)-only')).toEqual({ name: 'Shiny' })
  })

  it('merges per-model names with max/OR capacity facts untouched', () => {
    const index = parseCatalog(CATALOG)
    // The CATALOG fixture carries no names: capacity merge stays as it was.
    expect(index.get('gpt-4o')).toEqual({ contextWindow: 128000, maxTokens: 16384, imageInput: true })
  })
})

describe('displayNameOf', () => {
  it('normalizes raw names', () => {
    expect(displayNameOf('Claude Opus 4.5 (latest)')).toBe('Claude Opus 4.5')
    expect(displayNameOf('  Padded  ')).toBe('Padded')
    expect(displayNameOf('x', 'X')).toBeUndefined()
    expect(displayNameOf('')).toBeUndefined()
    expect(displayNameOf(42)).toBeUndefined()
  })
})

describe('loadModelIndex', () => {
  it('uses the bundled snapshot when enrichment is off (no fetch)', async () => {
    resetCaches()
    let fetchCalls = 0
    const fetchImpl = (async () => {
      fetchCalls++
      throw new Error('should not fetch')
    }) as typeof fetch
    const index = await loadModelIndex({ enrich: false, fetchImpl })
    expect(fetchCalls).toBe(0)
    // The real bundled snapshot ships with the package and has real entries.
    expect(index.get('claude-haiku-4-5')).toMatchObject({ contextWindow: 200000 })
    resetCaches()
  })

  it('fetches the fresh catalog when enrichment is on', async () => {
    resetCaches()
    let fetchCalls = 0
    const fetchImpl = (async () => {
      fetchCalls++
      return {
        ok: true,
        status: 200,
        json: async () => CATALOG,
      } as Response
    }) as typeof fetch
    const index = await loadModelIndex({ enrich: true, fetchImpl, now: () => 1000 })
    expect(fetchCalls).toBe(1)
    expect(index.get('gpt-4o')).toMatchObject({ contextWindow: 128000 })
    // Within the TTL the cache answers without a second wire call.
    const again = await loadModelIndex({ enrich: true, fetchImpl, now: () => 2000 })
    expect(again.get('gpt-4o')).toBeDefined()
    expect(fetchCalls).toBe(1)
    resetCaches()
  })

  it('degrades to the bundled snapshot when the fetch fails', async () => {
    resetCaches()
    const fetchImpl = (async () => ({ ok: false, status: 503, json: async () => undefined }) as Response) as typeof fetch
    const index = await loadModelIndex({ enrich: true, fetchImpl, now: () => 5000 })
    expect(index.get('claude-haiku-4-5')).toMatchObject({ contextWindow: 200000 })
    resetCaches()
  })

  it('negative-caches a failed fetch for 1h, not a full day', async () => {
    resetCaches()
    let fetchCalls = 0
    const fetchImpl = (async () => {
      fetchCalls++
      return { ok: false, status: 503, json: async () => undefined } as Response
    }) as typeof fetch
    const t0 = 5000
    const failed = await loadModelIndex({ enrich: true, fetchImpl, now: () => t0 })
    expect(fetchCalls).toBe(1)
    expect(failed.get('claude-haiku-4-5')).toMatchObject({ contextWindow: 200000 })
    // Within the negative TTL the bundled snapshot answers without a wire call.
    await loadModelIndex({ enrich: true, fetchImpl, now: () => t0 + 30 * 60 * 1000 })
    expect(fetchCalls).toBe(1)
    // Past it the endpoint is retried (and still failing here).
    await loadModelIndex({ enrich: true, fetchImpl, now: () => t0 + 61 * 60 * 1000 })
    expect(fetchCalls).toBe(2)
    resetCaches()
  })
})

describe('bundledIndex', () => {
  it('ships a real snapshot with substantial coverage', () => {
    const index = bundledIndex()
    expect(index.size).toBeGreaterThan(1000)
    for (const id of ['claude-sonnet-4-5', 'gpt-4o', 'gemini-2.5-pro', 'deepseek-chat']) {
      const meta = index.get(id)
      expect(meta?.contextWindow).toBeGreaterThan(0)
    }
  })

  it('resolves first-party effort vocabularies into the shipped snapshot', () => {
    const index = bundledIndex()
    // zhipuai first-party: low|high|max (no none → no off).
    expect(index.get('glm-5.3-flash')?.reasoningEfforts).toEqual({ low: 'low', high: 'high', max: 'max' })
    // openai first-party: none|low|medium|high|xhigh.
    expect(index.get('gpt-5.2')?.reasoningEfforts).toEqual({ off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' })
    // First-party budget-only presence silences aggregator effort claims.
    expect(index.get('claude-sonnet-4-5')).not.toHaveProperty('reasoningEfforts')
    expect(index.get('gemini-2.5-pro')).not.toHaveProperty('reasoningEfforts')
  })
})
describe('peekModelIndex / modelIndexForSync / refreshModelIndex', () => {
  const catalogFetch = (): { fetchImpl: typeof fetch; calls: () => number } => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return { ok: true, status: 200, json: async () => CATALOG } as Response
    }) as typeof fetch
    return { fetchImpl, calls: () => calls }
  }

  it('peek answers only inside the TTL window and never fetches', async () => {
    resetCaches()
    expect(peekModelIndex(1000)).toBeUndefined()
    const { fetchImpl, calls } = catalogFetch()
    await loadModelIndex({ enrich: true, fetchImpl, now: () => 1000 })
    expect(calls()).toBe(1)
    expect(peekModelIndex(1000)?.get('gpt-4o')).toMatchObject({ contextWindow: 128000 })
    expect(peekModelIndex(1000 + 23 * 60 * 60 * 1000)).toBeDefined()
    expect(peekModelIndex(1000 + 25 * 60 * 60 * 1000)).toBeUndefined()
    expect(calls()).toBe(1)
    resetCaches()
  })

  it('modelIndexForSync answers from the bundled snapshot immediately and refreshes behind it', async () => {
    resetCaches()
    const { fetchImpl, calls } = catalogFetch()
    // No await: the sync path must never wait on the 6.9 MB catalog.
    const index = modelIndexForSync({ enrich: true, fetchImpl })
    expect(index.get('claude-haiku-4-5')).toMatchObject({ contextWindow: 200000 })
    expect(peekModelIndex()).toBeUndefined()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(calls()).toBe(1)
    // The NEXT run sees the fresh catalog.
    expect(peekModelIndex()?.get('gpt-4o')).toMatchObject({ contextWindow: 128000 })
    expect(modelIndexForSync({ enrich: true, fetchImpl })).toBe(peekModelIndex())
    resetCaches()
  })

  it('does not start a refresh when enrichment is off', async () => {
    resetCaches()
    const { fetchImpl, calls } = catalogFetch()
    const index = modelIndexForSync({ enrich: false, fetchImpl })
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(index.get('claude-haiku-4-5')).toMatchObject({ contextWindow: 200000 })
    expect(calls()).toBe(0)
    resetCaches()
  })

  it('a live cache entry satisfies a speculative refresh without a second download', async () => {
    resetCaches()
    const { fetchImpl, calls } = catalogFetch()
    // Both calls on the REAL clock: an injected clock would look ancient
    // against the entry the first call stamped, which is a test artefact.
    await refreshModelIndex({ fetchImpl })
    expect(calls()).toBe(1)
    await refreshModelIndex({ fetchImpl })
    expect(calls()).toBe(1)
    resetCaches()
  })

  it('caps a stalled catalog fetch and negative-caches the bundled snapshot', async () => {
    resetCaches()
    const fetchImpl = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    })) as typeof fetch
    const index = await refreshModelIndex({ fetchImpl, timeoutMs: 5, now: () => 2000 })
    expect(index.get('claude-haiku-4-5')).toMatchObject({ contextWindow: 200000 })
    // Negative cache: the failure is remembered instead of retried per sync.
    expect(peekModelIndex(2000 + 30 * 60 * 1000)?.get('claude-haiku-4-5')).toBeDefined()
    resetCaches()
  })
})
describe('resolveCapacityFact', () => {
  it('prefers first-party values, else the lower median', () => {
    expect(resolveCapacityFact([1000000, 1024, 128000])).toBe(128000)
    expect(resolveCapacityFact([128000, 128000, 1050000])).toBe(128000)
    expect(resolveCapacityFact([64000, 1050000])).toBe(64000)
    expect(resolveCapacityFact([1000000, 200000], [200000])).toBe(200000)
    expect(resolveCapacityFact([], [])).toBeUndefined()
  })
})
