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
})
