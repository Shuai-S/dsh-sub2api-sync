import { describe, expect, it } from 'vitest'
import { baseURLForProtocol, buildProviderProfile, guessPlatformFromModels, protocolForPlatform, renderProviderName, SUB2API_RETRY_POLICY } from '../src/protocols.ts'
import { isOwnedRoute, groupIdOfRoute, panelRefreshRef, panelTokenRef, parseGroupId, relayKeyRef, routeForKey } from '../src/types.ts'

describe('platform → protocol mapping', () => {
  it('maps the nine verified platforms', () => {
    expect(protocolForPlatform('anthropic')).toBe('anthropic-messages')
    for (const platform of ['openai', 'grok', 'kimi', 'zhipu', 'deepseek']) {
      expect(protocolForPlatform(platform)).toBe('openai-responses')
    }
    for (const platform of ['gemini', 'antigravity', 'composite']) {
      expect(protocolForPlatform(platform)).toBe('openai-completions')
    }
  })

  it('returns undefined for unknown platforms so callers can fail loudly', () => {
    expect(protocolForPlatform('coze')).toBeUndefined()
    expect(protocolForPlatform('')).toBeUndefined()
  })
})

describe('baseURL derivation per protocol', () => {
  it('gives OpenAI-family protocols a /v1 root', () => {
    expect(baseURLForProtocol('http://gw:8080', 'openai-responses')).toBe('http://gw:8080/v1')
    expect(baseURLForProtocol('http://gw:8080', 'openai-completions')).toBe('http://gw:8080/v1')
    expect(baseURLForProtocol('http://gw:8080/', 'openai-responses')).toBe('http://gw:8080/v1')
    expect(baseURLForProtocol('http://gw:8080/v1', 'openai-completions')).toBe('http://gw:8080/v1')
  })

  it('gives anthropic-messages the bare host', () => {
    expect(baseURLForProtocol('http://gw:8080', 'anthropic-messages')).toBe('http://gw:8080')
    expect(baseURLForProtocol('http://gw:8080/v1', 'anthropic-messages')).toBe('http://gw:8080')
    expect(baseURLForProtocol('https://gw.example.com///', 'anthropic-messages')).toBe('https://gw.example.com')
  })
})

describe('provider profile construction', () => {
  it('builds a hand-declared profile with route-level defaults and retry policy', () => {
    const profile = buildProviderProfile({
      groupId: 7,
      displayName: 'NexaRelay(Claude 拼车)',
      protocol: 'anthropic-messages',
      instance: 'https://gw.example.com',
      apiKeyEnv: 'DSH_SUB2API_KEY_7',
      models: [{ id: 'claude-x' }],
    })
    expect(profile.displayName).toBe('NexaRelay(Claude 拼车)')
    expect(profile.apiKeyEnv).toBe('DSH_SUB2API_KEY_7')
    expect(profile.api).toBe('anthropic-messages')
    expect(profile.baseURL).toBe('https://gw.example.com')
    expect(profile.defaultContextWindow).toBe(128000)
    expect(profile.defaultMaxTokens).toBe(8192)
    expect(profile.defaultInput).toEqual(['text'])
    expect(profile.retryPolicy).toEqual(SUB2API_RETRY_POLICY)
    expect(profile.models).toEqual([{ id: 'claude-x' }])
  })

  it('falls back the display name to the group id', () => {
    const profile = buildProviderProfile({
      groupId: 3, displayName: '', protocol: 'openai-responses', instance: 'http://gw', apiKeyEnv: 'K', models: [{ id: 'a' }],
    })
    expect(profile.displayName).toBe('Group 3')
    expect(profile.baseURL).toBe('http://gw/v1')
  })

  it('clones the compat template into every model without sharing references', () => {
    const template = { compat: { supportsDeveloperRole: false } }
    const profile = buildProviderProfile({
      groupId: 1, displayName: 'X', protocol: 'openai-responses', instance: 'http://gw', apiKeyEnv: 'K',
      models: [{ id: 'a' }, { id: 'b' }], template,
    })
    expect(profile.models?.[0]?.compat).toEqual({ supportsDeveloperRole: false })
    expect(profile.models?.[1]?.compat).toEqual({ supportsDeveloperRole: false })
    expect(profile.models?.[0]?.compat).not.toBe(template.compat)
    expect(profile.models?.[0]?.compat).not.toBe(profile.models?.[1]?.compat)
  })

  it('passes reasoning efforts through, including explicit off', () => {
    const off = buildProviderProfile({
      groupId: 1, displayName: 'X', protocol: 'openai-responses', instance: 'http://gw', apiKeyEnv: 'K',
      models: [{ id: 'a' }], template: { reasoningEfforts: false },
    })
    expect(off.models?.[0]?.reasoningEfforts).toBe(false)
    const levels = buildProviderProfile({
      groupId: 1, displayName: 'X', protocol: 'openai-responses', instance: 'http://gw', apiKeyEnv: 'K',
      models: [{ id: 'a' }], template: { reasoningEfforts: { low: 'low', high: 'high' } },
    })
    expect(levels.models?.[0]?.reasoningEfforts).toEqual({ low: 'low', high: 'high' })
  })
})

