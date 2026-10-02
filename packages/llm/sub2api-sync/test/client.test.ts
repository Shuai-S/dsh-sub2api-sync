import { describe, expect, it } from 'vitest'
import { gatewayApiRoot, readModelList, Sub2apiClient } from '../src/client.ts'

describe('gatewayApiRoot', () => {
  it('appends /v1 exactly once', () => {
    expect(gatewayApiRoot('http://gw:8080')).toBe('http://gw:8080/v1')
    expect(gatewayApiRoot('http://gw:8080/')).toBe('http://gw:8080/v1')
    expect(gatewayApiRoot('http://gw:8080/v1')).toBe('http://gw:8080/v1')
    expect(gatewayApiRoot('http://gw:8080/v1/')).toBe('http://gw:8080/v1')
    expect(gatewayApiRoot('  https://gw.example.com  ')).toBe('https://gw.example.com/v1')
  })

  it('answers empty for empty input', () => {
    expect(gatewayApiRoot('')).toBe('')
    expect(gatewayApiRoot('   ')).toBe('')
  })
})

describe('readModelList', () => {
  it('takes ids and tolerates extra fields', () => {
    const models = readModelList({
      object: 'list',
      data: [
        { id: 'claude-x', type: 'model', display_name: 'Claude X', created_at: '2024-01-01' },
        { id: 'gpt-y', extra: { nested: true } },
      ],
    })
    expect(models).toEqual([
      { id: 'claude-x', displayName: 'Claude X' },
      { id: 'gpt-y' },
    ])
  })

  it('skips entries without a usable id', () => {
    const models = readModelList({ data: [{ id: 'a' }, { nope: true }, null, 'str', { id: '' }, { id: 'b' }] })
    expect(models.map((model) => model.id)).toEqual(['a', 'b'])
  })

  it('fails loudly when the payload is not a model list', () => {
    expect(() => readModelList({ error: { message: 'nope' } })).toThrowError(/data/)
    expect(() => readModelList(undefined)).toThrowError(/data/)
    expect(() => readModelList({ data: 'not-an-array' })).toThrowError(/data/)
  })
})

describe('Sub2apiClient.listModels', () => {
  function fetchAnswering(status: number, payload: unknown): { client: Sub2apiClient; calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      } as Response
    }) as typeof fetch
    return { client: new Sub2apiClient({ baseURL: 'http://gw:8080', fetchImpl }), calls }
  }

  it('sends the relay key as a bearer token against the /v1 root', async () => {
    const { client, calls } = fetchAnswering(200, { data: [{ id: 'm1' }] })
    const models = await client.listModels('sk-relay')
    expect(models.map((model) => model.id)).toEqual(['m1'])
    expect(calls[0]?.url).toBe('http://gw:8080/v1/models')
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer sk-relay')
  })

  it('reports non-2xx answers loudly with the status code', async () => {
    const { client } = fetchAnswering(401, { error: { message: 'bad key' } })
    await expect(client.listModels('sk-bad')).rejects.toThrowError(/HTTP 401/)
  })

  it('surfaces the gateway refusal code and message (flat envelope)', async () => {
    const { client } = fetchAnswering(403, { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient account balance' })
    await expect(client.listModels('sk-relay')).rejects.toThrowError(
      /HTTP 403（INSUFFICIENT_BALANCE: Insufficient account balance）/,
    )
  })

  it('surfaces the OpenAI-style nested error envelope', async () => {
    const { client } = fetchAnswering(403, { error: { message: 'API key 已过期', code: 'API_KEY_EXPIRED' } })
    await expect(client.listModels('sk-relay')).rejects.toThrowError(/HTTP 403（API_KEY_EXPIRED: API key 已过期）/)
  })

  it('degrades to status-only when the error body is unreadable', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json') } }) as unknown) as typeof fetch
    const client = new Sub2apiClient({ baseURL: 'http://gw:8080', fetchImpl })
    await expect(client.listModels('sk-relay')).rejects.toThrowError(/返回 HTTP 500$/)
  })

  it('omits the code when it duplicates the message', async () => {
    const { client } = fetchAnswering(403, { code: 'nope', message: 'nope' })
    await expect(client.listModels('sk-relay')).rejects.toThrowError(/HTTP 403（nope）/)
  })

  it('rejects a non-http baseURL at construction', () => {
    expect(() => new Sub2apiClient({ baseURL: 'ftp://gw' })).toThrowError(/http\(s\)/)
    expect(() => new Sub2apiClient({ baseURL: '' })).toThrowError(/http\(s\)/)
  })
})
