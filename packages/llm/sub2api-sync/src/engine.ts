/**
 * The sync engine: diff the panel group state against the plugin's entries
 * in the settings user layer and apply a minimal write plan to
 * `llm-pi-ai.providers` through `settings.mutate`.
 *
 * rev.4 model: the panel is the single source of groups (id/name/platform),
 * reached through the credential-backed {@link PanelGateway}. Key sources
 * per group (three states):
 * 1. `groups[gid].keyId` set — reuse that exact panel key (persisted by the
 *    card's "选已有 key" or by a previous auto-creation);
 * 2. `keyId` unset but a credential exists — pasted key, used verbatim (its
 *    panel name is matched best-effort for the display name);
 * 3. neither — auto: reuse the group-named key, else create one named after
 *    the group, then persist the keyId (rename-proof idempotency).
 *
 * Guarantees (per the design Agent Note, carried over):
 * - idempotent: a second sync with unchanged inputs produces zero writes;
 * - scoped: only `sub2api-<10-hex>` (and legacy `sub2api-<digits>`) routes
 *   are ever written or removed;
 * - optimistic: writes carry `expectedRevision` and a `SettingsConflictError`
 *   triggers a re-read, a recompute, and a bounded retry (3 attempts);
 * - single flight: syncs are serialized on one queue;
 * - loud: every per-group failure lands in the report, whole-sync failures
 *   throw with context, and nothing writes a half state.
 *
 * @module sub2api-sync/engine
 */

import { createHash } from 'node:crypto'
import { Sub2apiClient, type GatewayModelEntry } from './client.ts'
import type { PanelGateway, PanelGroup, PanelKey } from './panel.ts'
import { buildProviderProfile, protocolForPlatform, renderProviderName, type PiAiProviderProfile, type ProfileModelInput } from './protocols.ts'
import { bundledIndex, type ModelMetaIndex } from './enrich.ts'
import type { Sub2apiSyncConfig } from './config.ts'
import {
  isOwnedRoute,
  legacyKeyIdOfRoute,
  legacyKeyRef,
  mutateWithRetry,
  routeForKey,
  routeKeyRef,
  type ApiProtocol,
  type CredentialsLike,
  type SettingsLike,
  type SettingsPathOp,
} from './types.ts'

/** The settings namespace owned by dsh-llm-pi-ai. */
export const PI_AI_NS = 'llm-pi-ai'
/** The settings namespace owned by this plugin. */
export const OWN_NS = 'sub2api-sync'

/** Minimal structural view of the settings service the engine needs. */
export type { SettingsLike, SettingsPathOp } from './types.ts'

export interface SyncEngineOptions {
  settings: SettingsLike
  credentials: CredentialsLike
  /** Credential-backed panel gateway (login tokens, single-flight refresh). */
  gateway: PanelGateway
  fetchImpl?: typeof fetch
  /**
   * Model-metadata index source (C4). The host injects the NON-blocking
   * resolver (`modelIndexForSync`), which answers from cache/snapshot and
   * refreshes off the critical path; the default here is the bundled snapshot
   * alone, so a unit test can never reach for the network by accident.
   */
  loadModelIndex?: (options: { enrich: boolean; fetchImpl?: typeof fetch }) => ModelMetaIndex | Promise<ModelMetaIndex>
  /**
   * The instance's configured site name for the `{siteName}` template
   * placeholder (cached probe; absent/unknown falls back to "sub2api").
   */
  siteName?: () => Promise<string | undefined>
  /** How many `/v1/models` discoveries run at once (default {@link DISCOVERY_CONCURRENCY}). */
  discoveryConcurrency?: number
  /** Clock, injected by tests (discovery-cache TTLs and the timing report). */
  now?: () => number
}

export type SyncAction = 'created' | 'updated' | 'unchanged' | 'failed'

export interface SyncEntryOutcome {
  groupId: number
  route: string
  /** The panel key id this entry synced (absent for stale/invalid ids). */
  keyId?: number
  displayName?: string
  action: SyncAction
  models?: number
  error?: string
  /** Set when the selected id does not exist in the panel (stale selection). */
  invalid?: true
}

export interface SyncReport {
  entries: SyncEntryOutcome[]
  removed: string[]
  /** Number of `set`/`unset` ops the accepted mutate carried. */
  writes: number
  /** How many mutate attempts were used (1 = no conflict). */
  attempts: number
  warnings: string[]
  /** Per-phase wall clock of this run — the card renders it, and it is how a
   * "the sync feels slow" report gets answered with numbers, not guesses. */
  timing?: SyncTiming
}

/**
 * Wall-clock cost of one sync, split by phase. `discoveryMs` is WALL time for
 * the whole fan-out (not the sum over keys), so it shows the concurrency win.
 */
export interface SyncTiming {
  /** Panel reads: groups + the key page walk. */
  panelMs: number
  /** Metadata index resolution (≈0 when the process cache answered). */
  catalogMs: number
  /** `/v1/models` discovery across the selected keys. */
  discoveryMs: number
  /** Settings commits (providers + the route→keyId map when it moved). */
  writeMs: number
  totalMs: number
}

/** Which phase a running sync is in (the card's progress line). */
export type SyncStep = 'panel' | 'models' | 'write'

