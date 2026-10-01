/**
 * Registration logic for the browser half: locale dictionaries plus the slot
 * seats — the settings-page main card, the plugins-page tuning card, and the
 * U2 placements (Models-page provider-card badge + footer, Plugins-page
 * detail badge/section, and the bundle-activation guide). All `ctx` wiring
 * lives here — the components stay Cordis-free.
 *
 * @module sub2api-sync/client/mount
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only augmentation pulls: each merges its services/contracts into this
// compile program (Context.locale / Context.slots / Context.configForms and
// the SlotMap + LocaleNamespaceMap tables). Must stay.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { Sub2apiSyncConfig } from '../config.ts'
import { PKG_NAME } from './constants.ts'
import { dictionaries, NS } from './locales.ts'
import { statusSource } from './status.ts'
import { ensureCss } from './styles.ts'
import { createPluginApi } from './usePluginApi.ts'
import { Sub2apiSyncSection, type SectionInjected } from './section/Sub2apiSyncSection.tsx'
import { BundleConfigCard } from './bundleConfig/BundleConfigCard.tsx'
import { ProviderBadge } from './models/ProviderBadge.tsx'
import { ModelsFooter } from './models/ModelsFooter.tsx'
import { DetailBadge, DetailSection } from './plugins/Detail.tsx'
import { ActivationGuide } from './plugins/ActivationGuide.tsx'

/** Register dictionaries and slot contributions on the client context. */
export function mount(ctx: Context): void {
  ensureCss()
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'sub2api-sync: dictionaries')
  const t = ctx.locale.bind(NS)
  const config = ctx.configForms.get<Sub2apiSyncConfig>(NS)

  const sectionOps: SectionInjected = {
    api: createPluginApi(),
    config,
    hooks: { status: statusSource },
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'sub2api-sync',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: () => sectionOps,
  }, Sub2apiSyncSection))

  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: PKG_NAME,
    locale: NS,
  }, BundleConfigCard))

  // U2 placements — all read-only status/provenance surfaces (§3).
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: 'llm-pi-ai',
    locale: NS,
  }, ProviderBadge))

  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'sub2api-sync',
    order: 10,
    locale: NS,
  }, ModelsFooter))

  ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
    name: 'plugins.detail.badge',
    id: 'sub2api-sync',
    locale: NS,
  }, DetailBadge))

  ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
    name: 'plugins.detail.section',
    id: 'sub2api-sync',
    locale: NS,
  }, DetailSection))

  ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
    name: 'plugins.bundle.activation',
    key: PKG_NAME,
    locale: NS,
  }, ActivationGuide))
}
