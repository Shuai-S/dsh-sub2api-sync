/**
 * U2 placements 5: the Plugins-page detail badge and detail section, both
 * filtered to this bundle's own subject (`subject.kind === 'bundle'` with the
 * package name). The badge is the one-glance sync state. The section renders
 * the last sync report — and doubles as the detail page's panel connection
 * entry: while the panel is signed out it offers the same `SignInDialog` the
 * settings section owns, so the activation guide's "open configuration"
 * (which navigates here — `pluginNavigation` has no settings-page route)
 * lands on a page that can actually connect.
 *
 * @module sub2api-sync/client/plugins/Detail
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Sub2apiSyncConfig } from '../../config.ts'
import { PKG_NAME } from '../constants.ts'
import { refreshStatus, useStatus, useStatusHealth } from '../status.ts'
import { useConfigForm } from '../useConfigForm.ts'
import type { PluginApi } from '../usePluginApi.ts'
import { NS } from '../locales.ts'
import { detailCardModel, footerModel } from '../models/badge.ts'
import { SignInDialog } from '../section/SignInDialog.tsx'

export type DetailBadgeProps =
  PropsRuntime<'plugins.detail.badge'> & PropsLocale<typeof NS>

function isOwnBundle(subject: PropsRuntime<'plugins.detail.badge'>['subject']): boolean {
  return subject.kind === 'bundle' && subject.pkg.name === PKG_NAME
}

/** @param props - the detail-page subject plus the framework locale seat. */
export function DetailBadge(props: DetailBadgeProps): ReactNode {
  const { subject, t } = props
  if (!isOwnBundle(subject)) return null
  return <DetailBadgeBody t={t} />
}

function DetailBadgeBody({ t }: { t: TranslateNS<typeof NS> }): ReactNode {
  const status = useStatus()
  const footer = footerModel(status)
  return (
    <Tag tone={footer.signedIn ? 'success' : 'quiet'}>
      {footer.signedIn
        ? t('detailBadgeSynced', { count: footer.groups })
        : t('detailBadgeSignedOut')}
    </Tag>
  )
}

/** Business face the mount injects into the detail section (shared with the settings section's). */
export interface DetailInjected {
  api: PluginApi
  config: ConfigForm<Sub2apiSyncConfig>
}

export type DetailSectionProps =
  PropsRuntime<'plugins.detail.section'> & PropsLocale<typeof NS> & InjectFace<DetailInjected>

/** @param props - the detail-page subject, the locale seat, and the injected face. */
export function DetailSection(props: DetailSectionProps): ReactNode {
  const { subject, t, api, config } = props
  if (!isOwnBundle(subject)) return null
  return <DetailSectionBody t={t} api={api} config={config} />
}

function DetailSectionBody({ t, api, config }: PropsLocale<typeof NS> & DetailInjected): ReactNode {
  const status = useStatus()
  const reachable = useStatusHealth()
  const snapshot = useConfigForm(config)
  const [signInOpen, setSignInOpen] = useState(false)

  if (detailCardModel(status) === 'connect') {
    return (
      <section className="s2s-card">
        <span className="s2s-name">{t('detailConnectTitle')}</span>
        <p className="s2s-hint">{t('detailConnectHint')}</p>
        <div className="s2s-actions">
          <Button variant="primary" disabled={!reachable} onClick={() => { setSignInOpen(true) }}>
            {t('connectPanel')}
          </Button>
        </div>
        {!reachable && <p className="s2s-warn">{t('routesUnreachableWarning')}</p>}
        <SignInDialog
          open={signInOpen}
          onClose={() => { setSignInOpen(false) }}
          api={api}
          config={config}
          baseURL={snapshot.value?.baseURL}
          writable={snapshot.writable}
          routesReachable={reachable}
          onSignedIn={() => { void refreshStatus() }}
          t={t}
        />
      </section>
    )
  }
  return <DetailReportCard t={t} />
}

function DetailReportCard({ t }: { t: TranslateNS<typeof NS> }): ReactNode {
  const status = useStatus()
  const report = status?.lastReport
  return (
    <section className="s2s-card">
      <span className="s2s-name">{t('detailSectionTitle')}</span>
      {report === undefined
        ? <span className="s2s-badgeHint">{t('detailSectionEmpty')}</span>
        : (
            <ul className="s2s-steps">
              {report.entries.map((entry) => (
                <li key={entry.route} className="s2s-reportLine">
                  <span className={entry.action === 'failed' ? 's2s-reportError' : 's2s-reportText'}>
                    {entry.action === 'failed'
                      ? t('entryError', { name: entry.displayName ?? entry.route, error: entry.error ?? '' })
                      : t('entryModels', { name: entry.displayName ?? entry.route, count: entry.models ?? 0 })}
                  </span>
                </li>
              ))}
              {report.removed.length > 0 && (
                <li className="s2s-reportLine">{t('reportRemoved', { routes: report.removed.join(', ') })}</li>
              )}
            </ul>
          )}
    </section>
  )
}
