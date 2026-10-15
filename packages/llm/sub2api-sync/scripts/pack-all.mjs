/**
 * Build + pack the plugin under BOTH published npm names:
 *   - canonical scoped name — package.json "name" (@mangoc/dsh-sub2api-sync)
 *   - unscoped short alias  — dsh-sub2api-sync
 *
 * The plugin's runtime identity appears in three build artifacts that must
 * match the installed package's name:
 *   1. the client bundle's PKG_NAME (tsdown `define`, see tsdown.config.ts),
 *   2. the client ModuleLoader wrapper id (scripts/wrap-client.mjs, read from
 *      package.json at prepare time),
 *   3. cordis.patch.yml's bundle `name`.
 * For each variant this script rewrites package.json + cordis.patch.yml, then
 * runs `pnpm pack`, whose `prepare` hook rebuilds with DSH_PLUGIN_NAME set so
 * every embedded name matches the variant being packed. Repository files are
 * restored afterwards.
 *
 * Both tarballs land in the output directory with the same `version` — the
 * two packages move in lockstep. CI (release.yml) publishes both to npm and
 * attaches both to the GitHub Release.
 *
 * Usage: node scripts/pack-all.mjs [--out <dir>]   (default out dir: dist/)
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(root, 'package.json')
const patchPath = join(root, 'cordis.patch.yml')

const outFlag = process.argv.indexOf('--out')
const outDir = resolve(
  process.cwd(),
  outFlag !== -1 ? process.argv[outFlag + 1] : 'dist',
)

const pkgOriginal = readFileSync(pkgPath, 'utf8')
const patchOriginal = readFileSync(patchPath, 'utf8')
const { name: canonical, version } = JSON.parse(pkgOriginal)
const alias = 'dsh-sub2api-sync'

if (canonical === alias) {
  throw new Error(
    `package.json name is "${alias}" — the canonical name must stay scoped; the unscoped name is reserved for the alias variant`,
  )
}

function tgzOf(name) {
  const flat = name.startsWith('@') ? name.slice(1).replace('/', '-') : name
  return join(outDir, `${flat}-${version}.tgz`)
}

function pack(name) {
  const result = spawnSync('pnpm', ['pack', '--pack-destination', outDir], {
    cwd: root,
    env: { ...process.env, DSH_PLUGIN_NAME: name },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) throw new Error(`pnpm pack failed for ${name}`)
}

mkdirSync(outDir, { recursive: true })

const packed = []
let packError
try {
  // Variant 1: canonical scoped name — files already carry it.
  pack(canonical)
  packed.push({ name: canonical, tgz: tgzOf(canonical) })

  // Variant 2: unscoped alias — temporarily rewrite the two name-bearing files.
  const pkgAliased = pkgOriginal.replace(
    `"name": "${canonical}"`,
    `"name": "${alias}"`,
  )
  const patchAliased = patchOriginal.replace(
    `name: '${canonical}'`,
    `name: '${alias}'`,
  )
  if (pkgAliased === pkgOriginal || patchAliased === patchOriginal) {
    throw new Error('failed to rewrite package.json / cordis.patch.yml for the alias variant')
  }
  writeFileSync(pkgPath, pkgAliased)
  writeFileSync(patchPath, patchAliased)
  pack(alias)
  packed.push({ name: alias, tgz: tgzOf(alias) })
} catch (error) {
  packError = error
} finally {
  writeFileSync(pkgPath, pkgOriginal)
  writeFileSync(patchPath, patchOriginal)
  // The last `pnpm pack` (the alias variant, or whichever variant ran before a
  // mid-run failure) rebuilt lib/ under that variant's identity and left the
  // artifacts in the working tree. The installed package is the canonical
  // one, and a wrapper id that disagrees with it fatal-boots web boot
  // ("duplicate factory registration"), so rebuild lib/ under the restored
  // canonical identity on EVERY exit path — including failures.
  const rebuild = spawnSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (packError !== undefined) {
    if (rebuild.status !== 0) {
      console.error('post-pack rebuild also failed — lib/ still carries the last variant\'s artifacts; run `pnpm build` to recover')
    }
    throw packError
  }
  if (rebuild.status !== 0) throw new Error('post-pack rebuild of the canonical artifacts failed — lib/ still carries the alias variant')
}

for (const { name, tgz } of packed) console.log(`packed ${name} -> ${tgz}`)
