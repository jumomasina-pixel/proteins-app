// Coach reads a specific client's saved recipes.
// GET /api/coach-client?clientId=<uuid>
// Authorization: Bearer <coach access token>
// Returns same shape as saved-recipes.js GET
// Returns 403 if requesting user does not have role === 'coach'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabaseUrl    = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseKey    = process.env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !serviceRoleKey || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase env vars not set' })
  }

  const authHeader = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim()
  if (!authHeader) return res.status(401).json({ error: 'No access token provided' })

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${authHeader}` },
  })
  if (!userRes.ok) return res.status(401).json({ error: 'Invalid or expired token' })
  const { email: userEmail } = await userRes.json()

  const serviceHeaders = {
    'apikey':        serviceRoleKey,
    'Authorization': `Bearer ${serviceRoleKey}`,
    'Content-Type':  'application/json',
  }

  // Verify requesting user has role === 'coach'
  const profileRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(userEmail)}&select=role`,
    { headers: serviceHeaders }
  )
  if (!profileRes.ok) {
    return res.status(500).json({ error: 'Failed to verify coach role' })
  }
  const profileRows = await profileRes.json()
  const coachRole = Array.isArray(profileRows) && profileRows.length > 0 ? profileRows[0].role : null
  if (coachRole !== 'coach') {
    return res.status(403).json({ error: 'Forbidden — coach role required' })
  }

  const { clientId } = req.query
  if (!clientId) return res.status(400).json({ error: 'clientId is required' })

  const r = await fetch(
    `${supabaseUrl}/rest/v1/saved_recipes?user_id=eq.${clientId}&order=saved_at.desc`,
    { headers: serviceHeaders }
  )
  if (!r.ok) {
    const err = await r.text()
    console.error('[coach-client] GET failed:', err)
    return res.status(500).json({ error: 'Failed to fetch client recipes' })
  }
  const rows = await r.json()

  const profileR = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${clientId}&select=name,weight,target_weight,training_frequency,foods_to_avoid,sport,goal,role`,
    { headers: serviceHeaders }
  )
  let clientProfile = null
  if (profileR.ok) {
    const profileRows = await profileR.json()
    if (Array.isArray(profileRows) && profileRows.length > 0) {
      const p = profileRows[0]
      clientProfile = {
        weight:            p.weight            || null,
        targetWeight:      p.target_weight     || null,
        trainingFrequency: p.training_frequency || null,
        foodsToAvoid:      p.foods_to_avoid    || null,
        sport:             p.sport             || null,
        goal:              p.goal              || null,
      }
    }
  }

  return res.status(200).json({
    savedRecipes: rows.map(row => ({
      id:          row.id,
      recipe_data: row.recipe_data,
      saved_at:    row.saved_at,
    })),
    clientProfile,
  })
}
