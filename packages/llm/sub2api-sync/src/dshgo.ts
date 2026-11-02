/**
 * dsh-Go native surfaces (NA protocol v1): a 'sync-status' panel plus a
 * 'sync-strip' composer strip, declared in package.json 'dshGo' and fed
 * here from the same RouteDeps face the web card's action routes use —
 * one contract, no duplicated host logic.
 *
 * Registration is inert without the dsh-go bridge: ctx.inject(['dshGo'], …)
 * simply never fires on a host without one (desktop), and 'dshGo' is NOT in
 * the plugin's top-level 'inject' (per the NA protocol — a top-level entry
 * would keep the whole plugin from booting there). Do not write ['dshGo?']
 * either: cordis 4.0.5 has no optional-dependency syntax and treats it as a
 * permanently-absent service name.
 *
 * Long actions are deliberately fire-and-forget: sync/login/logout start in
 * the background while the invoke answers with a toast immediately. That
 * keeps the 3-second invoke window irrelevant and behaves identically on
 * v1.0 Apps (no v1.1 pending channel needed). Fresh state reaches the App
 * through the data sources' interval re-emit (credential-store reads only —
 * no network on the tick) plus an immediate publish when a background
 * action settles; failures surface in the panel's callout instead of a
 * late toast the v1 effect whitelist cannot deliver.
 *
 * @module sub2api-sync/dshgo
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LoginResponse, RouteDeps } from './routes.ts'

/** The slice of the bridge's ctx.dshGo face this module uses (NA v1). */
interface DshGoFace {
  panel(id: string, face: {
    view: (scope: unknown, caps: { locale?: string }) => unknown
    data: (
      scope: unknown,
      emit: (data: Record<string, unknown>) => void,
      caps: { locale?: string },
    ) => (() => void) | void
    actions: Record<string, (scope: unknown, event: { locale?: string }) => unknown>
  }): unknown
  strip(
    id: string,
    data: (
      scope: unknown,
      emit: (data: { text: string; icon?: string; tone?: string }) => void,
      caps: { locale?: string },
    ) => (() => void) | void,
  ): unknown
}

/** One localized copy table; keys mirror the usage sites below. */
interface Texts {
  signedInPrefix: string
  signedOut: string
  noEmail: string
  loginAction: string
  logoutAction: string
  syncAction: string
  syncing: string
  idle: string
  instanceLabel: string
  stateLabel: string
  routesLabel: string
  lastSyncLabel: string
  never: string
  loginStarted: string
  logoutStarted: string
  twoFaHint: string
  hint: string
  justNow: string
  minutesAgo(n: number): string
  hoursAgo(n: number): string
  daysAgo(n: number): string
}

const ZH: Texts = {
  signedInPrefix: '已登录',
  signedOut: '未登录：在设置里填写实例地址与邮箱，凭据槽写入面板密码',
  noEmail: '请先在设置里填写面板邮箱',
  loginAction: '登录面板',
  logoutAction: '退出登录',
  syncAction: '立即同步',
  syncing: '同步中',
  idle: '空闲',
  instanceLabel: '实例',
  stateLabel: '状态',
  routesLabel: '路由数',
  lastSyncLabel: '上次同步',
  never: '尚未同步',
  loginStarted: '正在登录…',
  logoutStarted: '正在退出…',
  twoFaHint: '该账号开启了两步验证：请在网页版设置卡完成第二因子',
  hint: '勾选 key、两步验证与逐路由移除请在网页版设置卡操作',
  justNow: '刚刚',
  minutesAgo: (n) => n + ' 分钟前',
  hoursAgo: (n) => n + ' 小时前',
  daysAgo: (n) => n + ' 天前',
}

