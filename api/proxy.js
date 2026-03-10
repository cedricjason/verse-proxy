export default async function handler(req, res) {
  const { path = '33-gallery', ...rest } = req.query
  
  // Build the Verse URL
  const params = new URLSearchParams({ iframe: 'true', ...rest })
  const verseUrl = `https://iframe.verse.works/${path}?${params}`
  
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

    // Swap light class to dark on the html element
    html = html.replace(
      /(<html[^>]*class="[^"]*)\blight\b([^"]*")/,
      '$1dark$2'
    )

    // Forward relevant headers
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    
    res.status(200).send(html)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
