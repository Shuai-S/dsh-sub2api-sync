/**
 * Thin React wrapper over the platform's shared configuration form (the
 * `configForms` seam, design note §7): a useSyncExternalStore pair over the
 * form's snapshot/subscribe, plus field-level and path-level write helpers.
 * All official-seam access stays in this file so a future transport migration
 * touches one module.
 *
 * @module sub2api-sync/client/useConfigForm
 */

import { useMemo, useSyncExternalStore } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Sub2apiSyncConfig } from '../config.ts'

/**
 * Path operation view over one settings namespace. Structurally identical to
 * the platform's `SettingsPathOpView` (declared in
 * `@deepseek-ai/dsh-api-remotes/client`, which this package does not depend
 * on), so values are accepted either way.
 */
export type ConfigPathValue =
  | string
  | number
  | boolean
  | null
  | ConfigPathValue[]
  | { [key: string]: ConfigPathValue }

export type ConfigPathOp =
  | { op: 'set'; path: string[]; value: ConfigPathValue }
  | { op: 'unset'; path: string[] }

/** Subscribe to one namespace's config form snapshot. */
export function useConfigForm(form: ConfigForm<Sub2apiSyncConfig>): ConfigFormSnapshot<Sub2apiSyncConfig> {
  // Bound once per form instance: uSES pairs these with its own subscription.
  const subscribe = useMemo(() => form.subscribe.bind(form), [form])
  const getSnapshot = useMemo(() => form.getSnapshot.bind(form), [form])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Queue one field write (carries the latest known revision). */
export function setField(
  form: ConfigForm<Sub2apiSyncConfig>,
  field: string,
  value: unknown,
): Promise<boolean> {
  return form.set(field, value)
}

/** Queue one field clear — the field re-inherits the composition layer. */
export function unsetField(form: ConfigForm<Sub2apiSyncConfig>, field: string): Promise<boolean> {
  return form.unset(field)
}
