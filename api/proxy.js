export default async function handler(req, res) {
  const verseOrigin = 'https://iframe.verse.works'
  
  // Proxy all _next static assets directly
  if (req.url.startsWith('/_next/') || req.url.startsWith('/cdn-cgi/')) {
    const assetUrl = `${verseOrigin}${req.url}`
    try {
      const assetRes = await fetch(assetUrl)
      const contentType = assetRes.headers.get('content-type') || 'application/octet-stream'
      res.setHeader('Content-Type', contentType)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      const buffer = await assetRes.arrayBuffer()
      res.status(assetRes.status).send(Buffer.from(buffer))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
    return
  }

  // Proxy the main HTML page
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
      }
    })

    let html = await response.text()

    // Swap light to dark on the html element
    html = html.replace(
      /(<html[^>]*class="[^"]*)\blight\b([^"]*")/,
      '$1dark$2'
    )

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.status(200).send(html)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
