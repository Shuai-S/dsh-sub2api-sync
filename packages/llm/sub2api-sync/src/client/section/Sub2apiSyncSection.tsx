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

import { useCallback, useEffect, useState } from 'react'
import { Button, StateDot, Tag, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { type Sub2apiSyncConfig } from '../../config.ts'
import type { GroupsView, StatusResponse } from '../../routes.ts'
import type { SyncAction, SyncReport } from '../../engine.ts'
import type { NS } from '../locales.ts'
import { refreshStatus } from '../status.ts'
import { useConfigForm } from '../useConfigForm.ts'
import type { PluginApi } from '../usePluginApi.ts'
import { SignInDialog } from './SignInDialog.tsx'
import { KeysCard } from './KeysCard.tsx'

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
  const secondary = !signedIn
    ? t('signedOut')
    : auth?.kind === 'pat'
      ? t('signedInPat')
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
      .then(() => {
        setSyncFeedback({ tone: 'ok', text: t('syncDone') })
        return refreshStatus()
      })
      .catch((cause) => { setSyncFeedback({ tone: 'error', text: t('actionFailedLabel', { message: messageOf(cause) }) }) })
      .finally(() => { setSyncBusy(false) })
  }

  return (
    <div className="s2s-section">
      {snapshot.status === 'ready' && !writable && <p className="s2s-warn">{t('localOnlyWarning')}</p>}
      {snapshot.status === 'unavailable' && <p className="s2s-warn">{t('configUnavailable')}</p>}

      <section className="s2s-card">
        <div className="s2s-row">
          <div className="s2s-identity">
            <div className="s2s-avatar">
              <StateDot state={dotState} size={16} />
            </div>
            <div className="s2s-identityCopy">
              <span className="s2s-name">{t('nameLine', { instance: hostOf(status?.instance ?? '') })}</span>
              <span className="s2s-secondary">{secondary}</span>
            </div>
          </div>
          <div className="s2s-actions">
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
        {accountFeedback !== undefined && (
          <p className={`s2s-feedback ${accountFeedback.tone === 'ok' ? 's2s-feedbackOk' : 's2s-feedbackError'}`}>{accountFeedback.text}</p>
        )}
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
        {syncFeedback !== undefined && (
          <p className={`s2s-feedback ${syncFeedback.tone === 'ok' ? 's2s-feedbackOk' : 's2s-feedbackError'}`}>{syncFeedback.text}</p>
        )}
        <SyncReportView t={t} report={report} />
      </section>

      <SignInDialog open={signInOpen} onClose={() => { setSignInOpen(false) }} api={api} config={config} baseURL={configuredBaseURL} writable={writable} onSignedIn={onSignedIn} t={t} />
    </div>
  )
}

/** The last sync report: per-entry lines, removals, and warnings. */
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
