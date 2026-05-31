export default async function handler(req, res) {
  console.log('[auth-user] called, method:', req.method)

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase env vars not set' })
  }

  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    return res.status(401).json({ error: 'No access token provided' })
  }

  // ── Validate token and get Supabase auth user (shared by GET + POST) ─────────
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${token}` },
  })
  if (!userRes.ok) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
  const user = await userRes.json()

  // ── POST — upsert profile on onboarding completion ────────────────────────────
  if (req.method === 'POST') {
    const {
      name, sport, goal, training_philosophy, referred_by, role,
      weight, target_weight, targetWeight,
      training_frequency, trainingFrequency,
      foods_to_avoid, foodsToAvoid,
    } = req.body || {}
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    const upsertPayload = {
      id:    user.id,
      email: user.email,
      name:  name  || '',
      sport: sport || '',
      goal:  goal  || '',
    }
    // Accept either camelCase (frontend) or snake_case variants for these numeric/text fields.
    const resolvedWeight           = weight             ?? null
    const resolvedTargetWeight     = target_weight      ?? targetWeight      ?? null
    const resolvedTrainingFreq     = training_frequency ?? trainingFrequency ?? null
    const resolvedFoodsToAvoid     = foods_to_avoid     ?? foodsToAvoid      ?? null
    if (resolvedWeight           !== null) upsertPayload.weight             = resolvedWeight
    if (resolvedTargetWeight     !== null) upsertPayload.target_weight      = resolvedTargetWeight
    if (resolvedTrainingFreq     !== null) upsertPayload.training_frequency = resolvedTrainingFreq
    if (resolvedFoodsToAvoid     !== null) upsertPayload.foods_to_avoid     = resolvedFoodsToAvoid

    // Only include training_philosophy when the caller passes it (explicit null is fine).
    // Onboarding writes null; the first-session capture writes the user's typed answer.
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'training_philosophy')) {
      upsertPayload.training_philosophy = training_philosophy
    }
    // Only include referred_by when the caller passes a non-empty slug — never overwrite a
    // prior referral attribution back to null on a re-save.
    if (typeof referred_by === 'string' && referred_by.trim()) {
      upsertPayload.referred_by = referred_by.trim()
    }
    // Only set role on new signups (free or pt_referred). Never let the client
    // escalate an existing role to pro/coach/fighter — those are set manually via Supabase.
    if (typeof role === 'string' && ['free', 'pt_referred'].includes(role)) {
      upsertPayload.role = role
    }
    console.log('[auth-user] Upsert payload:', upsertPayload)

    try {
      const upsertRes = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
        method: 'POST',
        headers: {
          'apikey':        serviceRoleKey || supabaseKey,
          'Authorization': `Bearer ${serviceRoleKey || supabaseKey}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(upsertPayload),
      })

      const upsertText = await upsertRes.text()
      console.log('[auth-user] Upsert result:', upsertRes.status, upsertText)

      if (!upsertRes.ok) {
        return res.status(500).json({ error: upsertText || `Supabase upsert failed (${upsertRes.status})` })
      }

      return res.status(200).json({ success: true, dbRowExists: true })
    } catch (err) {
      console.error('[auth-user] POST error:', err)
      return res.status(500).json({ error: err.message })
    }
  }

  // ── GET — read role + profile fields ─────────────────────────────────────────
  if (req.method === 'GET') {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    console.log('AUTH-USER GET — looking up email:', user.email)
    let dbRole = 'free'
    let dbProfile = null
    let dbRowExists = false
    let isPremium = false
    let roleRes
    let rows
    try {
      roleRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(user.email)}&select=role,name,sport,goal,training_philosophy,referral_slug,referred_by,client_count,is_premium`,
        {
          headers: {
            'apikey':        serviceRoleKey || supabaseKey,
            'Authorization': `Bearer ${serviceRoleKey || supabaseKey}`,
          },
        }
      )
      if (!roleRes.ok) {
        const errText = await roleRes.text()
        console.log('AUTH-USER GET — query FAILED:', errText)
      }
      if (roleRes.ok) {
        rows = await roleRes.json()
        if (Array.isArray(rows) && rows.length > 0) {
          const row = rows[0]
          dbRowExists = true
          if (row.role) dbRole = row.role
          isPremium = row.is_premium === true
          // Compute live active client count — only profiles referred by this coach
          // that are NOT coaches themselves (never counts the coach's own account).
          let liveClientCount = row.client_count ?? 0
          if (row.role === 'coach' && row.referral_slug) {
            try {
              const countRes = await fetch(
                `${supabaseUrl}/rest/v1/profiles?referred_by=eq.${encodeURIComponent(row.referral_slug)}&role=neq.coach&select=id`,
                {
                  headers: {
                    'apikey':        serviceRoleKey || supabaseKey,
                    'Authorization': `Bearer ${serviceRoleKey || supabaseKey}`,
                  },
                }
              )
              if (countRes.ok) {
                const countRows = await countRes.json()
                if (Array.isArray(countRows)) liveClientCount = countRows.length
              }
            } catch {}
          }

          if (row.name) dbProfile = {
            name:               row.name,
            sport:              row.sport || null,
            goal:               row.goal || null,
            weight:             row.weight || null,
            trainingPhilosophy: row.training_philosophy ?? null,
            referralSlug:       row.referral_slug ?? null,
            referredBy:         row.referred_by ?? null,
            clientCount:        liveClientCount,
          }
        }
      }
    } catch {
      // Non-fatal — default to free / no profile
    }

    console.log('AUTH-USER GET — profiles query status:', roleRes?.status, 'rows returned:', rows?.length, 'dbRowExists:', dbRowExists)
    return res.status(200).json({ user, role: dbRole, dbProfile, dbRowExists, isPremium })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
