/**
 * sub2api sync plugin — host half.
 *
 * rev.4: the panel is the single source of groups. Login channels are
 * PAT / password(+2FA) / OAuth (OAuth routes deferred until the sub2api
 * side lands); configuration reads/writes ride the platform settings seam
 * (`configForms` in the browser), so the host routes carry only actions,
 * secrets, and state projection.
 *
 * The settings section needs no registration since dsh 0.1.7: the `Config`
 * export is auto-projected into the settings page, and every field arrives
 * here as a live volatile cell (`ResolvedSub2apiSyncConfig`), so the entry's
 * resolved config is the authoritative source — the loader swaps cell values
 * in place on each form write and announces them via `loader/volatile-update`.
 *
 * @module sub2api-sync
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import { readConfig, validateConfig, type ResolvedSub2apiSyncConfig, type Sub2apiSyncConfig } from './config.ts'
import { Sub2apiSyncEngine, OWN_NS, PI_AI_NS, type SyncReport } from './engine.ts'
import { PanelGateway, panelPasswordRef } from './panel.ts'
import {
  describeOwnedRoutes,
  registerRoutes,
  type GroupsView,
  type LoginResponse,
  type KeysListPage,
  type PanelKeyMeta,
  type RouteDeps,
  type StatusRoute,
} from './routes.ts'
import type { SettingsPathOp } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Mirrors `@deepseek-ai/cordis-plugin-loader`'s declaration (not a
     * dependency here): the loader announces an in-place volatile config
     * commit for this plugin's entry with the changed field paths.
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

export { Config, validateConfig, DEFAULT_PROVIDER_NAME_TEMPLATE } from './config.ts'
export { Sub2apiSyncEngine, Sub2apiSyncError, OWN_NS, PI_AI_NS } from './engine.ts'
export { PanelClient, PanelGateway, PanelError } from './panel.ts'
export { buildProviderProfile, baseURLForProtocol, protocolForPlatform, guessPlatformFromModels, renderProviderName, SUB2API_RETRY_POLICY } from './protocols.ts'
export {
  API_PROTOCOLS,
  PLATFORMS,
  instanceKey,
  isOwnedRoute,
  routeForKey,
  groupIdOfRoute,
  relayKeyRef,
  panelTokenRef,
  panelRefreshRef,
  panelPasswordRef,
  parseGroupId,
} from './types.ts'
export { ROUTES, trustedRequest } from './routes.ts'

export const name: string = 'sub2api-sync'
export const inject: string[] = ['settings', 'credentials']

export function apply(ctx: Context, config: ResolvedSub2apiSyncConfig): void {
  // The authoritative section source: the entry's resolved config itself.
  // Every field arrives as a live volatile cell; folding it per call always
  // reads the current values the settings page (or the profile document)
  // last wrote.
  const source = (): Sub2apiSyncConfig => readConfig(config)

  // Cross-field constraints the schema cannot express. There is no write-site
  // validate hook any more: the write persists first, the loader then commits
  // the volatile cells and announces them, and an invalid value fails loudly
  // here and at every sync instead of silently stranding the plugin.
  const judge = (): void => {
    try {
      validateConfig(source())
    } catch (error) {
      ctx.logger.error(error)
    }
  }
  judge()

  const credentials = {
    resolve: (ref: string) => ctx.credentials.resolve(credentialRef(ref)),
    set: (ref: string, value: string) => ctx.credentials.set(credentialRef(ref), value),
    unset: (ref: string) => ctx.credentials.unset(credentialRef(ref)),
  }
  // The gateway re-reads baseURL per call: the card may edit the instance
  // address between operations.
  const gateway = new PanelGateway({ baseURL: () => source().baseURL?.trim() ?? '', credentials })
  const engine = new Sub2apiSyncEngine({ settings: ctx.settings, credentials, gateway })
  let lastReport: SyncReport | undefined
  let lastReportAt: number | undefined

  const ownRevision = (): number | undefined =>
    ctx.settings.describe().find((descriptor) => descriptor.ns === OWN_NS)?.revision

  /** Conflict-retried write into this plugin's own section (best effort). */
  const mutateOwn = async (ops: SettingsPathOp[]): Promise<void> => {
    let attempts = 0
    for (;;) {
      attempts++
      const revision = ownRevision()
      if (revision === undefined) throw new Error('sub2api-sync: 自身 settings 命名空间未注册')
      try {
        await ctx.settings.mutate(OWN_NS, ops, revision)
        return
      } catch (error) {
        const shape = error as { code?: unknown; name?: unknown } | null | undefined
        const conflict = shape?.code === 'SETTINGS_CONFLICT' || shape?.name === 'SettingsConflictError'
        if (conflict && attempts < 3) continue
        throw error
      }
    }
  }

  const instance = (): string => source().baseURL?.trim() ?? ''

  const deps: RouteDeps = {
    instance,
    authState: () => gateway.authState(source().email),
    login: async (email, password): Promise<LoginResponse> => {
      let pwd = password
      if (pwd === undefined || pwd.length === 0) {
        pwd = (await credentials.resolve(panelPasswordRef(instance())))?.value
      }
      if (pwd === undefined || pwd.length === 0) {
        throw new Error('请输入面板密码（首次登录后密码会保存到凭据存储，之后可免输入）')
      }
      if (password !== undefined && password.length > 0) {
        await credentials.set(panelPasswordRef(instance()), password)
      }
      await mutateOwn([{ op: 'set', path: ['email'], value: email }]).catch(() => undefined)
      const outcome = await gateway.login(email, pwd)
      if (outcome.kind === '2fa') return { ok: true, kind: '2fa', requires2FA: true }
      return { ok: true, kind: 'ok' }
    },
    login2FA: (code) => gateway.login2FA(code),
    logout: () => gateway.logout(),
    setPat: async (token) => {
      const groups = await gateway.setPat(token)
      return { ok: true, groups: groups.length }
    },
    listGroups: async (): Promise<GroupsView[]> => {
      const groups = await gateway.use((panel, token) => panel.listAvailableGroups(token))
      return groups.map((group) => ({
        id: group.id,
        name: group.name,
        platform: group.platform,
        status: group.status,
        rateMultiplier: group.rateMultiplier,
        isExclusive: group.isExclusive,
        claudeCodeOnly: group.claudeCodeOnly,
        enabled: false,
      }))
    },
    sync: async (keyIds?: number[]) => {
      lastReport = await engine.sync(source(), keyIds)
      lastReportAt = Date.now()
      return lastReport
    },
    lastReport: () => lastReport,
    lastReportAt: () => lastReportAt,
    listKeys: async (page, pageSize): Promise<KeysListPage> => {
      const result = await gateway.use((panel, token) => panel.listKeys(token, { page, pageSize }))
      return {
        keys: result.items.map((key) => ({
          id: key.id,
          name: key.name,
          groupId: key.groupId,
          ...(key.status !== undefined ? { status: key.status } : {}),
        })),
        total: result.total,
        pages: result.pages,
      }
    },
    createKey: async (input): Promise<PanelKeyMeta> => {
      const config = source()
      const key = await gateway.use((panel, token) => panel.createKey(token, {
        name: input.name,
        groupId: input.groupId,
        ...(config.keyQuota !== undefined ? { quota: config.keyQuota } : {}),
        ...(config.keyExpiresInDays !== undefined ? { expiresinDays: config.keyExpiresInDays } : {}),
      }))
      return {
        id: key.id,
        name: key.name,
        groupId: key.groupId,
        ...(key.status !== undefined ? { status: key.status } : {}),
      }
    },
    isSyncRunning: () => engine.isRunning(),
    ownedRoutes: (): StatusRoute[] => describeOwnedRoutes(
      // The settings surface has no `get(ns)`: read the llm-pi-ai entry's
      // live value through describe() (same-process caller, no redaction).
      ctx.settings.describe().find((descriptor) => descriptor.ns === PI_AI_NS)?.value,
    ),
    allowRemote: () => source().allowRemoteActions === true,
  }

  registerRoutes(ctx, deps)

  // Scheduled resync: armed from config, re-armed on every volatile commit.
  // The engine queue dedupes against explicit syncs (`isRunning` check).
  let timer: ReturnType<typeof setInterval> | undefined
  let armedFor: number | undefined
  const disarm = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    armedFor = undefined
  }
  const arm = (): void => {
    const interval = source().syncIntervalMs
    if (interval === undefined || interval < 60_000) {
      disarm()
      return
    }
    if (armedFor === interval) return
    disarm()
    timer = setInterval(() => {
      if (engine.isRunning()) return
      void engine.sync(source()).catch((error) => ctx.logger.error(error))
    }, interval)
    armedFor = interval
  }
  arm()
  ctx.on('loader/volatile-update', () => {
    judge()
    arm()
  })
  ctx.effect(() => () => disarm())
}
