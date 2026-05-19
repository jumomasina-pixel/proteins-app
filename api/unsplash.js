export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { query } = req.query
  if (!query) return res.status(400).json({ error: 'query is required' })

  const accessKey = process.env.UNSPLASH_ACCESS_KEY
  if (!accessKey) {
    return res.status(500).json({ error: 'UNSPLASH_ACCESS_KEY environment variable is not set' })
  }

  try {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=landscape&per_page=1`
    const response = await fetch(url, {
      headers: { Authorization: `Client-ID ${accessKey}` },
    })

    if (!response.ok) {
      return res.status(response.status).json({ error: `Unsplash error ${response.status}` })
    }

    const data = await response.json()
    const photo = data.results?.[0]

    if (!photo) {
      return res.status(200).json({ url: null })
    }

    return res.status(200).json({
      url: photo.urls.regular,
      thumb: photo.urls.small,
      alt: photo.alt_description || query,
      credit: {
        name: photo.user.name,
        link: photo.links.html,
      },
    })
  } catch (err) {
    console.error('[unsplash]', err)
    return res.status(500).json({ error: err.message })
  }
}
