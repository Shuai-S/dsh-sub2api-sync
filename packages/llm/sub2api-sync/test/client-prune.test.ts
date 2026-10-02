import { describe, expect, it } from 'vitest'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { dropSelectedKey, pruneInvalidSelection } from '../src/client/useConfigForm.ts'
import type { SyncReport } from '../src/engine.ts'

/** Minimal ConfigForm double: snapshot values + recorded field writes. */
function fakeConfig(selectedKeys: number[]): { config: ConfigForm<{ selectedKeys?: number[] }>; writes: unknown[] } {
  const writes: unknown[] = []
  const config = {
    getSnapshot: () => ({ status: 'ready', value: { selectedKeys }, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' }),
    subscribe: () => () => undefined,
    set: async (field: string, value: unknown) => { writes.push([field, value]); return true },
    unset: async () => true,
    mutate: async () => true,
  } as unknown as ConfigForm<{ selectedKeys?: number[] }>
  return { config, writes }
}

function reportOf(invalidIds: number[]): SyncReport {
  return {
    entries: invalidIds.map((id) => ({ groupId: id, route: `${id}`, action: 'failed' as const, error: 'gone', invalid: true as const })),
    removed: [],
    writes: 0,
    attempts: 1,
    warnings: [],
  }
}

describe('pruneInvalidSelection', () => {
  it('drops stale ids and keeps the rest sorted', async () => {
    const { config, writes } = fakeConfig([2, 1, 9])
    const changed = await pruneInvalidSelection(config, reportOf([2, 9]))
    expect(changed).toBe(true)
    expect(writes).toEqual([['selectedKeys', [1]]])
  })

  it('does nothing when no entry is invalid', async () => {
    const { config, writes } = fakeConfig([1, 2])
    expect(await pruneInvalidSelection(config, { entries: [], removed: [], writes: 0, attempts: 1, warnings: [] })).toBe(false)
    expect(writes).toEqual([])
  })

  it('does nothing when the invalid ids were not selected', async () => {
    const { config, writes } = fakeConfig([1])
    expect(await pruneInvalidSelection(config, reportOf([9]))).toBe(false)
    expect(writes).toEqual([])
  })
})

describe('dropSelectedKey', () => {
  it('drops the removed key from the selection (no resurrection on the next sync)', async () => {
    const { config, writes } = fakeConfig([3, 1, 4])
    expect(await dropSelectedKey(config, 1)).toBe(true)
    expect(writes).toEqual([['selectedKeys', [3, 4]]])
  })

  it('does nothing when the key was not selected', async () => {
    const { config, writes } = fakeConfig([1, 2])
    expect(await dropSelectedKey(config, 9)).toBe(false)
    expect(writes).toEqual([])
  })
})
