export default async function handler(req, res) {
  const supabaseUrl    = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseKey    = process.env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !serviceRoleKey || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase env vars not set' })
  }

  // Validate Bearer token and resolve user identity
  const authHeader = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim()
  if (!authHeader) return res.status(401).json({ error: 'No access token provided' })

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${authHeader}` },
  })
  if (!userRes.ok) return res.status(401).json({ error: 'Invalid or expired token' })
  const { id: userId } = await userRes.json()

  const base = `${supabaseUrl}/rest/v1/saved_recipes`
  const serviceHeaders = {
    'apikey':        serviceRoleKey,
    'Authorization': `Bearer ${serviceRoleKey}`,
    'Content-Type':  'application/json',
  }

  // ── GET — all saved recipes for this user, newest first ─────────────────────
  if (req.method === 'GET') {
    const r = await fetch(`${base}?user_id=eq.${userId}&order=saved_at.desc`, { headers: serviceHeaders })
    if (!r.ok) {
      const err = await r.text()
      console.error('[saved-recipes] GET failed:', err)
      return res.status(500).json({ error: 'Failed to fetch saved recipes' })
    }
    const rows = await r.json()
    return res.status(200).json(rows.map(row => ({
      id:          row.id,
      recipe_data: row.recipe_data,
      saved_at:    row.saved_at,
    })))
  }

  // ── POST — insert a new saved recipe ─────────────────────────────────────────
  if (req.method === 'POST') {
    const { recipe_data } = req.body || {}
    if (!recipe_data) return res.status(400).json({ error: 'recipe_data is required' })

    const r = await fetch(base, {
      method:  'POST',
      headers: { ...serviceHeaders, 'Prefer': 'return=representation' },
      body:    JSON.stringify({ user_id: userId, recipe_data }),
    })
    if (!r.ok) {
      const err = await r.text()
      console.error('[saved-recipes] POST failed:', err)
      return res.status(500).json({ error: err || 'Failed to save recipe' })
    }
    const rows = await r.json()
    return res.status(200).json({ id: rows[0]?.id })
  }

  // ── DELETE — delete by row id, scoped to this user ───────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.body || {}
    if (!id) return res.status(400).json({ error: 'id is required' })

    const r = await fetch(`${base}?id=eq.${id}&user_id=eq.${userId}`, {
      method:  'DELETE',
      headers: serviceHeaders,
    })
    if (!r.ok) {
      const err = await r.text()
      console.error('[saved-recipes] DELETE failed:', err)
      return res.status(500).json({ error: err || 'Failed to delete recipe' })
    }
    return res.status(200).json({ success: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
