const PROTEIN_KEYWORDS = [
  'pork', 'chicken', 'salmon', 'beef', 'lamb', 'tofu', 'prawn', 'tuna',
  'egg', 'eggs', 'fish', 'turkey', 'duck', 'veal', 'crab', 'shrimp',
  'cod', 'mince', 'steak', 'bacon', 'sausage', 'chorizo', 'lentils',
  'beans', 'tempeh', 'sardine', 'anchovy', 'scallop', 'lobster',
]

const SKIP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'with', 'in', 'on', 'of', 'for',
  'au', 'en', 'la', 'le', 'du', 'style', 'pan', 'one', 'pot',
  'san', 'choy', 'bow', 'bao', 'der', 'von',
])

const GENERIC_FALLBACKS = [
  'healthy meal', 'fresh food', 'cooked protein', 'home cooking',
]

async function searchUnsplash(query, accessKey) {
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=landscape&per_page=1`
  const r = await fetch(url, { headers: { Authorization: `Client-ID ${accessKey}` } })
  if (!r.ok) return null
  const data = await r.json()
  return data.results?.[0] ?? null
}

function meaningfulWords(name) {
  return name
    .replace(/[&+]/g, ' ')
    .split(/\s+/)
    .map(w => w.replace(/[^a-zA-Z]/g, '').toLowerCase())
    .filter(w => w.length > 2 && !SKIP_WORDS.has(w))
}

function extractProtein(name) {
  for (const word of name.toLowerCase().split(/\s+/)) {
    const clean = word.replace(/[^a-z]/g, '')
    if (PROTEIN_KEYWORDS.includes(clean)) return clean
  }
  return null
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { query, cuisine } = req.query
  if (!query) return res.status(400).json({ error: 'query is required' })

  const accessKey = process.env.UNSPLASH_ACCESS_KEY
  if (!accessKey) {
    return res.status(500).json({ error: 'UNSPLASH_ACCESS_KEY environment variable is not set' })
  }

  try {
    // ── Fallback chain — stops at first hit ───────────────────────────────────
    const candidates = []

    // 1. Full dish name
    candidates.push(query)

    // 2. First two meaningful words
    const words = meaningfulWords(query)
    if (words.length >= 2) candidates.push(words.slice(0, 2).join(' '))
    else if (words.length === 1) candidates.push(words[0])

    // 3. Primary protein + "food"
    const protein = extractProtein(query)
    if (protein) candidates.push(protein + ' food')

    // 4 & 5. Cuisine fallbacks
    if (cuisine) {
      candidates.push(cuisine + ' food')
      candidates.push(cuisine + ' dish')
    }

    // 6. Generic fallbacks
    candidates.push(...GENERIC_FALLBACKS)

    for (const q of candidates) {
      const photo = await searchUnsplash(q, accessKey)
      if (photo) {
        return res.status(200).json({
          url: photo.urls.regular,   // 1080px — fine for both card and hero
          alt: photo.alt_description || query,
          resolvedQuery: q,
          credit: { name: photo.user.name, link: photo.links.html },
        })
      }
    }

    // Exhausted every fallback (API healthy but zero results across all queries)
    return res.status(200).json({ url: null })
  } catch (err) {
    console.error('[unsplash]', err)
    return res.status(500).json({ error: err.message })
  }
}
