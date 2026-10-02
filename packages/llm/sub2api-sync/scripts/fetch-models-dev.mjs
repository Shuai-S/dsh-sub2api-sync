// Regenerate data/models-dev.snapshot.json from https://models.dev/api.json.
//
// The snapshot is the offline fallback for the engine's model-metadata
// enrichment (src/enrich.ts): per model id a compact tuple
//   [contextWindow, maxOutputTokens, hasImageInput, isReasoningModel, efforts?, name?]
// where `efforts` (present only when the id resolves to effort levels) is the
// normalized level array — `none` stands for pi-ai's `off`, the rest are wire
// spellings passed through verbatim — and `name` (present only when the id
// resolves to a display name) is models.dev's `name` with its " (latest)"
// marker stripped. Collisions (the same id under several providers) merge
// with max(context), max(output), OR(image), OR(reasoning); effort levels
// follow parseCatalog's first-party preference (whose vocabulary and provider
// set are imported from src/enrich.ts — single source of truth): first-party
// sources win outright, otherwise aggregator sources intersect. Display names
// prefer first-party sources too (a first-party name overrides; an aggregator
// name only fills an absence).
//
// Usage: node scripts/fetch-models-dev.mjs [local-api.json]
//   (regenerate whenever models.dev grows new models; pass a previously saved
//   https://models.dev/api.json to regenerate offline)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { displayNameOf, EFFORT_VOCABULARY, FIRST_PARTY_PROVIDERS } from '../src/enrich.ts'

const SOURCE_URL = 'https://models.dev/api.json'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../data/models-dev.snapshot.json')

const catalog = await (async () => {
  const local = process.argv[2]
  if (local !== undefined) {
    console.log(`using local catalog: ${local}`)
    return JSON.parse(readFileSync(local, 'utf8'))
  }
  const response = await fetch(SOURCE_URL)
  if (!response.ok) {
    console.error(`fetch failed: HTTP ${response.status}`)
    process.exit(1)
  }
  return response.json()
})()

const tuples = new Map()
const merge = (id, context, output, image, reasoning) => {
  const key = String(id).toLowerCase()
  if (key.length === 0) return
  const current = tuples.get(key)
  if (current === undefined) {
    tuples.set(key, [context, output, image ? 1 : 0, reasoning ? 1 : 0])
    return
  }
  if (context !== undefined && (current[0] === undefined || context > current[0])) current[0] = context
  if (output !== undefined && (current[1] === undefined || output > current[1])) current[1] = output
  if (image) current[2] = 1
  if (reasoning) current[3] = 1
}

// Effort sources accumulate per id in two groups; the first-party merge runs
// after the walk because first-party presence must silence aggregators entirely.
const effortSources = { firstParty: new Map(), aggregator: new Map() }
const firstPartyIds = new Set()
const recordEfforts = (key, model, firstParty) => {
  const options = model.reasoning_options
  if (!Array.isArray(options)) return
  const seen = new Set()
  for (const option of options) {
    if (option === null || typeof option !== 'object') continue
    if (option.type !== 'effort' || !Array.isArray(option.values)) continue
    for (const value of option.values) {
      if (typeof value === 'string' && EFFORT_VOCABULARY.includes(value)) seen.add(value)
    }
  }
  if (seen.size === 0) return
  const levels = EFFORT_VOCABULARY.filter((level) => seen.has(level))
  const group = firstParty ? effortSources.firstParty : effortSources.aggregator
  const existing = group.get(key)
  if (existing === undefined) group.set(key, [levels])
  else existing.push(levels)
}

const intersectLevels = (sources) => {
  const [first, ...rest] = sources
  const merged = first.filter((level) => rest.every((source) => source.includes(level)))
  return merged.length > 0 ? merged : undefined
}
const resolveEfforts = (key, sources) => {
  const levels = intersectLevels(sources)
  if (levels === undefined) return
  const tuple = tuples.get(key)
  if (tuple === undefined) tuples.set(key, [undefined, undefined, 0, 0, levels])
  else tuple[4] = levels
}

// Display names accumulate per id in the same two groups (set-if-absent);
// resolution runs after the walk: a first-party name overrides whatever an
// earlier aggregator walk contributed, an aggregator name only fills an
// absence. A name can be an id's ONLY fact — it still ships in the snapshot.
const nameSources = { firstParty: new Map(), aggregator: new Map() }
const recordName = (key, model, firstParty) => {
  const name = displayNameOf(model.name, key)
  if (name === undefined) return
  const group = firstParty ? nameSources.firstParty : nameSources.aggregator
  if (!group.has(key)) group.set(key, name)
}
const resolveName = (key, name, override) => {
  const tuple = tuples.get(key)
  if (tuple === undefined) tuples.set(key, [undefined, undefined, 0, 0, undefined, name])
  else if (tuple[5] === undefined || override) tuple[5] = name
}

let scanned = 0
for (const [providerName, provider] of Object.entries(catalog)) {
  const models = provider?.models
  if (models === null || typeof models !== 'object') continue
  const firstParty = FIRST_PARTY_PROVIDERS.has(providerName)
  for (const model of Object.values(models)) {
    if (model === null || typeof model !== 'object') continue
    scanned++
    const id = model.id
    if (typeof id !== 'string' || id.length === 0) continue
    const key = id.toLowerCase()
    if (firstParty) firstPartyIds.add(key)
    const context = model?.limit?.context
    const output = model?.limit?.output
    const image = model?.modalities?.input?.includes('image') === true || model?.attachment === true
    const reasoning = model?.reasoning === true
    merge(key, typeof context === 'number' ? context : undefined, typeof output === 'number' ? output : undefined, image, reasoning)
    recordEfforts(key, model, firstParty)
    recordName(key, model, firstParty)
  }
}
for (const [key, sources] of effortSources.firstParty) resolveEfforts(key, sources)
// A first-party entry for the id — with or without effort data — wins; its
// effort-less budget-only/toggle shape is data too (Anthropic's claude and
// Google's gemini entries are budget-only, so aggregators must not refill).
for (const [key, sources] of effortSources.aggregator) {
  if (!firstPartyIds.has(key)) resolveEfforts(key, sources)
}
// Names: aggregator fills first, first-party overrides (mirrors parseCatalog).
for (const [key, name] of nameSources.aggregator) resolveName(key, name, false)
for (const [key, name] of nameSources.firstParty) resolveName(key, name, true)

const snapshot = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: SOURCE_URL,
  models: Object.fromEntries([...tuples.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
}

const previous = (() => {
  try { return readFileSync(OUT, 'utf8').length } catch { return 0 }
})()
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(snapshot))
const withEfforts = [...tuples.values()].filter((tuple) => tuple[4] !== undefined).length
const withNames = [...tuples.values()].filter((tuple) => tuple[5] !== undefined).length
console.log(`models scanned: ${scanned}, unique ids: ${tuples.size}, with effort levels: ${withEfforts}, with display names: ${withNames}`)
console.log(`written: ${OUT} (${JSON.stringify(snapshot).length} bytes; previous ${previous})`)
