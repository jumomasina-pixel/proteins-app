// Founding Coach — Phase 1 referral endpoint.
// Two actions:
//   • validate — POST { action: 'validate', slug } → { valid, coachName?, full? }
//     • valid=false reasons: 'not_found' | 'capped'
//   • record   — POST { action: 'record',   slug } → { success, clientCount, capped? }
//     • increments client_count on the coach row. Re-checks the cap before incrementing.
//
// Seat cap: 20 clients per coach (hardcoded for Phase 1).
//
// PHASE 2 - STRIPE NOT YET CONFIGURED
// When Stripe Connect is wired up, a successful 'record' should fire a webhook to register
// the client as billable at $5/mo and credit the coach $1/mo per active seat. No Stripe SDK,
// env vars, or API calls are present anywhere in the app — phase 1 ships without billing.

const SEAT_CAP = 20

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const SUPABASE_URL     = process.env.SUPABASE_URL
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not set' })
  }

  const serviceHeaders = {
    apikey:        SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  }

  const { action, slug } = req.body || {}
  if (!action || !slug || typeof slug !== 'string') {
    return res.status(400).json({ error: 'action and slug are required' })
  }
  const cleanSlug = slug.trim().toLowerCase()
  if (!cleanSlug) {
    return res.status(400).json({ error: 'slug cannot be empty' })
  }

  // Look up the coach row by slug. role must be 'coach' to count — guards against
  // someone setting referral_slug on a normal user row by mistake.
  async function loadCoach() {
    const url = `${SUPABASE_URL}/rest/v1/profiles?referral_slug=eq.${encodeURIComponent(cleanSlug)}&role=eq.coach&select=id,name,client_count,referral_slug`
    const r = await fetch(url, { headers: serviceHeaders })
    if (!r.ok) {
      const body = await r.text()
      throw new Error(`coach lookup failed: ${r.status} ${body}`)
    }
    const rows = await r.json()
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
  }

  try {
    if (action === 'validate') {
      const coach = await loadCoach()
      if (!coach) {
        return res.status(200).json({ valid: false, reason: 'not_found' })
      }
      const count = Number(coach.client_count) || 0
      if (count >= SEAT_CAP) {
        return res.status(200).json({ valid: false, reason: 'capped', coachName: coach.name || null })
      }
      const firstName = (coach.name || '').split(' ')[0] || coach.name || null
      return res.status(200).json({
        valid:     true,
        coachName: firstName,
        full:      coach.name || null,
        seatsLeft: Math.max(0, SEAT_CAP - count),
      })
    }

    if (action === 'record') {
      const coach = await loadCoach()
      if (!coach) {
        return res.status(404).json({ success: false, error: 'coach_not_found' })
      }
      const count = Number(coach.client_count) || 0
      if (count >= SEAT_CAP) {
        return res.status(200).json({ success: false, capped: true, clientCount: count })
      }
      const next = count + 1
      // PATCH the coach row.
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${coach.id}`,
        {
          method:  'PATCH',
          headers: { ...serviceHeaders, 'Prefer': 'return=representation' },
          body:    JSON.stringify({ client_count: next }),
        }
      )
      if (!patchRes.ok) {
        const body = await patchRes.text()
        console.error('[referral] PATCH client_count failed:', body)
        return res.status(500).json({ success: false, error: 'patch_failed' })
      }
      // PHASE 2 - STRIPE NOT YET CONFIGURED — enqueue Stripe billable-seat creation here.
      return res.status(200).json({ success: true, clientCount: next })
    }

    return res.status(400).json({ error: `unknown action: ${action}` })
  } catch (err) {
    console.error('[referral] error:', err)
    return res.status(500).json({ error: err.message })
  }
}
