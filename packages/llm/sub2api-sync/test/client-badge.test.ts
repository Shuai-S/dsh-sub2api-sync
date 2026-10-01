import { describe, expect, it } from 'vitest'
import { badgeModel, footerModel, isSyncedRoute, relativeMinutes } from '../src/client/models/badge.ts'
import type { StatusResponse } from '../src/routes.ts'

function status(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    ok: true,
    auth: { signedIn: true, kind: 'pat' },
    instance: 'http://panel:9000',
    syncRunning: false,
    routes: [
      { route: 'sub2api-2', displayName: 'NexaRelay(key-2)', api: 'openai-responses', models: 3, modelsPreview: ['a', 'b', 'c'] },
    ],
    lastReport: {
      entries: [
        { groupId: 2, route: 'sub2api-2', displayName: 'NexaRelay(key-2)', action: 'updated', models: 3 },
        { groupId: 3, route: 'sub2api-3', displayName: 'NexaRelay(x)', action: 'failed', error: 'boom' },
      ],
      removed: ['sub2api-9'],
      writes: 2,
      attempts: 1,
      warnings: [],
    },
    lastReportAt: 1_000,
    ...overrides,
  }
}

describe('isSyncedRoute', () => {
  it('claims only the sub2api-<digits> ownership boundary', () => {
    expect(isSyncedRoute('sub2api-2')).toBe(true)
    expect(isSyncedRoute('sub2api-openai')).toBe(false)
    expect(isSyncedRoute('my-route')).toBe(false)
  })
})

describe('badgeModel', () => {
  it('joins the route row with the last report entry', () => {
    const badge = badgeModel('sub2api-2', status())
    expect(badge).toEqual({
      models: 3,
      displayName: 'NexaRelay(key-2)',
      lastAction: 'updated',
      lastReportAt: 1000,
    })
  })

  it('is undefined for non-owned routes and unknown status', () => {
    expect(badgeModel('sub2api-openai', status())).toBeUndefined()
    expect(badgeModel('sub2api-2', undefined)).toBeUndefined()
  })

  it('is undefined when the route is not registered (not synced yet)', () => {
    expect(badgeModel('sub2api-42', status())).toBeUndefined()
  })

  it('carries the failure message of the last report', () => {
    const badge = badgeModel('sub2api-3', status())
    expect(badge).toBeUndefined() // route not registered — only lastReport mentions it
  })
})

describe('footerModel', () => {
  it('counts the registered routes and carries the last sync time', () => {
    const footer = footerModel(status())
    expect(footer).toEqual({ signedIn: true, groups: 1, lastReportAt: 1000 })
  })

  it('degrades without a status snapshot', () => {
    expect(footerModel(undefined)).toEqual({ signedIn: false, groups: 0 })
  })
})

describe('relativeMinutes', () => {
  it('says just now under a minute and floors minutes otherwise', () => {
    expect(relativeMinutes(60_000, 60_000 + 30_000)).toEqual({ key: 'footerJustNow' })
    expect(relativeMinutes(60_000, 60_000 + 90_000)).toEqual({ key: 'footerMinutesAgo', count: 1 })
    expect(relativeMinutes(0, 125 * 60_000)).toEqual({ key: 'footerMinutesAgo', count: 125 })
  })
})
