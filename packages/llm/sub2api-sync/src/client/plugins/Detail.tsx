/**
 * U2 placements 5: the Plugins-page detail badge and detail section, both
 * filtered to this bundle's own subject (`subject.kind === 'bundle'` with the
 * package name). The badge is the one-glance sync state; the section renders
 * the last sync report under the page's own content.
 *
 * @module sub2api-sync/client/plugins/Detail
 */

import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { PKG_NAME } from '../constants.ts'
import { useStatus } from '../status.ts'
import { NS } from '../locales.ts'
import { footerModel } from '../models/badge.ts'

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

export type DetailSectionProps =
  PropsRuntime<'plugins.detail.section'> & PropsLocale<typeof NS>

/** @param props - the detail-page subject plus the framework locale seat. */
export function DetailSection(props: DetailSectionProps): ReactNode {
  const { subject, t } = props
  if (!isOwnBundle(subject)) return null
  return <DetailSectionBody t={t} />
}

function DetailSectionBody({ t }: { t: TranslateNS<typeof NS> }): ReactNode {
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
