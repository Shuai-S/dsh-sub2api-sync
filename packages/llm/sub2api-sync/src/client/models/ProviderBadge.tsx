/**
 * U2 placement 3: the badge on every sub2api-managed provider card in the
 * Models page. The slot is keyed by the row's settings namespace, so this
 * registration receives every hand-declared `llm-pi-ai` card and filters to
 * the `sub2api-<10-hex>` (and legacy digit) routes it owns. Read-only by
 * design: status and
 * provenance only, with a pointer to the management entry — the slot has no
 * cross-section navigation seat.
 *
 * @module sub2api-sync/client/models/ProviderBadge
 */

import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { badgeModel, isSyncedRoute } from './badge.ts'
import { useStatus } from '../status.ts'
import { NS, type Sub2apiSyncKey } from '../locales.ts'

export type ProviderBadgeProps =
  PropsRuntime<'settings.models.provider-card'> & PropsLocale<typeof NS>

function actionKeyOf(action: 'created' | 'updated' | 'unchanged' | 'failed'): Sub2apiSyncKey {
  switch (action) {
    case 'created': return 'actionCreated'
    case 'updated': return 'actionUpdated'
    case 'unchanged': return 'actionUnchanged'
    case 'failed': return 'actionFailed'
  }
}

/** @param props - the provider row plus the framework locale seat. */
export function ProviderBadge(props: ProviderBadgeProps): ReactNode {
  const { provider, t } = props
  if (!isSyncedRoute(provider.provider)) return null
  return <ProviderBadgeBody routeId={provider.provider} t={t} />
}

function ProviderBadgeBody({ routeId, t }: { routeId: string; t: TranslateNS<typeof NS> }): ReactNode {
  const status = useStatus()
  const badge = badgeModel(routeId, status)
  if (badge === undefined) return null
  return (
    <div className="s2s-badgeRow">
      <Tag tone="info">{t('badgeManagedTag')}</Tag>
      <span className="s2s-badgeMeta">
        {t('badgeModels', { count: badge.models })}
        {badge.lastAction !== undefined ? ` · ${t(actionKeyOf(badge.lastAction))}` : ''}
      </span>
      <span className="s2s-badgeHint">{t('badgeManageHint')}</span>
    </div>
  )
}
