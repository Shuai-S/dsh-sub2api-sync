import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  files?: string[]
  icon?: string
}
const credentialsPackage = '@deepseek-ai/dsh-credentials'

describe('runtime package metadata', () => {
  it('ships the statically imported credential helper as a production dependency', () => {
    expect(manifest.dependencies?.[credentialsPackage]).toBe('0.2.0-rc.2')
    expect(manifest.peerDependencies?.[credentialsPackage]).toBeUndefined()
    expect(manifest.peerDependenciesMeta?.[credentialsPackage]).toBeUndefined()
  })
})

/**
 * The host reads the detail page's document through the locale `meta.detail`
 * seam: the first locale file on the language chain that declares one wins,
 * and a declared file missing from the package fails the whole read (no
 * README fallback). These guards keep the declaration, the files whitelist,
 * and the shipped bytes in lockstep.
 */
describe('detail page packaging (official bundle-detail contract)', () => {
  it('declares meta.detail in both locales and ships the named documents', () => {
    expect(manifest.files).toContain('docs')
    for (const lang of ['zh', 'en'] as const) {
      const meta = JSON.parse(readFileSync(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8')).meta
      expect(meta.detail, `locale/${lang}.json meta.detail`).toMatch(/^docs\/[\w.-]+\.md$/)
      const docPath = new URL(`../${meta.detail}`, import.meta.url)
      expect(existsSync(docPath), `${meta.detail} exists`).toBe(true)
      const doc = readFileSync(docPath, 'utf8')
      const image = doc.match(/\]\(([^)]+\.svg)\)/u)?.[1]
      expect(image, 'detail doc embeds the preview SVG').toBeDefined()
      expect(existsSync(new URL(`../docs/${image}`, import.meta.url)), 'preview SVG exists').toBe(true)
    }
  })

  it('declares the package icon and ships it on the files whitelist', () => {
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.files).toContain('icon.svg')
    expect(existsSync(new URL('../icon.svg', import.meta.url))).toBe(true)
  })
})
