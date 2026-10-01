/**
 * Shared `/status` poller: one module-level observable store feeding every
 * consumer (settings card now; model-page badge and plugin-page badge later).
 * Polling runs on a 5s interval while at least one subscriber exists and
 * stops when the last one leaves, so background settings pages cost nothing.
 *
 * The store satisfies the `HostObservable` shape (getSnapshot/subscribe), so
 * the mount wires it straight into the section's inject `hooks` compartment,
 * which synthesizes the `useStatus` selector hook on component props.
 *
 * @module sub2api-sync/client/status
 */

import { useSyncExternalStore } from 'react'
import { ROUTES } from '../routes.ts'
import type { StatusResponse } from '../routes.ts'
import { callJson } from './usePluginApi.ts'

const POLL_MS = 5000

let snapshot: StatusResponse | undefined
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

function publish(next: StatusResponse | undefined): void {
  // Identical references stay silent: uSES relies on getSnapshot stability.
  if (next === snapshot) return
  snapshot = next
  for (const listener of listeners) listener()
}

/** One poll round; a failed round keeps the last good snapshot (transient). */
async function poll(): Promise<void> {
  try {
    publish(await callJson<StatusResponse>(ROUTES.status))
  } catch {
    // The next tick retries; stale data with the poller quiet beats a blank card.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    void poll()
    timer = setInterval(() => { void poll() }, POLL_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/** The observable source wired into the slot inject face's hooks compartment. */
export const statusSource: {
  getSnapshot(): StatusResponse | undefined
  subscribe(fn: () => void): () => void
} = {
  getSnapshot: () => snapshot,
  subscribe,
}

/** Selector hook over the shared status snapshot (component-side twin). */
export function useStatus(): StatusResponse | undefined {
  return useSyncExternalStore(subscribe, getSnapshot)
}

function getSnapshot(): StatusResponse | undefined {
  return snapshot
}

/**
 * Force one poll round immediately (after login, sync, logout) and resolve
 * once the snapshot settled. Safe to call with no subscribers: it publishes
 * into the store and returns; the interval only drives further rounds.
 */
export async function refreshStatus(): Promise<StatusResponse | undefined> {
  await poll()
  return snapshot
}
