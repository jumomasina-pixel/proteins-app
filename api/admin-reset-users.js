export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const secret = process.env.ADMIN_RESET_SECRET
    if (!secret) {
      return res.status(500).json({ error: 'ADMIN_RESET_SECRET env var not set' })
    }

    const authHeader = req.headers['authorization'] || ''
    const provided = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const SUPABASE_URL = process.env.SUPABASE_URL
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Supabase env vars not set' })
    }

    const serviceHeaders = {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    }

    // 1. Delete all rows from the users table
    const tableRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=neq.null`,
      {
        method: 'DELETE',
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
      }
    )
    if (!tableRes.ok) {
      const body = await tableRes.json().catch(() => ({}))
      console.error('[admin-reset-users] profiles table delete error:', body)
      return res.status(500).json({ error: body.message || body.error || 'Failed to delete profiles table rows' })
    }

    // 2. List all auth users
    const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      headers: serviceHeaders,
    })
    if (!listRes.ok) {
      const body = await listRes.json().catch(() => ({}))
      console.error('[admin-reset-users] listUsers error:', body)
      return res.status(500).json({ error: body.message || body.error || 'Failed to list auth users' })
    }
    const listData = await listRes.json()
    const users = listData?.users ?? []

    // 3. Delete every auth user
    for (const user of users) {
      const delRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: serviceHeaders,
      })
      if (!delRes.ok) {
        const body = await delRes.json().catch(() => ({}))
        console.error(`[admin-reset-users] deleteUser(${user.id}) error:`, body)
      }
    }

    return res.status(200).json({ success: true, deleted: users.length })
  } catch (err) {
    console.error('[admin-reset-users] unexpected error:', err)
    return res.status(500).json({ error: err.message })
  }
}
