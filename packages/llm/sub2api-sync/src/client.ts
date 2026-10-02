/**
 * Gateway-side HTTP client for sub2api: model discovery under a relay key.
 * No DSH dependencies, so it unit-tests against an injected fetch. Phase 2
 * adds the panel half (login / keys / groups) beside this module.
 *
 * @module sub2api-sync/client
 */

/**
 * The `/v1` API root for OpenAI-style gateway endpoints (`/models`,
 * `/chat/completions`, `/responses`, …). A URL already ending in `/v1`
 * passes through; anything else gets `/v1` appended.
 */
export function gatewayApiRoot(baseURL: string): string {
  const cleaned = (baseURL ?? '').trim().replace(/\/+$/, '')
  if (cleaned.length === 0) return ''
  return /\/v1$/i.test(cleaned) ? cleaned : `${cleaned}/v1`
}

export interface Sub2apiClientOptions {
  /** sub2api instance address, with or without a trailing `/v1`. */
  baseURL: string
  /** Fetch implementation override (tests); defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
}

/** One model entry as the gateway answers it — the shape varies per platform. */
export interface GatewayModelEntry {
  id: string
  displayName?: string
}

export class Sub2apiClient {
  private readonly root: string
  private readonly fetchImpl: typeof fetch

  constructor(options: Sub2apiClientOptions) {
    const base = options.baseURL?.trim() ?? ''
    if (!/^https?:\/\//i.test(base)) throw new Error('sub2api: baseURL 必须是 http(s) 地址')
    this.root = gatewayApiRoot(base)
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (fetchImpl === undefined) throw new Error('sub2api: 当前环境没有 fetch 可用')
    this.fetchImpl = fetchImpl.bind(globalThis)
  }

  /**
   * Discover the model ids one relay key can serve (`GET /v1/models`). The
   * gateway answers an OpenAI-style list whose element shape varies per
   * platform — grok embeds reasoning fields, a `client_version` query
   * switches to the Codex manifest — so the reader takes `id` and tolerates
   * everything else (verified: `handler/gateway_handler.go`).
   */
  async listModels(relayKey: string, options?: { signal?: AbortSignal }): Promise<GatewayModelEntry[]> {
    const response = await this.fetchImpl(`${this.root}/models`, {
      headers: { authorization: `Bearer ${relayKey}` },
      signal: options?.signal,
    })
    if (!response.ok) {
      throw new Error(`sub2api 网关 GET ${this.root}/models 返回 HTTP ${response.status}${await refusalDetail(response)}`)
    }
    const payload: unknown = await response.json()
    return readModelList(payload)
  }

}

/**
 * Extract the gateway's own refusal reason from an error body so the sync
 * report can say WHY a key was rejected (balance / expiry / subscription /
 * IP allow-list), not just the HTTP status. sub2api writes two shapes:
 * flat `{code, message}` (middleware ErrorResponse) and OpenAI-style
 * `{error: {message, code}}`; anything else degrades to "".
 */
export async function refusalDetail(response: Response): Promise<string> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return ''
  }
  if (typeof payload !== 'object' || payload === null) return ''
  const record = payload as { code?: unknown; message?: unknown; error?: unknown }
  const nested = typeof record.error === 'object' && record.error !== null
    ? (record.error as { code?: unknown; message?: unknown })
    : undefined
  const message = [nested?.message, record.message].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  )
  const code = [nested?.code, record.code].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  )
  if (message === undefined && code === undefined) return ''
  const label = code !== undefined && message !== undefined && message !== code ? `${code}: ${message}` : (code ?? message ?? '')
  return label.length > 0 ? `（${label}）` : ''
}

/** Tolerant reader for the `/models` payload; unknown shapes fail loudly. */
export function readModelList(payload: unknown): GatewayModelEntry[] {
  const data = (payload as { data?: unknown } | null | undefined)?.data
  if (!Array.isArray(data)) {
    throw new Error('sub2api 网关 /models 响应不是模型列表（缺少 data 数组）')
  }
  const models: GatewayModelEntry[] = []
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const id = (item as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) continue
    const displayName = (item as { display_name?: unknown }).display_name
    models.push({
      id,
      ...(typeof displayName === 'string' && displayName.length > 0 && displayName !== id
        ? { displayName }
        : {}),
    })
  }
  return models
}
