// Regenerate data/models-dev.snapshot.json from https://models.dev/api.json.
//
// The snapshot is the offline fallback for the engine's model-metadata
// enrichment (src/enrich.ts): per model id a compact tuple
//   [contextWindow, maxOutputTokens, hasImageInput, isReasoningModel]
// Collisions (the same id under several providers) merge with
// max(context), max(output), OR(image), OR(reasoning).
//
// Usage: node scripts/fetch-models-dev.mjs  (regenerate whenever models.dev
// grows new models; the transform mirrors parseCatalog in src/enrich.ts).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_URL = 'https://models.dev/api.json'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../data/models-dev.snapshot.json')

const response = await fetch(SOURCE_URL)
if (!response.ok) {
  console.error(`fetch failed: HTTP ${response.status}`)
  process.exit(1)
}
const catalog = await response.json()

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

let scanned = 0
for (const provider of Object.values(catalog)) {
  const models = provider?.models
  if (models === null || typeof models !== 'object') continue
  for (const model of Object.values(models)) {
    if (model === null || typeof model !== 'object') continue
    scanned++
    const id = model.id ?? undefined
    const context = model?.limit?.context
    const output = model?.limit?.output
    const image = model?.modalities?.input?.includes('image') === true || model?.attachment === true
    const reasoning = model?.reasoning === true
    merge(id, typeof context === 'number' ? context : undefined, typeof output === 'number' ? output : undefined, image, reasoning)
  }
}

const snapshot = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: SOURCE_URL,
  models: Object.fromEntries([...tuples.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(snapshot))
const previous = (() => {
  try { return readFileSync(OUT, 'utf8').length } catch { return 0 }
})()
console.log(`models scanned: ${scanned}, unique ids: ${tuples.size}`)
console.log(`written: ${OUT} (${JSON.stringify(snapshot).length} bytes; previous ${previous})`)
