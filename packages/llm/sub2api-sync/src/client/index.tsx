/**
 * Browser half of the sub2api sync plugin: locale dictionaries, the
 * settings-page main card (`settings.section`), and the plugins-page tuning
 * card (`plugins.bundle.config`). Registration logic lives in `mount.ts`.
 *
 * @module sub2api-sync/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { mount } from './mount.ts'

export const name = 'dsh-sub2api-sync-client'
export const inject = ['slots', 'locale', 'configForms', 'pluginNavigation']

/** Plugin body: register locale dictionaries and both slot seats. */
export function apply(ctx: Context): void {
  mount(ctx)
}
