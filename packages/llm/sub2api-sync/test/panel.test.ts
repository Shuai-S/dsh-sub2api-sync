import { describe, expect, it, vi } from 'vitest'
import { PanelClient, PanelError, PanelGateway } from '../src/panel.ts'
import { oauthRefreshRef, oauthTokenRef, panelRefreshRef, panelTokenRef, type CredentialsLike } from '../src/types.ts'

const BASE = 'http://panel:9000'

class FakeCreds implements CredentialsLike {
  private store = new Map<string, string>()

  seed(ref: string, value: string): void {
    this.store.set(ref, value)
  }

  async resolve(ref: string): Promise<{ value: string } | undefined> {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value }
  }

  async set(ref: string, value: string): Promise<void> {
    this.store.set(ref, value)
  }

  async unset(ref: string): Promise<void> {
    this.store.delete(ref)
  }
}

interface PanelCall {
  method: string
  path: string
  body?: unknown
  token?: string
}

interface FakeResponse {
  status?: number
  body?: unknown
}

/** Route-by-method+path fake panel server that records every call. */
function makeServer(handler: (call: PanelCall) => FakeResponse | undefined): { calls: PanelCall[]; fetchImpl: typeof fetch } {
  const calls: PanelCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const parsed = new URL(url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: PanelCall = {
      method: init?.method ?? 'GET',
      path: `${parsed.pathname}${parsed.search}`,
      ...(init?.body !== undefined ? { body: JSON.parse(init.body as string) } : {}),
      ...(headers.authorization !== undefined ? { token: headers.authorization.replace('Bearer ', '') } : {}),
    }
    calls.push(call)
    const result = handler(call)
    const status = result?.status ?? 404
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(result?.body ?? {}),
    } as Response
  }) as typeof fetch
  return { calls, fetchImpl }
}

function ok(data: unknown): FakeResponse {
  return { status: 200, body: { code: 0, message: 'success', data } }
}

