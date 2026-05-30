// Returns the list of clients referred by this coach, with latest cook log per client.
// POST { coachSlug }
// Authorization: Bearer <supabase-user-jwt>

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const SUPABASE_URL      = process.env.SUPABASE_URL
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  const SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not set' })
  }

  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    return res.status(401).json({ error: 'No access token provided' })
  }

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey':        SUPABASE_ANON_KEY || SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${token}`,
    },
  })
  if (!userRes.ok) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
  const user = await userRes.json()

  const { coachSlug } = req.body || {}
  if (!coachSlug || typeof coachSlug !== 'string') {
    return res.status(400).json({ error: 'coachSlug is required' })
  }
  const cleanSlug = coachSlug.trim().toLowerCase()

  const serviceHeaders = {
    apikey:         SERVICE_ROLE_KEY,
    Authorization:  `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  }

  // Confirm requesting user owns this slug and has role=coach
  const coachRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(user.email)}&select=role,referral_slug`,
    { headers: serviceHeaders }
  )
  if (!coachRes.ok) {
    return res.status(500).json({ error: 'Failed to verify coach identity' })
  }
  const coachRows = await coachRes.json()
  const coachRow  = Array.isArray(coachRows) && coachRows.length > 0 ? coachRows[0] : null
  if (!coachRow || coachRow.role !== 'coach' || coachRow.referral_slug !== cleanSlug) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    // Fetch clients
    const clientsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?referred_by=eq.${encodeURIComponent(cleanSlug)}&select=id,name,goal,sport,created_at&order=created_at.desc`,
      { headers: serviceHeaders }
    )
    if (!clientsRes.ok) {
      const body = await clientsRes.text()
      console.error('[coach-roster] clients query error:', body)
      return res.status(500).json({ error: 'Failed to fetch roster' })
    }
    const clients = await clientsRes.json()
    if (!Array.isArray(clients)) return res.status(200).json({ clients: [] })

    // Fetch latest cook log per client — graceful if coach_logs table doesn't exist yet
    let logsByName = {}
    try {
      const logsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_logs?coach_slug=eq.${encodeURIComponent(cleanSlug)}&select=client_name,dish_name,created_at&order=created_at.desc`,
        { headers: serviceHeaders }
      )
      if (logsRes.ok) {
        const logs = await logsRes.json()
        if (Array.isArray(logs)) {
          for (const log of logs) {
            // Keep only the most recent per client name
            if (!logsByName[log.client_name]) logsByName[log.client_name] = log
          }
        }
      }
    } catch {}

    const enriched = clients.map(c => ({
      ...c,
      latestLog: logsByName[c.name] ?? null,
    }))

    return res.status(200).json({ clients: enriched })
  } catch (err) {
    console.error('[coach-roster] error:', err)
    return res.status(500).json({ error: err.message })
  }
}
