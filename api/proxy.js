export default async function handler(req, res) {
  const VERSE_ORIGIN = 'https://iframe.verse.works'
  const VERSE_API_ORIGIN = 'https://verse.works'
  const PROXY_ORIGIN = 'https://verse-33gallery.vercel.app'

  function rewriteOrigins(text) {
    return text
      .split(VERSE_ORIGIN).join(PROXY_ORIGIN)
      .split(VERSE_API_ORIGIN).join(PROXY_ORIGIN)
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
      text = rewriteOrigins(text)
      res.setHeader('Content-Type', ct)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Cache-Control', 'no-store')
      res.status(upstream.status).send(text)
    } catch (err) {
      console.error('[proxy] pipeText error:', url, err.message)
      res.status(502).json({ error: err.message })
    }
  }

  async function pipeRequest(url) {
    try {
      const fetchOpts = {
        method: req.method,
        headers: {
          ...upstreamHeaders(),
          'Content-Type': req.headers['content-type'] || 'application/json',
          'Origin': VERSE_ORIGIN,
        },
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        fetchOpts.body = Buffer.concat(chunks)
      }
      const upstream = await fetch(url, fetchOpts)
      const ct = upstream.headers.get('content-type') || 'application/json'
      let text = await upstream.text()
      text = rewriteOrigins(text)
      res.setHeader('Content-Type', ct)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Apollo-Operation-Name, Apollo-Require-Preflight')
      res.setHeader('Cache-Control', 'no-store')
      res.status(upstream.status).send(text)
    } catch (err) {
      console.error('[proxy] pipeRequest error:', url, err.message)
      res.status(502).json({ error: err.message })
    }
  }

  const rawUrl = req.url

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Apollo-Operation-Name, Apollo-Require-Preflight')
    res.status(204).end()
    return
  }

  // Serve service worker — v3, avoids new Request() constructor entirely
  if (rawUrl === '/sw.js') {
    const swCode = `// v3
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

self.addEventListener('fetch', function(event) {
  const url = event.request.url;
  if (!url.includes('verse.works')) return;

  event.respondWith((async function() {
    const proxied = url
      .replace('https://iframe.verse.works', '${PROXY_ORIGIN}')
      .replace('https://verse.works', '${PROXY_ORIGIN}');

    // Read body first for non-GET requests (streaming not allowed in SW fetch)
    let body = undefined;
    if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
      body = await event.request.arrayBuffer();
    }

    // Pass proxied URL + init directly to fetch() — no new Request() constructor
    return fetch(proxied, {
      method: event.request.method,
      headers: event.request.headers,
      body: body,
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
    });
  })());
});`
    res.setHeader('Content-Type', 'application/javascript')
    res.setHeader('Service-Worker-Allowed', '/')
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(swCode)
    return
  }

  // 1. Static JS/CSS — rewrite origin strings inside JS
  if (rawUrl.startsWith('/_next/static/')) {
    try {
      const upstream = await fetch(`${VERSE_ORIGIN}${rawUrl}`, { headers: upstreamHeaders() })
      const ct = upstream.headers.get('content-type') || 'application/octet-stream'
      res.setHeader('Content-Type', ct)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Cache-Control', 'public, max-age=3600')
      if (ct.includes('javascript') || ct.includes('json')) {
        let text = await upstream.text()
        text = rewriteOrigins(text)
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

  // 2. Next.js image optimisation
  if (rawUrl.startsWith('/_next/image')) {
    return pipeRaw(`${VERSE_ORIGIN}${rawUrl}`)
  }

  // 3. Next.js data routes
  if (rawUrl.startsWith('/_next/data/')) {
    return pipeText(`${VERSE_ORIGIN}${rawUrl}`)
  }

  // 4. GraphQL / query endpoint on verse.works
  if (rawUrl.startsWith('/query') || rawUrl.startsWith('/graphql')) {
    return pipeRequest(`${VERSE_API_ORIGIN}${rawUrl}`)
  }

  // 5. Next.js API routes
  if (rawUrl.startsWith('/api/')) {
    return pipeRequest(`${VERSE_ORIGIN}${rawUrl}`)
  }

  // 6. CDN helpers
  if (rawUrl.startsWith('/cdn-cgi/')) {
    return pipeRaw(`${VERSE_ORIGIN}${rawUrl}`)
  }

  // 7. Static file extensions
  const staticExt = /\.(woff2?|ttf|eot|otf|ico|png|jpe?g|gif|svg|webp|avif|mp4|webm|map)(\?|$)/i
  if (staticExt.test(rawUrl)) {
    return pipeRaw(`${VERSE_ORIGIN}${rawUrl}`)
  }

  // 8. Favicon / manifest / robots
  if (rawUrl.startsWith('/favicon') || rawUrl.startsWith('/manifest') || rawUrl === '/robots.txt') {
    return pipeRaw(`${VERSE_ORIGIN}${rawUrl}`)
  }

  // ─── 9. HTML page ──────────────────────────────────────────────────────────
  let parsedUrl
  try {
    parsedUrl = new URL(rawUrl, 'http://x')
  } catch {
    res.status(400).json({ error: 'Bad request URL' })
    return
  }

  const versePath = parsedUrl.pathname
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
    html = rewriteOrigins(html)

    html = html.replace(
      /(<html[^>]*\sclass=")([\w\s-]*)"/,
      (match, prefix, classes) => {
        const updated = classes.split(/\s+/).filter(Boolean)
          .map(c => (c === 'light' ? 'dark' : c)).join(' ')
        const withDark = updated.includes('dark') ? updated : updated + ' dark'
        return `${prefix}${withDark}"`
      }
    )

    const headInject = `<script>
(function(){
  // Dark mode guard
  var h=document.documentElement;
  function d(){if(h.classList.contains('light')){h.classList.replace('light','dark');}else if(!h.classList.contains('dark')){h.classList.add('dark');}}
  d();
  new MutationObserver(function(){d();}).observe(h,{attributes:true,attributeFilter:['class']});

  // Register SW — intercepts all verse.works Apollo/GraphQL calls
  // No reload: SW will intercept from next navigation naturally
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(function(reg) { console.log('[proxy] SW registered', reg.scope); })
      .catch(function(err) { console.warn('[proxy] SW failed', err); });
  }
})();
</script>`

    html = html.replace('<head>', '<head>' + headInject)

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(html)
  } catch (err) {
    console.error('[proxy] html error:', verseUrl, err.message)
    res.status(500).json({ error: err.message })
  }
}
