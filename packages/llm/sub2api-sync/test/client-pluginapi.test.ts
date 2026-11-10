/**
 * The browser API face's OAuth start: the browser must declare its own
 * `location.origin` in the request body so the host resolves a callback
 * origin the user's browser can actually reach (rewriting reverse proxies
 * hide the real Host header), plus the desktop-shell `pullApp` channel flag
 * that gates the callback page's `dsh://open` pull-back. Runs against a
 * stubbed fetch — no network.
 *
 * @module sub2api-sync/test/client-pluginapi
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPluginApi } from '../src/client/usePluginApi.ts'
import { ROUTES } from '../src/routes.ts'

interface SeenCall {
  url: string
  init: RequestInit | undefined
}

const seen: SeenCall[] = []

// Minimal location stub: usePluginApi reads globalThis.location.origin per call.
const globalWithLocation = globalThis as unknown as { location?: { origin?: string } }
const originalLocation = globalWithLocation.location
globalWithLocation.location = { origin: 'http://10.10.10.20:3079' }

// Navigator stub: usePluginApi reads globalThis.navigator.userAgent for the
// desktop-shell (Electron) detection. defineProperty because Node's own
// `navigator` global is getter-only.
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
function setNavigator(userAgent: string | undefined): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: userAgent === undefined ? originalNavigator?.value : { userAgent },
    configurable: true,
  })
}
setNavigator('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36')

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  seen.push({ url: String(input), init })
  return new Response(JSON.stringify({ ok: true, attemptId: 'a-1', authorizeUrl: 'http://panel:9000/x' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}) as typeof fetch

beforeEach(() => {
  // Re-arm the location stub: afterEach restores the process-wide original,
  // which is undefined outside a browser.
  globalWithLocation.location = { origin: 'http://10.10.10.20:3079' }
})

afterEach(() => {
  seen.length = 0
  globalWithLocation.location = originalLocation
  setNavigator(undefined)
})

describe('createPluginApi().oauthStart', () => {
  it('declares the browser origin and the non-desktop channel in the request body', async () => {
    const api = createPluginApi()
    const answer = await api.oauthStart()
    expect(answer).toEqual({ ok: true, attemptId: 'a-1', authorizeUrl: 'http://panel:9000/x' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(ROUTES.oauthStart)
    expect(seen[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ origin: 'http://10.10.10.20:3079', pullApp: false })
  })

  it('flags the desktop shell (Electron UA) for the callback pull-back', async () => {
    setNavigator('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0.0.0 Electron/37.0.0 Safari/537.36')
    const api = createPluginApi()
    await api.oauthStart()
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ origin: 'http://10.10.10.20:3079', pullApp: true })
  })
})
