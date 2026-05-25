export default async function handler(req, res) {
  console.log('[auth-user] called, method:', req.method)

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase env vars not set' })
  }

  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    return res.status(401).json({ error: 'No access token provided' })
  }

  // ── Validate token and get Supabase auth user (shared by GET + POST) ─────────
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${token}` },
  })
  if (!userRes.ok) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
  const user = await userRes.json()

  // ── POST — upsert profile on onboarding completion ────────────────────────────
  if (req.method === 'POST') {
    const { name, sport, goal } = req.body || {}
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    const upsertPayload = {
      id:    user.id,
      email: user.email,
      name:  name  || '',
      sport: sport || '',
      goal:  goal  || '',
    }
    console.log('[auth-user] Upsert payload:', upsertPayload)

    try {
      const upsertRes = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
        method: 'POST',
        headers: {
          'apikey':        serviceRoleKey || supabaseKey,
          'Authorization': `Bearer ${serviceRoleKey || supabaseKey}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(upsertPayload),
      })

      const upsertText = await upsertRes.text()
      console.log('[auth-user] Upsert result:', upsertRes.status, upsertText)

      if (!upsertRes.ok) {
        return res.status(500).json({ error: upsertText || `Supabase upsert failed (${upsertRes.status})` })
      }

      return res.status(200).json({ success: true, dbRowExists: true })
    } catch (err) {
      console.error('[auth-user] POST error:', err)
      return res.status(500).json({ error: err.message })
    }
  }

  // ── GET — read role + profile fields ─────────────────────────────────────────
  if (req.method === 'GET') {
    let dbRole = 'free'
    let dbProfile = null
    let dbRowExists = false
    try {
      const roleRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(user.email)}&select=role,name,sport,goal,weight`,
        {
          headers: {
            'apikey':        supabaseKey,
            'Authorization': `Bearer ${token}`,
          },
        }
      )
      if (roleRes.ok) {
        const rows = await roleRes.json()
        if (Array.isArray(rows) && rows.length > 0) {
          const row = rows[0]
          dbRowExists = true
          if (row.role) dbRole = row.role
          if (row.name) dbProfile = { name: row.name, sport: row.sport || null, goal: row.goal || null, weight: row.weight || null }
        }
      }
    } catch {
      // Non-fatal — default to free / no profile
    }

    return res.status(200).json({ user, role: dbRole, dbProfile, dbRowExists })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
