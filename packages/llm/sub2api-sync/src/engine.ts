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
 * - scoped: only `sub2api-<digits>` routes are ever written or removed;
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
  groupIdOfRoute,
  isOwnedRoute,
  relayKeyRef,
  routeForKey,
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
  /** Credential-backed panel gateway (login/PAT tokens, single-flight refresh). */
  gateway: PanelGateway
  fetchImpl?: typeof fetch
  /** Model-metadata index loader (C4); overridable in tests. */
  loadModelIndex?: typeof loadModelIndex
}

export type SyncAction = 'created' | 'updated' | 'unchanged' | 'failed'

export interface SyncEntryOutcome {
  groupId: number
  route: string
  displayName?: string
  action: SyncAction
  models?: number
  error?: string
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
  private queue: Promise<unknown> = Promise.resolve()
  private running = false

  constructor(options: SyncEngineOptions) {
    this.settings = options.settings
    this.credentials = options.credentials
    this.gateway = options.gateway
    this.fetchImpl = options.fetchImpl
    this.modelIndexLoader = options.loadModelIndex ?? loadModelIndex
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

    const effective = { ...config, selectedKeys: selection ?? config.selectedKeys }
    for (const target of resolveTargets(effective, keyRows)) {
      if ('invalid' in target) {
        entries.push({ groupId: target.invalid, route: `${target.invalid}`, action: 'failed', error: target.error })
        continue
      }
      const key = target.key
      const route = routeForKey(key.id)
      try {
        const group = groupById.get(key.groupId)
        if (group === undefined) {
          throw new Sub2apiSyncError(`key #${key.id}（${key.name}）的分组 ${key.groupId} 在面板不可用`)
        }
        const profile = await this.buildKeyProfile(config, key, group, instance, modelIndex)
        desired.set(route, profile)
        entries.push({
          groupId: group.id,
          route,
          displayName: profile.displayName,
          action: 'unchanged',
          models: profile.models?.length ?? 0,
        })
      } catch (error) {
        entries.push({ groupId: key.groupId, route, action: 'failed', error: messageOf(error) })
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
    // (mutate above) and its credential (here, best effort). The route embeds
    // the key id, so remote revocation is always addressable.
    const warnings: string[] = []
    for (const route of removed) {
      const keyId = groupIdOfRoute(route)
      if (keyId === undefined) continue
      try {
        await this.credentials.unset(relayKeyRef(keyId))
      } catch (error) {
        warnings.push(`key ${route} 的凭据清理失败：${messageOf(error)}`)
      }
      if (config.deleteOrphanKeys === true) {
        try {
          await this.gateway.use((panel, token) => panel.deleteKey(token, keyId))
        } catch (error) {
          warnings.push(`key ${route} 的远端撤销失败：${messageOf(error)}`)
        }
      }
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
  ): Promise<PiAiProviderProfile> {
    const protocol: ApiProtocol | undefined = protocolForPlatformWithOverride(group.platform, config.protocolOverrides?.[String(group.id)])
    if (protocol === undefined) {
      throw new Sub2apiSyncError(
        `key #${key.id}（${key.name}）所属分组 ${group.id} 的平台 "${group.platform}" 没有协议映射（可用 protocolOverrides 显式指定）`,
      )
    }

    const ref = relayKeyRef(key.id)
    let plaintext = key.key
    if (plaintext === undefined || plaintext.length === 0) {
      const stored = await this.credentials.resolve(ref)
      plaintext = stored?.value
    }
    if (plaintext === undefined || plaintext.length === 0) {
      throw new Sub2apiSyncError(`key #${key.id}（${key.name}）面板未返回明文且没有已存凭据——请用管理员账号登录面板，或粘贴这把 key`)
    }
    if (this.credentials.resolve !== undefined) {
      // Keep the credential in step so later syncs survive panel masking.
      const stored = await this.credentials.resolve(ref)
      if (stored?.value !== plaintext) {
        await this.credentials.set(ref, plaintext)
      }
    }

    const models = await this.discoverModels(config, group.id, instance, plaintext)
    return buildProviderProfile({
      groupId: group.id,
      displayName: renderProviderName(config.providerNameTemplate, key.name),
      protocol,
      instance,
      models: models.map((model) => enrichModel(model, modelIndex)),
      apiKeyEnv: ref,
      template: config.compatTemplate,
    })
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

/** Attach the enriched capacity facts (if any) to one discovered model. */
function enrichModel(model: GatewayModelEntry, index: ModelMetaIndex): ProfileModelInput {
  const meta = index.get(model.id.toLowerCase())
  if (meta === undefined) return { id: model.id }
  return {
    id: model.id,
    ...(meta.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {}),
    ...(meta.maxTokens !== undefined ? { maxTokens: meta.maxTokens } : {}),
    ...(meta.imageInput === true ? { imageInput: true } : {}),
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
