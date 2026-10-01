import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Build-artifact guard for the dynamic browser half: the wrapped client
 * bundle may only request the baseline externals (React, JSX runtime, and
 * the shared UI primitives library). Anything else — e.g. schemastery
 * dragged in by a value import of `config.ts` — has no row in the app's
 * module table, so the require throws at boot and the whole client half
 * silently dies (installed-but-invisible symptom). Skipped when the bundle
 * has not been built yet.
 */
const BUNDLE = join(import.meta.dirname, '../lib/client.js')

describe('client bundle externals', () => {
  it('requests only baseline externals', { skip: !existsSync(BUNDLE) }, () => {
    const source = readFileSync(BUNDLE, 'utf8')
    const requires = [...source.matchAll(/\brequire\((["'])([^"']+)\1\)/g)].map((match) => match[2])
    expect(requires.length).toBeGreaterThan(0)
    for (const specifier of requires) {
      expect(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'], `unexpected external: ${specifier}`).toContain(specifier)
    }
  })
})
