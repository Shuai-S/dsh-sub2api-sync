import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')
const { name: pkgName } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// tsdown emits CommonJS as client.cjs in this ESM package. Prefer that fresh
// build over a client.js left behind by an earlier wrapper run.
const filename = ['client.cjs', 'client.js']
  .map(name => join(lib, name))
  .find(path => {
    try {
      readFileSync(path)
      return true
    } catch {
      return false
    }
  })
if (filename === undefined) throw new Error('tsdown did not emit lib/client.js or lib/client.cjs')
let source = readFileSync(filename, 'utf8')
// Identity injection: replace the build-time placeholder with this build's
// package name, read from package.json (pack-all.mjs rewrites it per variant
// before `pnpm pack` triggers this script). Keeps PKG_NAME (client slot keys,
// detail-page filter) consistent with the wrapper id below.
source = source.replace(/__DSH_PLUGIN_NAME__/g, JSON.stringify(pkgName))
const out = join(lib, 'client.js')

// The ModuleLoader wrapper id MUST equal the package name the Host mounts the
// bundle under: the client-modules graph row is keyed by that name, and a
// script that loads without registering its row id is retried on its
// one-resource URL — the replay then hits the already-registered factory and
// fatal-boots the whole web app with "duplicate factory registration". A stale
// wrapper id is exactly what `pack-all.mjs` used to leave behind after packing
// the alias variant last, so refuse to ship one instead of failing at boot.
const WRAPPER_HEAD_ID = /^window\.__ModuleLoader__\.load\(\{\n\tid: "([^"]+)",\n/
if (source.includes('window.__ModuleLoader__')) {
  const wrappedId = source.match(WRAPPER_HEAD_ID)?.[1]
  if (wrappedId === undefined) throw new Error('wrap-client: lib input carries an unrecognized __ModuleLoader__ wrapper; delete lib/client.js and re-run `pnpm build`')
  if (wrappedId !== pkgName) {
    throw new Error(
      `wrap-client: refusing to ship wrapper id "${wrappedId}" while package.json name is "${pkgName}" `
      + '(stale pack-all variant artifact — such a mismatch fatal-boots web boot). '
      + 'Run `pnpm build` so tsdown regenerates lib/client.cjs, or delete lib/client.js, then re-run.',
    )
  }
  if (source.includes('__DSH_PLUGIN_NAME__')) throw new Error('wrap-client: wrapped client.js still carries the __DSH_PLUGIN_NAME__ placeholder')
  if (filename !== out) writeFileSync(out, source)
  process.exit(0)
}

writeFileSync(out, `window.__ModuleLoader__.load({
	id: "${pkgName}",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${source}
		return module.exports;
	}
});
`)
