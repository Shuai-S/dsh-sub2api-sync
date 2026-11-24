/**
 * Key-list filtering for the Keys card.
 *
 * The card filters a local snapshot instead of the panel's own `search`
 * parameter: upstream matches the key NAME and the key STRING only
 * (`api_key_repo.go`: `NameContainsFold OR KeyContainsFold`), so a group-name
 * term can only ever be honoured on this side. Snapshotting also makes typing
 * a pure render — no request per keystroke.
 *
 * @module sub2api-sync/client/keysFilter
 */

/** What one row shows and what the term is matched against. */
export interface KeyMatchFields {
  name: string
  groupName: string
}

/** Case-insensitive containment over the row's two visible text fields. */
export function matchKeyQuery(fields: KeyMatchFields, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  return fields.name.toLowerCase().includes(needle) || fields.groupName.toLowerCase().includes(needle)
}

/**
 * Filter one snapshot, preserving panel order (newest first). `fieldsOf`
 * resolves the row's own group label, so the term matches exactly the text the
 * user reads — including the `#<groupId>` fallback for groups the account
 * cannot see.
 */
export function filterKeys<T>(
  keys: readonly T[],
  query: string,
  fieldsOf: (key: T) => KeyMatchFields,
): T[] {
  const needle = query.trim()
  if (needle.length === 0) return [...keys]
  return keys.filter((key) => matchKeyQuery(fieldsOf(key), needle))
}

/** One page's slice of an already-filtered list (page is 1-based, clamped). */
export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / pageSize))
  const current = Math.min(Math.max(1, page), pages)
  const start = (current - 1) * pageSize
  return { rows: items.slice(start, start + pageSize), page: current, pages }
}
