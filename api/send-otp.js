export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { email, redirectTo } = req.body

  if (!email) {
    return res.status(400).json({ error: 'email is required' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase env vars not set' })
  }

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/otp`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        options: {
          emailRedirectTo: redirectTo || 'https://myremi.io',
        },
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(errorText || `Supabase returned ${response.status}`)
    }

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('[send-otp]', err)
    return res.status(500).json({ error: err.message })
  }
}
