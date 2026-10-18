import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Build/regression guard for the create-key dialog's group picker panel.
 *
 * The panel must stay `position: fixed`: MenuSurface defaults to
 * `position: relative`, and without the override the viewport-coordinate
 * `top`/`left` from useAnchoredPosition become relative offsets — the panel
 * displaces across the modal, squeezes the form as an in-flow flex item, and
 * stays clipped by the card's `overflow: hidden` (the blank floating box
 * reported on 2026-10-18, fixed the same day).
 */
const STYLES = readFileSync(join(import.meta.dirname, '../src/client/styles.ts'), 'utf8')
const BUNDLE = join(import.meta.dirname, '../lib/client.js')

/** Body of the first `{ … }` block following `selector`. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) return ''
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return close === -1 ? '' : css.slice(open + 1, close)
}

describe('group picker panel positioning', () => {
  it('keeps .s2s-groupPanel fixed-positioned in the stylesheet source', () => {
    const body = ruleBody(STYLES, '.s2s-groupPanel')
    expect(body).not.toBe('')
    expect(body).toContain('position: fixed')
  })

  it('guards the built client bundle when it has been built', { skip: !existsSync(BUNDLE) }, () => {
    const bundle = readFileSync(BUNDLE, 'utf8')
    expect(ruleBody(bundle, '.s2s-groupPanel')).toContain('position: fixed')
  })
})
