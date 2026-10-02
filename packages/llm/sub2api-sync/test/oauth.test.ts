/**
 * Unit coverage for the OAuth web channel (C2): PKCE shape, attempt
 * lifecycle, discovery fallback, loopback redirect policy, and the token
 * leg's wire contract. Everything runs against injected fakes — no network.
 *
 * @module sub2api-sync/test/oauth
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  OAuthAttemptStore,
  OAuthError,
  buildAuthorizeUrl,
  callbackPageHtml,
  createPkcePair,
  discoverOAuthEndpoints,
  exchangeAuthorizationCode,
  loopbackCallbackOrigin,
  oauthScopesFor,
  refreshAccessToken,
  resetDiscoveryCache,
  type OAuthEndpoints,
} from '../src/oauth.ts'
import { callbackLangOf } from '../src/routes.ts'

const ENDPOINTS: OAuthEndpoints = {
  authorizationEndpoint: 'http://panel:9000/api/v1/oauth/authorize',
  tokenEndpoint: 'http://panel:9000/api/v1/oauth/token',
  revocationEndpoint: 'http://panel:9000/api/v1/oauth/revoke',
}

afterEach(() => {
  resetDiscoveryCache()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('createPkcePair', () => {
  it('produces a base64url verifier (43-128 chars) and the matching S256 challenge', async () => {
    const { verifier, challenge } = await createPkcePair()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const expected = Buffer.from(digest).toString('base64url')
    expect(challenge).toBe(expected)
  })

  it('produces distinct pairs on every call', async () => {
    const [a, b] = [await createPkcePair(), await createPkcePair()]
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).not.toBe(b.challenge)
  })
})

describe('OAuthAttemptStore', () => {
  it('binds state to the attempt once; a second redirect finds nothing', () => {
    const store = new OAuthAttemptStore()
    const attempt = store.create({ verifier: 'v', redirectUri: 'http://127.0.0.1:1/x', scope: 'openid' })
    expect(store.takeByState(attempt.state)).toBeDefined()
    // The state was consumed by the first lookup (single-use), so a replay
    // of the same redirect is refused.
    expect(store.takeByState(attempt.state)).toBeUndefined()
  })

  it('expires attempts past the TTL', () => {
    const store = new OAuthAttemptStore(60_000)
    const attempt = store.create({ verifier: 'v', redirectUri: 'http://127.0.0.1:1/x', scope: 'openid' }, 0)
    expect(store.takeByState(attempt.state, 61_000)).toBeUndefined()
    expect(store.peek(attempt.id, 61_000)).toBeUndefined()
  })

  it('projects completed/failed phases for the dialog poll', () => {
    const store = new OAuthAttemptStore()
    const a = store.create({ verifier: 'v', redirectUri: 'http://127.0.0.1:1/x', scope: 'openid' })
    store.settle(a.id, 'completed')
    expect(store.peek(a.id)).toEqual({ phase: 'completed' })
    const b = store.create({ verifier: 'v', redirectUri: 'http://127.0.0.1:1/x', scope: 'openid' })
    store.settle(b.id, 'failed', 'invalid_grant')
    expect(store.peek(b.id)).toEqual({ phase: 'failed', error: 'invalid_grant' })
  })

  it('cancel removes the attempt entirely', () => {
    const store = new OAuthAttemptStore()
    const attempt = store.create({ verifier: 'v', redirectUri: 'http://127.0.0.1:1/x', scope: 'openid' })
    expect(store.cancel(attempt.id)).toBe(true)
    expect(store.peek(attempt.id)).toBeUndefined()
  })

  it('unknown states answer undefined', () => {
    const store = new OAuthAttemptStore()
    expect(store.takeByState('nope')).toBeUndefined()
  })
})

describe('discoverOAuthEndpoints', () => {
  it('uses the standard RFC 8414 location first', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input))
      return jsonResponse(200, {
        authorization_endpoint: 'http://panel:9000/api/v1/oauth/authorize',
        token_endpoint: 'http://panel:9000/api/v1/oauth/token',
        revocation_endpoint: 'http://panel:9000/api/v1/oauth/revoke',
      })
    }) as typeof fetch
    const endpoints = await discoverOAuthEndpoints('http://panel:9000', fetchImpl)
    expect(calls).toEqual(['http://panel:9000/.well-known/oauth-authorization-server'])
    expect(endpoints).toEqual(ENDPOINTS)
  })

  it('falls back to the versioned alias when the standard path 404s', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input))
      if (String(input).endsWith('/api/v1/oauth/.well-known')) {
        return jsonResponse(200, {
          authorization_endpoint: 'http://panel:9000/api/v1/oauth/authorize',
          token_endpoint: 'http://panel:9000/api/v1/oauth/token',
        })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    const endpoints = await discoverOAuthEndpoints('http://panel:9000/', fetchImpl)
    expect(calls).toEqual([
      'http://panel:9000/.well-known/oauth-authorization-server',
      'http://panel:9000/api/v1/oauth/.well-known',
    ])
    expect(endpoints.authorizationEndpoint).toBe('http://panel:9000/api/v1/oauth/authorize')
    expect(endpoints.revocationEndpoint).toBeUndefined()
  })

  it('fails loud when neither location answers with complete metadata', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as typeof fetch
    await expect(discoverOAuthEndpoints('http://panel:9000', fetchImpl)).rejects.toThrowError(OAuthError)
    // The failure is cached for the TTL — the next call fails without I/O.
    await expect(discoverOAuthEndpoints('http://panel:9000', fetchImpl)).rejects.toThrowError(OAuthError)
  })
})

describe('loopbackCallbackOrigin', () => {
  it('keeps loopback origins with any port and the fixed plugin path', () => {
    expect(loopbackCallbackOrigin('http://127.0.0.1:19387')).toBe('http://127.0.0.1:19387/plugins/dsh-sub2api-sync/oauth/callback')
    expect(loopbackCallbackOrigin('http://[::1]:19387')).toBe('http://[::1]:19387/plugins/dsh-sub2api-sync/oauth/callback')
  })

  it('rejects non-loopback origins (cross-device)', () => {
    expect(() => loopbackCallbackOrigin('http://192.168.1.5:19387')).toThrowError(OAuthError)
    expect(() => loopbackCallbackOrigin('not a url')).toThrowError(OAuthError)
  })
})

describe('buildAuthorizeUrl', () => {
  it('carries code + S256 + state + scope as query parameters', () => {
    const url = new URL(buildAuthorizeUrl(ENDPOINTS, {
      redirectUri: 'http://127.0.0.1:19387/plugins/dsh-sub2api-sync/oauth/callback',
      scope: 'openid profile keys:read',
      state: 'st-1',
      challenge: 'ch-1',
    }))
    expect(url.toString().startsWith(ENDPOINTS.authorizationEndpoint)).toBe(true)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('dsh-sub2api-sync')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('st-1')
    expect(url.searchParams.get('scope')).toBe('openid profile keys:read')
  })
})

describe('token legs', () => {
  it('exchanges the code with form encoding and repeats the exact redirect_uri + verifier', async () => {
    let method = ''
    let contentType = ''
    let body = ''
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      method = init?.method ?? ''
      contentType = String((init?.headers as Record<string, string>)['content-type'])
      body = String(init?.body)
      return jsonResponse(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 900, scope: 'openid profile', token_type: 'Bearer' })
    }) as typeof fetch
    const pair = await exchangeAuthorizationCode(ENDPOINTS, {
      code: 'code-1',
      redirectUri: 'http://127.0.0.1:19387/plugins/dsh-sub2api-sync/oauth/callback',
      verifier: 'ver-1',
    }, fetchImpl)
    expect(method).toBe('POST')
    expect(contentType).toBe('application/x-www-form-urlencoded')
    const params = new URLSearchParams(body)
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('client_id')).toBe('dsh-sub2api-sync')
    expect(params.get('code')).toBe('code-1')
    expect(params.get('code_verifier')).toBe('ver-1')
    expect(params.get('redirect_uri')).toBe('http://127.0.0.1:19387/plugins/dsh-sub2api-sync/oauth/callback')
    expect(pair.accessToken).toBe('at-1')
    expect(pair.refreshToken).toBe('rt-1')
    expect(pair.scope).toBe('openid profile')
  })

  it('surfaces the provider OAuth error code on failures', async () => {
    const fetchImpl = (async () => jsonResponse(400, { error: 'invalid_grant' })) as typeof fetch
    await expect(exchangeAuthorizationCode(ENDPOINTS, { code: 'c', redirectUri: 'r', verifier: 'v' }, fetchImpl))
      .rejects.toMatchObject({ code: 'invalid_grant' })
  })

  it('refresh posts grant_type=refresh_token and keeps rotation', async () => {
    let body = ''
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body)
      return jsonResponse(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 900, token_type: 'Bearer' })
    }) as typeof fetch
    const pair = await refreshAccessToken(ENDPOINTS, 'rt-old', fetchImpl)
    const params = new URLSearchParams(body)
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('rt-old')
    expect(pair.accessToken).toBe('at-2')
    expect(pair.refreshToken).toBe('rt-2')
  })
})

describe('oauthScopesFor', () => {
  it('adds keys:revoke only when orphan revocation is enabled', () => {
    expect(oauthScopesFor(false)).toBe('openid profile groups:read keys:read keys:create')
    expect(oauthScopesFor(undefined)).toBe('openid profile groups:read keys:read keys:create')
    expect(oauthScopesFor(true)).toBe('openid profile groups:read keys:read keys:create keys:revoke')
  })
})

describe('callbackPageHtml', () => {
  it('success page (zh default): brand row, single-locale title, official message, 打开应用 button', () => {
    const html = callbackPageHtml('success', '你可以关闭此页面，返回桌面端继续工作。')
    expect(html).toContain('<span class="wordmark">Sub2API</span>')
    expect(html).toContain('<span class="badge">SYNC</span>')
    expect(html).toContain('<title>授权成功</title>')
    expect(html).toContain('<h1>授权成功</h1>')
    expect(html).toContain('你可以关闭此页面，返回桌面端继续工作。')
    expect(html).toContain('>打开应用</button>')
    expect(html).toContain("location.href = 'dsh://open'")
    // No bilingual compounds, no hint paragraph.
    expect(html).not.toContain('Authorization complete')
    expect(html).not.toContain('若应用未自动置前')
    expect(html).not.toContain('class="hint"')
  })

  it('renders English copy when the callback locale is en', () => {
    const html = callbackPageHtml('success', 'You can close this page and return to the desktop app to continue.', 'en')
    expect(html).toContain('<title>Authorization complete</title>')
    expect(html).toContain('<h1>Authorization complete</h1>')
    expect(html).toContain('>Open app</button>')
    expect(html).toContain('lang="en"')
    expect(html).not.toContain('授权成功')
  })

  it('keeps the official dark-gradient welcome panel on the right (both variants)', () => {
    for (const html of [callbackPageHtml('success', 'ok'), callbackPageHtml('failure', 'boom')]) {
      expect(html).toContain('class="art"')
      expect(html).toContain('欢迎对话 DeepSeek Harness，<br>共探智能上限')
    }
  })

  it('failure page: same layout with the escaped error, no open-app button', () => {
    const html = callbackPageHtml('failure', '授权被拒绝（<script>alert(1)</script>）')
    expect(html).toContain('<span class="wordmark">Sub2API</span>')
    expect(html).toContain('<h1>授权失败</h1>')
    expect(html).toContain('授权被拒绝（&#60;script&#62;alert(1)&#60;/script&#62;）')
    expect(html).not.toContain('s2s-back')
    expect(html).toContain('window.close()')
  })
})

describe('callbackLangOf', () => {
  it('takes the first Accept-Language tag: en* → en, anything else → zh', () => {
    expect(callbackLangOf('en-US,en;q=0.9')).toBe('en')
    expect(callbackLangOf('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh')
    expect(callbackLangOf('ja,en;q=0.8')).toBe('zh')
    expect(callbackLangOf(undefined)).toBe('zh')
    expect(callbackLangOf('')).toBe('zh')
  })
})
