export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()

  if (!token) {
    return res.status(401).json({ error: 'No access token provided' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase env vars not set' })
  }

  try {
    // 1. Validate the token and get the Supabase auth user
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${token}`,
      },
    })

    if (!userRes.ok) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }

    const user = await userRes.json()

    // 2. Read role + profile fields from the users table
    let dbRole = 'free'
    let dbProfile = null
    try {
      const roleRes = await fetch(
        `${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(user.email)}&select=role,name,sport,goal,weight`,
        {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${token}`,
          },
        }
      )
      if (roleRes.ok) {
        const rows = await roleRes.json()
        if (Array.isArray(rows) && rows.length > 0) {
          const row = rows[0]
          if (row.role) dbRole = row.role
          if (row.name) dbProfile = { name: row.name, sport: row.sport || null, goal: row.goal || null, weight: row.weight || null }
        }
      }
    } catch {
      // Non-fatal — default to free / no profile
    }

    return res.status(200).json({ user, role: dbRole, dbProfile })
  } catch (err) {
    console.error('[auth-user]', err)
    return res.status(500).json({ error: err.message })
  }
}
