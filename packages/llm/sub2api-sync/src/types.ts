/**
 * Shared vocabulary of the sub2api sync plugin: platforms, wire protocols,
 * route/credential naming, service interfaces, and the ownership boundary
 * this plugin enforces inside `llm-pi-ai.providers`.
 *
 * rev.5: routes are opaque — `sub2api-<10-hex>` derived from SHA-256 over
 * (instance baseURL, panel key id). The panel's sequential key id never
 * appears in route or credential names, so a shared config screenshot cannot
 * reveal how many keys the site has handed out. Legacy `sub2api-<digits>`
 * routes stay recognized (owned + cleaned up) so existing deployments
 * migrate on the next sync; the plaintext credential gains a legacy-ref
 * fallback read for the same reason.
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

/** Human labels for the group types, matching the platform picker's wording. */
export const PLATFORM_LABELS: Record<Sub2apiPlatform, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  grok: 'Grok',
  kimi: 'Kimi',
  zhipu: 'Zhipu GLM',
  deepseek: 'DeepSeek',
  composite: 'Composite',
}

/** The display label for a group type; unknown values pass through raw so a
 * future sub2api platform still shows something truthful. */
export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform as Sub2apiPlatform] ?? platform
}

/**
 * The default provider-name template (rev.4 decision). Lives here — not in
 * `config.ts` — so the browser half can value-import it without pulling the
 * schemastery-backed schema (the client bundle must only request baseline
 * externals; see test/client-bundle.test.ts).
 */
export const DEFAULT_PROVIDER_NAME_TEMPLATE = '{siteName}({keyName})'

/**
 * Wire protocols llm-pi-ai can speak; must stay inside its
 * `supportedProtocols()` set or the write is refused with `settings-rejected`.
 */
export const API_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

export type ApiProtocol = (typeof API_PROTOCOLS)[number]

/** Route prefix this plugin owns inside `llm-pi-ai.providers`. */
export const ROUTE_PREFIX = 'sub2api-'

/** A new-shape route suffix: 10 lowercase hex chars (40-bit SHA-256 truncation). */
const SLUG_ROUTE = /^sub2api-[0-9a-f]{10}$/
/** A legacy route suffix: the raw panel key id (pre-rev.5 deployments). */
const LEGACY_ROUTE = /^sub2api-\d+$/

const OWNED_ROUTE = /^(?:sub2api-[0-9a-f]{10}|sub2api-\d+)$/

/**
 * Ownership boundary: only `sub2api-<10-hex>` (rev.5 opaque slug) and the
 * legacy `sub2api-<digits>` routes belong to this plugin. Anything else —
 * including the community plugin's `sub2api-openai` style routes — stays out
 * of this plugin's write and cleanup set.
 */
export function isOwnedRoute(route: string): boolean {
  return OWNED_ROUTE.test(route)
}

/**
 * FIPS 180-4 SHA-256 over UTF-8 input, pure JS so both the host half and the
 * browser bundle can use it without pulling `node:crypto`. Only used for
 * non-secret route slugs; tests pin the standard vectors.
 */
export function sha256Hex(input: string): string {
  const data = new TextEncoder().encode(input)
  const bitLength = data.length * 8
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32))
  view.setUint32(padded.length - 4, bitLength >>> 0)
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, '0')).join('')
}

/** Round constants for SHA-256 (FIPS 180-4 §4.2.2). */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** Route slug for one relay key: SHA-256 over (instance, key id), truncated. */
export function keyRouteSlug(baseURL: string, keyId: number): string {
  return sha256Hex(`${instanceKey(baseURL)}\n${keyId}`).slice(0, 10)
}

/**
 * The llm-pi-ai route name for one selected relay key. The slug is derived
 * from the instance address and the panel key id — stable across syncs and
 * key renames, collision-free across instances, and it carries no hint about
 * the panel's sequential key numbering.
 */
