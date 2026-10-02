/**
 * The main settings card (`settings.section`, id `sub2api-sync`): identity
 * header, instance connection, panel account, group management, and the sync
 * action with its report. The component is Cordis-free — data arrives through
 * the injected face (`api`, `config`, and the framework-synthesized
 * `useStatus` selector hook) and all copy through the `t` seat.
 *
 * Styling follows the ui-settings-account visual spec (§4.4) through the
 * shared stylesheet installed at mount time.
 *
 * @module sub2api-sync/client/section/Sub2apiSyncSection
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, StateDot, Tag, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { type Sub2apiSyncConfig } from '../../config.ts'
import { ROUTES, type GroupsView, type StatusResponse, type StatusRoute } from '../../routes.ts'
import type { SyncAction, SyncReport } from '../../engine.ts'
import type { NS } from '../locales.ts'
import { refreshStatus } from '../status.ts'
import { dropSelectedKey, pruneInvalidSelection, setField, useConfigForm } from '../useConfigForm.ts'
import type { PluginApi } from '../usePluginApi.ts'
import { SignInDialog } from './SignInDialog.tsx'
import { KeysCard } from './KeysCard.tsx'
import { accountLabelOf, formatBalance } from './header.ts'

/** Business face the mount injects into this section. */
export interface SectionInjected {
  api: PluginApi
  config: ConfigForm<Sub2apiSyncConfig>
  /** Status observable; the framework synthesizes the `useStatus` prop hook. */
  hooks: { status: HostObservable<StatusResponse | undefined> }
}

/** Composed section props: owner share + locale seat + injected face. */
export type Sub2apiSyncSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & InjectFace<SectionInjected>

/** Per-row and per-block feedback line (rendered under the acting block). */
type Feedback = { tone: 'ok' | 'error'; text: string } | undefined

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The instance display host: the URL's host when parseable, else the raw value. */
function hostOf(instance: string): string {
  const trimmed = instance.trim()
  if (trimmed.length === 0) return '—'
  try {
    return new URL(trimmed).host
  } catch {
    return trimmed
  }
}

function actionKeyOf(action: SyncAction): 'actionCreated' | 'actionUpdated' | 'actionUnchanged' | 'actionFailed' {
  switch (action) {
    case 'created': return 'actionCreated'
    case 'updated': return 'actionUpdated'
    case 'unchanged': return 'actionUnchanged'
    case 'failed': return 'actionFailed'
  }
}

function actionToneOf(action: SyncAction): 'success' | 'info' | 'outline' | 'danger' {
  switch (action) {
    case 'created': return 'success'
    case 'updated': return 'info'
    case 'unchanged': return 'outline'
    case 'failed': return 'danger'
  }
}

