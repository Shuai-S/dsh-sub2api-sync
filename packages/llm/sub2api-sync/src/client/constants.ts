/**
 * Shared client-half constants. The package name is duplicated here (instead
 * of reading package.json at runtime) because the browser bundle must stay
 * static; it is the single source for the `plugins.bundle.config` /
 * `plugins.bundle.activation` slot keys and the detail-page subject filter.
 *
 * @module sub2api-sync/client/constants
 */

export const PKG_NAME = '@deepseek-ai/dsh-sub2api-sync'
