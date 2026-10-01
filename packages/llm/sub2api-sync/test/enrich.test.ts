import { describe, expect, it } from 'vitest'
import { bundledIndex, loadModelIndex, parseCatalog, parseSnapshot, resetCaches } from '../src/enrich.ts'

const SNAPSHOT = JSON.stringify({
  generatedAt: '2026-09-30',
  source: 'https://models.dev/api.json',
  models: {
    'claude-x': [200000, 64000, 1, 1],
    'text-only': [128000, 8192, 0, 0],
    'no-capacity': [undefined, undefined, 1, 0],
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
  })

  it('tolerates a malformed snapshot', () => {
    expect(parseSnapshot('not json').size).toBe(0)
    expect(parseSnapshot('{"models": null}').size).toBe(0)
  })
})

describe('parseCatalog', () => {
  it('merges cross-provider duplicates with max/OR semantics', () => {
    const index = parseCatalog(CATALOG)
    expect(index.get('claude-x')).toEqual({
      contextWindow: 1000000, // max(200000, 1000000)
      maxTokens: 64000, // max(64000, 32000)
      imageInput: true,
      reasoningModel: true,
    })
    expect(index.get('gpt-4o')).toEqual({ contextWindow: 128000, maxTokens: 16384, imageInput: true })
  })

  it('returns an empty index for malformed catalogs', () => {
    expect(parseCatalog(null).size).toBe(0)
    expect(parseCatalog('junk').size).toBe(0)
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
})
