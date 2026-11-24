/**
 * Unit coverage for the Keys card's local matching: the panel's own `search`
 * matches the key name and the key string only, so the group-name leg (and the
 * `#<id>` fallback rows render) is entirely this module's contract.
 *
 * @module sub2api-sync/test/client-keysfilter
 */

import { describe, expect, it } from 'vitest'
import { filterKeys, matchKeyQuery, pageSlice } from '../src/client/keysFilter.ts'

describe('matchKeyQuery', () => {
  it('matches the key name case-insensitively', () => {
    expect(matchKeyQuery({ name: 'codex-稳定[号池]', groupName: 'x' }, 'CODEX')).toBe(true)
    expect(matchKeyQuery({ name: '课件测试', groupName: 'x' }, '课件')).toBe(true)
    expect(matchKeyQuery({ name: '福利key3', groupName: 'x' }, 'Key3')).toBe(true)
  })

  it('matches the group name — the leg the panel search cannot cover', () => {
    expect(matchKeyQuery({ name: '福利key3', groupName: '国庆国模特惠' }, '国模')).toBe(true)
    expect(matchKeyQuery({ name: '福利key3', groupName: 'codex-稳定[号池]' }, '号池')).toBe(true)
  })

  it('matches the #<id> label an invisible group renders', () => {
    expect(matchKeyQuery({ name: '福利key3', groupName: '#40' }, '40')).toBe(true)
  })

  it('treats an empty or whitespace term as match-all', () => {
    expect(matchKeyQuery({ name: 'x', groupName: 'y' }, '')).toBe(true)
    expect(matchKeyQuery({ name: 'x', groupName: 'y' }, '   ')).toBe(true)
  })

  it('rejects a term present in neither field', () => {
    expect(matchKeyQuery({ name: '福利key3', groupName: '#40' }, 'claude')).toBe(false)
  })
})

describe('filterKeys', () => {
  const keys = [
    { id: 1, name: 'codex-稳定[号池]', groupId: 7 },
    { id: 2, name: '国庆国模', groupId: 8 },
    { id: 3, name: '福利key3', groupId: 40 },
  ]
  const names: Record<number, string> = { 7: 'codex-稳定[号池]', 8: '国庆国模特惠' }
  const groupNameOf = (gid: number): string => names[gid] ?? `#${gid}`
  const run = (query: string): number[] =>
    filterKeys(keys, query, (key) => ({ name: key.name, groupName: groupNameOf(key.groupId) })).map((key) => key.id)

  it('keeps panel order and returns every row for an empty term', () => {
    expect(run('')).toEqual([1, 2, 3])
    expect(run('   ')).toEqual([1, 2, 3])
  })

  it('matches names and group names in one pass', () => {
    expect(run('国模')).toEqual([2])
    expect(run('特惠')).toEqual([2])
    expect(run('codex')).toEqual([1])
    expect(run('#40')).toEqual([3])
  })

  it('answers an empty array when nothing matches', () => {
    expect(run('nope-nowhere')).toEqual([])
  })
})

describe('pageSlice', () => {
  const items = [1, 2, 3, 4, 5, 6, 7]

  it('slices 1-based pages and reports the page count', () => {
    expect(pageSlice(items, 1, 5)).toEqual({ rows: [1, 2, 3, 4, 5], page: 1, pages: 2 })
    expect(pageSlice(items, 2, 5)).toEqual({ rows: [6, 7], page: 2, pages: 2 })
  })

  it('clamps an out-of-range page instead of painting an empty list', () => {
    expect(pageSlice(items, 9, 5)).toEqual({ rows: [6, 7], page: 2, pages: 2 })
    expect(pageSlice(items, 0, 5)).toEqual({ rows: [1, 2, 3, 4, 5], page: 1, pages: 2 })
    expect(pageSlice([], 3, 5)).toEqual({ rows: [], page: 1, pages: 1 })
  })
})
