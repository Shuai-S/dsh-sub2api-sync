/**
 * Instance icon + site-name discovery and the icon byte proxy (host half only).
 *
 * The settings card shows the instance's own icon as the identity mark and
 * its configured site name in the header once signed in. One probe of the
 * instance root HTML serves both: parse `<link rel="icon">` (sub2api
 * declares `/logo.svg` there) and `<title>` (sub2api's backend rewrites it
 * to `{site_name} - AI API Gateway`, so the title carries the operator's
 * configured site name). Undeclared icons fall back to the `/favicon.ico`
 * convention. The bytes are proxied through a same-origin plugin route so
 * the webview never loads cross-origin imagery (no CORS/mixed-content
 * caveats). A per-instance cache (10 min TTL) keeps repeat polls off the
 * instance's HTML.
 *
 * @module sub2api-sync/icon
 */

/** Icon bytes handed to the /icon route (content-type is upstream's or guessed). */
export interface IconPayload {
  contentType: string
  body: Buffer
}

/** What one probe knows about an instance. */
interface InstanceMeta {
  iconUrl: string
  title?: string
}

/** How long a resolved icon URL is trusted before re-reading the HTML. */
const URL_TTL_MS = 10 * 60 * 1000
/** Discovery + byte fetches cap, so an offline instance cannot stall callers. */
const TIMEOUT_MS = 2500
/** Refuse to proxy absurd payloads. */
const MAX_BYTES = 1_000_000
/** Sub2api's backend always appends this suffix to the rewritten title. */
const TITLE_SUFFIX = ' - AI API Gateway'
/** Header layout guard: site names beyond this render truncated anyway. */
const MAX_TITLE_LENGTH = 60

/**
 * Extract the first usable icon href from an HTML document. Only the
 * `<link>` shape is honored (the standard mechanism); `mask-icon` is skipped
 * (Safari pinned-tab monochrome glyphs make poor avatars), everything else
 * whose `rel` contains the `icon` word qualifies. Minimal entity decoding
 * for the one entity HTML attribute values practically carry.
 */
export function pickIconHref(html: string): string | undefined {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0]
    const rel = attr(tag, 'rel')?.toLowerCase() ?? ''
    if (!rel.split(/\s+/).includes('icon') || rel.includes('mask')) continue
    const href = attr(tag, 'href')
    if (href === undefined || href.length === 0) continue
    return href.replace(/&amp;/gi, '&')
  }
  return undefined
}

/**
 * Extract the site name from an HTML `<title>`: decode the handful of
 * entities title text practically carries, trim, and strip sub2api's fixed
 * ` - AI API Gateway` suffix (case-insensitive) to surface the operator's
 * configured site name. Absent or empty titles yield undefined.
 */
export function parseSiteTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([^<]*)<\/title>/i.exec(html)
  if (match === null) return undefined
  const decoded = match[1]
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .trim()
  const stripped = decoded.toLowerCase().endsWith(TITLE_SUFFIX.toLowerCase())
    ? decoded.slice(0, decoded.length - TITLE_SUFFIX.length).trim()
    : decoded
  if (stripped.length === 0) return undefined
  return stripped.length > MAX_TITLE_LENGTH ? `${stripped.slice(0, MAX_TITLE_LENGTH)}…` : stripped
}

/** One attribute value out of a tag string (double/single/unquoted). */
function attr(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = pattern.exec(tag)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

/** Fetch with a hard timeout; doubles (tests) may ignore the signal. */
async function fetchCapped(url: string, fetchImpl: typeof fetch): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, TIMEOUT_MS)
  try {
    return await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

/** Resolve the icon URL + site title from one instance's root HTML. */
async function probeInstance(base: string, fetchImpl: typeof fetch): Promise<InstanceMeta> {
  const fallback: InstanceMeta = { iconUrl: `${base}/favicon.ico` }
  try {
    const response = await fetchCapped(`${base}/`, fetchImpl)
    const type = response.headers.get('content-type') ?? ''
    if (!response.ok || !(/text\/html/i.test(type) || type.length === 0)) return fallback
    const html = await response.text()
    const href = pickIconHref(html)
    const iconUrl = href !== undefined
      ? (() => {
        try {
          return new URL(href, `${base}/`).toString()
        } catch {
          return fallback.iconUrl
        }
      })()
      : fallback.iconUrl
    return { iconUrl, title: parseSiteTitle(html) }
  } catch {
    return fallback
  }
}

/** Guess a content type from the URL extension when upstream omits it. */
function guessContentType(url: string): string {
  const path = new URL(url).pathname.toLowerCase()
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.gif')) return 'image/gif'
  return 'image/x-icon'
}

/**
 * Build the instance probe the route deps expose: `icon` proxies the icon
 * bytes for the /icon route, `siteName` serves the parsed title for the
 * /site route. One factory per plugin instance — the meta cache lives in
 * the closure, so the icon and site-name consumers share one HTML read per
 * TTL window. Errors never throw — an unavailable answer resolves to
 * `undefined` and the client keeps its fallbacks.
 */
export function createInstanceProbe(options: { fetchImpl?: typeof fetch } = {}): {
  icon: (instance: string) => Promise<IconPayload | undefined>
  siteName: (instance: string) => Promise<string | undefined>
} {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const cache = new Map<string, { meta: InstanceMeta; at: number }>()
  const metaOf = async (instance: string): Promise<InstanceMeta | undefined> => {
    const base = instance.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(base)) return undefined
    const now = Date.now()
    const hit = cache.get(base)
    if (hit !== undefined && now - hit.at < URL_TTL_MS) return hit.meta
    const meta = await probeInstance(base, fetchImpl)
    cache.set(base, { meta, at: now })
    return meta
  }
  return {
    icon: async (instance) => {
      const meta = await metaOf(instance)
      if (meta === undefined) return undefined
      try {
        const response = await fetchCapped(meta.iconUrl, fetchImpl)
        if (!response.ok) return undefined
        const body = Buffer.from(await response.arrayBuffer())
        if (body.length === 0 || body.length > MAX_BYTES) return undefined
        const upstream = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
        return { contentType: upstream.length > 0 ? upstream : guessContentType(meta.iconUrl), body }
      } catch {
        return undefined
      }
    },
    siteName: async (instance) => (await metaOf(instance))?.title,
  }
}
