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

    // 2. Read role from the users table (anon key + user's own token is fine for SELECT)
    let dbRole = 'free'
    try {
      const roleRes = await fetch(
        `${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(user.email)}&select=role`,
        {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${token}`,
          },
        }
      )
      if (roleRes.ok) {
        const rows = await roleRes.json()
        if (Array.isArray(rows) && rows.length > 0 && rows[0].role) {
          dbRole = rows[0].role
        }
      }
    } catch {
      // Role lookup failure is non-fatal — default to 'free'
    }

    return res.status(200).json({ user, role: dbRole })
  } catch (err) {
    console.error('[auth-user]', err)
    return res.status(500).json({ error: err.message })
  }
}