const EN: Texts = {
  signedInPrefix: 'Signed in',
  signedOut: 'Signed out: fill the instance URL and email in settings, write the panel password into the credential slot',
  noEmail: 'Fill the panel email in settings first',
  loginAction: 'Sign in',
  logoutAction: 'Sign out',
  syncAction: 'Sync now',
  syncing: 'Syncing',
  idle: 'Idle',
  instanceLabel: 'Instance',
  stateLabel: 'State',
  routesLabel: 'Routes',
  lastSyncLabel: 'Last sync',
  never: 'Never',
  loginStarted: 'Signing in…',
  logoutStarted: 'Signing out…',
  twoFaHint: 'Two-factor is enabled: finish the second factor in the web settings card',
  hint: 'Key selection, two-factor and per-route removal live in the web settings card',
  justNow: 'just now',
  minutesAgo: (n) => n + ' min ago',
  hoursAgo: (n) => n + ' h ago',
  daysAgo: (n) => n + ' d ago',
}

const textOf = (locale: string | undefined): Texts =>
  typeof locale === 'string' && locale.toLowerCase().startsWith('en') ? EN : ZH

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function relativeTime(at: number, t: Texts): string {
  const elapsed = Date.now() - at
  if (elapsed < 60_000) return t.justNow
  if (elapsed < 3_600_000) return t.minutesAgo(Math.floor(elapsed / 60_000))
  if (elapsed < 86_400_000) return t.hoursAgo(Math.floor(elapsed / 3_600_000))
  return t.daysAgo(Math.floor(elapsed / 86_400_000))
}

/** Complete panel data model — the strip folds its one-line view from it. */
interface PanelData {
  statusText: string
  statusTone: 'good' | 'warn' | 'bad' | 'info'
  signedIn: boolean
  instance: string
  stateText: string
  routeCount: number
  lastSyncText: string
  routes: { title: string; subtitle?: string; trailing?: string }[]
  actions: { label: string; style?: 'primary' | 'plain'; action: string }[]
}

/** Extra host half the RouteDeps face does not carry. */
export interface DshGoHooks {
  /** The configured panel email (login needs it; deps only closes over it). */
  email(): string | undefined
}

/**
 * Register the native panel and strip. No-op without the bridge; the
 * callback body only runs on hosts that provide the 'dshGo' service.
 */
