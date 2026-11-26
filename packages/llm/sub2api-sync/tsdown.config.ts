import { defineConfig } from 'tsdown'

const nodeExternal = [
  /^@deepseek-ai\//,
  /^@earendil-works\//,
  'react',
  'react/jsx-runtime',
]

// The plugin's package name is NOT injected here: tsdown 0.4.4's `define`
// does not reliably reach the client bundle. Identity injection (PKG_NAME +
// ModuleLoader id) happens in scripts/wrap-client.mjs, which already owns the
// wrapper and reads the (possibly variant-rewritten) package.json name.

// Declarations are NOT emitted here any more: tsdown 0.4.4's dts step fused
// neighbouring statements in 7 of the 12 files it produced ('./co./config.jseclare
// module …') while keeping each file's byte count, so 0.4.0 shipped
// declarations no TypeScript consumer could parse. `tsc -p tsconfig.dts.json
// --emitDeclarationOnly` now owns that step, and scripts/check-dts.mjs proves
// the result.

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
    },
    platform: 'node',
    format: 'esm',
    dts: false,
    outDir: 'lib',
    fixedExtension: false,
    deps: { neverBundle: nodeExternal },
  },
  {
    entry: {
      client: 'src/client/index.tsx',
    },
    platform: 'browser',
    format: 'cjs',
    dts: false,
    outDir: 'lib',
    fixedExtension: false,
    deps: { neverBundle: ['react', 'react/jsx-runtime'] },
  },
])
