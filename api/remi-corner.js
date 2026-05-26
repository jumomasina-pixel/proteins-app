import Anthropic from '@anthropic-ai/sdk'

// Resolve profile fields — handles both v7 (new) and legacy mapped schema
function resolveProfile(p) {
  const name   = p?.name || 'this athlete'
  const weight = p?.weight ?? p?.currentWeight ?? null
  // goals: v7 uses goals[] array; legacy uses goal string
  const goalsArr = Array.isArray(p?.goals) ? p.goals : []
  const goal   = goalsArr[0] || p?.goal || 'maintain'
  const sport  = p?.primarySport || ''
  // trainingFrequency: v7 uses trainingFrequency; legacy uses trainingFreq
  const freq   = p?.trainingFrequency || p?.trainingFreq || ''
  const philosophy = p?.trainingPhilosophy || ''
  const weightCutMode = !!p?.weightCutMode
  const fightDate     = p?.fightDate || ''
  const targetWeight  = p?.fightTargetWeight ?? p?.targetWeight ?? null
  return { name, weight, goal, sport, freq, philosophy, weightCutMode, fightDate, targetWeight }
}

const FUEL_PROMPT = (p) => {
  const { name, weight, goal, sport, weightCutMode, fightDate, targetWeight } = resolveProfile(p)
  if (weightCutMode && fightDate && targetWeight) {
    return `You are a sports dietician. This athlete is in weight cut preparation for a fight/competition on ${fightDate}, targeting ${targetWeight}kg (currently ${weight ?? '?'}kg). Give one specific, actionable tip for low-sodium, low-bloat eating today. Be direct and practical. 2–3 sentences max.`
  }
  const weightStr = weight ? `${weight}kg` : 'their current weight'
  const sportStr  = sport ? ` who does ${sport}` : ''
  return `You are a sports dietician. Give one specific, actionable fuelling tip for ${name}${sportStr} at ${weightStr} who wants to ${goal}. Focus on today — something they can actually do at their next meal. Direct, no fluff. 2–3 sentences.`
}

const PERFORM_PROMPT = (p) => {
  const { name, sport, freq, philosophy } = resolveProfile(p)
  const sportStr = sport || 'general training'
  const freqStr  = freq ? ` (trains ${freq})` : ''
  const philStr  = philosophy ? ` Their philosophy: ${philosophy}.` : ''
  return `You are a performance nutritionist. Give one specific tip on how nutrition can improve performance in ${sportStr} for ${name}${freqStr}.${philStr} Focus on timing, recovery, or a specific nutrient. Direct, actionable, 2–3 sentences. No generic advice.`
}

const GREETING_PROMPT = (p, timeOfDay) => {
  const { name, goal, sport, freq } = resolveProfile(p)
  const freqStr = freq || 'regularly'
  return `Generate one sentence greeting for ${name}. Their goal is ${goal}, primary sport is ${sport || 'general training'}, training frequency is ${freqStr}. Current time of day: ${timeOfDay || 'day'}. The sentence should feel like a coach who knows them well — precise, warm, not performative. No exclamation marks. Under 20 words.`
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })
  }

  const { tab, type, profile, timeOfDay } = req.body

  if (type === 'greeting') {
    const client = new Anthropic({ apiKey })
    try {
      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [{ role: 'user', content: GREETING_PROMPT(profile, timeOfDay) }],
      })
      return res.status(200).json({ tip: message.content[0]?.text?.trim() ?? '' })
    } catch (err) {
      console.error('[remi-corner] greeting error:', err)
      return res.status(500).json({ error: err.message })
    }
  }

  if (!tab) {
    return res.status(400).json({ error: 'tab or type is required' })
  }

  const prompt = tab === 'perform' ? PERFORM_PROMPT(profile) : FUEL_PROMPT(profile)

  const client = new Anthropic({ apiKey })

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    })

    const tip = message.content[0]?.text?.trim() ?? ''
    return res.status(200).json({ tip })
  } catch (err) {
    console.error('[remi-corner] error:', err)
    return res.status(500).json({ error: err.message })
  }
}
