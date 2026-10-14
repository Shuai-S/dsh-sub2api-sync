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

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
    },
    platform: 'node',
    format: 'esm',
    dts: true,
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
