/**
 * U2 placement 6: the one-time guidance after the user enables the bundle in
 * the Plugins page. The page mounts the keyed entry for the just-enabled
 * package; this component renders the three-step first-run path and hands
 * navigation back to the page via `onOpenDetails` / `onDismiss`.
 *
 * @module sub2api-sync/client/plugins/ActivationGuide
 */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from '../locales.ts'

export type ActivationGuideProps =
  PropsRuntime<'plugins.bundle.activation'> & PropsLocale<typeof NS>

/** @param props - the activation subject plus the page's dismiss/navigate commands. */
export function ActivationGuide(props: ActivationGuideProps): ReactNode {
  const { t, onDismiss, onOpenDetails } = props
  return (
    <div className="s2s-card">
      <span className="s2s-name">{t('activationTitle')}</span>
      <ol className="s2s-steps">
        <li>{t('activationStep1')}</li>
        <li>{t('activationStep2')}</li>
        <li>{t('activationStep3')}</li>
      </ol>
      <div className="s2s-actions">
        <Button variant="primary" onClick={onOpenDetails}>{t('activationOpenConfig')}</Button>
        <Button variant="ghost" onClick={onDismiss}>{t('activationDismiss')}</Button>
      </div>
    </div>
  )
}