export function routeForKey(baseURL: string, keyId: number): string {
  return `${ROUTE_PREFIX}${keyRouteSlug(baseURL, keyId)}`
}

/** The route's suffix (slug or legacy digits), when the shape is owned. */
export function suffixOfRoute(route: string): string | undefined {
  if (SLUG_ROUTE.test(route) || LEGACY_ROUTE.test(route)) return route.slice(ROUTE_PREFIX.length)
  return undefined
}

/** The panel key id encoded in a LEGACY digit route, when the shape matches. */
export function legacyKeyIdOfRoute(route: string): number | undefined {
  if (!LEGACY_ROUTE.test(route)) return undefined
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

/** OAuth access-token credential reference for one instance (C2). */
export function oauthTokenRef(baseURL: string): string {
  return `DSH_SUB2API_OAUTH_TOKEN_${hashString(instanceKey(baseURL))}`
}

/** OAuth refresh-token credential reference for one instance (C2). */
export function oauthRefreshRef(baseURL: string): string {
  return `DSH_SUB2API_OAUTH_REFRESH_${hashString(instanceKey(baseURL))}`
}

/**
 * Credential reference carrying one route's relay key. Derived from the
 * route suffix, so the lifecycle follows the route exactly: removal unsets
 * it without needing the panel key id. New routes hash-scope the ref per
 * instance; legacy digit routes keep their historical ref shape.
 */
export function routeKeyRef(route: string): string {
  const suffix = suffixOfRoute(route)
  if (suffix === undefined) throw new Error(`sub2api-sync: "${route}" 不是本插件的路由名`)
  return `DSH_SUB2API_KEY_${suffix}`
}

/**
 * Legacy per-key-id credential reference (pre-rev.5). Kept as a READ
 * fallback during migration: deployments that stored plaintext under
 * `DSH_SUB2API_KEY_<id>` keep syncing without re-entering the key. Never
 * written anymore; only unset when the matching legacy route is removed.
 */
export function legacyKeyRef(keyId: number): string {
  return `DSH_SUB2API_KEY_${keyId}`
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

/**
 * The settings service's concurrent-writer error shape (`code` or `name`).
 * One predicate for every conflict surface: the shared mutate helper below,
 * the engine's plan loop, and the route layer's 409 projection.
 */
export function isSettingsConflict(error: unknown): boolean {
  const shape = error as { code?: unknown; name?: unknown } | null | undefined
  return shape?.code === 'SETTINGS_CONFLICT' || shape?.name === 'SettingsConflictError'
}

/**
 * Conflict-retried write into one settings namespace: build the ops, read
 * the namespace's live revision, mutate, and on a concurrent-writer conflict
 * rebuild + retry (bounded — 3 attempts total, matching the engine's policy).
 *
 * `buildOps` runs per attempt so a retry can recompute the plan against the
 * just-re-read state; it may close over outer holders to surface the final
 * ops/actions (the engine does exactly that for its sync report). An empty
 * ops list skips the wire round trip entirely — but the namespace must still
 * exist (the same loud failure the engine's revision read used to produce).
 */
export async function mutateWithRetry(
  settings: SettingsLike,
  ns: string,
  buildOps: () => SettingsPathOp[] | Promise<SettingsPathOp[]>,
  options: { missingError?: string; attempts?: number } = {},
): Promise<void> {
  const maxAttempts = options.attempts ?? 3
  for (let attempt = 1; ; attempt++) {
    const ops = await buildOps()
    const descriptor = settings.describe().find((candidate) => candidate.ns === ns)
    if (descriptor === undefined) {
      throw new Error(options.missingError ?? `sub2api-sync: 设置命名空间 "${ns}" 未注册`)
    }
    if (ops.length === 0) return
    try {
      await settings.mutate(ns, ops, descriptor.revision)
      return
    } catch (error) {
      if (attempt < maxAttempts && isSettingsConflict(error)) continue
      throw error
    }
  }
}
