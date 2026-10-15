/**
 * The plugin's own settings section (`sub2api-sync` namespace): types and the
 * schemastery schema the host projects into the settings page.
 *
 * rev.4 shape (no legacy compatibility — the project has not shipped):
 * - `selectedKeys` lists the relay keys checked for sync (default `[]` — 全不选);
 * - one provider route per selected key (`sub2api-<10-hex>` slug over
 *   instance + key id — no sequential ids in route or credential names),
 *   written by the card and by the engine's keyId persistence;
 * - `manualGroups` (hand-declared Mode B groups) is retired — groups come
 *   from the panel, and platform is read directly from the panel DTO;
 * - `providerNameTemplate` renders the provider displayName (C5: must keep
 *   the `{keyName}` or `{siteName}` placeholder);
 * - `allowRemoteActions` is the cross-device escape hatch (§11 of the
 *   client-UI design note).
 *
 * Since dsh 0.1.7 the `Config` export is auto-projected — there is no
 * `installSection` registration any more. Every top-level field is marked
 * `volatile`, which is what makes the entry appear as a settings form at
 * all: the host keeps each volatile field as a live cell, so a form write
 * updates the running plugin in place (no remount) and the entry's resolved
 * config is the single source of truth.
 *
 * @module sub2api-sync/config
 */

import z from '@deepseek-ai/schemastery'
import type { ModelTemplate, PiAiRetryPolicy } from './protocols.ts'
import { DEFAULT_PROVIDER_NAME_TEMPLATE, type ApiProtocol } from './types.ts'
import { THINKING_LEVELS, type ThinkingLevel } from './protocols.ts'

/** Per-section overrides over the plugin's built-in lenient retry policy
 * (`SUB2API_RETRY_POLICY`): an absent key inherits the built-in value.
 * YAML-only advanced field (一字段一写面 — the tuning card does not render it). */
export interface RetryPolicyOverride {
  mode?: PiAiRetryPolicy['mode']
  maxRetries?: number
  retryableCodes?: string[]
  backoff?: {
    initialDelayMs?: number
    maxDelayMs?: number
    jitterRatio?: number
  }
}

/** Per-group key-source options; `keyId` absent = 自动（组名建/复用）. */
export interface Sub2apiSyncConfig {
  /** sub2api instance address, with or without a trailing `/v1`. */
  baseURL?: string
  /** Panel account email (Mode A, password/2FA channel). */
  email?: string
  /** Provider displayName template; `{keyName}` and `{siteName}` placeholders. Default `{siteName}({keyName})`. */
  providerNameTemplate?: string
  /** Relay keys selected for sync (panel key ids); default `[]` — 全不选. */
  selectedKeys?: number[]
  /** Manual model lists when `/v1/models` is unavailable for a group. */
  modelListOverrides?: Record<string, string[]>
  /** Per-group wire-protocol override over the panel platform mapping. */
  protocolOverrides?: Record<string, ApiProtocol>
  /** Registered route → panel key id, written by the engine so the card's
   * per-route remove button works without a panel round trip (slugs hide
   * the numeric id by design). */
  routeKeyIds?: Record<string, number>
  /** Per-model template inherited by every synced model entry. */
  compatTemplate?: ModelTemplate
  /** models.dev metadata enrichment toggle (reserved, C4). */
  enrichModelMeta?: boolean
  /** Optional quota (USD) for keys the plugin creates. */
  keyQuota?: number
  /** Optional expiry in days for keys the plugin creates. */
  keyExpiresInDays?: number
  /** Whether removal also revokes the remote key (needs the stored keyId). */
  deleteOrphanKeys?: boolean
  /** Scheduled resync interval; absent = off. */
  syncIntervalMs?: number
  /** Retry policy overrides merged over the built-in policy every synced
   * route carries (see `RetryPolicyOverride`). */
  retryPolicy?: RetryPolicyOverride
  /** Route-level context-window default for models the metadata enrichment
   * cannot match. Default 128000. */
  defaultContextWindow?: number
  /** Route-level max-output-tokens default for models the metadata
   * enrichment cannot match. Default 8192. */
  defaultMaxTokens?: number
  /** Escape hatch: allow action routes from private-network peers (§11). Default false. */
  allowRemoteActions?: boolean
}

