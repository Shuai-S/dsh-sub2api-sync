/**
 * Shared client-half constants. The plugin package name is injected at build
 * time by scripts/wrap-client.mjs (it replaces the __DSH_PLUGIN_NAME__
 * placeholder with the package.json name — rewritten per variant by
 * scripts/pack-all.mjs) because the browser bundle must stay static AND the
 * plugin is published under two npm names: each build embeds its own name so
 * the `plugins.bundle.config` / `plugins.bundle.activation` slot keys and the
 * detail-page subject filter match the installed package.
 *
 * @module sub2api-sync/client/constants
 */

declare const __DSH_PLUGIN_NAME__: string

export const PKG_NAME = __DSH_PLUGIN_NAME__
