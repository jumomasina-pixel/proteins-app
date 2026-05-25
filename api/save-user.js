export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { name, email, sport, goal, weight } = req.body

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_ANON_KEY

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal,resolution=ignore-duplicates',
      },
      body: JSON.stringify({ name, email, sport, goal, weight }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(errorText || `Supabase returned ${response.status}`)
    }

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('[save-user]', err)
    return res.status(500).json({ error: err.message })
  }
}
