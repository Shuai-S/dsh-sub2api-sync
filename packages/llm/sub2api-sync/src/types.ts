/**
 * Shared vocabulary of the sub2api sync plugin: platforms, wire protocols,
 * route/credential naming, service interfaces, and the ownership boundary
 * this plugin enforces inside `llm-pi-ai.providers`.
 *
 * rev.4: fingerprint-derived routes are retired — routes are always
 * `sub2api-<group-id>` with the real panel group id; keys are anchored by
 * the persisted `keyId` instead of a name fingerprint.
 *
 * @module sub2api-sync/types
 */

/** Platforms sub2api assigns to groups (verified: `backend/internal/domain/constants.go`; live instance 2026-09-30). */
export const PLATFORMS = [
  'anthropic',
  'openai',
  'gemini',
  'antigravity',
  'grok',
  'kimi',
  'zhipu',
  'deepseek',
  'composite',
] as const

export type Sub2apiPlatform = (typeof PLATFORMS)[number]

/**
 * The default provider-name template (rev.4 decision). Lives here — not in
 * `config.ts` — so the browser half can value-import it without pulling the
 * schemastery-backed schema (the client bundle must only request baseline
 * externals; see test/client-bundle.test.ts).
 */
export const DEFAULT_PROVIDER_NAME_TEMPLATE = 'NexaRelay({keyName})'

/**
 * Wire protocols llm-pi-ai can speak; must stay inside its
 * `supportedProtocols()` set or the write is refused with `settings-rejected`.
 */
export const API_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

export type ApiProtocol = (typeof API_PROTOCOLS)[number]

/** Route prefix this plugin owns inside `llm-pi-ai.providers`. */
export const ROUTE_PREFIX = 'sub2api-'

const OWNED_ROUTE = /^sub2api-\d+$/

/**
 * Ownership boundary: only `sub2api-<digits>` routes belong to this plugin,
 * because our provider ids are `sub2api-<group-id>` with numeric group ids.
 * The digits-only shape keeps anything else — including the community
 * plugin's `sub2api-openai` style routes — out of this plugin's write and
 * cleanup set.
 */
export function isOwnedRoute(route: string): boolean {
  return OWNED_ROUTE.test(route)
}

/** The llm-pi-ai route name for one selected relay key (key ids are panel-unique). */
export function routeForKey(keyId: number): string {
  return `${ROUTE_PREFIX}${keyId}`
}

/** The group id encoded in an owned route name, when the shape matches. */
export function groupIdOfRoute(route: string): number | undefined {
  if (!isOwnedRoute(route)) return undefined
  const id = Number(route.slice(ROUTE_PREFIX.length))
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/**
 * FNV-1a 32-bit string hash. Used to derive per-instance credential
 * reference suffixes (tokens/password are secrets of one panel instance;
 * hashing the baseURL keeps refs stable yet instance-scoped).
 */
export function hashString(input: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  // `0` would fail the positive-id guards elsewhere — remap to 1 (p ≈ 2^-32).
  return (hash >>> 0) || 1
}

/** Normalized instance key the credential suffixes derive from. */
export function instanceKey(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '').toLowerCase()
}

/** Panel access-token credential reference for one instance. */
export function panelTokenRef(baseURL: string): string {
  return `DSH_SUB2API_TOKEN_${hashString(instanceKey(baseURL))}`
}

/** Panel refresh-token credential reference for one instance. */
export function panelRefreshRef(baseURL: string): string {
  return `DSH_SUB2API_REFRESH_${hashString(instanceKey(baseURL))}`
}

/** Panel password credential reference for one instance (Mode A, C3). */
export function panelPasswordRef(baseURL: string): string {
  return `DSH_SUB2API_PASSWORD_${hashString(instanceKey(baseURL))}`
}

/** Credential reference carrying one group's relay key. */
export function relayKeyRef(groupId: number): string {
  return `DSH_SUB2API_KEY_${groupId}`
}

/**
 * Parse a user/config-supplied group id: decimal digits within the safe
 * integer range. Group ids are int64 at the sub2api side; anything beyond
 * `Number.MAX_SAFE_INTEGER` fails loudly instead of being silently mangled.
 */
export function parseGroupId(input: unknown): number | undefined {
  if (typeof input === 'number') return Number.isSafeInteger(input) && input > 0 ? input : undefined
  if (typeof input !== 'string') return undefined
  if (!/^\d+$/.test(input)) return undefined
  const id = Number(input)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** Minimal structural view of the settings service the engine needs. */
export interface SettingsLike {
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; revision: number; value?: unknown }>
  mutate(ns: string, ops: SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/** One settings path operation (shared by llm-pi-ai writes and own-ns writes). */
export type SettingsPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** Minimal structural view of the credentials service the engine needs. */
export interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}
