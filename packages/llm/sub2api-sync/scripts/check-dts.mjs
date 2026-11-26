/**
 * Release gate for the emitted declarations.
 *
 * Why: the tsdown 0.4.4 dts step fused neighbouring statements into single
 * lines ('./co./config.jseclare module ...') while keeping each file's byte
 * length, so size and checksum comparisons could not see the damage. The build
 * now emits declarations with `tsc -p tsconfig.dts.json`; this script proves
 * the result is what a consumer actually reads:
 *   1. every source module has a declaration file (and nothing extra ships),
 *   2. the whole set type-checks as one consumer program,
 *   3. no file carries the known glue signatures of the broken emitter.
 *
 * Dependency-free on purpose: TypeScript is already a devDependency, and the
 * gate runs inside `pnpm check` where a network install is not available.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')

/** Every complaint as { file, line, message }; file is relative to the package root. */
const problems = []
const report = (file, line, message) => problems.push({ file, line, message })

/** Declaration files the build must produce, derived from the sources tsc compiles. */
function sourceDeclarations(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
    // client/** is the browser bundle: the exports map has a JS entry for it but
    // no types entry, so tsconfig.dts.json excludes it and lib/client/** must
    // never appear (a stray lib/client/index.d.ts would be a build bug).
    .filter((name) => name.split(/[\\/]/)[0] !== 'client')
    .map((name) => name.replace(/\.tsx?$/, '.d.ts'))
    .sort()
}

/** Every declaration file present under lib/, relative to lib. */
function declarationFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((name) => name.endsWith('.d.ts'))
    .sort()
}

let declared = []
try {
  declared = declarationFiles(libDir)
} catch {
  // lib/ does not exist at all — the build never ran here.
}
if (declared.length === 0) {
  console.error('check-dts: lib/ holds no .d.ts files — run the build before this gate')
  process.exit(1)
}

const expected = sourceDeclarations(srcDir)
for (const name of expected) {
  if (!declared.includes(name)) report(join('lib', name), 1, 'missing — no declaration was emitted for this source module')
}
for (const name of declared) {
  if (!expected.includes(name)) report(join('lib', name), 1, 'unexpected — no matching source module (stale or foreign declaration file)')
}

// Consumer view of the package: no `types` (the package needs @types/node only
// for its own build) and the DOM lib so the emitted `fetch`/`Response`/`AbortSignal`
// names resolve from a lib that ships with TypeScript instead of an install.
const program = ts.createProgram({
  rootNames: declared.map((name) => join(libDir, name)),
  options: {
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: false,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  },
})

/**
 * Node-only names the consumer supplies for itself: `node:http` and friends are
 * builtins whose types live in @types/node, and 2591 ('Cannot find name
 * Buffer', raised only when no node types are loaded). Both are ambient
 * environment noise in THIS program, not damage to the emitted text, so they
 * must not mask a real error. Everything else is reported.
 */
function isNodeTypesNoise(code, message) {
  if (code === 2307) return /^Cannot find module 'node:/.test(message)
  return code === 2591
}

for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
  if (diagnostic.file === undefined) continue
  const inside = relative(libDir, diagnostic.file.fileName)
  // Diagnostics raised inside node_modules belong to a dependency's types, not
  // to this package's emit; the gate owns lib/ only.
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) continue
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  if (isNodeTypesNoise(diagnostic.code, message)) continue
  const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1
  report(join('lib', inside), line, `TS${diagnostic.code}: ${message}`)
}

// Known glue signatures of the broken dts emitter. Checked on every line: a
// fused file keeps its byte count, so only the token shape gives it away.
const GLUE_TOKENS = [
  ['jseclare', 'declaration keyword fused onto a module specifier'],
  ['jsxport', 'export keyword fused onto a module specifier'],
]
// Two relative specifiers inside one quoted string ('./co./config.js'): the
// emitter overwrote the middle of a path in place.
const FUSED_SPECIFIER = /['"]\.\/[^'"\n]*\.\//

let totalBytes = 0
for (const name of declared) {
  const file = join('lib', name)
  const text = readFileSync(join(libDir, name), 'utf8')
  totalBytes += Buffer.byteLength(text)
  text.split('\n').forEach((line, index) => {
    for (const [token, meaning] of GLUE_TOKENS) {
      if (line.includes(token)) report(file, index + 1, `glue signature '${token}' — ${meaning}`)
    }
    const fused = FUSED_SPECIFIER.exec(line)
    if (fused !== null) report(file, index + 1, `fused module specifier ${fused[0]}`)
    // Comment-only lines legitimately carry apostrophes ("the loader's entry"),
    // so quote balance is only meaningful on code lines; a trailing // comment
    // is trimmed for the same reason.
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) return
    const quotes = line.replace(/\/\/.*$/, '').split("'").length - 1
    if (quotes % 2 !== 0) report(file, index + 1, `unbalanced quotes (${quotes} single quote(s)) — a specifier or string literal is truncated`)
  })
}

// A fused file can fail in hundreds of cascading ways; the first few name the
// damage and the count keeps the report readable.
const MAX_REPORTED = 25

const summary = `${declared.length} declaration files, ${totalBytes} bytes`
if (problems.length === 0) {
  console.log(`check-dts: OK — ${summary} parsed cleanly and carry no glue signatures`)
} else {
  problems.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  for (const problem of problems.slice(0, MAX_REPORTED)) {
    console.error(`check-dts: ${problem.file}:${problem.line} ${problem.message}`)
  }
  if (problems.length > MAX_REPORTED) console.error(`check-dts: … ${problems.length - MAX_REPORTED} more problem(s) suppressed`)
  console.error(`check-dts: FAILED — ${problems.length} problem(s) in ${summary}`)
  process.exitCode = 1
}
