/**
 * Identity-header helpers for the sync card: the account segment (username,
 * else a masked email) rendered between the site name and the instance host.
 * Pure string logic — no React, no fetch.
 *
 * @module sub2api-sync/client/section/header
 */

/**
 * Mask an email for display (`user@example.com` → `u***@example.com`): the
 * panel profile answers the raw address, the header only shows a hint. The
 * local part keeps its first character; anything without a separator is
 * masked wholesale.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim()
  const at = trimmed.indexOf('@')
  if (at <= 0) return trimmed.length > 0 ? `${trimmed.slice(0, 1)}***` : '—'
  return `${trimmed.slice(0, 1)}***${trimmed.slice(at)}`
}

/** The header account segment: the set username, else the masked email. */
export function accountLabelOf(profile: { username?: string; email?: string } | undefined): string | undefined {
  const username = profile?.username?.trim()
  if (username !== undefined && username.length > 0) return username
  const email = profile?.email?.trim()
  return email !== undefined && email.length > 0 ? maskEmail(email) : undefined
}

/**
 * Format the account balance for the header pill, mirroring the panel's own
 * `formatCurrency` (USD; sub-cent amounts show six decimals so a nearly
 * drained account does not round to $0.00).
 */
export function formatBalance(amount: number): string {
  const digits = amount > 0 && amount < 0.01 ? 6 : 2
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount)
}