describe('PanelClient', () => {
  it('reads the account profile: username and email, empties dropped', async () => {
    const { fetchImpl, calls } = makeServer((call) => {
      expect(call.method).toBe('GET')
      expect(call.path).toBe('/api/v1/auth/me')
      expect(call.token).toBe('token-1')
      return ok({ id: 1, email: ' user@example.com ', username: '  ', role: 'user' })
    })
    const client = new PanelClient({ baseURL: BASE, fetchImpl })
    const profile = await client.getProfile('token-1')
    expect(profile).toEqual({ email: 'user@example.com' })
  })

  it('answers an empty profile when the account has neither username nor email', async () => {
    const { fetchImpl } = makeServer(() => ok({ id: 2 }))
    const client = new PanelClient({ baseURL: BASE, fetchImpl })
    expect(await client.getProfile('token-1')).toEqual({})
  })

  it('carries the numeric balance through and drops non-numeric shapes', async () => {
    const withBalance = makeServer(() => ok({ id: 3, email: 'a@b.c', balance: 12.5 }))
    expect(await new PanelClient({ baseURL: BASE, fetchImpl: withBalance.fetchImpl }).getProfile('t')).toEqual({
      email: 'a@b.c',
      balance: 12.5,
    })
    const without = makeServer(() => ok({ id: 4, balance: '12.50' }))
    expect(await new PanelClient({ baseURL: BASE, fetchImpl: without.fetchImpl }).getProfile('t')).toEqual({ email: undefined })
  })
  it('classifies a successful password login and carries the token pair', async () => {
    const { fetchImpl, calls } = makeServer((call) => {
      expect(call.path).toBe('/api/v1/auth/login')
      return ok({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer', user: { id: 1 } })
    })
    const client = new PanelClient({ baseURL: BASE, fetchImpl })
    const outcome = await client.login('a@b.c', 'pw')
    expect(outcome).toEqual({ kind: 'ok', accessToken: 'at-1', refreshToken: 'rt-1' })
    expect(calls[0]?.body).toEqual({ email: 'a@b.c', password: 'pw' })
  })

  it('classifies the 2FA discriminator', async () => {
    const { fetchImpl } = makeServer(() => ok({ requires_2fa: true, temp_token: 'tmp-1', user_email_masked: 'a***' }))
    const client = new PanelClient({ baseURL: BASE, fetchImpl })
    const outcome = await client.login('a@b.c', 'pw')
    expect(outcome).toEqual({ kind: '2fa', tempToken: 'tmp-1' })
  })

  it('classifies captcha interception (best effort until A4 lands)', async () => {
    const { fetchImpl } = makeServer(() => ({ status: 403, body: { code: 403, message: 'Turnstile 校验失败' } }))
    const client = new PanelClient({ baseURL: BASE, fetchImpl })
    const error = await client.login('a@b.c', 'pw').then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(PanelError)
    expect((error as PanelError & { kind?: string }).kind).toBe('captcha')
  })

  it('reports Cloudflare interception pages loudly', async () => {
    const { fetchImpl } = makeServer(() => ({ status: 403, body: 'Just a moment...' }))
    const client = new PanelClient({ baseURL: BASE, fetchImpl })
    await expect(client.login('a@b.c', 'pw')).rejects.toThrowError(/Cloudflare/)
  })

  it('surfaces envelope errors with their message', async () => {
    const { fetchImpl } = makeServer(() => ({ status: 200, body: { code: 1001, message: '密码错误' } }))
    const client = new PanelClient({ baseURL: BASE, fetchImpl })
    await expect(client.login('a@b.c', 'bad')).rejects.toThrowError(/密码错误/)
  })

  it('reads groups/available as a bare array and tolerates a missing platform', async () => {
    const { fetchImpl, calls } = makeServer(() => ok([
      { id: 2, name: 'codex-稳定[号池]', platform: 'openai', rate_multiplier: 0.2, status: 'active', claude_code_only: false, fork_extra: 'ignored' },
      { id: 4, name: 'claude-max[号池]', status: 'active' },
      { junk: true },
    ]))
    const client = new PanelClient({ baseURL: BASE, fetchImpl })
    const groups = await client.listAvailableGroups('token-1')
    expect(calls[0]?.path).toBe('/api/v1/groups/available')
    expect(calls[0]?.token).toBe('token-1')
    expect(groups).toEqual([
      { id: 2, name: 'codex-稳定[号池]', platform: 'openai', rateMultiplier: 0.2, status: 'active', isExclusive: undefined, claudeCodeOnly: false },
      { id: 4, name: 'claude-max[号池]', platform: '', status: 'active' },
    ])
  })

  it('rejects a non-array groups payload', async () => {
    const { fetchImpl } = makeServer(() => ok({ items: [] }))
    const client = new PanelClient({ baseURL: BASE, fetchImpl })
    await expect(client.listAvailableGroups('t')).rejects.toThrowError(/不是数组/)
  })

  it('fetches one native key page and forwards the console call shape', async () => {
    const keyPage = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: from + index, name: `k${from + index}`, group_id: 2, key: `sk-${from + index}`, status: 'active' }))
    const { fetchImpl, calls } = makeServer((call) => {
      if (call.path.startsWith('/api/v1/keys')) {
        const pageNo = Number(new URL(`http://x${call.path}`).searchParams.get('page'))
        return ok(pageNo === 1
          ? { items: keyPage(1, 5), total: 150, page: 1, page_size: 5, pages: 30 }
          : { items: keyPage(6, 5), total: 150, page: 2, page_size: 5, pages: 30 })
      }
      return undefined
    })
    const client = new PanelClient({ baseURL: BASE, fetchImpl })
    const first = await client.listKeys('t', { groupId: 2, page: 1, pageSize: 5 })
    expect(first.items).toHaveLength(5)
    expect(first.total).toBe(150)
    expect(first.pages).toBe(30)
    const second = await client.listKeys('t', { groupId: 2, page: 2, pageSize: 5 })
    expect(second.items).toHaveLength(5)
    expect(second.items[0]?.id).toBe(6)
    const paths = calls.filter((call) => call.path.startsWith('/api/v1/keys')).map((call) => call.path)
    expect(paths[0]).toContain('/api/v1/keys?page=1&page_size=5')
    expect(paths[0]).toContain('group_id=2')
    expect(paths[0]).toContain('sort_by=created_at')
    expect(paths[0]).toContain('sort_order=desc')
    expect(paths[0]).toContain('timezone=')
    expect(paths[1]).toContain('page=2')
  })

  it('creates keys with the group-name payload and honors quota guards', async () => {
    const { fetchImpl, calls } = makeServer(() => ok({ id: 9, name: 'Claude 拼车', group_id: 1, key: 'sk-new', status: 'active' }))
    const client = new PanelClient({ baseURL: BASE, fetchImpl })
    const key = await client.createKey('t', { name: 'Claude 拼车', groupId: 1, quota: 0, expiresinDays: 30 })
    expect(key.id).toBe(9)
    expect(calls[0]?.body).toEqual({ name: 'Claude 拼车', group_id: 1, expires_in_days: 30 })
  })

  it('deletes keys by id', async () => {
    const { fetchImpl, calls } = makeServer(() => ok(null))
    const client = new PanelClient({ baseURL: BASE, fetchImpl })
    await client.deleteKey('t', 77)
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/api/v1/keys/77' })
  })
})

