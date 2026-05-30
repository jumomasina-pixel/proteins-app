import Anthropic from '@anthropic-ai/sdk'

// Two actions:
//   (default)     — generate AI observation note for the coach dashboard
//   client_log    — INSERT a client cook event into coach_logs

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { action } = req.body || {}

  // ── action: client_log — INSERT into coach_logs ───────────────────────────
  if (action === 'client_log') {
    const SUPABASE_URL     = process.env.SUPABASE_URL
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return res.status(200).json({ success: false })
    const { coachSlug, clientName, dishName, sport, goal } = req.body || {}
    if (!coachSlug || !clientName || !dishName) return res.status(200).json({ success: false })
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/coach_logs`, {
        method: 'POST',
        headers: {
          apikey:         SERVICE_ROLE_KEY,
          Authorization:  `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer:         'return=minimal',
        },
        body: JSON.stringify({
          coach_slug:  coachSlug.trim().toLowerCase(),
          client_name: clientName,
          dish_name:   dishName,
          sport:       sport || '',
          goal:        Array.isArray(goal) ? goal.join(', ') : (goal || ''),
        }),
      })
      return res.status(200).json({ success: true })
    } catch {
      return res.status(200).json({ success: false })
    }
  }

  // ── Default: generate AI observation for coach dashboard ──────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(200).json({ note: null })

  const { clientId, clientName, sport, goal } = req.body || {}
  if (!clientId || !clientName) return res.status(200).json({ note: null })

  try {
    const client = new Anthropic({ apiKey })
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 120,
      system:     'You are Remi — precise, warm, direct. No filler. No exclamation marks.',
      messages: [{
        role:    'user',
        content: `Write one observation (2 sentences max) about ${clientName} based on their profile. Sport: ${sport || 'not specified'}. Goal: ${goal || 'not specified'}. This is for their coach — flag anything worth a check-in. Be specific to their sport and goal. Plain text only, no markdown.`,
      }],
    })
    const note = msg.content?.[0]?.text?.trim() || null
    return res.status(200).json({ note })
  } catch {
    return res.status(200).json({ note: null })
  }
}
