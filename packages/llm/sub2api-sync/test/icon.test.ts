import { describe, expect, it } from 'vitest'
import { createInstanceProbe, parseSiteTitle, pickIconHref } from '../src/icon.ts'

describe('pickIconHref', () => {
  it('finds the declared icon in sub2api\'s actual head markup', () => {
    const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8" />'
      + '<link rel="icon" type="image/svg+xml" href="/logo.svg" />'
      + '<meta name="viewport" content="width=device-width, initial-scale=1.0" /></head></html>'
    expect(pickIconHref(html)).toBe('/logo.svg')
  })

  it('accepts shortcut icon, single quotes, unquoted values, and entities', () => {
    expect(pickIconHref(`<link rel="shortcut icon" href='/static/fav.png'>`)).toBe('/static/fav.png')
    expect(pickIconHref('<link REL=icon HREF=/a/b.ico>')).toBe('/a/b.ico')
    expect(pickIconHref('<link rel="icon" href="/a?x=1&amp;y=2">')).toBe('/a?x=1&y=2')
  })

  it('skips mask-icon and links without href', () => {
    const html = '<link rel="mask-icon" href="/mono.svg"><link rel="icon"></head>'
    expect(pickIconHref(html)).toBeUndefined()
  })

  it('returns undefined when no icon link exists', () => {
    expect(pickIconHref('<html><head><title>x</title></head></html>')).toBeUndefined()
    expect(pickIconHref('')).toBeUndefined()
  })
})

/** Scripted fetch double recording URLs; each answer is a plain object. */
function scriptFetch(steps: Array<{ url: string; status?: number; contentType?: string; text?: string; buffer?: Buffer; reject?: boolean }>): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = []
  let index = 0
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    urls.push(url)
    const step = steps[Math.min(index, steps.length - 1)]
    index++
    if (step.url !== url && step.url !== '*') {
      throw new Error(`unexpected fetch: ${url}`)
    }
    if (step.reject === true) {
      throw new Error('network down')
    }
    if ((step.status ?? 200) >= 400) {
      return { ok: false, status: step.status, headers: new Map() } as unknown as Response
    }
    const headers = new Map([['content-type', step.contentType ?? 'application/octet-stream']])
    return {
      ok: true,
      status: step.status ?? 200,
      headers,
      text: async () => step.text ?? '',
      arrayBuffer: async () => (step.buffer ?? Buffer.alloc(0)),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, urls }
}

describe('parseSiteTitle', () => {
  it('surfaces the operator site name from sub2api\'s rewritten title', () => {
    expect(parseSiteTitle('<title>我的中转 - AI API Gateway</title>')).toBe('我的中转')
    expect(parseSiteTitle('<title>Sub2API - AI API Gateway</title>')).toBe('Sub2API')
  })

  it('keeps foreign titles without the suffix intact and decodes entities', () => {
    expect(parseSiteTitle('<title>Example Panel</title>')).toBe('Example Panel')
    expect(parseSiteTitle('<title>Tom &amp; Jerry 站</title>')).toBe('Tom & Jerry 站')
  })

  it('returns undefined for absent or empty titles', () => {
    expect(parseSiteTitle('<html><head></head></html>')).toBeUndefined()
    expect(parseSiteTitle('<title>   </title>')).toBeUndefined()
  })

  it('caps runaway titles', () => {
    const long = parseSiteTitle(`<title>${'x'.repeat(100)}</title>`)
    expect(long).toBeDefined()
    expect(long?.length).toBeLessThanOrEqual(61) // 60 chars + ellipsis
  })
})

