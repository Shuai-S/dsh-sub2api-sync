/**
 * Typed fetchers over the host half's action routes. Same-origin `fetch` to
 * the webserver-registered plugin routes is the transport seam the design
 * note blesses (§7); secrets never ride these responses, so the client can
 * treat every payload as projectable state.
 *
 * The `ROUTES` constants and the response shapes come from the host module
 * `../routes.ts` — one contract, no structural copies. The host module is
 * pure TS and rides the client bundle; its node-only imports are type-only
 * and erased.
 *
 * @module sub2api-sync/client/usePluginApi
 */

import { ROUTES } from '../routes.ts'
import type {
  GroupsResponse,
  LoginResponse,
  PatResponse,
  StatusResponse,
  SyncResponse,
  CreateKeyResponse,
  KeysResponse,
} from '../routes.ts'

/** JSON-shaped error the host routes answer with on failures. */
interface ErrorPayload {
  error?: unknown
}

/**
 * One same-origin JSON call. Non-2xx answers throw an Error carrying the
 * host's `error` message; a body the host did not flag still returns parsed.
 */
export async function callJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(`HTTP ${response.status}`)
  }
  if (!response.ok) {
    const message = (payload as ErrorPayload | null | undefined)?.error
    throw new Error(typeof message === 'string' && message.length > 0 ? message : `HTTP ${response.status}`)
  }
  return payload as T
}

/** Dismissable body shapes accepted by the action routes. */
type JsonBody = Record<string, unknown>

const post = (body?: JsonBody): RequestInit => ({
  method: 'POST',
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})

/** Everything the cards need from the host half, namespaced per action. */
export interface PluginApi {
  status(): Promise<StatusResponse>
  login(email: string, password: string | undefined): Promise<LoginResponse>
  login2fa(code: string): Promise<LoginResponse>
  logout(): Promise<{ ok: true }>
  pat(token: string): Promise<PatResponse>
  groups(): Promise<GroupsResponse>
  listKeys(page: number, pageSize: number): Promise<KeysResponse>
  createKey(input: { groupId: number; name: string }): Promise<CreateKeyResponse>
  sync(keyIds?: number[]): Promise<SyncResponse>
}

/** Build the plugin API face injected into the cards (pure; no cordis). */
export function createPluginApi(): PluginApi {
  return {
    status: () => callJson<StatusResponse>(ROUTES.status),
    login: (email, password) => callJson<LoginResponse>(ROUTES.login, post({
      email,
      ...(password !== undefined && password.length > 0 ? { password } : {}),
    })),
    login2fa: (code) => callJson<LoginResponse>(ROUTES.login2fa, post({ code })),
    logout: () => callJson<{ ok: true }>(ROUTES.logout, post()),
    pat: (token) => callJson<PatResponse>(ROUTES.pat, post({ token })),
    groups: () => callJson<GroupsResponse>(ROUTES.groups),
    listKeys: (page, pageSize) => callJson<KeysResponse>(`${ROUTES.keys}?page=${page}&pageSize=${pageSize}`),
    createKey: (input) => callJson<CreateKeyResponse>(ROUTES.keys, post(input)),
    sync: (keyIds) => callJson<SyncResponse>(ROUTES.sync, post(keyIds !== undefined ? { keyIds } : undefined)),
  }
}
