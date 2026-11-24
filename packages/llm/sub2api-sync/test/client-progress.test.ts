import { describe, expect, it } from 'vitest'
import { formatDuration, syncProgressText } from '../src/client/progress.ts'

/** Locale stub: the same placeholders the dictionaries carry, same shapes. */
const ZH: Record<string, string> = {
  syncStepPanel: '读取面板…',
  syncStepModels: '拉取模型 {done}/{total}…',
  syncStepWrite: '写入路由…',
}
const t = ((key: string, params?: Record<string, unknown>) => {
  const template = ZH[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}) as unknown as Parameters<typeof syncProgressText>[0]

describe('syncProgressText', () => {
  it('names each host phase', () => {
    expect(syncProgressText(t, { step: 'panel', done: 0, total: 1, startedAt: 0 })).toBe('读取面板…')
    expect(syncProgressText(t, { step: 'write', done: 0, total: 1, startedAt: 0 })).toBe('写入路由…')
  })

  it('carries the per-key counter', () => {
    expect(syncProgressText(t, { step: 'models', done: 2, total: 5, startedAt: 0 })).toBe('拉取模型 2/5…')
  })

  it('answers nothing when the host reports no progress', () => {
    expect(syncProgressText(t, undefined)).toBeUndefined()
  })
})

describe('formatDuration', () => {
  it('keeps milliseconds under a second and one decimal above', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(742)).toBe('742ms')
    expect(formatDuration(999)).toBe('999ms')
    expect(formatDuration(1000)).toBe('1.0s')
    expect(formatDuration(12_345)).toBe('12.3s')
  })

  it('treats nonsense as zero instead of rendering NaN', () => {
    expect(formatDuration(-5)).toBe('0ms')
    expect(formatDuration(Number.NaN)).toBe('0ms')
  })
})
