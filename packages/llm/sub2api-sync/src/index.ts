/**
 * sub2api sync plugin — host half.
 *
 * rev.4: the panel is the single source of groups. Login channels are
 * password(+2FA) / OAuth (OAuth routes deferred until the sub2api
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
import { Sub2apiSyncEngine, OWN_NS, PI_AI_NS, createSyncReportStore } from './engine.ts'
import { createInstanceProbe } from './icon.ts'
import {
  OAuthAttemptStore,
  buildAuthorizeUrl,
  callbackPageHtml,
  createPkcePair,
  discoverOAuthEndpoints,
  exchangeAuthorizationCode,
  loopbackCallbackOrigin,
  oauthScopesFor,
  resetDiscoveryCache,
} from './oauth.ts'
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
import { routeKeyRef, routeForKey, panelTokenRef, panelRefreshRef, oauthTokenRef, oauthRefreshRef, isOwnedRoute } from './types.ts'
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
  routeKeyRef,
  legacyKeyRef,
  legacyKeyIdOfRoute,
  panelTokenRef,
  panelRefreshRef,
  oauthTokenRef,
  oauthRefreshRef,
  panelPasswordRef,
  parseGroupId,
} from './types.ts'
export { ROUTES, trustedRequest, callbackLangOf } from './routes.ts'
export {
  OAUTH_CALLBACK_PATH,
  OAUTH_CLIENT_ID,
  OAuthAttemptStore,
  OAuthError,
  buildAuthorizeUrl,
  callbackPageHtml,
  createPkcePair,
  discoverOAuthEndpoints,
  exchangeAuthorizationCode,
  loopbackCallbackOrigin,
  oauthScopesFor,
  refreshAccessToken,
  revokeToken,
  type CallbackLang,
} from './oauth.ts'

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

  /** Conflict-retried write into the llm-pi-ai section (purge path mirrors
   * the engine's conflict policy without touching its queue). */
  const mutatePiAi = async (ops: SettingsPathOp[]): Promise<void> => {
    let attempts = 0
    for (;;) {
      attempts++
      const revision = ctx.settings.describe().find((descriptor) => descriptor.ns === PI_AI_NS)?.revision
      if (revision === undefined) throw new Error('sub2api-sync: llm-pi-ai 设置条目未注册')
      try {
        await ctx.settings.mutate(PI_AI_NS, ops, revision)
        return
      } catch (error) {
        const shape = error as { code?: unknown; name?: unknown } | null | undefined
        const conflict = shape?.code === 'SETTINGS_CONFLICT' || shape?.name === 'SettingsConflictError'
        if (conflict && attempts < 3) continue
        throw error
      }
    }
  }

  const credentials = {
    resolve: (ref: string) => ctx.credentials.resolve(credentialRef(ref)),
    set: (ref: string, value: string) => ctx.credentials.set(credentialRef(ref), value),
    unset: (ref: string) => ctx.credentials.unset(credentialRef(ref)),
  }

  // The last accepted sync report. Part of the visible sync state: purged
  // together with the routes/credentials, so a signed-out card never keeps
  // advertising a sync whose providers are already gone.
  const reports = createSyncReportStore()

  /**
   * Purge this plugin's sync state: every owned provider route leaves the
   * llm-pi-ai section and its relay-key credential is dropped. Logout,
   * definitive auth loss, and instance switches all funnel here.
   */
  const purgeSyncState = async (): Promise<void> => {
    reports.clear()
    const section = ctx.settings.describe().find((descriptor) => descriptor.ns === PI_AI_NS)?.value
    const routes = describeOwnedRoutes(section).map((route) => route.route)
    if (routes.length > 0) {
      await mutatePiAi(routes.map((route) => ({ op: 'unset', path: ['providers', route] }) as SettingsPathOp))
    }
    for (const route of routes) {
      await credentials.unset(routeKeyRef(route)).catch(() => undefined)
    }
    // The route → key id map describes purged routes only.
    await mutateOwn([{ op: 'unset', path: ['routeKeyIds'] } as SettingsPathOp]).catch(() => undefined)
  }

  /** Drop one instance's unreachable panel secrets (token/refresh/OAuth pair). */
  const dropInstanceSecrets = async (baseURL: string): Promise<void> => {
    for (const ref of [panelTokenRef(baseURL), panelRefreshRef(baseURL), oauthTokenRef(baseURL), oauthRefreshRef(baseURL)]) {
      await credentials.unset(ref).catch(() => undefined)
    }
  }

  // The gateway re-reads baseURL per call: the card may edit the instance
  // address between operations. Definitive auth loss (refresh refused) also
  // purges the sync state per the logout/expiry policy.
  const gateway = new PanelGateway({ baseURL: () => source().baseURL?.trim() ?? '', credentials, onAuthLost: () => void purgeSyncState().catch(() => undefined) })
  const engine = new Sub2apiSyncEngine({ settings: ctx.settings, credentials, gateway, siteName: () => instanceProbe.siteName(instance()) })

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

  // Instance icon + site-name probe (cached per instance in the closure).
  const instanceProbe = createInstanceProbe()

  // OAuth web channel (C2): attempts live in host memory only — the PKCE
  // verifier never leaves this process, and `state` is single-use.
  const oauthAttempts = new OAuthAttemptStore()

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
    logout: async () => {
      await gateway.logout()
      // Logout policy: the site's sync state (provider routes + relay key
      // credentials) goes with the session.
      await purgeSyncState().catch(() => undefined)
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
      const report = await engine.sync(source(), keyIds)
      reports.record(report)
      return report
    },
    lastReport: () => reports.report(),
    lastReportAt: () => reports.at(),
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
      // The create response carries the one-time plaintext: park it in the
      // credential store immediately so sync never needs the reveal round
      // trip for keys created in this session. The ref derives from the
      // route (instance + key id), matching the engine's resolve chain.
      const baseURL = config.baseURL?.trim() ?? ''
      if (key.key !== undefined && key.key.length > 0 && !key.key.includes('****') && /^https?:\/\//i.test(baseURL)) {
        await credentials.set(routeKeyRef(routeForKey(baseURL, key.id)), key.key).catch(() => undefined)
      }
      return {
        id: key.id,
        name: key.name,
        groupId: key.groupId,
        ...(key.status !== undefined ? { status: key.status } : {}),
      }
    },
    isSyncRunning: () => engine.isRunning(),
    icon: () => instanceProbe.icon(instance()),
    siteName: () => instanceProbe.siteName(instance()),
    // The header account is cosmetic, but failures propagate: the route layer
    // catches and answers `{ok, error}` so the card's console names the cause.
    account: () => gateway.use((panel, token) => panel.getProfile(token)),
    resetSync: async (previousBaseURL?: string) => {
      await purgeSyncState()
      if (previousBaseURL !== undefined && previousBaseURL.trim().length > 0) {
        await dropInstanceSecrets(previousBaseURL)
      }
    },
    removeSyncedKey: async (keyId) => {
      const baseURL = instance()
      if (!/^https?:\/\//i.test(baseURL)) {
        throw new Error('sub2api-sync: baseURL 未配置或不是 http(s) 地址')
      }
      // The report entry is the authority on which route the engine actually
      // wrote (a pre-rev.5 legacy key still lives at its digit route); the
      // recomputed slug is only the fallback for a report-less removal.
      const entry = reports.report()?.entries.find((candidate) => candidate.keyId === keyId && candidate.invalid !== true)
      const route = entry?.route ?? routeForKey(baseURL, keyId)
      if (!isOwnedRoute(route)) {
        throw new Error(`sub2api-sync: 路由 ${route} 不在本插件的所有权边界内`)
      }
      await mutatePiAi([{ op: 'unset', path: ['providers', route] }])
      await credentials.unset(routeKeyRef(route)).catch(() => undefined)
      // The route leaves the engine's route → key id map too.
      await mutateOwn([{ op: 'unset', path: ['routeKeyIds', route] } as SettingsPathOp]).catch(() => undefined)
      // The report stops advertising the removed provider — same shape a
      // sync that dropped the key would have produced.
      const current = reports.report()
      if (current !== undefined && current.entries.some((candidate) => candidate.route === route)) {
        reports.record({
          ...current,
          entries: current.entries.filter((candidate) => candidate.route !== route),
          removed: [...current.removed, route],
          writes: current.writes + 1,
        })
      }
    },
    ownedRoutes: (): StatusRoute[] => {
      // The settings surface has no `get(ns)`: read the llm-pi-ai entry's
      // live value through describe() (same-process caller, no redaction).
      const descriptors = ctx.settings.describe()
      const routes = describeOwnedRoutes(descriptors.find((descriptor) => descriptor.ns === PI_AI_NS)?.value)
      // Annotate each route with its panel key id (engine's route → id map)
      // so the card can remove it without a panel round trip.
      const map = (descriptors.find((descriptor) => descriptor.ns === OWN_NS)?.value as { routeKeyIds?: Record<string, number> } | undefined)?.routeKeyIds ?? {}
      return routes.map((route) => (map[route.route] !== undefined ? { ...route, keyId: map[route.route] } : route))
    },
    allowRemote: () => source().allowRemoteActions === true,
    oauthProbe: async (address: string) => {
      // Host-side discovery probe for the sign-in dialog's channel
      // auto-detection (the browser cannot fetch the instance cross-origin).
      try {
        await discoverOAuthEndpoints(address)
        return true
      } catch {
        // A failed probe must not poison the 5-minute negative discovery
        // cache: the user may fix a typo on the next keystroke, and the real
        // oauthStart must retry fresh.
        resetDiscoveryCache()
        return false
      }
    },
    oauthStart: async (callbackOrigin) => {
      const instanceValue = instance()
      if (!/^https?:\/\//i.test(instanceValue)) {
        throw new Error('请先填写 sub2api 实例地址，再发起网页授权')
      }
      const redirectUri = loopbackCallbackOrigin(callbackOrigin)
      const endpoints = await discoverOAuthEndpoints(instanceValue)
      const { verifier, challenge } = await createPkcePair()
      const attempt = oauthAttempts.create({ verifier, redirectUri, scope: oauthScopesFor(source().deleteOrphanKeys) })
      const authorizeUrl = buildAuthorizeUrl(endpoints, {
        redirectUri,
        scope: attempt.scope,
        state: attempt.state,
        challenge,
      })
      return { attemptId: attempt.id, authorizeUrl }
    },
    oauthCallback: async (query, lang = 'zh') => {
      const state = query.get('state') ?? ''
      const attempt = state.length > 0 ? oauthAttempts.takeByState(state) : undefined
      if (attempt === undefined) {
        return { html: callbackPageHtml('failure', '授权请求不存在、已过期或已被使用——请回到应用重新发起网页授权', lang) }
      }
      const providerError = query.get('error')
      if (providerError !== null && providerError.length > 0) {
        const description = query.get('error_description') ?? ''
        oauthAttempts.settle(attempt.id, 'failed', providerError)
        return { html: callbackPageHtml('failure', `授权被拒绝（${providerError}）${description.length > 0 ? `：${description}` : ''}`, lang) }
      }
      const code = query.get('code') ?? ''
      if (code.length === 0) {
        oauthAttempts.settle(attempt.id, 'failed', '回调缺少授权码')
        return { html: callbackPageHtml('failure', '授权回调缺少授权码（code）——请回到应用重新发起', lang) }
      }
      try {
        const endpoints = await discoverOAuthEndpoints(instance())
        // Final leg: verifier + exact redirect_uri ride again; the provider
        // answers a rotating access+refresh pair which never touches a URL.
        const pair = await exchangeAuthorizationCode(endpoints, {
          code,
          redirectUri: attempt.redirectUri,
          verifier: attempt.verifier,
        })
        await gateway.storeOAuthTokens(pair)
        oauthAttempts.settle(attempt.id, 'completed')
        // Success copy mirrors the official landing page verbatim; the
        // dynamic failure details stay as the provider/host produced them.
        const successMessage = lang === 'en'
          ? 'You can close this page and return to the desktop app to continue.'
          : '你可以关闭此页面，返回桌面端继续工作。'
        return { html: callbackPageHtml('success', successMessage, lang) }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        oauthAttempts.settle(attempt.id, 'failed', message)
        return { html: callbackPageHtml('failure', message, lang) }
      }
    },
    oauthStatus: async (attemptId) => {
      const attempt = attemptId !== undefined ? oauthAttempts.peek(attemptId) : undefined
      const email = source().email
      return {
        ok: true,
        attempt,
        auth: await gateway.authState(email),
      }
    },
    oauthCancel: async (attemptId) => {
      oauthAttempts.cancel(attemptId)
    },
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
