import { describe, expect, it } from 'vitest'
import { baseURLForProtocol, buildProviderProfile, guessPlatformFromModels, protocolForPlatform, renderProviderName, SUB2API_RETRY_POLICY } from '../src/protocols.ts'
import { isOwnedRoute, legacyKeyIdOfRoute, legacyKeyRef, panelRefreshRef, panelTokenRef, parseGroupId, platformLabel, routeForKey, routeKeyRef, sha256Hex, suffixOfRoute } from '../src/types.ts'

describe('platformLabel', () => {
  it('labels the verified platforms with the picker wording', () => {
    expect(platformLabel('anthropic')).toBe('Anthropic')
    expect(platformLabel('openai')).toBe('OpenAI')
    expect(platformLabel('zhipu')).toBe('Zhipu GLM')
    expect(platformLabel('composite')).toBe('Composite')
  })

  it('passes unknown platforms through raw (future-proof)', () => {
    expect(platformLabel('minimax')).toBe('minimax')
    expect(platformLabel('opencode')).toBe('opencode')
  })
})

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

  it('merges retry-policy overrides over the built-in policy (backoff deeply)', () => {
    const profile = buildProviderProfile({
      groupId: 7,
      displayName: 'NexaRelay(Claude 拼车)',
      protocol: 'anthropic-messages',
      instance: 'https://gw.example.com',
      apiKeyEnv: 'DSH_SUB2API_KEY_7',
      models: [{ id: 'claude-x' }],
      retryPolicy: { maxRetries: 2, backoff: { maxDelayMs: 30000 } },
      defaultContextWindow: 200000,
      defaultMaxTokens: 16384,
    })
    // Overridden keys win…
    expect(profile.retryPolicy?.maxRetries).toBe(2)
    expect(profile.retryPolicy?.backoff?.maxDelayMs).toBe(30000)
    // …while untouched built-in keys (and the rest of backoff) inherit.
    expect(profile.retryPolicy?.mode).toBe(SUB2API_RETRY_POLICY.mode)
    expect(profile.retryPolicy?.retryableCodes).toEqual(SUB2API_RETRY_POLICY.retryableCodes)
    expect(profile.retryPolicy?.backoff?.initialDelayMs).toBe(SUB2API_RETRY_POLICY.backoff.initialDelayMs)
    expect(profile.retryPolicy?.backoff?.jitterRatio).toBe(SUB2API_RETRY_POLICY.backoff.jitterRatio)
    // Route-level model defaults ride the Config fields.
    expect(profile.defaultContextWindow).toBe(200000)
    expect(profile.defaultMaxTokens).toBe(16384)
  })

  it('falls back the display name to the group id', () => {
    const profile = buildProviderProfile({
      groupId: 3, displayName: '', protocol: 'openai-responses', instance: 'http://gw', apiKeyEnv: 'K', models: [{ id: 'a' }],
    })
    expect(profile.displayName).toBe('Group 3')
    expect(profile.baseURL).toBe('http://gw/v1')
  })

  it('writes the enriched display name onto the model entry when present', () => {
    const profile = buildProviderProfile({
      groupId: 1, displayName: 'X', protocol: 'anthropic-messages', instance: 'http://gw', apiKeyEnv: 'K',
      models: [{ id: 'claude-x', name: 'Claude X 4.5' }, { id: 'plain' }],
    })
    expect(profile.models?.[0]).toEqual({ id: 'claude-x', name: 'Claude X 4.5' })
    expect(profile.models?.[1]).toEqual({ id: 'plain' })
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

  it('carries the provider-level default effort when the template names one', () => {
    const withDefault = buildProviderProfile({
      groupId: 1, displayName: 'X', protocol: 'openai-responses', instance: 'http://gw', apiKeyEnv: 'K',
      models: [{ id: 'a' }], template: { reasoning: 'medium' },
    })
    expect(withDefault.reasoning).toBe('medium')
    const without = buildProviderProfile({
      groupId: 1, displayName: 'X', protocol: 'openai-responses', instance: 'http://gw', apiKeyEnv: 'K',
      models: [{ id: 'a' }],
    })
    expect(without.reasoning).toBeUndefined()
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

  describe('reasoning-effort precedence (template > auto-fill)', () => {
    const AUTO = { off: null, low: 'low', high: 'high' }
    const build = (template?: { reasoningEfforts?: false | Record<string, string | null> }) => buildProviderProfile({
      groupId: 1, displayName: 'X', protocol: 'openai-responses', instance: 'http://gw', apiKeyEnv: 'K',
      models: [{ id: 'a', reasoningEfforts: { ...AUTO } }, { id: 'b' }],
      ...(template !== undefined ? { template } : {}),
    })

    it('auto-fills the per-model map when the template has no reasoningEfforts', () => {
      const profile = build()
      expect(profile.models?.[0]?.reasoningEfforts).toEqual(AUTO)
      expect(profile.models?.[0]?.reasoningEfforts).not.toBe(AUTO)
      expect(profile.models?.[1]).not.toHaveProperty('reasoningEfforts')
    })

    it('lets an explicit template map win over the auto fill', () => {
      const profile = build({ reasoningEfforts: { low: 'low' } })
      expect(profile.models?.[0]?.reasoningEfforts).toEqual({ low: 'low' })
    })

    it('lets an explicit template false win over the auto fill', () => {
      const profile = build({ reasoningEfforts: false })
      expect(profile.models?.[0]?.reasoningEfforts).toBe(false)
    })
  })
})

describe('renderProviderName', () => {
  it('renders the default template with the site name, falling back to sub2api', () => {
    expect(renderProviderName(undefined, 'Claude 拼车', '我的中转')).toBe('我的中转(Claude 拼车)')
    expect(renderProviderName(undefined, 'Claude 拼车')).toBe('sub2api(Claude 拼车)')
    expect(renderProviderName('', 'Claude 拼车', '')).toBe('sub2api(Claude 拼车)')
  })

  it('substitutes {keyName} and {siteName} in custom templates', () => {
    expect(renderProviderName('{siteName}·{keyName}', '我的key', '站点A')).toBe('站点A·我的key')
    expect(renderProviderName('NexaRelay({keyName})', '我的key')).toBe('NexaRelay(我的key)')
    expect(renderProviderName('[{keyName}] 中转', 'gpt组')).toBe('[gpt组] 中转')
    expect(renderProviderName('{siteName} 中转', 'k')).toBe('sub2api 中转')
  })

  it('falls back to the default template when no placeholder is present', () => {
    expect(renderProviderName('no placeholder here', 'k', '站点C')).toBe('站点C(k)')
    expect(renderProviderName('no placeholder here', 'k')).toBe('sub2api(k)')
  })
})

describe('ownership boundary and naming', () => {
  it('owns slug routes and legacy digit routes, nothing else', () => {
    expect(isOwnedRoute(routeForKey('http://gw:8080', 12))).toBe(true)
    expect(isOwnedRoute('sub2api-12')).toBe(true) // legacy shape, migrated on next sync
    expect(isOwnedRoute('sub2api-0')).toBe(true)
    expect(isOwnedRoute('sub2api-openai')).toBe(false)
    expect(isOwnedRoute('sub2api-12a')).toBe(false)
    expect(isOwnedRoute('sub2api-')).toBe(false)
    expect(isOwnedRoute('my-route')).toBe(false)
  })

  it('derives opaque stable slugs from instance + key id (no sequential leak)', () => {
    expect(routeForKey('http://gw:8080', 42)).toMatch(/^sub2api-[0-9a-f]{10}$/)
    expect(routeForKey('http://gw:8080', 42)).toBe(routeForKey('http://gw:8080/', 42))
    expect(routeForKey('http://gw:8080', 42)).toBe(routeForKey('http://GW:8080', 42))
    // Different keys and different instances never share a route.
    expect(routeForKey('http://gw:8080', 42)).not.toBe(routeForKey('http://gw:8080', 43))
    expect(routeForKey('http://gw:8080', 42)).not.toBe(routeForKey('http://other:8080', 42))
  })

  it('round-trips route suffixes and legacy ids', () => {
    expect(suffixOfRoute(routeForKey('http://gw:8080', 42))).toMatch(/^[0-9a-f]{10}$/)
    expect(suffixOfRoute('sub2api-42')).toBe('42')
    expect(suffixOfRoute('sub2api-openai')).toBeUndefined()
    expect(legacyKeyIdOfRoute('sub2api-42')).toBe(42)
    expect(legacyKeyIdOfRoute('sub2api-042')).toBe(42)
    expect(legacyKeyIdOfRoute(routeForKey('http://gw:8080', 42))).toBeUndefined()
    expect(legacyKeyIdOfRoute('sub2api-openai')).toBeUndefined()
  })
})

describe('credential references', () => {
  it('derives relay key refs from the route suffix (both shapes)', () => {
    expect(routeKeyRef('sub2api-12')).toBe('DSH_SUB2API_KEY_12')
    expect(routeKeyRef(routeForKey('http://gw:8080', 12))).toMatch(/^DSH_SUB2API_KEY_[0-9a-f]{10}$/)
    expect(routeKeyRef(routeForKey('http://gw:8080', 12))).not.toBe(routeKeyRef(routeForKey('http://other:8080', 12)))
    expect(() => routeKeyRef('sub2api-openai')).toThrowError(/不是本插件的路由名/)
  })

  it('keeps the legacy key-id ref for migration reads', () => {
    expect(legacyKeyRef(12)).toBe('DSH_SUB2API_KEY_12')
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

describe('sha256Hex (route slug primitive)', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('handles multi-block and non-ASCII inputs', () => {
    // 1000 × 'a' — spans 16 blocks (NIST vector).
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3')
    expect(sha256Hex('中文输入')).toHaveLength(64)
    expect(sha256Hex('中文输入')).not.toBe(sha256Hex('中文输人'))
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
