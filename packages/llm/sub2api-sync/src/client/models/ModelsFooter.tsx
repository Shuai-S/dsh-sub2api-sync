/**
 * U2 placement 4: the Models-page footer strip — synced group count plus a
 * coarse relative last-sync time. Additive list slot; renders nothing
 * meaningful before the first sync (a quiet "never synced" line).
 *
 * @module sub2api-sync/client/models/ModelsFooter
 */

import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { footerModel, relativeMinutes } from './badge.ts'
import { useStatus } from '../status.ts'
import { NS } from '../locales.ts'

export type ModelsFooterProps =
  PropsRuntime<'settings.models.footer'> & PropsLocale<typeof NS>

/** @param props - the framework locale seat (the footer owner props are empty). */
export function ModelsFooter(props: ModelsFooterProps): ReactNode {
  const { t } = props
  const status = useStatus()
  const footer = footerModel(status)
  const when = footer.lastReportAt !== undefined
    ? (() => {
        const relative = relativeMinutes(footer.lastReportAt, Date.now())
        return t(relative.key, relative.count !== undefined ? { count: relative.count } : {})
      })()
    : t('footerNeverSynced')
  return (
    <div className="s2s-footerStrip">
      <span>
        {footer.signedIn
          ? t('footerSyncedCount', { count: footer.groups })
          : t('footerSignedOut')}
      </span>
      <span>{when}</span>
    </div>
  )
}