describe('renderProviderName', () => {
  it('renders the default NexaRelay template when none is configured', () => {
    expect(renderProviderName(undefined, 'Claude 拼车')).toBe('NexaRelay(Claude 拼车)')
    expect(renderProviderName('', 'Claude 拼车')).toBe('NexaRelay(Claude 拼车)')
  })

  it('substitutes {keyName} in a custom template', () => {
    expect(renderProviderName('NexaRelay({keyName})', '我的key')).toBe('NexaRelay(我的key)')
    expect(renderProviderName('[{keyName}] 中转', 'gpt组')).toBe('[gpt组] 中转')
  })

  it('falls back to the default template when the placeholder is missing', () => {
    expect(renderProviderName('no placeholder here', 'k')).toBe('NexaRelay(k)')
  })
})

describe('ownership boundary and naming', () => {
  it('owns only sub2api-<digits> routes', () => {
    expect(isOwnedRoute('sub2api-12')).toBe(true)
    expect(isOwnedRoute('sub2api-0')).toBe(true)
    expect(isOwnedRoute('sub2api-openai')).toBe(false)
    expect(isOwnedRoute('sub2api-12a')).toBe(false)
    expect(isOwnedRoute('sub2api-')).toBe(false)
    expect(isOwnedRoute('my-route')).toBe(false)
  })

  it('round-trips group ids through route names', () => {
    expect(routeForKey(42)).toBe('sub2api-42')
    expect(groupIdOfRoute('sub2api-42')).toBe(42)
    expect(groupIdOfRoute('sub2api-openai')).toBeUndefined()
    expect(groupIdOfRoute('sub2api-042')).toBe(42)
  })
})

describe('credential references', () => {
  it('names relay key credentials deterministically', () => {
    expect(relayKeyRef(12)).toBe('DSH_SUB2API_KEY_12')
  })

  it('scopes panel token refs to the instance', () => {
    expect(panelTokenRef('http://gw:8080')).toBe(panelTokenRef('http://gw:8080/'))
    expect(panelTokenRef('http://gw:8080')).not.toBe(panelTokenRef('http://other:8080'))
    expect(panelTokenRef('http://gw:8080')).not.toBe(panelRefreshRef('http://gw:8080'))
    expect(panelRefreshRef('http://gw:8080')).toMatch(/^DSH_SUB2API_REFRESH_\d+$/)
  })

  it('parses group ids with the safe-integer guard', () => {
    expect(parseGroupId('42')).toBe(42)
    expect(parseGroupId(42)).toBe(42)
    expect(parseGroupId('0')).toBeUndefined()
    expect(parseGroupId('-1')).toBeUndefined()
    expect(parseGroupId('12a')).toBeUndefined()
    expect(parseGroupId('9007199254740993')).toBeUndefined() // 2^53 + 1
    expect(parseGroupId(undefined)).toBeUndefined()
  })
})

describe('fingerprint routing (retired in rev.4)', () => {
  it('no longer ships fingerprint-based route derivation', async () => {
    // The paste path anchors routes on the real group id; the fingerprint
    // helper was removed so no code path can revive the dual route families.
    const types = await import('../src/types.ts')
    expect((types as Record<string, unknown>).fingerprintKeyId).toBeUndefined()
  })
})

describe('guessPlatformFromModels', () => {
  it('names the platform for a single model family', () => {
    expect(guessPlatformFromModels(['claude-sonnet-4-5', 'claude-opus-4-1'])).toBe('anthropic')
    expect(guessPlatformFromModels(['gpt-5.1', 'o3-mini', 'codex-max'])).toBe('openai')
    expect(guessPlatformFromModels(['grok-4', 'grok-3-mini'])).toBe('grok')
    expect(guessPlatformFromModels(['gemini-2.5-pro', 'gemini-2.5-flash'])).toBe('gemini')
    expect(guessPlatformFromModels(['kimi-k2-thinking', 'moonshot-v1-8k'])).toBe('kimi')
    expect(guessPlatformFromModels(['glm-4.6', 'cogview-3'])).toBe('zhipu')
    expect(guessPlatformFromModels(['deepseek-chat', 'deepseek-reasoner'])).toBe('deepseek')
  })

  it('reads vendor-prefixed and path-style ids', () => {
    expect(guessPlatformFromModels(['anthropic/claude-3-5-haiku'])).toBe('anthropic')
    expect(guessPlatformFromModels(['openai/gpt-4.1'])).toBe('openai')
  })

  it('calls a mixed family list composite', () => {
    expect(guessPlatformFromModels(['claude-sonnet-4-5', 'gpt-5.1'])).toBe('composite')
  })

  it('returns undefined when nothing matches', () => {
    expect(guessPlatformFromModels([])).toBeUndefined()
    expect(guessPlatformFromModels(['mystery-model'])).toBeUndefined()
  })
})
