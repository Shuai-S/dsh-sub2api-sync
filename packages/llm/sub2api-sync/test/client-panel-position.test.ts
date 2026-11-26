/**
 * Geometry coverage for the picker's plugin-owned panel placement.
 *
 * The host's `useAnchoredPosition` was removed from the primitives package,
 * so the clamp math now lives in `src/client/usePanelPosition.ts`. These
 * cases pin the contract the picker relied on: place against the chosen
 * anchor edge, then pull the panel back inside the viewport only on axes
 * that have a real measured size.
 *
 * @module sub2api-sync/test/client-panel-position
 */

import { describe, expect, it } from 'vitest'
import { computePanelPosition } from '../src/client/usePanelPosition.ts'
import type { PanelPositionInput } from '../src/client/usePanelPosition.ts'

/** A comfortably placed panel: no clamp should fire for the base case. */
const BASE: PanelPositionInput = {
  anchor: { left: 100, right: 300, top: 300, bottom: 340 },
  panel: { width: 200, height: 150 },
  side: 'bottom',
  align: 'start',
  gap: 6,
  margin: 24,
  viewport: { width: 1280, height: 800 },
  topMargin: 24,
}

const place = (patch: Partial<PanelPositionInput> = {}): { left: number; top: number } =>
  computePanelPosition({ ...BASE, ...patch })

describe('computePanelPosition', () => {
  it('hangs the panel below the anchor, left-aligned by default', () => {
    expect(place()).toEqual({ left: 100, top: 346 })
  })

  it('places the panel above the anchor for side top', () => {
    expect(place({ side: 'top' })).toEqual({ left: 100, top: 144 })
  })

  it('right-aligns the panel to the anchor for align end', () => {
    expect(place({ align: 'end', anchor: { ...BASE.anchor, right: 340 } })).toEqual({ left: 140, top: 346 })
  })

  it('clamps a panel that overflows the left edge to the margin', () => {
    expect(place({ anchor: { ...BASE.anchor, left: 10 } }).left).toBe(24)
  })

  it('clamps a panel that overflows the right edge inside the viewport', () => {
    expect(place({ anchor: { ...BASE.anchor, left: 1100 } }).left).toBe(1056)
  })

  it('clamps the top edge to the supplied top margin', () => {
    const top = place({ side: 'top', topMargin: 40, anchor: { ...BASE.anchor, top: 40 } }).top
    expect(top).toBe(40)
  })

  it('clamps the bottom edge inside the viewport', () => {
    const top = place({ anchor: { ...BASE.anchor, bottom: 780 } }).top
    expect(top).toBe(626)
  })

  it('leaves both axes alone when the panel has not been measured yet', () => {
    const position = place({
      panel: { width: 0, height: 0 },
      anchor: { left: 5, right: 15, top: 2, bottom: 10 },
      topMargin: 40,
    })
    expect(position).toEqual({ left: 5, top: 16 })
  })
})
