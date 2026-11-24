/**
 * Sync-progress copy and latency formatting for the settings card. Pure
 * string logic — no React, no fetch — so both the Keys card's button and the
 * sync card's status line render the same words for the same host phase.
 *
 * @module sub2api-sync/client/progress
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SyncProgress } from '../engine.ts'
import type { NS } from './locales.ts'

/**
 * One-line description of the running sync's phase, or `undefined` when the
 * host reports no progress (idle, or an older host half).
 */
export function syncProgressText(t: TranslateNS<typeof NS>, progress: SyncProgress | undefined): string | undefined {
  if (progress === undefined) return undefined
  if (progress.step === 'panel') return t('syncStepPanel')
  if (progress.step === 'write') return t('syncStepWrite')
  return t('syncStepModels', { done: progress.done, total: progress.total })
}

/**
 * Compact duration for the report's meta line: whole milliseconds under a
 * second, one decimal above (`742ms`, `1.3s`). Sub-100ms runs keep their
 * millisecond precision on purpose — "0.0s" would read as a broken timer.
 */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (safe < 1000) return `${Math.round(safe)}ms`
  return `${(safe / 1000).toFixed(1)}s`
}
