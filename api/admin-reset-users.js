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

    const { email } = req.body || {}
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email is required in the request body.' })
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

    // 1. Find the auth user by email
    const listRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
      { headers: serviceHeaders }
    )
    if (!listRes.ok) {
      const body = await listRes.json().catch(() => ({}))
      console.error('[admin-reset-users] listUsers error:', body)
      return res.status(500).json({ error: body.message || body.error || 'Failed to look up user' })
    }
    const listData = await listRes.json()
    const match = (listData?.users ?? []).find(u => u.email === email)
    if (!match) {
      return res.status(200).json({ found: false, message: `No user found for ${email}.` })
    }

    const userId = match.id

    // 2. Delete their profiles row
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`,
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
    if (!profileRes.ok) {
      const body = await profileRes.json().catch(() => ({}))
      console.error('[admin-reset-users] profile delete error:', body)
      return res.status(500).json({ error: body.message || body.error || 'Failed to delete profile row' })
    }

    // 3. Delete the auth user
    const delRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${userId}`,
      {
        method: 'DELETE',
        headers: serviceHeaders,
      }
    )
    if (!delRes.ok) {
      const body = await delRes.json().catch(() => ({}))
      console.error(`[admin-reset-users] deleteUser(${userId}) error:`, body)
      return res.status(500).json({ error: body.message || body.error || 'Failed to delete auth user' })
    }

    return res.status(200).json({ success: true, email })
  } catch (err) {
    console.error('[admin-reset-users] unexpected error:', err)
    return res.status(500).json({ error: err.message })
  }
}
