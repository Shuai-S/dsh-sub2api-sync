/**
 * Platform → wire-protocol mapping and provider-profile construction.
 *
 * The mapping follows the sub2api gateway source (verified:
 * `routes/gateway.go`, `isOpenAIResponsesCompatibleGatewayPlatform`): the
 * five OpenAI-family platforms are forwarded through the gateway's OpenAI
 * Responses path natively, anthropic through Messages, and the remaining
 * platforms only exist behind gateway bridging — chat/completions there.
 * Speaking the gateway's native path avoids its chat/completions ↔ native
 * conversion, which drops or misaligns parallel tool calls.
 *
 * @module sub2api-sync/protocols
 */

import type { ApiProtocol } from './types.ts'

/** One model entry inside an llm-pi-ai provider profile. */
export interface ProviderProfileModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: Array<'text' | 'image'>
  reasoningEfforts?: false | Record<string, string | null>
  compat?: Record<string, unknown>
}

export interface PiAiRetryPolicy {
  mode: 'normal' | 'always'
  maxRetries?: number
  retryableCodes?: string[]
  backoff?: { initialDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
}

/** One provider route inside the `llm-pi-ai` settings section. */
export interface PiAiProviderProfile {
  apiKeyEnv?: string
  displayName?: string
  api?: ApiProtocol
  baseURL?: string
  models?: ProviderProfileModel[]
  defaultContextWindow?: number
  defaultMaxTokens?: number
  defaultInput?: Array<'text' | 'image'>
  retryPolicy?: PiAiRetryPolicy
  /** Provider-level default reasoning effort (pi-ai `reasoning`). */
  reasoning?: ThinkingLevel
}

/**
 * Lenient retry policy for proxied upstreams: sub2api sits in front of
 * provider subscriptions that enforce their own HTTP 429 windows, and
 * llm-pi-ai's default normal policy (2 retries / 10s) cannot outlast them.
 */
export const SUB2API_RETRY_POLICY: Required<PiAiRetryPolicy> = {
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
  backoff: { initialDelayMs: 1000, maxDelayMs: 120000, jitterRatio: 0.2 },
}

/**
 * Guess one sub2api platform from discovered model ids. The gateway never
 * answers a relay key with the group platform, but model families map
 * cleanly: one consistent family names its platform, a mix of families is
 * the signature of a composite group. Returns `undefined` when nothing
 * matches — the caller keeps the manual choice authoritative.
 */
export function guessPlatformFromModels(modelIds: readonly string[]): string | undefined {
  const families = new Set<string>()
  for (const raw of modelIds) {
    const id = raw.toLowerCase()
    if (/(^|[/:.-])claude/.test(id)) families.add('anthropic')
    else if (/(^|[/:.-])(gpt|o[1345]|codex|chatgpt)/.test(id)) families.add('openai')
    else if (/(^|[/:.-])grok/.test(id)) families.add('grok')
    else if (/(^|[/:.-])gemini/.test(id)) families.add('gemini')
    else if (/(^|[/:.-])(kimi|moonshot)/.test(id) || /(^|[/:.-])k[23]($|[.:.-])/.test(id)) families.add('kimi')
    else if (/(^|[/:.-])(glm|chatglm|cogview|cogvideo)/.test(id)) families.add('zhipu')
    else if (/(^|[/:.-])deepseek/.test(id)) families.add('deepseek')
    else families.add('unknown')
  }
  const known = [...families].filter((family) => family !== 'unknown')
  if (known.length === 0) return undefined
  // Composite groups forward several upstream families through one key.
  return known.length === 1 ? known[0] : 'composite'
}

/**
 * Map one sub2api platform to the wire protocol the gateway serves on its
 * native path. Returns `undefined` for platforms outside the known set —
 * callers fail the group loudly instead of guessing.
 */
export function protocolForPlatform(platform: string): ApiProtocol | undefined {
  switch (platform) {
    case 'anthropic':
      return 'anthropic-messages'
    case 'openai':
    case 'grok':
    case 'kimi':
    case 'zhipu':
    case 'deepseek':
      return 'openai-responses'
    case 'gemini':
    case 'antigravity':
    case 'composite':
      return 'openai-completions'
    default:
      return undefined
  }
}

/**
 * Render the provider displayName from the relay key's name. The template is
 * a Config field (C5: must contain `{keyName}`); callers that receive an
 * invalid template still get a sane name instead of a broken one.
 */
export function renderProviderName(template: string | undefined, keyName: string, siteName?: string): string {
  const site = siteName !== undefined && siteName.length > 0 ? siteName : 'sub2api'
  if (template !== undefined && template.length > 0 && (template.includes('{keyName}') || template.includes('{siteName}'))) {
    return template.replaceAll('{siteName}', site).replaceAll('{keyName}', keyName)
  }
  return `${site}(${keyName})`
}

/**
 * Derive the profile baseURL for one protocol. OpenAI-family SDKs append
 * their endpoint to a `/v1`-rooted URL; the Anthropic SDK treats the URL as
 * a bare host and appends `/v1/messages` itself, so a `/v1` root there would
 * produce `/v1/v1/messages` (404).
 */
export function baseURLForProtocol(instance: string, protocol: ApiProtocol): string {
  const cleaned = instance.trim().replace(/\/+$/, '')
  if (protocol === 'anthropic-messages') return cleaned.replace(/\/v1$/i, '')
  return /\/v1$/i.test(cleaned) ? cleaned : `${cleaned}/v1`
}

/** pi-ai thinking levels a provider-level default effort may name. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** Per-model template inherited by every synced model entry (Config field). */
export interface ModelTemplate {
  compat?: Record<string, unknown>
  reasoningEfforts?: false | Record<string, string | null>
  /**
   * Provider-level default reasoning effort (pi-ai profile `reasoning`): the
   * effort preselected for every synced model and sent when the user has not
   * picked one. models.dev publishes no default-effort data, so this is the
   * user's explicit choice rather than catalog-derived.
   */
  reasoning?: ThinkingLevel
}

/** One discovered model with its enrichment facts (from the models.dev index). */
export interface ProfileModelInput {
  id: string
  /** Display name for selectors (models.dev `name`); absent keeps the id. */
  name?: string
  contextWindow?: number
  maxTokens?: number
  imageInput?: boolean
  /** Per-model auto-filled effort map (models.dev `reasoning_options`). */
  reasoningEfforts?: Record<string, string | null>
}

export interface ProfileInput {
  groupId: number
  /** Rendered provider display name (`renderProviderName` over the key name). */
  displayName: string
  protocol: ApiProtocol
  /** sub2api instance address, with or without a trailing `/v1`. */
  instance: string
  models: readonly ProfileModelInput[]
  apiKeyEnv: string
  template?: ModelTemplate
  /** Overrides over {@link SUB2API_RETRY_POLICY}; absent keys inherit it. */
  retryPolicy?: Partial<PiAiRetryPolicy>
  /** Route-level defaults for models the enrichment could not match
   * (Config `defaultContextWindow`/`defaultMaxTokens`). */
  defaultContextWindow?: number
  defaultMaxTokens?: number
}

/** Build one hand-declared llm-pi-ai provider profile for a group. */
export function buildProviderProfile(input: ProfileInput): PiAiProviderProfile {
  const compat = input.template?.compat
  // Reasoning-effort precedence: an explicit template (map or `false`) is the
  // user's decision and wins over the per-model auto-fill; only a template
  // without `reasoningEfforts` lets the models.dev-derived map through.
  const reasoning = input.template?.reasoningEfforts
  // Retry policy: the built-in lenient proxied-upstream policy with the
  // Config's per-section overrides merged over it (`backoff` merges deeply —
  // a partial backoff override must not lose the other built-in delays).
  const override = input.retryPolicy ?? {}
  const retryPolicy: PiAiRetryPolicy = {
    ...SUB2API_RETRY_POLICY,
    ...override,
    retryableCodes: [...(override.retryableCodes ?? SUB2API_RETRY_POLICY.retryableCodes)],
    backoff: { ...SUB2API_RETRY_POLICY.backoff, ...override.backoff },
  }
  return {
    displayName: input.displayName.length > 0 ? input.displayName : `Group ${input.groupId}`,
    apiKeyEnv: input.apiKeyEnv,
    api: input.protocol,
    baseURL: baseURLForProtocol(input.instance, input.protocol),
    models: input.models.map((model) => ({
      id: model.id,
      // Display name for the model-catalog editor's 显示名称 column (the
      // pi-ai entry's `name` field); absent leaves the id as the name.
      ...(model.name !== undefined ? { name: model.name } : {}),
      // Enrichment (C4) fills the capacity facts the gateway never reports;
      // models without a match keep the route-level defaults below.
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      ...(model.imageInput === true ? { input: ['text', 'image'] as Array<'text' | 'image'> } : {}),
      ...(compat !== undefined ? { compat: { ...compat } } : {}),
      ...(reasoning === false
        ? { reasoningEfforts: false }
        : reasoning !== undefined
          ? { reasoningEfforts: { ...reasoning } }
          : model.reasoningEfforts !== undefined
            ? { reasoningEfforts: { ...model.reasoningEfforts } }
            : {}),
    })),
    // Provider-level default effort (pi-ai `reasoning`) — the UI preselects
    // it and drops its "provider default" option once present.
    ...(input.template?.reasoning !== undefined ? { reasoning: input.template.reasoning } : {}),
    // Route-level defaults for models the enrichment could not match —
    // overridable per deployment (Config fields, same names).
    defaultContextWindow: input.defaultContextWindow ?? 128000,
    defaultMaxTokens: input.defaultMaxTokens ?? 8192,
    defaultInput: ['text'],
    retryPolicy,
  }
}
