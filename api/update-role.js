const VALID_ROLES = ['free', 'coach', 'admin']

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { email, role } = req.body

  if (!email || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `email and role (${VALID_ROLES.join('|')}) required` })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Supabase env vars not configured' })
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ role }),
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(errorText || `Supabase returned ${response.status}`)
    }

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('[update-role]', err)
    return res.status(500).json({ error: err.message })
  }
}