/**
 * What one run acts on:
 * - `selection` (default): exactly the ticked keys — creates new routes,
 *   updates changed ones, and removes routes whose key left the selection.
 * - `registered`: only the keys that ALREADY own a route. A refresh re-validates
 *   and rewrites what exists; it never creates a route for a newly ticked key
 *   and never removes one. That keeps the sync card's "刷新同步" button from
 *   doubling as "sync the selection".
 */
export type SyncScope = 'selection' | 'registered'

/** One progress snapshot of the sync currently running. */
export interface SyncProgress {
  step: SyncStep
  /** Items finished in this step (keys for `models`, else 0/1). */
  done: number
  /** Items this step will finish (0 while unknown). */
  total: number
  /** Epoch ms when the run started. */
  startedAt: number
}

/**
 * One target's discovery result, before it is folded into the report and the
 * desired profile map. `desired`/`profileWarnings` are stripped on the way in.
 */
interface KeyOutcome extends SyncEntryOutcome {
  desired?: PiAiProviderProfile
  profileWarnings?: string[]
}

/** Default discovery fan-out: enough to overlap a group's keys, small enough
 * that a relay's per-key rate limiter stays quiet. */
export const DISCOVERY_CONCURRENCY = 4
/** Default model-discovery cache window (config: `discoveryCacheSeconds`). */
export const DEFAULT_DISCOVERY_CACHE_SECONDS = 60
/** Keys per panel page during the sync walk. */
const KEY_WALK_PAGE_SIZE = 100
/** Panel pages one sync reads (10 × 100 keys). */
const KEY_WALK_MAX_PAGES = 10
/** Upper bound on the discovery cache (entries are tiny; a long session should not leak). */
const DISCOVERY_CACHE_MAX_ENTRIES = 200
/** Base pause before retrying a rate-limited/timed-out discovery (grows linearly). */
const DISCOVERY_RETRY_DELAY_MS = 700
/** Retries after the first discovery attempt (so 3 attempts at most). */
const DISCOVERY_RETRY_ATTEMPTS = 2

/**
 * In-memory holder for the last accepted sync report (the status
 * projection's `lastReport` / `lastReportAt`). The host clears it wherever
 * the sync state is purged — logout, definitive auth loss, instance
 * switch — because a report describing routes that no longer exist must
 * not keep presenting itself as the current state.
 */
export interface SyncReportStore {
  record(report: SyncReport): void
  clear(): void
  report(): SyncReport | undefined
  at(): number | undefined
}

export function createSyncReportStore(): SyncReportStore {
  let report: SyncReport | undefined
  let at: number | undefined
  return {
    record: (value) => { report = value; at = Date.now() },
    clear: () => { report = undefined; at = undefined },
    report: () => report,
    at: () => at,
  }
}

/** Whole-sync failure: bad config, not signed in, llm-pi-ai unavailable, or retries exhausted. */
export class Sub2apiSyncError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Sub2apiSyncError'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Order-insensitive JSON comparison — profiles are plain JSON values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (typeof a === 'object') {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key) => key in right && deepEqual(left[key], right[key]))
  }
  return false
}

/**
 * Resolve the selected relay keys against the panel's key rows. A selected id
 * the panel no longer serves becomes an `invalid` entry (reported, not fatal).
 */
export function resolveTargets(
  config: Sub2apiSyncConfig,
  keyRows: readonly PanelKey[],
): Array<{ key: PanelKey } | { invalid: number; error: string }> {
  const byId = new Map(keyRows.map((key) => [key.id, key]))
  const targets: Array<{ key: PanelKey } | { invalid: number; error: string }> = []
  for (const id of config.selectedKeys ?? []) {
    const key = byId.get(id)
    if (key === undefined) {
      targets.push({ invalid: id, error: `key #${id} 在面板不存在（可能已删除）——请在 Keys 卡搜索框中回车刷新列表后重新勾选` })
      continue
    }
    targets.push({ key })
  }
  return targets
}

export class Sub2apiSyncEngine {
  private readonly settings: SettingsLike
  private readonly credentials: CredentialsLike
  private readonly gateway: PanelGateway
  private readonly fetchImpl?: typeof fetch
  private readonly modelIndexLoader: (options: { enrich: boolean; fetchImpl?: typeof fetch }) => ModelMetaIndex | Promise<ModelMetaIndex>
  private readonly siteName?: () => Promise<string | undefined>
  private readonly discoveryConcurrency: number
  private readonly now: () => number
  /** Per-process window of proven `/v1/models` answers, so repeat syncs skip
   * the round trip (see `discoveryCacheSeconds`). Keyed by a digest, never by
   * the plaintext itself. */
  private readonly discoveryCache = new Map<string, { models: GatewayModelEntry[]; at: number }>()
  private queue: Promise<unknown> = Promise.resolve()
  private running = false
  private progressValue: SyncProgress | undefined

  constructor(options: SyncEngineOptions) {
    this.settings = options.settings
    this.credentials = options.credentials
    this.gateway = options.gateway
    this.fetchImpl = options.fetchImpl
    this.modelIndexLoader = options.loadModelIndex ?? (() => bundledIndex())
    this.siteName = options.siteName
    this.discoveryConcurrency = Math.max(1, options.discoveryConcurrency ?? DISCOVERY_CONCURRENCY)
    this.now = options.now ?? Date.now
  }