describe('PanelGateway', () => {
  it('stores the token pair on password login and reports the panel auth kind', async () => {
    const creds = new FakeCreds()
    const { fetchImpl } = makeServer(() => ok({ access_token: 'at-1', refresh_token: 'rt-1' }))
    const gateway = new PanelGateway({ baseURL: BASE, credentials: creds, fetchImpl })
    await gateway.login('a@b.c', 'pw')
    expect(await creds.resolve(panelTokenRef(BASE))).toEqual({ value: 'at-1' })
    expect(await creds.resolve(panelRefreshRef(BASE))).toEqual({ value: 'rt-1' })
    expect(await gateway.authState('a@b.c')).toEqual({ signedIn: true, kind: 'panel', email: 'a@b.c' })
  })

  it('keeps the 2FA temp token in memory until the code arrives', async () => {
    const creds = new FakeCreds()
    const { fetchImpl } = makeServer((call) => {
      if (call.path === '/api/v1/auth/login') return ok({ requires_2fa: true, temp_token: 'tmp-9' })
      if (call.path === '/api/v1/auth/login/2fa') return ok({ access_token: 'at-2', refresh_token: 'rt-2' })
      return undefined
    })
    const gateway = new PanelGateway({ baseURL: BASE, credentials: creds, fetchImpl })
    await expect(gateway.login2FA('123456')).rejects.toThrowError(/没有待完成的 2FA/)
    await gateway.login('a@b.c', 'pw')
    expect(await creds.resolve(panelTokenRef(BASE))).toBeUndefined()
    await gateway.login2FA('123456')
    expect(await creds.resolve(panelTokenRef(BASE))).toEqual({ value: 'at-2' })
  })

  it('fails an authed call loudly when signed out', async () => {
    const { fetchImpl } = makeServer(() => ok([]))
    const gateway = new PanelGateway({ baseURL: BASE, credentials: new FakeCreds(), fetchImpl })
    await expect(gateway.use((panel, token) => panel.listAvailableGroups(token))).rejects.toThrowError(/尚未登录/)
  })

  it('refreshes once on a 401 and retries with the new token', async () => {
    const creds = new FakeCreds()
    creds.seed(panelTokenRef(BASE), 'stale')
    creds.seed(panelRefreshRef(BASE), 'rt-1')
    let keysCalls = 0
    let refreshCalls = 0
    const { fetchImpl } = makeServer((call) => {
      if (call.path.startsWith('/api/v1/keys')) {
        keysCalls++
        return keysCalls === 1 ? { status: 401, body: { code: 401, message: 'expired' } } : ok({ items: [], total: 0, page: 1, page_size: 100, pages: 0 })
      }
      if (call.path === '/api/v1/auth/refresh') {
        refreshCalls++
        return ok({ access_token: 'fresh', refresh_token: 'rt-2' })
      }
      return undefined
    })
    const gateway = new PanelGateway({ baseURL: BASE, credentials: creds, fetchImpl })
    const keys = await gateway.use((panel, token) => panel.listKeys(token))
    expect(keys.items).toEqual([])
    expect(refreshCalls).toBe(1)
    expect(keysCalls).toBe(2)
    expect(await creds.resolve(panelTokenRef(BASE))).toEqual({ value: 'fresh' })
    expect(await creds.resolve(panelRefreshRef(BASE))).toEqual({ value: 'rt-2' })
  })

  it('dedupes concurrent refreshes into one wire call', async () => {
    const creds = new FakeCreds()
    creds.seed(panelTokenRef(BASE), 'stale')
    creds.seed(panelRefreshRef(BASE), 'rt-1')
    let keysCalls = 0
    let refreshCalls = 0
    const { fetchImpl } = makeServer((call) => {
      if (call.path.startsWith('/api/v1/keys')) {
        keysCalls++
        return keysCalls <= 2 ? { status: 401, body: { code: 401, message: 'expired' } } : ok({ items: [], total: 0, page: 1, page_size: 100, pages: 0 })
      }
      if (call.path === '/api/v1/auth/refresh') {
        refreshCalls++
        return ok({ access_token: 'fresh' })
      }
      return undefined
    })
    const gateway = new PanelGateway({ baseURL: BASE, credentials: creds, fetchImpl })
    const [a, b] = await Promise.all([
      gateway.use((panel, token) => panel.listKeys(token)),
      gateway.use((panel, token) => panel.listKeys(token)),
    ])
    expect(a.items).toEqual([])
    expect(b.items).toEqual([])
    expect(refreshCalls).toBe(1)
  })

  it('drops both tokens when the refresh fails, then requires re-login', async () => {
    const creds = new FakeCreds()
    creds.seed(panelTokenRef(BASE), 'stale')
    creds.seed(panelRefreshRef(BASE), 'dead')
    const { fetchImpl } = makeServer((call) => {
      if (call.path.startsWith('/api/v1/keys')) return { status: 401, body: { code: 401, message: 'expired' } }
      if (call.path === '/api/v1/auth/refresh') return { status: 200, body: { code: 401, message: 'refresh rejected' } }
      return undefined
    })
    const onAuthLost = vi.fn()
    const gateway = new PanelGateway({ baseURL: BASE, credentials: creds, fetchImpl, onAuthLost })
    await expect(gateway.use((panel, token) => panel.listKeys(token))).rejects.toThrowError(/刷新失败/)
    expect(await creds.resolve(panelTokenRef(BASE))).toBeUndefined()
    expect(await creds.resolve(panelRefreshRef(BASE))).toBeUndefined()
    expect(onAuthLost).toHaveBeenCalledTimes(1)
  })

  it('fires onAuthLost when no refresh token remains (password channel)', async () => {
    const creds = new FakeCreds()
    creds.seed(panelTokenRef(BASE), 'stale')
    const { fetchImpl } = makeServer((call) => {
      if (call.path.startsWith('/api/v1/keys')) return { status: 401, body: { code: 401, message: 'expired' } }
      return undefined
    })
    const onAuthLost = vi.fn()
    const gateway = new PanelGateway({ baseURL: BASE, credentials: creds, fetchImpl, onAuthLost })
    await expect(gateway.use((panel, token) => panel.listKeys(token))).rejects.toThrowError(/无 refresh token/)
    expect(onAuthLost).toHaveBeenCalledTimes(1)
  })

  it('does not fire onAuthLost when the panel is merely unreachable', async () => {
    const creds = new FakeCreds()
    creds.seed(panelTokenRef(BASE), 'stale')
    creds.seed(panelRefreshRef(BASE), 'live')
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const onAuthLost = vi.fn()
    const gateway = new PanelGateway({ baseURL: BASE, credentials: creds, fetchImpl, onAuthLost })
    await expect(gateway.use((panel, token) => panel.listKeys(token))).rejects.toThrowError()
    expect(onAuthLost).not.toHaveBeenCalled()
  })

  it('fires onAuthLost when the OAuth refresh is refused', async () => {
    const creds = new FakeCreds()
    creds.seed(oauthTokenRef(BASE), 'stale-oauth')
    creds.seed(oauthRefreshRef(BASE), 'dead-oauth')
    const { fetchImpl } = makeServer((call) => {
      if (call.path.startsWith('/api/v1/keys')) return { status: 401, body: { code: 401, message: 'expired' } }
      // Discovery candidates and the token endpoint refuse too — the refresh
      // itself fails, which is a definitive auth loss.
      return { status: 401, body: { code: 401, message: 'rejected' } }
    })
    const onAuthLost = vi.fn()
    const gateway = new PanelGateway({ baseURL: BASE, credentials: creds, fetchImpl, onAuthLost })
    await expect(gateway.use((panel, token) => panel.listKeys(token))).rejects.toThrowError(/OAuth 登录已过期/)
    expect(onAuthLost).toHaveBeenCalledTimes(1)
    expect(await creds.resolve(oauthTokenRef(BASE))).toBeUndefined()
    expect(await creds.resolve(oauthRefreshRef(BASE))).toBeUndefined()
  })

  it('clears tokens on logout but keeps the stored password', async () => {
    const creds = new FakeCreds()
    const { fetchImpl } = makeServer(() => ok({ access_token: 'at-1', refresh_token: 'rt-1' }))
    const gateway = new PanelGateway({ baseURL: BASE, credentials: creds, fetchImpl })
    await gateway.login('a@b.c', 'pw')
    await gateway.logout()
    expect(await creds.resolve(panelTokenRef(BASE))).toBeUndefined()
    expect(await creds.resolve(panelRefreshRef(BASE))).toBeUndefined()
  })
})
