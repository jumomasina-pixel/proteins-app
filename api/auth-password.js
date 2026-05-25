export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { action, email, password, access_token } = req.body || {}

  if (action !== 'update-password' && !email) return res.status(400).json({ error: 'email required' })

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase env vars not set' })
  }

  try {
    // ── Sign in ───────────────────────────────────────────────────────────────
    if (action === 'signin') {
      if (!password) return res.status(400).json({ error: 'password required' })

      const r = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'apikey': supabaseKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      })
      const data = await r.json()
      if (!r.ok) {
        const msg = data.error_description || data.msg || data.error || 'Sign in failed'
        return res.status(400).json({ error: msg })
      }
      return res.status(200).json({
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        user:          data.user,
      })
    }

    // ── Sign up ───────────────────────────────────────────────────────────────
    if (action === 'signup') {
      if (!password) return res.status(400).json({ error: 'password required' })

      const r = await fetch(`${supabaseUrl}/auth/v1/signup`, {
        method: 'POST',
        headers: { 'apikey': supabaseKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      })
      const data = await r.json()
      if (!r.ok) {
        const msg = data.error_description || data.msg || data.error || 'Sign up failed'
        return res.status(400).json({ error: msg })
      }
      // access_token is null when email confirmation is enabled in Supabase dashboard
      if (!data.access_token) {
        return res.status(400).json({
          error: 'Email confirmation is enabled on this project. Disable it in Supabase Auth settings to allow immediate sign-in.',
        })
      }
      return res.status(200).json({
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        user:          data.user,
      })
    }

    // ── Forgot password ───────────────────────────────────────────────────────
    if (action === 'forgot') {
      const r = await fetch(`${supabaseUrl}/auth/v1/recover`, {
        method: 'POST',
        headers: { 'apikey': supabaseKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), redirect_to: 'https://myremi.io' }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        return res.status(400).json({ error: data.error_description || data.msg || 'Failed to send reset email.' })
      }
      return res.status(200).json({ success: true })
    }

    // ── Update password (recovery flow) ───────────────────────────────────────
    if (action === 'update-password') {
      if (!access_token) return res.status(400).json({ error: 'access_token required' })
      if (!password) return res.status(400).json({ error: 'password required' })
      const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
        method: 'PUT',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        return res.status(400).json({ error: data.error_description || data.msg || data.error || 'Failed to update password.' })
      }
      return res.status(200).json({ success: true })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    console.error('[auth-password]', err)
    return res.status(500).json({ error: err.message })
  }
}