const apiProtocolSchema = z.union([
  z.const('openai-completions'),
  z.const('openai-responses'),
  z.const('anthropic-messages'),
])

// The output side is `any` deliberately: the factory's own mapped snapshot
// types (deeply-readonly volatile snapshots through `NoInfer`) are not
// expressible by a hand-written annotation, and nothing in this package
// consumes `Config`'s output type — `ResolvedSub2apiSyncConfig` below is the
// resolved runtime view `apply` uses.
export const Config: z<Sub2apiSyncConfig, any> = z.object({
  baseURL: z.string().volatile(),
  email: z.string().volatile(),
  providerNameTemplate: z.string().default(DEFAULT_PROVIDER_NAME_TEMPLATE).volatile(),
  selectedKeys: z.array(z.number().step(1)).default([]).volatile(),
  modelListOverrides: z.dict(z.array(z.string())).default({}).volatile(),
  protocolOverrides: z.dict(apiProtocolSchema).default({}).volatile(),
  routeKeyIds: z.dict(z.number().step(1)).default({}).volatile(),
  compatTemplate: z.object({
    compat: z.dict(z.any()),
    reasoningEfforts: z.union([z.const(false), z.dict(z.union([z.string(), z.const(null)]))]),
    reasoning: z.union([
      z.const('off'), z.const('minimal'), z.const('low'),
      z.const('medium'), z.const('high'), z.const('xhigh'), z.const('max'),
    ]),
  }).volatile(),
  enrichModelMeta: z.boolean().default(true).volatile(),
  keyQuota: z.number().volatile(),
  keyExpiresInDays: z.number().step(1).volatile(),
  deleteOrphanKeys: z.boolean().default(false).volatile(),
  syncIntervalMs: z.number().step(1).volatile(),
  retryPolicy: z.object({
    mode: z.union([z.const('normal'), z.const('always')]),
    maxRetries: z.number().step(1),
    retryableCodes: z.array(z.string()),
    backoff: z.object({
      initialDelayMs: z.number(),
      maxDelayMs: z.number(),
      jitterRatio: z.number(),
    }),
  }).volatile(),
  defaultContextWindow: z.number().step(1).volatile(),
  defaultMaxTokens: z.number().step(1).volatile(),
  allowRemoteActions: z.boolean().default(false).volatile(),
})

/** The default provider-name template — owned by `types.ts` (browser-safe), re-exported here. */
export { DEFAULT_PROVIDER_NAME_TEMPLATE } from './types.ts'

/**
 * One resolved volatile field: a stable reference whose `get()` yields the
 * current immutable snapshot. Structurally `cosmokit`'s `Volatile<T>`; kept
 * local so this package need not depend on it.
 */
export interface LiveField<T> {
  get(): T
}

/**
 * The entry config `apply` receives: every schema field resolves to a live
 * cell the host swaps in place on each settings-form write. Keep the
 * reference (re-reading cells per call), never cache a snapshot across a
 * write boundary.
 */
export type ResolvedSub2apiSyncConfig = {
  [K in keyof Sub2apiSyncConfig]: LiveField<Sub2apiSyncConfig[K]>
}

/** Unwrap one live cell into its current snapshot; plain values pass through. */
function unwrap(field: unknown): unknown {
  if (field !== null && typeof field === 'object' && typeof (field as { get?: unknown }).get === 'function') {
    return (field as { get(): unknown }).get()
  }
  return field
}

/** Fold the live entry config into one plain snapshot for a sync run. */
export function readConfig(config: ResolvedSub2apiSyncConfig): Sub2apiSyncConfig {
  return Object.fromEntries(
    Object.entries(config).map(([key, field]) => [key, unwrap(field)]),
  ) as Sub2apiSyncConfig
}

