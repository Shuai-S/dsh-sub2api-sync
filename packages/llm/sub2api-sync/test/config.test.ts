import { describe, expect, it } from 'vitest'
import { DEFAULT_PROVIDER_NAME_TEMPLATE, validateConfig } from '../src/config.ts'

function base(): Parameters<typeof validateConfig>[0] {
  return {
    baseURL: 'https://panel.example.com',
    providerNameTemplate: DEFAULT_PROVIDER_NAME_TEMPLATE,
    selectedKeys: [],
  }
}

describe('validateConfig', () => {
  it('accepts a well-formed section', () => {
    expect(() => validateConfig(base())).not.toThrow()
  })

  it('requires an http(s) baseURL', () => {
    expect(() => validateConfig({ ...base(), baseURL: 'ftp://x' })).toThrowError(/baseURL/)
    expect(() => validateConfig({ ...base(), baseURL: 'not-a-url' })).toThrowError(/baseURL/)
    expect(() => validateConfig({ ...base(), baseURL: undefined })).not.toThrow()
  })

  it('enforces the {keyName} placeholder on the provider-name template (C5)', () => {
    expect(() => validateConfig({ ...base(), providerNameTemplate: 'NexaRelay' })).toThrowError(/\{keyName\}|\{siteName\}/)
    expect(() => validateConfig({ ...base(), providerNameTemplate: '' })).not.toThrow()
  })

  it('keeps group ids inside the safe positive integer range', () => {
    expect(() => validateConfig({ ...base(), selectedKeys: [0] })).toThrowError(/selectedKeys/)
    expect(() => validateConfig({ ...base(), selectedKeys: [-1] })).toThrowError(/selectedKeys/)
    expect(() => validateConfig({ ...base(), selectedKeys: [9007199254740993] })).toThrowError(/selectedKeys/)
    expect(() => validateConfig({ ...base(), selectedKeys: [1.5] })).toThrowError(/selectedKeys/)
    expect(() => validateConfig({ ...base(), selectedKeys: [12, 42] })).not.toThrow()
  })

  it('rejects a resync interval below the 60s floor (it used to silently disable the timer)', () => {
    expect(() => validateConfig({ ...base(), syncIntervalMs: 59999 })).toThrowError(/syncIntervalMs/)
    expect(() => validateConfig({ ...base(), syncIntervalMs: 60000 })).not.toThrow()
    expect(() => validateConfig({ ...base(), syncIntervalMs: undefined })).not.toThrow()
  })

  it('rejects a negative quota or a sub-day expiry (they used to be silently dropped)', () => {
    expect(() => validateConfig({ ...base(), keyQuota: -1 })).toThrowError(/keyQuota/)
    expect(() => validateConfig({ ...base(), keyQuota: 0 })).not.toThrow()
    expect(() => validateConfig({ ...base(), keyExpiresInDays: 0 })).toThrowError(/keyExpiresInDays/)
    expect(() => validateConfig({ ...base(), keyExpiresInDays: 1.5 })).toThrowError(/keyExpiresInDays/)
    expect(() => validateConfig({ ...base(), keyExpiresInDays: 30 })).not.toThrow()
  })

  it('validates the retry-policy overrides and the route-level model defaults', () => {
    expect(() => validateConfig({ ...base(), retryPolicy: { mode: 'normal' } })).not.toThrow()
    expect(() => validateConfig({ ...base(), retryPolicy: { mode: 'aggressive' as never } })).toThrowError(/retryPolicy\.mode/)
    expect(() => validateConfig({ ...base(), retryPolicy: { maxRetries: -1 } })).toThrowError(/maxRetries/)
    expect(() => validateConfig({ ...base(), retryPolicy: { backoff: { jitterRatio: 2 } } })).toThrowError(/jitterRatio/)
    expect(() => validateConfig({ ...base(), defaultContextWindow: 0 })).toThrowError(/defaultContextWindow/)
    expect(() => validateConfig({ ...base(), defaultMaxTokens: -5 })).toThrowError(/defaultMaxTokens/)
    expect(() => validateConfig({ ...base(), defaultContextWindow: 200000, defaultMaxTokens: 16384 })).not.toThrow()
  })
})
