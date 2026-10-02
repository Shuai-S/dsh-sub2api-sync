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

import { Sub2apiClient, type GatewayModelEntry } from './client.ts'
import type { PanelGateway, PanelGroup, PanelKey } from './panel.ts'
import { buildProviderProfile, protocolForPlatform, renderProviderName, type PiAiProviderProfile, type ProfileModelInput } from './protocols.ts'
import { loadModelIndex, type ModelMetaIndex } from './enrich.ts'
import type { Sub2apiSyncConfig } from './config.ts'
import {
  isOwnedRoute,
  legacyKeyIdOfRoute,
  legacyKeyRef,
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
  /** Model-metadata index loader (C4); overridable in tests. */
  loadModelIndex?: typeof loadModelIndex
  /**
   * The instance's configured site name for the `{siteName}` template
   * placeholder (cached probe; absent/unknown falls back to "sub2api").
   */
  siteName?: () => Promise<string | undefined>
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
}

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

function isSettingsConflict(error: unknown): boolean {
  const shape = error as { code?: unknown; name?: unknown } | null | undefined
  return shape?.code === 'SETTINGS_CONFLICT' || shape?.name === 'SettingsConflictError'
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
      targets.push({ invalid: id, error: `key #${id} 在面板不存在（可能已删除）——请在 Keys 卡刷新后重新勾选` })
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
  private readonly modelIndexLoader: typeof loadModelIndex
  private readonly siteName?: () => Promise<string | undefined>
  private queue: Promise<unknown> = Promise.resolve()
  private running = false

  constructor(options: SyncEngineOptions) {
    this.settings = options.settings
    this.credentials = options.credentials
    this.gateway = options.gateway
    this.fetchImpl = options.fetchImpl
    this.modelIndexLoader = options.loadModelIndex ?? loadModelIndex
    this.siteName = options.siteName
  }

  /** Whether a sync is currently executing (UI busy marker). */
  isRunning(): boolean {
    return this.running
  }

  /**
   * Run one sync. At most one runs at a time — later callers queue behind
   * the previous one (the settings-card button, the tool, and the timer all
   * share this queue).
   */
  sync(config: Sub2apiSyncConfig, keyIds?: number[]): Promise<SyncReport> {
    const run = this.queue.then(
      () => this.runSync(config, keyIds),
      () => this.runSync(config, keyIds),
    )
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async runSync(config: Sub2apiSyncConfig, keyIds?: number[]): Promise<SyncReport> {
    this.running = true
    try {
      return await this.syncNow(config, keyIds)
    } finally {
      this.running = false
    }
  }

  private async syncNow(config: Sub2apiSyncConfig, selection?: number[]): Promise<SyncReport> {
    const instance = config.baseURL?.trim() ?? ''
    if (!/^https?:\/\//i.test(instance)) {
      throw new Sub2apiSyncError('sub2api-sync: baseURL 未配置或不是 http(s) 地址')
    }

    const entries: SyncEntryOutcome[] = []
    const desired = new Map<string, PiAiProviderProfile>()

    // The panel gates everything: not signed in fails loud here. One pass
    // gathers the group platform map and every key row (bounded page walk).
    const { groups, keyRows } = await this.gateway.use(async (panel, token) => {
      const groupList = await panel.listAvailableGroups(token)
      const rows: PanelKey[] = []
      for (let page = 1; page <= 10; page++) {
        const result = await panel.listKeys(token, { page, pageSize: 100 })
        rows.push(...result.items)
        if (page >= result.pages || result.items.length === 0) break
      }
      return { groups: groupList, keyRows: rows }
    })
    const groupById = new Map(groups.map((group) => [group.id, group]))

    // C4: resolve the model-metadata index once per sync (never throws —
    // the loader degrades to the bundled snapshot, then to route defaults).
    const modelIndex = await this.modelIndexLoader({ enrich: config.enrichModelMeta !== false, ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}) }).catch(
      () => new Map() as ModelMetaIndex,
    )
    // The `{siteName}` placeholder value — one cached probe per sync.
    const site = await this.siteName?.().catch(() => undefined)

    const syncWarnings: string[] = []
    const effective = { ...config, selectedKeys: selection ?? config.selectedKeys }
    for (const target of resolveTargets(effective, keyRows)) {
      if ('invalid' in target) {
        entries.push({ groupId: target.invalid, route: `${target.invalid}`, action: 'failed', error: target.error, invalid: true })
        continue
      }
      const key = target.key
      const route = routeForKey(instance, key.id)
      try {
        const group = groupById.get(key.groupId)
        if (group === undefined) {
          throw new Sub2apiSyncError(`key #${key.id}（${key.name}）的分组 ${key.groupId} 在面板不可用`)
        }
        const { profile, warnings: profileWarnings } = await this.buildKeyProfile(config, key, group, instance, modelIndex, site)
        desired.set(route, profile)
        syncWarnings.push(...profileWarnings)
        entries.push({
          groupId: group.id,
          route,
          keyId: key.id,
          displayName: profile.displayName,
          action: 'unchanged',
          models: profile.models?.length ?? 0,
        })
      } catch (error) {
        entries.push({ groupId: key.groupId, route, keyId: key.id, action: 'failed', error: messageOf(error) })
      }
    }

    // The diff/retry loop: every conflict re-reads the current section and
    // recomputes the ops against it; `desired` is conflict-independent.
    let attempts = 0
    const removed: string[] = []
    let ops: SettingsPathOp[] = []
    let routeActions = new Map<string, SyncAction>()

    for (;;) {
      attempts++
      const now = this.readCurrentProviders()
      const plan = planOps(now, desired)
      ops = plan.ops
      routeActions = plan.actions
      removed.length = 0
      for (const op of ops) {
        if (op.op === 'unset') removed.push(op.path[1])
      }
      const revision = this.revisionOf(PI_AI_NS)
      try {
        if (ops.length > 0) await this.settings.mutate(PI_AI_NS, ops, revision)
        break
      } catch (error) {
        if (isSettingsConflict(error) && attempts < 3) continue
        throw error
      }
    }

    for (const entry of entries) {
      const action = routeActions.get(entry.route)
      if (action !== undefined) entry.action = action
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
    // button needs it without a panel round trip. Best effort — a failed
    // write only costs the remove button until the next sync.
    try {
      const mapOps: SettingsPathOp[] = []
      for (const entry of entries) {
        if (entry.keyId !== undefined && entry.action !== 'failed') {
          mapOps.push({ op: 'set', path: ['routeKeyIds', entry.route], value: entry.keyId })
        }
      }
      for (const route of removed) {
        mapOps.push({ op: 'unset', path: ['routeKeyIds', route] })
      }
      if (mapOps.length > 0) {
        await this.settings.mutate(OWN_NS, mapOps, this.revisionOf(OWN_NS))
      }
    } catch {
      // Non-fatal: the next successful sync rewrites the map.
    }

    return { entries, removed, writes: ops.length, attempts, warnings }
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
      }),
      warnings,
    }
  }


  /**
   * Model source precedence: a non-empty `modelListOverrides` entry is the
   * user's explicit selection from the card picker and wins outright (no
   * fetch — the entry contains exactly the chosen ids). Otherwise discover
   * via `/v1/models`; discovery failure falls back to the overrides loudly.
   */
  private async discoverModels(
    config: Sub2apiSyncConfig,
    groupId: number,
    instance: string,
    relayKey: string,
  ): Promise<GatewayModelEntry[]> {
    const selection = config.modelListOverrides?.[String(groupId)] ?? []
    if (selection.length > 0) return selection.map((id) => ({ id }))
    try {
      const client = new Sub2apiClient({ baseURL: instance, fetchImpl: this.fetchImpl })
      return await client.listModels(relayKey)
    } catch (error) {
      throw new Sub2apiSyncError(
        `分组 ${groupId} 模型发现失败：${messageOf(error)}；且未配置 modelListOverrides 兜底`,
      )
    }
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

  private revisionOf(ns: string): number {
    const descriptor = this.settings.describe().find((candidate) => candidate.ns === ns)
    if (descriptor === undefined) {
      throw new Sub2apiSyncError(`设置命名空间 "${ns}" 未注册，无法取得 revision`)
    }
    return descriptor.revision
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

/** Pure diff of one current/desired snapshot → ops plus per-route actions. */
function planOps(
  current: Record<string, PiAiProviderProfile>,
  desired: Map<string, PiAiProviderProfile>,
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
    } else if (isOwnedRoute(route)) {
      ops.push({ op: 'unset', path: ['providers', route] })
      actions.set(route, 'unchanged') // removal is reported via `removed`, not per-entry
    }
    // Non-owned routes are never touched — that is the ownership boundary.
  }
  return { ops, actions }
}
