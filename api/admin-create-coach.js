// Admin-only endpoint to promote an existing user to coach + assign their referral slug.
// Phase 1 — there is no self-serve coach signup yet. Use this to create coaches one at a time.
//
// POST  /api/admin-create-coach
//   Headers: Authorization: Bearer <ADMIN_RESET_SECRET>
//   Body:    { email, slug }
//   Returns: { success: true, url, slug, email }
//
// Pre-conditions:
//   • The user must already have a profile row (i.e. they signed up / completed onboarding).
//   • The slug must not already be in use by another coach.

const REFERRAL_BASE = 'https://myremi.io'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const secret = (process.env.ADMIN_RESET_SECRET || '').trim()
  if (!secret) {
    return res.status(500).json({ error: 'ADMIN_RESET_SECRET env var not set' })
  }

  const authHeader = req.headers['authorization'] || ''
  const provided = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (provided !== secret) {
    // TEMPORARY DEBUG — remove once auth mismatch is diagnosed.
    console.log('[debug] secret length:', secret.length)
    console.log('[debug] provided length:', provided.length)
    console.log('[debug] secret first3:', secret.slice(0,3), 'last3:', secret.slice(-3))
    console.log('[debug] provided first3:', provided.slice(0,3), 'last3:', provided.slice(-3))
    console.log('[debug] match:', provided === secret)
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { email, slug } = req.body || {}
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required' })
  }
  if (!slug || typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug.trim().toLowerCase())) {
    return res.status(400).json({ error: 'slug must be 2–31 chars, lowercase alphanumeric + hyphens, must start alphanumeric' })
  }
  const cleanEmail = email.trim().toLowerCase()
  const cleanSlug  = slug.trim().toLowerCase()

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

  try {
    // 1. Ensure the slug isn't already taken.
    const slugCheck = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?referral_slug=eq.${encodeURIComponent(cleanSlug)}&select=id,email`,
      { headers: serviceHeaders }
    )
    if (!slugCheck.ok) {
      const body = await slugCheck.text()
      return res.status(500).json({ error: `slug check failed: ${body}` })
    }
    const slugRows = await slugCheck.json()
    if (Array.isArray(slugRows) && slugRows.length > 0 && slugRows[0].email !== cleanEmail) {
      return res.status(409).json({ error: `slug "${cleanSlug}" is already taken` })
    }

    // 2. Patch the profile row.
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(cleanEmail)}`,
      {
        method:  'PATCH',
        headers: { ...serviceHeaders, 'Prefer': 'return=representation' },
        body:    JSON.stringify({ role: 'coach', referral_slug: cleanSlug }),
      }
    )
    if (!patchRes.ok) {
      const body = await patchRes.text()
      return res.status(500).json({ error: `patch failed: ${body}` })
    }
    const patched = await patchRes.json()
    if (!Array.isArray(patched) || patched.length === 0) {
      return res.status(404).json({ error: `no profile found for ${cleanEmail}. The user must complete onboarding first.` })
    }

    return res.status(200).json({
      success: true,
      email:   cleanEmail,
      slug:    cleanSlug,
      url:     `${REFERRAL_BASE}/join/${cleanSlug}`,
    })
  } catch (err) {
    console.error('[admin-create-coach] error:', err)
    return res.status(500).json({ error: err.message })
  }
}
