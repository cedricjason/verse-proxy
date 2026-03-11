export default async function handler(req, res) {
  const VERSE_ORIGIN = 'https://iframe.verse.works'
  const PROXY_ORIGIN = 'https://verse-33gallery.vercel.app'  // ← updated domain

  function rewriteOrigin(text) {
    return text.split(VERSE_ORIGIN).join(PROXY_ORIGIN)
  }

  const upstreamHeaders = () => ({
    'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
    'Accept': req.headers['accept'] || '*/*',
    'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.5',
    'Accept-Encoding': 'identity',
    'Referer': 'https://33.gallery/',
  })

  async function pipeRaw(url) {
    try {
      const upstream = await fetch(url, { headers: upstreamHeaders() })
      const ct = upstream.headers.get('content-type') || 'application/octet-stream'
      const cc = upstream.headers.get('cache-control') || 'public, max-age=31536000, immutable'
      res.setHeader('Content-Type', ct)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Cache-Control', cc)
      for (const h of ['etag', 'last-modified', 'vary']) {
        const v = upstream.headers.get(h)
        if (v) res.setHeader(h, v)
      }
      const buffer = await upstream.arrayBuffer()
      res.status(upstream.status).send(Buffer.from(buffer))
    } catch (err) {
      console.error('[proxy] pipeRaw error:', url, err.message)
      res.status(502).json({ error: err.message })
    }
  }

  async function pipeText(url) {
    try {
      const upstream = await fetch(url, { headers: upstreamHeaders() })
      const ct = upstream.headers.get('content-type') || 'text/plain'
      let text = await upstream.text()
      text = rewriteOrigin(text)
      res.setHeader('Content-Type', ct)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Cache-Control', 'no-store')
      res.status(upstream.status).send(text)
    } catch (err) {
      console.error('[proxy] pipeText error:', url, err.message)
      res.status(502).json({ error: err.message })
    }
  }

  // ─── Build the clean upstream path from the raw request URL ─────────────────
  // req.url contains the full path+query as seen by the handler.
  // We strip the Vercel rewrite injected "path" query param if present.
  const rawUrl = req.url  // e.g. /_next/data/abc/33-gallery.json or /33-gallery?iframe=true

  // ─── Routing ─────────────────────────────────────────────────────────────────

  // 1. Static JS / CSS — rewrite origin strings inside JS so fetch() stays on proxy
  if (rawUrl.startsWith('/_next/static/')) {
    try {
      const upstream = await fetch(`${VERSE_ORIGIN}${rawUrl}`, { headers: upstreamHeaders() })
      const ct = upstream.headers.get('content-type') || 'application/octet-stream'
      res.setHeader('Content-Type', ct)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Cache-Control', 'public, max-age=3600')
      if (ct.includes('javascript') || ct.includes('json')) {
        let text = await upstream.text()
        text = rewriteOrigin(text)
        res.status(upstream.status).send(text)
      } else {
        const buffer = await upstream.arrayBuffer()
        res.status(upstream.status).send(Buffer.from(buffer))
      }
    } catch (err) {
      console.error('[proxy] static error:', rawUrl, err.message)
      res.status(502).json({ error: err.message })
    }
    return
  }

  // 2. Next.js image optimisation — now that domain is whitelisted, pipe directly
  if (rawUrl.startsWith('/_next/image')) {
    return pipeRaw(`${VERSE_ORIGIN}${rawUrl}`)
  }

  // 3. Next.js data routes — rewrite origin in JSON response
  if (rawUrl.startsWith('/_next/data/')) {
    return pipeText(`${VERSE_ORIGIN}${rawUrl}`)
  }

  // 4. API routes — rewrite origin in response
  if (rawUrl.startsWith('/api/')) {
    return pipeText(`${VERSE_ORIGIN}${rawUrl}`)
  }

  // 5. CDN / cloudflare helpers
  if (rawUrl.startsWith('/cdn-cgi/')) {
    return pipeRaw(`${VERSE_ORIGIN}${rawUrl}`)
  }

  // 6. Static file extensions
  const staticExt = /\.(woff2?|ttf|eot|otf|ico|png|jpe?g|gif|svg|webp|avif|mp4|webm|map)(\?|$)/i
  if (staticExt.test(rawUrl)) {
    return pipeRaw(`${VERSE_ORIGIN}${rawUrl}`)
  }

  // 7. Favicon / manifest / robots
  if (rawUrl.startsWith('/favicon') || rawUrl.startsWith('/manifest') || rawUrl === '/robots.txt') {
    return pipeRaw(`${VERSE_ORIGIN}${rawUrl}`)
  }

  // ─── 8. HTML page request ────────────────────────────────────────────────────
  // Parse the path cleanly — ignore Vercel's injected "path" rewrite param
  // by reconstructing the URL from what's actually in the raw request path.
  let parsedUrl
  try {
    parsedUrl = new URL(rawUrl, 'http://x')
  } catch {
    res.status(400).json({ error: 'Bad request URL' })
    return
  }

  // The pathname is the gallery/artwork/artist path on Verse
  // e.g. /33-gallery  or  /33-gallery/works/some-artwork
  const versePath = parsedUrl.pathname  // already has leading slash

  // Forward any query params except internal ones Vercel injects
  const forwardParams = new URLSearchParams()
  forwardParams.set('iframe', 'true')
  parsedUrl.searchParams.forEach((v, k) => {
    if (k !== 'path') forwardParams.set(k, v)
  })

  const verseUrl = `${VERSE_ORIGIN}${versePath}?${forwardParams}`

  try {
    const response = await fetch(verseUrl, { headers: upstreamHeaders() })
    const ct = response.headers.get('content-type') || ''

    if (!ct.includes('text/html')) {
      const buffer = await response.arrayBuffer()
      res.setHeader('Content-Type', ct)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.status(response.status).send(Buffer.from(buffer))
      return
    }

    let html = await response.text()

    // a) Rewrite all verse origin references
    html = rewriteOrigin(html)

    // b) Swap light → dark
    html = html.replace(
      /(<html[^>]*\sclass=")([\w\s-]*)"/,
      (match, prefix, classes) => {
        const updated = classes
          .split(/\s+/)
          .filter(Boolean)
          .map(c => (c === 'light' ? 'dark' : c))
          .join(' ')
        const withDark = updated.includes('dark') ? updated : updated + ' dark'
        return `${prefix}${withDark}"`
      }
    )

    // c) MutationObserver guard to survive React hydration resetting the class
    const darkGuard = `<script>
(function(){
  var h=document.documentElement;
  function d(){if(h.classList.contains('light')){h.classList.replace('light','dark');}else if(!h.classList.contains('dark')){h.classList.add('dark');}}
  d();
  new MutationObserver(function(){d();}).observe(h,{attributes:true,attributeFilter:['class']});
})();
</script>`
    html = html.replace('<head>', '<head>' + darkGuard)

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(html)
  } catch (err) {
    console.error('[proxy] html error:', verseUrl, err.message)
    res.status(500).json({ error: err.message })
  }
}
