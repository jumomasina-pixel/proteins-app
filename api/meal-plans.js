export default async function handler(req, res) {
  const supabaseUrl    = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseKey    = process.env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !serviceRoleKey || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase env vars not set' })
  }

  const authHeader = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim()
  if (!authHeader) return res.status(401).json({ error: 'No access token provided' })

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${authHeader}` },
  })
  if (!userRes.ok) return res.status(401).json({ error: 'Invalid or expired token' })
  const { id: userId } = await userRes.json()

  const base = `${supabaseUrl}/rest/v1/meal_plans`
  const serviceHeaders = {
    'apikey':        serviceRoleKey,
    'Authorization': `Bearer ${serviceRoleKey}`,
    'Content-Type':  'application/json',
  }

  // ── GET — fetch plan by week_start for authed user ──────────────────────────
  if (req.method === 'GET') {
    const { week_start } = req.query || {}
    if (!week_start) return res.status(400).json({ error: 'week_start is required' })

    const r = await fetch(
      `${base}?user_id=eq.${userId}&week_start=eq.${week_start}&select=plan`,
      { headers: serviceHeaders }
    )
    if (!r.ok) {
      const err = await r.text()
      console.error('[meal-plans] GET failed:', err)
      return res.status(500).json({ error: 'Failed to fetch meal plan' })
    }
    const rows = await r.json()
    return res.status(200).json({ plan: rows[0]?.plan ?? null })
  }

  // ── POST — upsert plan (conflict on user_id + week_start) ───────────────────
  if (req.method === 'POST') {
    const { week_start, plan } = req.body || {}
    if (!week_start || !plan) return res.status(400).json({ error: 'week_start and plan are required' })

    const r = await fetch(base, {
      method:  'POST',
      headers: { ...serviceHeaders, 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body:    JSON.stringify({
        user_id:    userId,
        week_start,
        plan,
        updated_at: new Date().toISOString(),
      }),
    })
    if (!r.ok) {
      const err = await r.text()
      console.error('[meal-plans] POST failed:', err)
      return res.status(500).json({ error: err || 'Failed to save meal plan' })
    }
    const rows = await r.json()
    return res.status(200).json({ plan: rows[0]?.plan ?? plan })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
