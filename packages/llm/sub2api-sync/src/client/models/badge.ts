/**
 * Pure badge models for the U2 placements (Models-page provider cards and
 * footer, Plugins-page badge/section). DOM-free so the host tsconfig can
 * compile the unit tests that cover them.
 *
 * @module sub2api-sync/client/models/badge
 */

import { isOwnedRoute } from '../../types.ts'
import type { StatusResponse } from '../../routes.ts'

/** Whether a Models-page provider route belongs to this plugin. */
export function isSyncedRoute(routeId: string): boolean {
  return isOwnedRoute(routeId)
}

export interface BadgeModel {
  models: number
  displayName?: string
  lastAction?: 'created' | 'updated' | 'unchanged' | 'failed'
  lastError?: string
  lastReportAt?: number
}

/**
 * Everything the provider-card badge renders for one route, derived from the
 * shared status snapshot; `undefined` when there is nothing to show yet.
 */
export function badgeModel(routeId: string, status: StatusResponse | undefined): BadgeModel | undefined {
  if (status === undefined || !isOwnedRoute(routeId)) return undefined
  const route = status.routes.find((candidate) => candidate.route === routeId)
  if (route === undefined) return undefined
  const entry = status.lastReport?.entries.find((candidate) => candidate.route === routeId)
  return {
    models: route.models,
    ...(route.displayName !== undefined ? { displayName: route.displayName } : {}),
    ...(entry?.action !== undefined ? { lastAction: entry.action } : {}),
    ...(entry?.error !== undefined ? { lastError: entry.error } : {}),
    ...(status.lastReportAt !== undefined ? { lastReportAt: status.lastReportAt } : {}),
  }
}

export interface FooterModel {
  signedIn: boolean
  groups: number
  lastReportAt?: number
}

/** The Models-page footer strip model (route count = synced group count). */
export function footerModel(status: StatusResponse | undefined): FooterModel {
  return {
    signedIn: status?.auth.signedIn === true,
    groups: status?.routes.length ?? 0,
    ...(status?.lastReportAt !== undefined ? { lastReportAt: status.lastReportAt } : {}),
  }
}

/** Coarse relative time for the footer line: just now / N minutes ago. */
export function relativeMinutes(at: number, now: number): { key: 'footerJustNow' | 'footerMinutesAgo'; count?: number } {
  const minutes = Math.max(0, Math.floor((now - at) / 60000))
  if (minutes < 1) return { key: 'footerJustNow' }
  return { key: 'footerMinutesAgo', count: minutes }
}