export function registerDshGo(ctx: Context, deps: RouteDeps, hooks: DshGoHooks): void {
  ctx.inject(['dshGo'], (host) => {
    const dshGo = (host as unknown as { dshGo?: DshGoFace }).dshGo
    if (dshGo === undefined) return

    /** Transient feedback from background actions; cleared by the next success. */
    let lastError: string | undefined
    let hint: string | undefined
    let activeLocale = 'zh-CN'

    const buildData = async (): Promise<PanelData> => {
      const t = textOf(activeLocale)
      let signedIn = false
      let email: string | undefined
      try {
        const auth = await deps.authState()
        signedIn = auth.signedIn
        email = auth.email
      } catch {
        // Credential-store read failed: present as signed-out; the tick retries.
        signedIn = false
      }
      const routes = deps.ownedRoutes()
      const lastSyncAt = deps.lastReportAt()
      const statusLine =
        lastError !== undefined ? { text: lastError, tone: 'bad' as const }
        : hint !== undefined ? { text: hint, tone: 'info' as const }
        : signedIn
          ? { text: t.signedInPrefix + (email !== undefined && email.length > 0 ? ' · ' + email : ''), tone: 'good' as const }
          : { text: t.signedOut, tone: 'warn' as const }
      return {
        statusText: statusLine.text,
        statusTone: statusLine.tone,
        signedIn,
        instance: deps.instance(),
        stateText: deps.isSyncRunning() ? t.syncing : signedIn ? t.idle : t.signedOut,
        routeCount: routes.length,
        lastSyncText: lastSyncAt === undefined ? t.never : relativeTime(lastSyncAt, t),
        routes: routes.map((route) => ({
          title: route.displayName ?? route.route,
          ...(route.api !== undefined ? { subtitle: route.api } : {}),
          trailing: String(route.models),
        })),
        actions: signedIn
          ? [
              { label: t.syncAction, style: 'primary' as const, action: 'sync' },
              { label: t.logoutAction, action: 'logout' },
            ]
          : [{ label: t.loginAction, style: 'primary' as const, action: 'login' }],
      }
    }

    /** Broadcast one fresh model to every live data/strip source. */
    const sinks = new Set<(data: PanelData) => void>()
    const publish = (data: PanelData): void => {
      for (const sink of [...sinks]) sink(data)
    }
    const schedule = (): void => {
      void buildData().then(publish).catch(() => undefined)
    }
    /** Emit now, on every settle, and on a bounded tick until cancelled. */
    const watch = (sink: (data: PanelData) => void): (() => void) => {
      sinks.add(sink)
      schedule()
      const timer = setInterval(schedule, 15_000)
      return () => {
        sinks.delete(sink)
        clearInterval(timer)
      }
    }
    const noteError = (cause: unknown): void => {
      lastError = messageOf(cause)
      schedule()
    }

    dshGo.panel('sync-status', {
      view: (_scope, caps) => {
        const t = textOf(caps?.locale)
        return {
          type: 'stack',
          children: [
            { type: 'callout', text: { $: 'data.statusText' }, tone: { $: 'data.statusTone' } },
            { type: 'row', children: [
              { type: 'metric', label: t.routesLabel, value: { $: 'data.routeCount' }, tone: 'info' },
              { type: 'metric', label: t.lastSyncLabel, value: { $: 'data.lastSyncText' }, tone: 'info' },
            ] },
            { type: 'keyValue', items: [
              [t.instanceLabel, { $: 'data.instance' }],
              [t.stateLabel, { $: 'data.stateText' }],
            ] },
            { type: 'list', items: { $: 'data.routes' } },
            { type: 'actions', items: { $: 'data.actions' } },
            { type: 'text', tone: 'muted', text: t.hint },
          ],
        }
      },
      data: (_scope, emit, caps) => {
        activeLocale = caps?.locale ?? activeLocale
        let alive = true
        const cancel = watch((data) => {
          if (alive) emit(data as unknown as Record<string, unknown>)
        })
        return () => {
          alive = false
          cancel()
        }
      },
      actions: {
        sync: () => {
          const t = textOf(activeLocale)
          if (deps.isSyncRunning()) return { toast: t.syncing + '…' }
          lastError = undefined
          void deps.sync().then(schedule).catch(noteError)
          return { toast: t.syncAction + ' · ' + t.syncing + '…' }
        },
        login: () => {
          const t = textOf(activeLocale)
          const email = hooks.email()?.trim() ?? ''
          if (email.length === 0) return { toast: t.noEmail }
          hint = undefined
          lastError = undefined
          void deps
            .login(email, undefined)
            .then((response: LoginResponse) => {
              // Second-factor legs cannot finish natively (no free-form input
              // on a v1 panel): point at the web card and let the web path own it.
              hint = response.kind === '2fa' ? t.twoFaHint : undefined
              schedule()
            })
            .catch(noteError)
          return { toast: t.loginStarted }
        },
        logout: () => {
          const t = textOf(activeLocale)
          lastError = undefined
          void deps.logout().then(schedule).catch(noteError)
          return { toast: t.logoutStarted }
        },
      },
    })

    dshGo.strip('sync-strip', (_scope, emit, caps) => {
      activeLocale = caps?.locale ?? activeLocale
      let alive = true
      const cancel = watch((data) => {
        if (!alive) return
        const t = textOf(activeLocale)
        emit({
          text: data.signedIn
            ? data.routeCount + ' · ' + data.lastSyncText
            : 'Sub2API · ' + t.signedOut,
          icon: 'chart',
          ...(data.statusTone === 'bad' ? { tone: 'bad' } : {}),
        })
      })
      return () => {
        alive = false
        cancel()
      }
    })
  })
}
