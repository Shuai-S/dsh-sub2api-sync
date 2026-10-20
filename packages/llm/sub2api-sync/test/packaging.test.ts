import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}
const credentialsPackage = '@deepseek-ai/dsh-credentials'

describe('runtime package metadata', () => {
  it('ships the statically imported credential helper as a production dependency', () => {
    expect(manifest.dependencies?.[credentialsPackage]).toBe('0.2.0-rc.2')
    expect(manifest.peerDependencies?.[credentialsPackage]).toBeUndefined()
    expect(manifest.peerDependenciesMeta?.[credentialsPackage]).toBeUndefined()
  })
})