/**
 * Cross-field constraints the schema cannot express. Shape-only on purpose:
 * reachability needs network I/O and belongs to the sync path, which fails
 * loudly with the instance named.
 */
export function validateConfig(config: Sub2apiSyncConfig): void {
  if (config.baseURL !== undefined && config.baseURL.length > 0 && !/^https?:\/\//i.test(config.baseURL.trim())) {
    throw new Error('sub2api-sync: baseURL 必须以 http(s):// 开头')
  }
  const compat = config.compatTemplate
  if (compat?.reasoning !== undefined && !THINKING_LEVELS.includes(compat.reasoning as ThinkingLevel)) {
    throw new Error(`sub2api-sync: compatTemplate.reasoning 必须是 ${THINKING_LEVELS.join('/')} 之一`)
  }
  const template = config.providerNameTemplate
  if (
    template !== undefined && template.length > 0 &&
    !template.includes('{keyName}') && !template.includes('{siteName}')
  ) {
    throw new Error('sub2api-sync: providerNameTemplate 必须包含 {keyName} 或 {siteName} 占位符')
  }
  for (const id of config.selectedKeys ?? []) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`sub2api-sync: selectedKeys 含非法 key id ${String(id)}`)
    }
  }
  // Values whose only alternative used to be a SILENT drop somewhere down the
  // write path: the resync timer treated <60s as "off", createKey filtered
  // non-positive quota/expiry at the panel call. Fail loudly at commit instead.
  if (config.syncIntervalMs !== undefined && config.syncIntervalMs < 60_000) {
    throw new Error('sub2api-sync: syncIntervalMs 定时同步间隔不能小于 60000ms（删除该字段即关闭定时同步）')
  }
  if (config.keyQuota !== undefined && config.keyQuota < 0) {
    throw new Error('sub2api-sync: keyQuota 不能为负数')
  }
  if (config.keyExpiresInDays !== undefined && (!Number.isSafeInteger(config.keyExpiresInDays) || config.keyExpiresInDays < 1)) {
    throw new Error('sub2api-sync: keyExpiresInDays 必须是 ≥1 的整数')
  }
  if (config.defaultContextWindow !== undefined && (!Number.isSafeInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('sub2api-sync: defaultContextWindow 必须是正整数')
  }
  if (config.defaultMaxTokens !== undefined && (!Number.isSafeInteger(config.defaultMaxTokens) || config.defaultMaxTokens <= 0)) {
    throw new Error('sub2api-sync: defaultMaxTokens 必须是正整数')
  }
  const retry = config.retryPolicy
  if (retry !== undefined) {
    if (retry.mode !== undefined && retry.mode !== 'normal' && retry.mode !== 'always') {
      throw new Error('sub2api-sync: retryPolicy.mode 必须是 normal 或 always')
    }
    if (retry.maxRetries !== undefined && (!Number.isSafeInteger(retry.maxRetries) || retry.maxRetries < 0)) {
      throw new Error('sub2api-sync: retryPolicy.maxRetries 必须是非负整数')
    }
    const backoff = retry.backoff
    if (backoff !== undefined) {
      if (backoff.initialDelayMs !== undefined && (!Number.isSafeInteger(backoff.initialDelayMs) || backoff.initialDelayMs < 0)) {
        throw new Error('sub2api-sync: retryPolicy.backoff.initialDelayMs 必须是非负整数')
      }
      if (backoff.maxDelayMs !== undefined && (!Number.isSafeInteger(backoff.maxDelayMs) || backoff.maxDelayMs < 0)) {
        throw new Error('sub2api-sync: retryPolicy.backoff.maxDelayMs 必须是非负整数')
      }
      if (backoff.jitterRatio !== undefined && (backoff.jitterRatio < 0 || backoff.jitterRatio > 1)) {
        throw new Error('sub2api-sync: retryPolicy.backoff.jitterRatio 必须在 [0, 1] 之间')
      }
    }
  }
}
