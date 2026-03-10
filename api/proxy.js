export default async function handler(req, res) {
  const verseOrigin = 'https://iframe.verse.works'

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------
  const pipe = async (url) => {
    try {
      const upstream = await fetch(url, {
        headers: {
          'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
          'Accept': req.headers['accept'] || '*/*',
          'Accept-Encoding': 'identity', // avoid compressed responses we can't stream easily
          'Referer': 'https://33.gallery/',
        },
      })

      const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
      const cacheControl = upstream.headers.get('cache-control') || 'public, max-age=31536000, immutable'

      res.setHeader('Content-Type', contentType)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Cache-Control', cacheControl)

      // Forward useful upstream headers (vary, etag, last-modified)
      for (const h of ['etag', 'last-modified', 'vary']) {
        const v = upstream.headers.get(h)
        if (v) res.setHeader(h, v)
      }

      const buffer = await upstream.arrayBuffer()
      res.status(upstream.status).send(Buffer.from(buffer))
    } catch (err) {
      console.error('[proxy] pipe error:', url, err.message)
      res.status(502).json({ error: err.message })
    }
  }

  // -----------------------------------------------------------------------
  // Routing
  // -----------------------------------------------------------------------
  const url = req.url  // includes query string

  // 1. Static JS/CSS chunks — always pipe, long cache
  if (url.startsWith('/_next/static/')) {
    return pipe(`${verseOrigin}${url}`)
  }

  // 2. Next.js image optimisation endpoint — pipe
  if (url.startsWith('/_next/image')) {
    return pipe(`${verseOrigin}${url}`)
  }

  // 3. Next.js data (RSC / getServerSideProps JSON) — pipe
  if (url.startsWith('/_next/data/')) {
    return pipe(`${verseOrigin}${url}`)
  }

  // 4. API routes — pipe
  if (url.startsWith('/api/')) {
    return pipe(`${verseOrigin}${url}`)
  }

  // 5. Cloudflare / CDN helpers — pipe
  if (url.startsWith('/cdn-cgi/')) {
    return pipe(`${verseOrigin}${url}`)
  }

  // 6. Favicons / manifests / robots — pipe
  if (
    url.startsWith('/favicon') ||
    url.startsWith('/manifest') ||
    url === '/robots.txt' ||
    url === '/sitemap.xml'
  ) {
    return pipe(`${verseOrigin}${url}`)
  }

  // 7. Known static asset extensions — pipe anything that looks like a file
  const staticExt = /\.(js|css|woff2?|ttf|eot|otf|ico|png|jpe?g|gif|svg|webp|avif|mp4|webm|json|map)(\?|$)/i
  if (staticExt.test(url)) {
    return pipe(`${verseOrigin}${url}`)
  }

  // -----------------------------------------------------------------------
  // 8. HTML page — fetch, swap light→dark, return
  // -----------------------------------------------------------------------
  const { path = '33-gallery', ...rest } = req.query
  const params = new URLSearchParams({ iframe: 'true', ...rest })
  const verseUrl = `${verseOrigin}/${path}?${params}`

  try {
    const response = await fetch(verseUrl, {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.5',
        'Referer': 'https://33.gallery/',
      },
    })

    // If Verse returns a non-HTML response on an unexpected path, just pipe it
    const ct = response.headers.get('content-type') || ''
    if (!ct.includes('text/html')) {
      const buffer = await response.arrayBuffer()
      res.setHeader('Content-Type', ct)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.status(response.status).send(Buffer.from(buffer))
      return
    }

    let html = await response.text()

    // Swap light → dark on the <html> element class list
    html = html.replace(
      /(<html[^>]*\sclass=")([\w\s-]*)"/,
      (match, prefix, classes) => {
        const updated = classes
          .split(/\s+/)
          .map(c => (c === 'light' ? 'dark' : c))
          .join(' ')
        // Ensure 'dark' is present even if 'light' wasn't found
        return `${prefix}${updated.includes('dark') ? updated : updated + ' dark'}"`
      }
    )

    // Inject a tiny inline script that re-applies 'dark' immediately after
    // React hydration (which would otherwise reset the class back to 'light').
    const darkGuard = `<script>
(function () {
  // Re-apply dark mode after every React root re-render / hydration attempt
  var html = document.documentElement;
  function ensureDark() {
    if (html.classList.contains('light')) {
      html.classList.replace('light', 'dark');
    } else if (!html.classList.contains('dark')) {
      html.classList.add('dark');
    }
  }
  // Immediate application
  ensureDark();
  // Watch for hydration replacing the class
  var obs = new MutationObserver(function (mutations) {
    mutations.forEach(function (m) {
      if (m.attributeName === 'class') ensureDark();
    });
  });
  obs.observe(html, { attributes: true, attributeFilter: ['class'] });
})();
</script>`

    // Inject right after <head> so it runs before any React code
    html = html.replace('<head>', '<head>' + darkGuard)

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    // Don't cache HTML — we want fresh light→dark swaps
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(html)
  } catch (err) {
    console.error('[proxy] html error:', verseUrl, err.message)
    res.status(500).json({ error: err.message })
  }
}
