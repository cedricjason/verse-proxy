export default async function handler(req, res) {
  const { path = '33-gallery', ...rest } = req.query
  
  const params = new URLSearchParams({ iframe: 'true', ...rest })
  const verseUrl = `https://iframe.verse.works/${path}?${params}`
  const verseOrigin = 'https://iframe.verse.works'
  
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

    // Swap light to dark
    html = html.replace(
      /(<html[^>]*class="[^"]*)\blight\b([^"]*")/,
      '$1dark$2'
    )

    // Rewrite absolute-path URLs to include verse origin
    // Handles src="/_next/...", href="/_next/...", url(/_next/...)
    html = html
      .replace(/(src|href)="\//g, `$1="${verseOrigin}/`)
      .replace(/(src|href)='\//g, `$1='${verseOrigin}/`)
      .replace(/url\(\//g, `url(${verseOrigin}/`)
      .replace(/sourceMappingURL=\//g, `sourceMappingURL=${verseOrigin}/`)

    // Fix Next.js router base path if needed
    html = html.replace(
      /"assetPrefix":""/g,
      `"assetPrefix":"${verseOrigin}"`
    )

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    res.status(200).send(html)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