/** @param props - owner/locale/injected shares (see {@link Sub2apiSyncSectionProps}). @returns the settings card. */
export function Sub2apiSyncSection({ t, api, config, useStatus }: Sub2apiSyncSectionProps) {
  const status = useStatus((value: StatusResponse | undefined) => value) as StatusResponse | undefined
  const snapshot = useConfigForm(config)
  const configValues = snapshot.value
  const writable = snapshot.writable

  const auth = status?.auth
  const signedIn = auth?.signedIn ?? false
  const syncRunning = status?.syncRunning ?? false

  // Connection is owned by the sign-in dialog (rev.5: the address commits
  // together with the credentials — one write surface per field).
  const configuredBaseURL = configValues?.baseURL

  // Identity header derivations (dot + secondary line) and the sync summary.
  const dotState: 'done' | 'idle' = signedIn ? 'done' : 'idle'
  // Signed in → show the instance's icon as the identity mark; fall back to
  // the state dot when it cannot load (offline instance, no icon). The bytes
  // come from the host half's same-origin /icon proxy (declared <link
  // rel=icon> first, /favicon.ico convention fallback); the instance rides
  // the query so a re-pointed config busts the browser cache.
  const instanceOrigin = (() => {
    try {
      return new URL(status?.instance ?? '').origin
    } catch {
      return ''
    }
  })()
  const iconSrc = instanceOrigin !== ''
    ? `${ROUTES.icon}?instance=${encodeURIComponent(instanceOrigin)}`
    : undefined
  const [faviconBroken, setFaviconBroken] = useState(false)
  useEffect(() => { setFaviconBroken(false) }, [iconSrc])
  // Session/site hygiene: the site's sync state (key selection, provider
  // routes, relay-key credentials) is purged whenever the session ends
  // (logout or definitive auth loss) or the instance address changes —
  // stale cross-site state otherwise produces sync failures like
  // "key #N 在面板不存在".
  const previousSignedIn = useRef(signedIn)
  useEffect(() => {
    const was = previousSignedIn.current
    previousSignedIn.current = signedIn
    if (was && !signedIn) {
      void setField(config, 'selectedKeys', [])
    }
  }, [signedIn, config])

  const instanceMarker = (configValues?.baseURL ?? '').trim().replace(/\/+$/, '').toLowerCase()
  const previousInstance = useRef<string | undefined>(undefined)
  useEffect(() => {
    const markerKey = 'sub2api-sync:last-instance'
    let stored: string | undefined
    try {
      stored = window.localStorage.getItem(markerKey) ?? undefined
      window.localStorage.setItem(markerKey, instanceMarker)
    } catch {
      // localStorage unavailable — the in-memory ref still covers this session.
    }
    const was = previousInstance.current ?? stored
    previousInstance.current = instanceMarker
    if (was !== undefined && was.length > 0 && was !== instanceMarker) {
      void setField(config, 'selectedKeys', [])
      void api.resetSyncState(was).catch(() => undefined)
    }
  }, [instanceMarker, api, config])
  // The instance's configured site name (host parses it from the instance's
  // HTML title); unknown → the static plugin label stays.
  const [siteName, setSiteName] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!signedIn || instanceOrigin === '') {
      setSiteName(undefined)
      return
    }
    let alive = true
    api.site()
      .then((response) => { if (alive) setSiteName(response.name) })
      .catch(() => { if (alive) setSiteName(undefined) })
    return () => { alive = false }
  }, [api, signedIn, instanceOrigin])
  // The signed-in account's identity (username, else the masked email) and
  // balance for the header; unknown → the two-segment line and no pill stay.
  // Refetched when a sync finishes (balance moves with sync usage).
  const [account, setAccount] = useState<{ username?: string; email?: string; balance?: number } | undefined>(undefined)
  useEffect(() => {
    if (!signedIn || syncRunning) {
      return
    }
    let alive = true
    api.account()
      .then((response) => {
        if (!alive) return
        // The route layer reports upstream failures here instead of throwing;
        // surface them once — the header itself falls back silently.
        if (response.error !== undefined) console.warn('[sub2api-sync] account:', response.error)
        setAccount({ username: response.username, email: response.email, balance: response.balance })
      })
      .catch((cause) => {
        // Diagnostic only: a stale host half answers 404 here until the app
        // reloads the plugin, and the header intentionally falls back.
        console.warn('[sub2api-sync] account fetch failed', cause)
        if (alive) setAccount(undefined)
      })
    return () => { alive = false }
  }, [api, signedIn, syncRunning])
  const accountSegment = accountLabelOf(account)
  // Line 1 stays site · host; the account segment leads line 2 (a third
  // segment overflows the first line on narrow cards).
  const nameLine = siteName !== undefined && siteName.length > 0
    ? t('nameLineSite', { name: siteName, instance: hostOf(status?.instance ?? '') })
    : t('nameLine', { instance: hostOf(status?.instance ?? '') })
  const secondary = !signedIn
    ? t('signedOut')
    : auth?.kind === 'oauth'
      ? accountSegment !== undefined
        ? t('signedInOAuthAccount', { account: accountSegment })
        : t('signedInOAuth')
      : t('signedInAs', { email: auth?.email ?? '' })
  const routeCount = status?.routes.length ?? 0
  const selectedCount = configValues?.selectedKeys?.length ?? 0
  const report = status?.lastReport

  // Account block ----------------------------------------------------------
  const [signInOpen, setSignInOpen] = useState(false)
  const [accountBusy, setAccountBusy] = useState(false)
  const [accountFeedback, setAccountFeedback] = useState<Feedback>(undefined)

  // Groups block -----------------------------------------------------------
  const [groups, setGroups] = useState<GroupsView[] | undefined>(undefined)

  const fetchGroups = useCallback((): void => {
    api.groups()
      .then((response) => { setGroups(response.groups) })
      .catch(() => { setGroups(undefined) })
  }, [api])

  useEffect(() => {
    if (!signedIn) {
      setGroups(undefined)
      return
    }
    fetchGroups()
  }, [signedIn, fetchGroups])

  // Sync block -------------------------------------------------------------
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncFeedback, setSyncFeedback] = useState<Feedback>(undefined)

  const signOut = (): void => {
    setAccountBusy(true)
    setAccountFeedback(undefined)
    api.logout()
      .then(() => {
        setAccountFeedback({ tone: 'ok', text: t('signOutDone') })
        return refreshStatus()
      })
      .catch((cause) => { setAccountFeedback({ tone: 'error', text: t('actionFailedLabel', { message: messageOf(cause) }) }) })
      .finally(() => { setAccountBusy(false) })
  }

  const onSignedIn = (): void => {
    setAccountFeedback({ tone: 'ok', text: t('signedInNotice') })
    void refreshStatus()
  }

  const syncNow = (): void => {
    setSyncBusy(true)
    setSyncFeedback(undefined)
    api.sync()
      .then(async (response) => {
        setSyncFeedback({ tone: 'ok', text: t('syncDone') })
        // Stale selections have no row to uncheck — drop them automatically.
        await pruneInvalidSelection(config, response.report)
        return refreshStatus()
      })
      .catch((cause) => { setSyncFeedback({ tone: 'error', text: t('actionFailedLabel', { message: messageOf(cause) }) }) })
      .finally(() => { setSyncBusy(false) })
  }

  // Per-route removal from the registered-routes list: local state only —
  // the host drops the provider route and credential without touching the
  // panel (which may refuse, e.g. an empty balance); the card drops the
  // selection entry so the next sync cannot resurrect the provider.
  const [removingRoute, setRemovingRoute] = useState<string | undefined>(undefined)
  const removeRoute = (route: StatusRoute): void => {
    const keyId = route.keyId
    if (keyId === undefined || removingRoute !== undefined) return
    setRemovingRoute(route.route)
    api.removeKey(keyId)
      .then(async () => {
        setSyncFeedback({ tone: 'ok', text: t('entryRemoveDone', { name: route.displayName ?? route.route }) })
        await dropSelectedKey(config, keyId).catch(() => undefined)
        await refreshStatus()
      })
      .catch((cause) => { setSyncFeedback({ tone: 'error', text: t('actionFailedLabel', { message: messageOf(cause) }) }) })
      .finally(() => { setRemovingRoute(undefined) })
  }

  return (
    <div className="s2s-section">
      {snapshot.status === 'ready' && !writable && <p className="s2s-warn">{t('localOnlyWarning')}</p>}
      {snapshot.status === 'unavailable' && <p className="s2s-warn">{t('configUnavailable')}</p>}

      <section className="s2s-card">
        <div className="s2s-row">
          <div className="s2s-identity">
            <div className="s2s-avatar">
              {signedIn && iconSrc !== undefined && !faviconBroken ? (
                <img
                  className="s2s-favicon"
                  src={iconSrc}
                  alt=""
                  onError={() => { setFaviconBroken(true) }}
                />
              ) : (
                <StateDot state={dotState} size={16} />
              )}
            </div>
            <div className="s2s-identityCopy">
              <span className="s2s-name">{nameLine}</span>
              <span className="s2s-secondary">{secondary}</span>
            </div>
          </div>
          <div className="s2s-actions">
            {accountFeedback !== undefined && (
              <span className={`s2s-feedback ${accountFeedback.tone === 'ok' ? 's2s-feedbackOk' : 's2s-feedbackError'}`}>{accountFeedback.text}</span>
            )}
            {signedIn && account?.balance !== undefined && (
              <span className="s2s-balance" title={t('balanceTitle')}>{t('balanceLabel', { amount: formatBalance(account.balance) })}</span>
            )}
            {signedIn ? (
              <Button variant="outline" disabled={accountBusy || syncRunning} title={syncRunning ? t('syncing') : undefined} onClick={signOut}>
                {t('signOut')}
              </Button>
            ) : (
              <Button variant="primary" disabled={accountBusy} onClick={() => { setSignInOpen(true) }}>
                {t('signIn')}
              </Button>
            )}
          </div>
        </div>
      </section>

      {!signedIn && (
        <section className="s2s-card">
          <div className="s2s-row">
            <span className="s2s-name">{t('accountTitle')}</span>
          </div>
          <p className="s2s-feedback s2s-hint">{t('accountSignedOutHint')}</p>
        </section>
      )}

      {signedIn && <KeysCard api={api} config={config} groups={groups ?? []} t={t} />}

      <section className="s2s-card">
        <div className="s2s-row">
          <span className="s2s-name">{t('syncTitle')}</span>
          <div className="s2s-actions">
            {(syncRunning || syncBusy) && <TextShimmer active>{t('syncing')}</TextShimmer>}
            <Button variant="primary" disabled={!signedIn || !writable || syncBusy || syncRunning || selectedCount === 0} onClick={syncNow}>
              {t('syncNow')}
            </Button>
          </div>
        </div>
        {routeCount > 0 && <p className="s2s-feedback s2s-hint">{t('routesSummary', { count: routeCount })}</p>}
        {/* The registered routes themselves — name, model count, and the wire
            protocol each one speaks — with the per-route remove button: this
            is the live state, so removal belongs here, not on the report. */}
        {status?.routes.map((route) => (
          <div className="s2s-reportLine" key={route.route}>
            <span className="s2s-reportMark" data-mark="ok" aria-hidden="true" />
            <span className="s2s-reportText">
              {t('entryModels', { name: route.displayName ?? route.route, count: route.models })}
              {' '}
              {route.api !== undefined ? <Tag tone="info">{route.api}</Tag> : null}
            </span>
            {route.keyId !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                className="s2s-reportRemove"
                disabled={removingRoute !== undefined}
                onClick={() => { removeRoute(route) }}
              >
                {t('entryRemove')}
              </Button>
            )}
          </div>
        ))}
        {syncFeedback !== undefined && (
          <p className={`s2s-feedback ${syncFeedback.tone === 'ok' ? 's2s-feedbackOk' : 's2s-feedbackError'}`}>{syncFeedback.text}</p>
        )}
        {/* The report is a hint about the last sync run only — no actions.
            Never paint it (or the empty placeholder) once the session is
            gone, even if a stale status snapshot is still in flight. */}
        {signedIn && <SyncReportView t={t} report={report} />}
      </section>

      <SignInDialog open={signInOpen} onClose={() => { setSignInOpen(false) }} api={api} config={config} baseURL={configuredBaseURL} writable={writable} onSignedIn={onSignedIn} t={t} />
    </div>
  )
}

