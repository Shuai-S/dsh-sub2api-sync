import { describe, expect, it } from 'vitest'
import { detailCardModel } from '../src/client/models/badge.ts'
import type { StatusResponse } from '../src/routes.ts'

function status(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    ok: true,
    auth: { signedIn: false, kind: 'panel' },
    instance: 'http://panel:9000',
    syncRunning: false,
    routes: [],
    ...overrides,
  }
}

describe('detailCardModel', () => {
  it('offers the connect card while signed out', () => {
    expect(detailCardModel(status())).toBe('connect')
  })

  it('falls back to the connect card without a status snapshot (poller quiet)', () => {
    expect(detailCardModel(undefined)).toBe('connect')
  })

  it('offers the connect card for a signed-out auth snapshot', () => {
    expect(detailCardModel(status({ auth: { signedIn: false, kind: 'none' } }))).toBe('connect')
  })

  it('switches to the report card once signed in (either channel)', () => {
    expect(detailCardModel(status({ auth: { signedIn: true, kind: 'panel' } }))).toBe('report')
    expect(detailCardModel(status({ auth: { signedIn: true, kind: 'oauth' } }))).toBe('report')
  })
})
