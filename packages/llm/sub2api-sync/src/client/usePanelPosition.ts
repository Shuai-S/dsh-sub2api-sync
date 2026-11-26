/// <reference lib="dom" />
// The node-side test program (lib ES2023, no DOM) compiles this module through
// the geometry test; pull the DOM declarations in so the hook's browser globals
// type-check there as well as in the client program.
/**
 * Anchored placement for the group picker's panel, owned by this plugin.
 *
 * The panel used to be placed by `useAnchoredPosition` from
 * `@deepseek-ai/dsh-client-ui-primitives`. The host dropped that export in
 * 0.2.2-rc.5, so the hook — and the internal `overlayTopMargin` helper it
 * consulted — live here now. Vendoring keeps the picker working against host
 * releases on both sides of the removal, while the placement contract stays
 * the same: measure the anchor's viewport rect and the panel's offset size,
 * offset the panel below (or above) the anchor, and clamp it inside the
 * viewport, re-running whenever either side moves or resizes.
 *
 * @module sub2api-sync/client/usePanelPosition
 */

import { useLayoutEffect, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

/** Which anchor edge the panel hangs from. */
export type PanelSide = 'top' | 'bottom'
/** Which anchor edge the panel lines up with horizontally. */
export type PanelAlign = 'start' | 'end'

/** The anchor's viewport-space box; only the edges the placement reads. */
export interface PanelAnchorRect {
  left: number
  right: number
  top: number
  bottom: number
}

/** The panel's measured size, from `offsetWidth`/`offsetHeight`. */
export interface PanelSize {
  width: number
  height: number
}

/** The visible viewport the panel must stay inside. */
export interface PanelViewport {
  width: number
  height: number
}

/** Everything the pure placement needs, so it can be tested without a DOM. */
export interface PanelPositionInput {
  anchor: PanelAnchorRect
  panel: PanelSize
  side: PanelSide
  align: PanelAlign
  /** Distance between the anchor edge named by `side` and the panel. */
  gap: number
  /** Distance kept between the panel and each viewport edge. */
  margin: number
  viewport: PanelViewport
  /** Top inset after frame clearance; computed by {@link overlayTopMargin}. */
  topMargin: number
}

/** Fixed coordinates for the panel. */
export interface PanelPosition {
  left: number
  top: number
}

/**
 * Place a fixed-position panel against its anchor and clamp it to the
 * viewport. Pure geometry: the hook below supplies the live measurements.
 *
 * A zero measured width/height means the panel has not laid out yet (it is
 * hidden or just mounted), so its axis is left unclamped — clamping a 0-size
 * panel would pin it to the far margin and flash before the next re-fit.
 */
export function computePanelPosition(input: PanelPositionInput): PanelPosition {
  const { anchor, panel, side, align, gap, margin, viewport, topMargin } = input
  let left = align === 'end' ? anchor.right - panel.width : anchor.left
  let top = side === 'top' ? anchor.top - gap - panel.height : anchor.bottom + gap
  if (panel.width > 0) left = Math.min(Math.max(left, margin), viewport.width - panel.width - margin)
  if (panel.height > 0) top = Math.min(Math.max(top, topMargin), viewport.height - panel.height - margin)
  return { left, top }
}

/**
 * Resolve the top margin an overlay keeps from the viewport edge.
 *
 * The desktop frame reserves a strip along the window's top edge; an overlay
 * that ignores it lands under the frame chrome. The CSS custom property
 * carries that strip's height (absent outside the desktop shell, which is why
 * a NaN keeps the caller's own margin), and fullscreen drops it because the
 * frame is not there. While the anchor's top edge is on screen the margin is
 * also capped at `anchor.bottom + gap`, so an overlay opened from a control
 * inside the strip stays next to it instead of being pushed below the strip.
 *
 * @param min - the overlay's own viewport margin in px, used as the floor.
 * @param anchor - the anchor rect, when one is known.
 * @param gap - distance the overlay keeps below `anchor`.
 */
export function overlayTopMargin(
  min: number,
  anchor?: { readonly top: number; readonly bottom: number },
  gap = 0,
): number {
  // The module is imported by node-side tests; touch no DOM until called in a
  // browser (or jsdom) where the helper actually has a document to inspect.
  if (typeof document === 'undefined') return min
  const root = document.documentElement
  const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance'))
  if (Number.isNaN(clearance)) return min
  const cap = anchor !== undefined && anchor.top >= 0 ? anchor.bottom + gap : Number.POSITIVE_INFINITY
  return Math.max(min, Math.min((root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20, cap))
}

/** Inputs for {@link useAnchoredPanelPosition}. */
export interface AnchoredPanelPositionOptions {
  /** Whether the panel is mounted and should track its anchor. */
  open: boolean
  /** Element whose viewport rect anchors the panel. */
  anchorRef: RefObject<HTMLElement | null>
  /** The floating panel, measured so the clamp uses its real size. */
  panelRef: RefObject<HTMLElement | null>
  /** Which anchor edge the panel hangs from; defaults to `bottom`. */
  side?: PanelSide
  /** Which anchor edge the panel lines up with; defaults to `start`. */
  align?: PanelAlign
  /** Distance kept between the anchor edge named by `side` and the panel. */
  gap: number
  /** Distance kept between the panel and each viewport edge. */
  margin: number
}

/**
 * Keep a fixed-position panel anchored to its trigger.
 *
 * A portaled panel is placed from its anchor's viewport rect, which stops
 * being true the moment anything scrolls or the window resizes. This measures
 * the anchor and the panel in the same commit that opens the panel (before
 * paint), then re-runs on scroll — capture phase, so scrollers nested in the
 * page are caught too — on resize, and on the panel's own size changes while
 * it is open.
 *
 * @param options - open state, refs, placement side/alignment, gap and margin.
 * @returns `left`/`top` for the panel, or `null` before the first measurement
 *   and while closed.
 */
export function useAnchoredPanelPosition(options: AnchoredPanelPositionOptions): CSSProperties | null {
  const { open, anchorRef, panelRef, side = 'bottom', align = 'start', gap, margin } = options
  const [position, setPosition] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const place = (): void => {
      if (typeof window === 'undefined') return
      const rect = anchorRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const panel = panelRef.current
      setPosition(computePanelPosition({
        anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        panel: { width: panel?.offsetWidth ?? 0, height: panel?.offsetHeight ?? 0 },
        side,
        align,
        gap,
        margin,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        topMargin: overlayTopMargin(margin, rect, gap),
      }))
    }
    // The first run measures the panel in the commit that opened it, so the
    // clamp uses real dimensions before anything paints.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    // The panel's own height changes without either event — the filter
    // shrinking the list, or a wrapped row growing — and a stale clamp would
    // let a panel near the bottom edge cross its margin. The guard keeps the
    // hook usable where `ResizeObserver` is absent, which is how node tests run.
    const panel = panelRef.current
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && panel !== null) {
      observer = new ResizeObserver(place)
      observer.observe(panel)
    }
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, anchorRef, panelRef, side, align, gap, margin])
  return position
}