  /** Whether a sync is currently executing (UI busy marker). */
  isRunning(): boolean {
    return this.running
  }

  /** Progress of the running sync (undefined when idle) — the card's live line. */
  progress(): SyncProgress | undefined {
    return this.running ? this.progressValue : undefined
  }

  /**
   * Run one sync. At most one runs at a time — later callers queue behind
   * the previous one (the settings-card button and the timer share this
   * queue).
   */
  sync(config: Sub2apiSyncConfig, keyIds?: number[], scope: SyncScope = 'selection'): Promise<SyncReport> {
    const run = this.queue.then(
      () => this.runSync(config, keyIds, scope),
      () => this.runSync(config, keyIds, scope),
    )
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async runSync(config: Sub2apiSyncConfig, keyIds: number[] | undefined, scope: SyncScope): Promise<SyncReport> {
    this.running = true
    try {
      return await this.syncNow(config, keyIds, scope)
    } finally {
      this.running = false
    }
  }

  private async syncNow(config: Sub2apiSyncConfig, selection: number[] | undefined, scope: SyncScope): Promise<SyncReport> {
    const instance = config.baseURL?.trim() ?? ''
    if (!/^https?:\/\//i.test(instance)) {
      throw new Sub2apiSyncError('sub2api-sync: baseURL 未配置或不是 http(s) 地址')
    }

    const startedAt = this.now()
    const entries: SyncEntryOutcome[] = []
    const desired = new Map<string, PiAiProviderProfile>()
    this.progressValue = { step: 'panel', done: 0, total: 1, startedAt }

    // Phase 1 — three INDEPENDENT reads in flight together: the panel walk
    // (which gates everything: not signed in fails loud here), the metadata
    // index (cache or bundled snapshot — never the wire), and the cached
    // site-name probe. Running them one after another was the bulk of a cold
    // sync's wall clock.
    const panelStartedAt = this.now()
    let catalogMs = 0
    const catalogRead = (async (): Promise<ModelMetaIndex> => {
      const at = this.now()
      try {
        return await this.modelIndexLoader({
          enrich: config.enrichModelMeta !== false,
          ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
        })
      } catch {
        // Enrichment is display sugar: a broken loader must never fail a sync.
        return new Map() as ModelMetaIndex
      } finally {
        catalogMs = this.now() - at
      }
    })()
    const siteRead: Promise<string | undefined> = this.siteName !== undefined
      ? this.siteName().catch(() => undefined)
      : Promise.resolve(undefined)
    const [{ groups, keyRows, truncated: keyWalkTruncated }, modelIndex, site] = await Promise.all([
      this.readPanel(),
      catalogRead,
      siteRead,
    ])
    const panelMs = this.now() - panelStartedAt
    const groupById = new Map(groups.map((group) => [group.id, group]))

    const syncWarnings: string[] = []
    if (keyWalkTruncated) {
      syncWarnings.push(`面板 key 数量超过单次同步的读取上限（${KEY_WALK_MAX_PAGES} 页 × ${KEY_WALK_PAGE_SIZE} = ${KEY_WALK_MAX_PAGES * KEY_WALK_PAGE_SIZE} 把）——超出部分未参与同步，也不会被移除`)
    }
    // The `{siteName}` placeholder fell back: say so, or the report silently
    // names providers `sub2api(…)` and the cause stays invisible.
    if (site === undefined && this.siteName !== undefined && (config.providerNameTemplate ?? '').includes('{siteName}')) {
      syncWarnings.push('实例站点名探测失败（实例不可达或页面 <title> 缺失）——displayName 暂用回退名 sub2api，站点名可解析后的同步会自动更正')
    }

    // `registered` ignores the caller's list on purpose: the keys behind the
    // existing routes are the only thing a refresh may touch.
    const selectedKeys: number[] = scope === 'registered'
      ? this.registeredKeyIds()
      : (selection ?? config.selectedKeys ?? [])
    if (scope === 'registered' && selectedKeys.length === 0) {
      throw new Sub2apiSyncError('sub2api-sync: 当前没有已注册的路由可刷新——请先在 Keys 卡勾选并用「同步所选」创建路由')
    }
    const effective: Sub2apiSyncConfig = { ...config, selectedKeys }
    // A selected key whose id the panel does not list is "invalid" — its row is
    // gone, so its route goes. That rule turns a BAD PANEL READ into a mass
    // deletion: an empty key listing makes every selection invalid and removes
    // every route. Refuse to work on an empty listing instead.
    if (keyRows.length === 0 && selectedKeys.length > 0) {
      throw new Sub2apiSyncError(
        'sub2api-sync: 面板返回了 0 把 key，但本地仍勾选了 ' + String(selectedKeys.length) + ' 把——疑似面板读取异常，已中止本次同步（不改动任何路由）；请稍后重试，或到面板确认这些 key 是否还在',
      )
    }

    // Phase 2 — discovery, bounded fan-out. Every key needs its own
    // `/v1/models` answer (a key's permissions decide what it sees), but the
    // keys are independent, so they overlap instead of queueing. The report
    // keeps the selection's order: results land in an index-keyed array.
    const targets = resolveTargets(effective, keyRows)
    const discoveryTotal = targets.reduce((count, target) => count + ('invalid' in target ? 0 : 1), 0)
    this.progressValue = { step: 'models', done: 0, total: discoveryTotal, startedAt }
    const discoveryStartedAt = this.now()
    let discovered = 0
    const outcomes = await mapWithConcurrency(targets, this.discoveryConcurrency, async (target): Promise<KeyOutcome> => {
      try {
        if ('invalid' in target) {
          return { groupId: target.invalid, route: `${target.invalid}`, action: 'failed', error: target.error, invalid: true }
        }
        const key = target.key
        const route = routeForKey(instance, key.id)
        try {
          const group = groupById.get(key.groupId)
          if (group === undefined) {
            throw new Sub2apiSyncError(`key #${key.id}（${key.name}）的分组 ${key.groupId} 在面板不可用`)
          }
          const { profile, warnings: profileWarnings } = await this.buildKeyProfile(config, key, group, instance, modelIndex, site)
          return {
            groupId: group.id,
            route,
            keyId: key.id,
            displayName: profile.displayName,
            action: 'unchanged',
            models: profile.models?.length ?? 0,
            desired: profile,
            profileWarnings,
          }
        } catch (error) {
          return { groupId: key.groupId, route, keyId: key.id, action: 'failed', error: messageOf(error) }
        }
      } finally {
        discovered++
        this.progressValue = { step: 'models', done: discovered, total: discoveryTotal, startedAt }
      }
    })
    const discoveryMs = this.now() - discoveryStartedAt
    /**
     * Routes whose key is STILL SELECTED but failed this run. Their existing
     * provider stays untouched: a transient discovery/auth failure must never
     * delete a working route (that turned one flaky sync into "my whole setup
     * vanished"). Only keys DROPPED from the selection — or ids the panel no
     * longer serves — are removable.
     */
    const keepRoutes = new Set<string>()
    /**
     * An EMPTY selection is never a removal instruction. The card disables its
     * sync buttons at zero selected keys, so an empty run means a stale/absent
     * selection reached the host — and removing every route (plus its
     * credential and the route→id map) on that signal is how a glitch turned
     * into "my whole setup vanished". Removal stays the job of an explicit
     * uncheck (a narrower, non-empty selection) or of logout/reset.
     */
    const selectionIsEmpty = selectedKeys.length === 0
    // A refresh never deletes: the routes it works on ARE the selection.
    const refreshOnly = scope === 'registered'
    for (const outcome of outcomes) {
      const { desired: profile, profileWarnings, ...entry } = outcome
      if (profile !== undefined) desired.set(entry.route, profile)
      if (profileWarnings !== undefined) syncWarnings.push(...profileWarnings)
      if (entry.action === 'failed' && entry.invalid !== true) keepRoutes.add(entry.route)
      entries.push(entry)
    }

    // Phase 3 — the writes. The diff/retry loop: every conflict re-reads the
    // current section and recomputes the ops against it; `desired` is
    // conflict-independent. The plan rebuild rides the shared mutate helper's
    // per-attempt `buildOps`.
    this.progressValue = { step: 'write', done: 0, total: 1, startedAt }
    const writeStartedAt = this.now()
    let attempts = 0
    const removed: string[] = []
    let ops: SettingsPathOp[] = []
    let routeActions = new Map<string, SyncAction>()

    await mutateWithRetry(this.settings, PI_AI_NS, () => {
      attempts++
      const now = this.readCurrentProviders()
      const plan = planOps(now, desired, keepRoutes, selectionIsEmpty || refreshOnly)
      ops = plan.ops
      routeActions = plan.actions
      removed.length = 0
      for (const op of ops) {
        if (op.op === 'unset') removed.push(op.path[1])
      }
      return ops
    })

    for (const entry of entries) {
      const action = routeActions.get(entry.route)
      if (action !== undefined) entry.action = action
    }
    for (const entry of entries) {
      if (entry.action !== 'failed' || !keepRoutes.has(entry.route)) continue
      syncWarnings.push(`key #${entry.keyId ?? '?'} 同步失败，已保留上次写入的路由 ${entry.route}（本次未改动）——修好原因后再同步即可`)
    }
    // Nothing was selected: say so, or the "0 个 key" report looks like a
    // successful sync that mysteriously changed nothing.
    if (selectionIsEmpty) {
      const kept = this.readCurrentProviders()
      const owned = Object.keys(kept).filter((route) => isOwnedRoute(route)).length
      syncWarnings.push(owned > 0
        ? `本次没有选中任何 key——为防误删，已保留现有的 ${String(owned)} 条路由（取消勾选某个 key 才会移除它的路由）`
        : '本次没有选中任何 key——未做任何改动')
    }
    // Did the commit actually land? A host-side plugin reload can drop the
    // write between the mutate and the read-back; reporting that is the
    // difference between "sync said OK" and "the routes are really there".
    if (desired.size > 0) {
      const landed = this.readCurrentProviders()
      const missing = [...desired.keys()].filter((route) => landed[route] === undefined)
      if (missing.length > 0) {
        syncWarnings.push(`写入未落地：${String(missing.length)} 条路由不在设置里（插件可能刚被宿主重载）——请再同步一次；本次不会删除任何已有路由`)
      }
    }

    // Deletion semantics: a route dropped from the selection loses its entry
    // (mutate above) and its credential (here, best effort). The credential
    // ref derives from the route itself, so cleanup never needs the key id;
    // the id for a remote revoke comes from the panel rows (new routes) or
    // the legacy digit encoding (pre-rev.5 routes).
    const keyIdByRoute = new Map(keyRows.map((row) => [routeForKey(instance, row.id), row.id]))
    const warnings = [...syncWarnings]
    for (const route of removed) {
      try {
        await this.credentials.unset(routeKeyRef(route))
      } catch (error) {
        warnings.push(`key ${route} 的凭据清理失败：${messageOf(error)}`)
      }
      const keyId = keyIdByRoute.get(route) ?? legacyKeyIdOfRoute(route)
      if (config.deleteOrphanKeys === true && keyId !== undefined) {
        try {
          await this.gateway.use((panel, token) => panel.deleteKey(token, keyId))
        } catch (error) {
          warnings.push(`key ${route} 的远端撤销失败：${messageOf(error)}`)
        }
      }
    }

    // Persist the route → key id map in this plugin's own section: slugs
    // deliberately hide the numeric id, and the card's per-route remove
    // button needs it without a panel round trip. Only MOVED entries are
    // written — an unchanged map must not cost a second commit (each commit
    // bumps the section revision and wakes every volatile listener). Best
    // effort: a failed write only costs the remove button until the next sync.
    try {
      const currentMap = this.readOwnRouteKeyIds()
      const mapOps: SettingsPathOp[] = []
      for (const entry of entries) {
        if (entry.keyId !== undefined && entry.action !== 'failed' && currentMap[entry.route] !== entry.keyId) {
          mapOps.push({ op: 'set', path: ['routeKeyIds', entry.route], value: entry.keyId })
        }
      }
      for (const route of removed) {
        if (route in currentMap) mapOps.push({ op: 'unset', path: ['routeKeyIds', route] })
      }
      if (mapOps.length > 0) {
        await mutateWithRetry(this.settings, OWN_NS, () => mapOps, {
          missingError: 'sub2api-sync: 自身 settings 命名空间未注册',
        })
      }
    } catch {
      // Non-fatal: the next successful sync rewrites the map.
    }

    return {
      entries,
      removed,
      writes: ops.length,
      attempts,
      warnings,
      timing: {
        panelMs,
        catalogMs,
        discoveryMs,
        writeMs: this.now() - writeStartedAt,
        totalMs: this.now() - startedAt,
      },
    }
  }

  /**
   * Groups + the bounded key page walk. The group map and the FIRST key page
   * are independent, so they overlap; further pages stay sequential (the walk
   * stops when the panel says so). The panel gates everything: a signed-out
   * session fails loud here.
   */
  private async readPanel(): Promise<{ groups: PanelGroup[]; keyRows: PanelKey[]; truncated: boolean }> {
    return this.gateway.use(async (panel, token) => {
      const groupsPromise = panel.listAvailableGroups(token)
      // The 401-retry path re-runs this closure; a rejection from the FIRST
      // attempt's sibling call would otherwise surface as an unhandled
      // rejection (Node kills the process on those). Observe it here; the
      // real error still propagates from whichever call is awaited.
      groupsPromise.catch(() => undefined)
      const first = await panel.listKeys(token, { page: 1, pageSize: KEY_WALK_PAGE_SIZE })
      const groups = await groupsPromise
      const rows = [...first.items]
      const walkTo = Math.min(first.pages, KEY_WALK_MAX_PAGES)
      for (let page = 2; page <= walkTo; page++) {
        const result = await panel.listKeys(token, { page, pageSize: KEY_WALK_PAGE_SIZE })
        rows.push(...result.items)
        if (result.items.length === 0) break
      }
      // A panel reporting more pages than the walk visits means the sync only
      // saw a prefix of the key list — surfaced as a report warning by the
      // caller instead of silently dropping the tail keys.
      return { groups, keyRows: rows, truncated: first.pages > KEY_WALK_MAX_PAGES }
    })
  }

  /**
   * The panel key ids behind the routes this plugin already registered. Reads
   * the live provider section plus its own route→keyId map (legacy digit
   * routes carry their id in the route name). A route with no recoverable id
   * is simply skipped — a refresh must never delete what it cannot resolve,
   * and `refreshOnly` keeps the removal plan empty anyway.
   */
  registeredKeyIds(): number[] {
    const providers = this.readCurrentProviders()
    const map = this.readOwnRouteKeyIds()
    const ids: number[] = []
    for (const route of Object.keys(providers)) {
      if (!isOwnedRoute(route)) continue
      const mapped = map[route]
      if (mapped !== undefined) {
        ids.push(mapped)
        continue
      }
      const legacy = legacyKeyIdOfRoute(route)
      if (legacy !== undefined) ids.push(legacy)
    }
    return [...new Set(ids)]
  }

  /** This plugin's own route→keyId map (empty when the section is cold). */
  private readOwnRouteKeyIds(): Record<string, number> {
    const descriptor = this.settings.describe().find((candidate) => candidate.ns === OWN_NS)
    const value = (descriptor?.value as { routeKeyIds?: unknown } | undefined)?.routeKeyIds
    if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return {}
    return value as Record<string, number>
  }

  /** Protocol + models + naming for one selected key; the plaintext comes
   * from the panel row when present, else from the stored credential. */
  private async buildKeyProfile(
    config: Sub2apiSyncConfig,
    key: PanelKey,
    group: PanelGroup,
    instance: string,
    modelIndex: ModelMetaIndex,
    site: string | undefined,
  ): Promise<{ profile: PiAiProviderProfile; warnings: string[] }> {
    const protocol: ApiProtocol | undefined = protocolForPlatformWithOverride(group.platform, config.protocolOverrides?.[String(group.id)])
    if (protocol === undefined) {
      throw new Sub2apiSyncError(
        `key #${key.id}（${key.name}）所属分组 ${group.id} 的平台 "${group.platform}" 没有协议映射（可用 protocolOverrides 显式指定）`,
      )
    }

    const route = routeForKey(instance, key.id)
    const ref = routeKeyRef(route)
    // A masked value (e.g. "sk-1****abcd") is NOT plaintext — sending it
    // upstream yields gateway 401s, and accepting it at ANY chain step
    // short-circuits the later sources (an ancient build persisted masked
    // rows into the credential store before mask detection existed). Every
    // step therefore rejects empty/masked candidates; a masked stored value
    // is garbage and gets unset on the spot.
    const usable = (value: string | undefined): value is string =>
      value !== undefined && value.length > 0 && !value.includes('****')
    // Where the plaintext came from: panel rows and reveal answers are
    // current by construction; a stored/legacy credential can predate the
    // instance (legacy refs are instance-less — another deployment sharing
    // the numeric key id poisons them) or a panel-side key rotation. The
    // discovery-401 self-heal below keys off this source.
    let source: 'panel' | 'stored' | 'legacy' = 'panel'
    let revealFailure: string | undefined
    let plaintext = key.key
    if (!usable(plaintext)) {
      plaintext = undefined
      const stored = await this.credentials.resolve(ref)
      if (usable(stored?.value)) {
        plaintext = stored?.value
        source = 'stored'
      } else if (stored?.value !== undefined) {
        await this.credentials.unset(ref).catch(() => undefined)
      }
    }
    if (!usable(plaintext) && ref !== legacyKeyRef(key.id)) {
      // Migration read: pre-rev.5 deployments stored plaintext under the raw
      // key-id ref. Read it so existing setups keep syncing; the value gets
      // re-persisted under the new ref below — but only after discovery
      // proves it works against THIS instance.
      const legacy = await this.credentials.resolve(legacyKeyRef(key.id))
      if (usable(legacy?.value)) {
        plaintext = legacy?.value
        source = 'legacy'
      } else if (legacy?.value !== undefined) {
        await this.credentials.unset(legacyKeyRef(key.id)).catch(() => undefined)
      }
    }
    if (!usable(plaintext)) {
      // OAuth channel masks key plaintext in listings; the controlled reveal
      // endpoint is the documented exception for client-owned keys. Keep the
      // failure reason — "endpoint missing" vs "key not client-owned" vs
      // "token expired" changes what the user does next.
      try {
        const revealed = await this.gateway.use((panel, token) => panel.revealKey(token, key.id))
        plaintext = !usable(revealed.key) ? undefined : revealed.key
        if (plaintext === undefined) revealFailure = 'reveal 未返回可用明文'
      } catch (error) {
        revealFailure = messageOf(error)
      }
    }
    if (!usable(plaintext)) {
      const revealNote = revealFailure !== undefined ? `；reveal 接口也失败：${revealFailure}` : ''
      throw new Sub2apiSyncError(`key #${key.id}（${key.name}）拿不到明文（面板列表不回明文且凭据库没有可用存底${revealNote}）——请在面板删除这把 key 后用插件「创建 key」重建，重建时会自动保存明文`)
    }

    let models: GatewayModelEntry[]
    try {
      models = await this.discoverModels(config, group.id, instance, plaintext)
    } catch (error) {
      // Discovery 401 on a stored/legacy plaintext: the value does not
      // authenticate against THIS instance. Drop the stored copies (so they
      // cannot poison every later sync) and retry once with the controlled
      // reveal value — the authoritative source for client-owned keys.
      if ((source !== 'stored' && source !== 'legacy') || !/HTTP 401(?![0-9])/.test(messageOf(error))) throw error
      await this.credentials.unset(ref).catch(() => undefined)
      if (ref !== legacyKeyRef(key.id)) await this.credentials.unset(legacyKeyRef(key.id)).catch(() => undefined)
      let revealed: string | undefined
      try {
        revealed = (await this.gateway.use((panel, token) => panel.revealKey(token, key.id)))?.key
      } catch (revealError) {
        throw new Sub2apiSyncError(
          `${messageOf(error)}；本地存底已作废，但 reveal 也失败：${messageOf(revealError)}——请在面板删除这把 key 后用插件「创建 key」重建`,
        )
      }
      if (revealed === undefined || revealed.length === 0 || revealed.includes('****')) {
        throw new Sub2apiSyncError(`${messageOf(error)}；本地存底已作废，但 reveal 未返回明文——请在面板删除这把 key 后用插件「创建 key」重建`)
      }
      plaintext = revealed
      models = await this.discoverModels(config, group.id, instance, plaintext)
    }

    // An empty discovery is a gateway-side condition — the relay exposes no
    // models to this key (an empty `data` array, or entries the tolerant
    // reader cannot interpret). It must fail THIS key alone: writing
    // `models: []` gets the whole llm-pi-ai commit rejected by the route
    // validation ("resolves no models; the installed catalog does not
    // describe this route…"), which aborts every other key's sync and hides
    // the faulty key behind core's cryptic message.
    if (models.length === 0) {
      const groupLabel = group.name.length > 0 ? `${group.name}（#${group.id}）` : `#${group.id}`
      throw new Sub2apiSyncError(
        `key #${key.id}（${key.name}）经网关 /v1/models 发现到 0 个模型（分组 ${groupLabel}）——中转站没有向这把 key 暴露任何模型；请在中转站确认该分组的模型配置与这把 key 的权限，或在卡片用「模型清单覆盖」显式指定模型。这把 key 已跳过，其余 key 照常同步`,
      )
    }

    // Keep the credential in step only after a proven-good discovery: a
    // failed sync must not persist an unvalidated (possibly wrong) value.
    if (this.credentials.resolve !== undefined) {
      const stored = await this.credentials.resolve(ref)
      if (stored?.value !== plaintext) {
        await this.credentials.set(ref, plaintext)
      }
    }
    const enriched = models.map((model) => enrichModel(model, modelIndex))
    // compatTemplate.reasoning is a PROVIDER-level default; pi-ai refuses a
    // request whose effort the model does not support, so a heterogeneous
    // group (non-reasoning models, narrower vocabularies) must not inherit
    // it blindly. Emit it only when every model supports the level; strip
    // it and say so otherwise.
    let template = config.compatTemplate
    const warnings: string[] = []
    const requestedDefault = template?.reasoning
    if (requestedDefault !== undefined) {
      const lacking = enriched
        .filter((model) => {
          const wire = model.reasoningEfforts?.[requestedDefault]
          return model.reasoningEfforts === undefined || wire === undefined || wire === null
        })
        .map((model) => model.id)
      if (lacking.length > 0) {
        template = { ...template, reasoning: undefined }
        const preview = lacking.length > 5 ? `${lacking.slice(0, 5).join('、')} 等` : lacking.join('、')
        warnings.push(`compatTemplate.reasoning=${requestedDefault} 未写入默认档位：${lacking.length} 个模型不支持该档位（${preview}）——未手动选择档位的请求会被拒绝，故整组回退为不设默认`)
      }
    }
    return {
      profile: buildProviderProfile({
        groupId: group.id,
        displayName: renderProviderName(config.providerNameTemplate, key.name, site),
        protocol,
        instance,
        models: enriched,
        apiKeyEnv: ref,
        template,
        retryPolicy: config.retryPolicy,
        defaultContextWindow: config.defaultContextWindow,
        defaultMaxTokens: config.defaultMaxTokens,
      }),
      warnings,
    }
  }


  /**
   * Model source precedence: a non-empty `modelListOverrides` entry is the
   * user's explicit selection from the card picker and wins outright (no
   * fetch — the entry contains exactly the chosen ids). Otherwise discover
   * via `/v1/models`; discovery failure falls back to the overrides loudly.
   *
   * Discovery answers are cached for `discoveryCacheSeconds` (default
   * {@link DEFAULT_DISCOVERY_CACHE_SECONDS}s, `0` = always re-query): the same
   * key re-synced minutes later — the scheduled resync, a second click, two
   * windows — skips the round trip. The cache key is a digest of instance +
   * group + plaintext, so the secret itself never becomes a map key.
   */
  private async discoverModels(
    config: Sub2apiSyncConfig,
    groupId: number,
    instance: string,
    relayKey: string,
  ): Promise<GatewayModelEntry[]> {
    const selection = config.modelListOverrides?.[String(groupId)] ?? []
    if (selection.length > 0) return selection.map((id) => ({ id }))
    const ttlMs = Math.max(0, config.discoveryCacheSeconds ?? DEFAULT_DISCOVERY_CACHE_SECONDS) * 1000
    const cacheKey = ttlMs > 0 ? discoveryCacheKey(instance, groupId, relayKey) : undefined
    if (cacheKey !== undefined) {
      const hit = this.discoveryCache.get(cacheKey)
      if (hit !== undefined && this.now() - hit.at < ttlMs) {
        return hit.models.map((model) => ({ ...model }))
      }
      if (hit !== undefined) this.discoveryCache.delete(cacheKey)
    }
    try {
      const models = await this.listModelsWithRetry(instance, relayKey)
      if (cacheKey !== undefined) {
        // Keep the map from growing without bound across long sessions.
        if (this.discoveryCache.size >= DISCOVERY_CACHE_MAX_ENTRIES) this.discoveryCache.clear()
        this.discoveryCache.set(cacheKey, { models, at: this.now() })
      }
      return models
    } catch (error) {
      throw new Sub2apiSyncError(
        `分组 ${groupId} 模型发现失败：${messageOf(error)}；且未配置 modelListOverrides 兜底`,
      )
    }
  }

  /**
   * One `/v1/models` call, retried ONCE when the relay answers 429: bounded
   * concurrency must not turn a working sync into a failed one just because a
   * relay meters per-key requests. Every other failure propagates unchanged
   * (the 401 self-heal in `buildKeyProfile` matches on the message).
   */
  private async listModelsWithRetry(instance: string, relayKey: string): Promise<GatewayModelEntry[]> {
    const client = new Sub2apiClient({ baseURL: instance, fetchImpl: this.fetchImpl })
    let lastError: unknown
    for (let attempt = 0; attempt <= DISCOVERY_RETRY_ATTEMPTS; attempt++) {
      try {
        return await client.listModels(relayKey)
      } catch (error) {
        lastError = error
        const retryable = /HTTP 429(?![0-9])|超时（/.test(messageOf(error))
        if (!retryable || attempt === DISCOVERY_RETRY_ATTEMPTS) throw error
        await new Promise((resolve) => { setTimeout(resolve, DISCOVERY_RETRY_DELAY_MS * (attempt + 1)) })
      }
    }
    throw lastError
  }

  private readCurrentProviders(): Record<string, PiAiProviderProfile> {
    // The 0.1.7+ settings surface has no `get(ns)`; a namespace's live value
    // rides its describe() descriptor (same-process caller, no redaction).
    const descriptor = this.settings.describe().find((candidate) => candidate.ns === PI_AI_NS)
    if (descriptor === undefined) {
      throw new Sub2apiSyncError('llm-pi-ai 设置条目未激活——需要 dsh-llm-pi-ai 挂载后才能写入 provider 路由')
    }
    const providers = (descriptor.value as { providers?: unknown } | undefined)?.providers
    if (providers === undefined || providers === null) return {}
    if (typeof providers !== 'object' || Array.isArray(providers)) {
      throw new Sub2apiSyncError('llm-pi-ai.providers 形状异常（不是对象）')
    }
    return providers as Record<string, PiAiProviderProfile>
  }
}

/** Attach the enriched facts (display name, capacity, efforts) to one discovered model. */
function enrichModel(model: GatewayModelEntry, index: ModelMetaIndex): ProfileModelInput {
  const meta = index.get(model.id.toLowerCase())
  if (meta === undefined) return { id: model.id }
  return {
    id: model.id,
    ...(meta.name !== undefined ? { name: meta.name } : {}),
    ...(meta.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {}),
    ...(meta.maxTokens !== undefined ? { maxTokens: meta.maxTokens } : {}),
    ...(meta.imageInput === true ? { imageInput: true } : {}),
    ...(meta.reasoningEfforts !== undefined ? { reasoningEfforts: { ...meta.reasoningEfforts } } : {}),
  }
}

/** Platform mapping with a per-group override applied last. */
function protocolForPlatformWithOverride(platform: string, override: ApiProtocol | undefined): ApiProtocol | undefined {
  return override ?? protocolForPlatform(platform)
}

/**
 * Pure diff of one current/desired snapshot → ops plus per-route actions.
 * `keep` names owned routes that must survive this run even though they are
 * not in `desired`: the key is still selected, it just failed this time.
 */
function planOps(
  current: Record<string, PiAiProviderProfile>,
  desired: Map<string, PiAiProviderProfile>,
  keep: ReadonlySet<string> = new Set(),
  keepAll = false,
): { ops: SettingsPathOp[]; actions: Map<string, SyncAction> } {
  const ops: SettingsPathOp[] = []
  const actions = new Map<string, SyncAction>()
  const routes = new Set<string>([
    ...Object.keys(current).filter(isOwnedRoute),
    ...desired.keys(),
  ])
  for (const route of routes) {
    const want = desired.get(route)
    const have = current[route]
    if (want !== undefined) {
      if (have === undefined) {
        ops.push({ op: 'set', path: ['providers', route], value: want })
        actions.set(route, 'created')
      } else if (!deepEqual(have, want)) {
        ops.push({ op: 'set', path: ['providers', route], value: want })
        actions.set(route, 'updated')
      } else {
        actions.set(route, 'unchanged')
      }
    } else if (isOwnedRoute(route) && !keepAll && !keep.has(route)) {
      ops.push({ op: 'unset', path: ['providers', route] })
      actions.set(route, 'unchanged') // removal is reported via `removed`, not per-entry
    }
    // Non-owned routes are never touched — that is the ownership boundary.
  }
  return { ops, actions }
}

/**
 * Bounded fan-out: at most `limit` workers run at once, results land in input
 * order. The worker is expected to swallow its own failures (the sync reports
 * per-key errors rather than aborting the run) — an escaping rejection still
 * propagates, it just stops the remaining queue.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  if (items.length === 0) return results
  let next = 0
  const size = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: size }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }))
  return results
}

/** Digest of one discovery target — instance + group + plaintext, never the secret itself. */
function discoveryCacheKey(instance: string, groupId: number, relayKey: string): string {
  return createHash('sha256').update(`${instance}\u0000${groupId}\u0000${relayKey}`).digest('hex').slice(0, 32)
}
