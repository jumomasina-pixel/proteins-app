export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { email } = req.query

  if (!email) {
    return res.status(400).json({ error: 'email query param required' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Supabase env vars not configured' })
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=name,email,role`,
      {
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
        },
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(errorText || `Supabase returned ${response.status}`)
    }

    const rows = await response.json()

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    return res.status(200).json({ user: rows[0] })
  } catch (err) {
    console.error('[get-user]', err)
    return res.status(500).json({ error: err.message })
  }
}