/**
 * The last sync report — a hint about the previous run (meta line, per-entry
 * outcomes, removals, warnings). No actions live here: removal belongs on
 * the registered-routes list above, which reflects the live state.
 */
function SyncReportView({ t, report }: PropsLocale<typeof NS> & { report: SyncReport | undefined }) {
  if (report === undefined) return <p className="s2s-feedback s2s-hint">{t('reportEmpty')}</p>
  return (
    <div className="s2s-column">
      <span className="s2s-hint">{t('reportMeta', { writes: report.writes, attempts: report.attempts })}</span>
      {report.entries.map((entry, index) => (
        <div className="s2s-reportLine" key={`${entry.groupId}-${index}`}>
          <span className="s2s-reportMark" data-mark={entry.action === 'failed' ? 'fail' : 'ok'} aria-hidden="true" />
          <span className={`s2s-reportText${entry.action === 'failed' ? ' s2s-reportError' : ''}`}>
            {entry.action === 'failed'
              ? t('entryError', { name: entry.displayName ?? entry.route, error: entry.error ?? '' })
              : t('entryModels', { name: entry.displayName ?? entry.route, count: entry.models ?? 0 })}
            {' '}
            <Tag tone={actionToneOf(entry.action)}>{t(actionKeyOf(entry.action))}</Tag>
          </span>
        </div>
      ))}
      {report.removed.length > 0 && (
        <span className="s2s-reportText">{t('reportRemoved', { routes: report.removed.join(', ') })}</span>
      )}
      {report.warnings.map((warning, index) => (
        <span className="s2s-reportText s2s-reportError" key={index}>{t('reportWarningLine', { message: warning })}</span>
      ))}
    </div>
  )
}
