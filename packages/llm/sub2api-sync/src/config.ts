/**
 * The plugin's own settings section (`sub2api-sync` namespace): types and the
 * schemastery schema the host projects into the settings page.
 *
 * rev.4 shape (no legacy compatibility — the project has not shipped):
 * - `selectedKeys` lists the relay keys checked for sync (default `[]` — 全不选);
 * - one provider route per selected key (`sub2api-<key-id>`), written by the
 *   card and by the engine's keyId persistence;
 * - `manualGroups` (hand-declared Mode B groups) is retired — groups come
 *   from the panel, and platform is read directly from the panel DTO;
 * - `providerNameTemplate` renders the provider displayName (C5: must keep
 *   the `{keyName}` placeholder);
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
import type { ModelTemplate } from './protocols.ts'
import type { ApiProtocol } from './types.ts'

/** Per-group key-source options; `keyId` absent = 自动（组名建/复用）. */
export interface Sub2apiSyncConfig {
  /** sub2api instance address, with or without a trailing `/v1`. */
  baseURL?: string
  /** Panel account email (Mode A, password/2FA channel). */
  email?: string
  /** Provider displayName template; `{keyName}` placeholder (C5). Default `NexaRelay({keyName})`. */
  providerNameTemplate?: string
  /** Relay keys selected for sync (panel key ids); default `[]` — 全不选. */
  selectedKeys?: number[]
  /** Manual model lists when `/v1/models` is unavailable for a group. */
  modelListOverrides?: Record<string, string[]>
  /** Per-group wire-protocol override over the panel platform mapping. */
  protocolOverrides?: Record<string, ApiProtocol>
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
  providerNameTemplate: z.string().default('NexaRelay({keyName})').volatile(),
  selectedKeys: z.array(z.number().step(1)).default([]).volatile(),
  modelListOverrides: z.dict(z.array(z.string())).default({}).volatile(),
  protocolOverrides: z.dict(apiProtocolSchema).default({}).volatile(),
  compatTemplate: z.object({
    compat: z.dict(z.any()),
    reasoningEfforts: z.union([z.const(false), z.dict(z.union([z.string(), z.const(null)]))]),
  }).volatile(),
  enrichModelMeta: z.boolean().default(true).volatile(),
  keyQuota: z.number().volatile(),
  keyExpiresInDays: z.number().step(1).volatile(),
  deleteOrphanKeys: z.boolean().default(false).volatile(),
  syncIntervalMs: z.number().step(1).volatile(),
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
  const template = config.providerNameTemplate
  if (template !== undefined && template.length > 0 && !template.includes('{keyName}')) {
    throw new Error('sub2api-sync: providerNameTemplate 必须包含 {keyName} 占位符')
  }
  for (const id of config.selectedKeys ?? []) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`sub2api-sync: selectedKeys 含非法 key id ${String(id)}`)
    }
  }
}