describe('createInstanceProbe', () => {
  it('parses the declared link and title, then proxies icon bytes', async () => {
    const { fetch, urls } = scriptFetch([
      { url: 'http://panel:9000/', contentType: 'text/html', text: '<title>我的中转 - AI API Gateway</title><link rel="icon" href="/logo.svg">' },
      { url: 'http://panel:9000/logo.svg', contentType: 'image/svg+xml', buffer: Buffer.from('<svg/>') },
    ])
    const probe = createInstanceProbe({ fetchImpl: fetch })
    const icon = await probe.icon('http://panel:9000')
    expect(icon?.contentType).toBe('image/svg+xml')
    expect(icon?.body.toString()).toBe('<svg/>')
    expect(urls).toEqual(['http://panel:9000/', 'http://panel:9000/logo.svg'])
    await expect(probe.siteName('http://panel:9000')).resolves.toBe('我的中转')
  })

  it('falls back to the /favicon.ico convention and an undefined name', async () => {
    const { fetch, urls } = scriptFetch([
      { url: 'http://panel:9000/', contentType: 'text/html', text: '<html><head><title>t</title></head></html>' },
      { url: 'http://panel:9000/favicon.ico', contentType: 'image/x-icon', buffer: Buffer.from([0, 0, 1, 0]) },
    ])
    const probe = createInstanceProbe({ fetchImpl: fetch })
    const icon = await probe.icon('http://panel:9000')
    expect(icon?.contentType).toBe('image/x-icon')
    expect(urls[1]).toBe('http://panel:9000/favicon.ico')
    // The stub title has no sub2api suffix and is kept verbatim.
    await expect(probe.siteName('http://panel:9000')).resolves.toBe('t')
  })

  it('answers undefined when the icon bytes cannot be fetched', async () => {
    const { fetch } = scriptFetch([
      { url: 'http://panel:9000/', contentType: 'text/html', text: '<link rel="icon" href="/logo.svg">' },
      { url: 'http://panel:9000/logo.svg', status: 404 },
    ])
    const probe = createInstanceProbe({ fetchImpl: fetch })
    await expect(probe.icon('http://panel:9000')).resolves.toBeUndefined()
    // The site name still comes from the cached HTML probe.
    await expect(probe.siteName('http://panel:9000')).resolves.toBeUndefined()
  })

  it('shares one HTML read per TTL across icon and site-name consumers', async () => {
    const { fetch, urls } = scriptFetch([
      { url: 'http://panel:9000/', contentType: 'text/html', text: '<title>S</title><link rel="icon" href="/logo.svg">' },
      { url: '*', contentType: 'image/svg+xml', buffer: Buffer.from('<svg/>') },
    ])
    const probe = createInstanceProbe({ fetchImpl: fetch })
    await probe.siteName('http://panel:9000')
    await probe.icon('http://panel:9000')
    await probe.siteName('http://panel:9000')
    expect(urls.filter((url) => url === 'http://panel:9000/')).toHaveLength(1)
  })

  it('answers undefined for a non-http instance without fetching', async () => {
    const { fetch, urls } = scriptFetch([])
    const probe = createInstanceProbe({ fetchImpl: fetch })
    await expect(probe.icon('not-a-url')).resolves.toBeUndefined()
    await expect(probe.siteName('')).resolves.toBeUndefined()
    expect(urls).toEqual([])
  })

  it('retries a failed first probe so the first sync does not pin the fallback name', async () => {
    // Cold DNS/TLS right after login can fail the first read; the old probe
    // cached that failure for 10 minutes and the first sync branded every
    // provider `sub2api(…)`. One in-call retry recovers the title.
    const { fetch, urls } = scriptFetch([
      { url: 'http://panel:9000/', reject: true },
      { url: 'http://panel:9000/', contentType: 'text/html', text: '<title>我的中转 - AI API Gateway</title>' },
    ])
    const probe = createInstanceProbe({ fetchImpl: fetch, retryDelayMs: 1 })
    await expect(probe.siteName('http://panel:9000')).resolves.toBe('我的中转')
    expect(urls.filter((url) => url === 'http://panel:9000/')).toHaveLength(2)
  })

  it('re-probes a title-less instance once the short negative window passes', async () => {
    const { fetch, urls } = scriptFetch([
      { url: 'http://panel:9000/', contentType: 'text/html', text: '<html><head></head></html>' },
      { url: 'http://panel:9000/', contentType: 'text/html', text: '<html><head></head></html>' },
      { url: 'http://panel:9000/', contentType: 'text/html', text: '<title>我的中转 - AI API Gateway</title>' },
    ])
    const probe = createInstanceProbe({ fetchImpl: fetch, retryDelayMs: 1, negativeTtlMs: 5 })
    await expect(probe.siteName('http://panel:9000')).resolves.toBeUndefined()
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    await expect(probe.siteName('http://panel:9000')).resolves.toBe('我的中转')
    expect(urls.filter((url) => url === 'http://panel:9000/')).toHaveLength(3)
  })

  it('serves the title-less negative within the window without re-probing', async () => {
    const { fetch, urls } = scriptFetch([
      { url: 'http://panel:9000/', contentType: 'text/html', text: '<html><head></head></html>' },
      { url: 'http://panel:9000/', contentType: 'text/html', text: '<html><head></head></html>' },
    ])
    const probe = createInstanceProbe({ fetchImpl: fetch, retryDelayMs: 1, negativeTtlMs: 60_000 })
    await expect(probe.siteName('http://panel:9000')).resolves.toBeUndefined()
    await expect(probe.siteName('http://panel:9000')).resolves.toBeUndefined()
    expect(urls.filter((url) => url === 'http://panel:9000/')).toHaveLength(2)
  })
})
