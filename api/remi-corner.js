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
    return `You are Remi — a personal chef and nutritionist. Precise, warm, direct. No exclamation marks. No filler. This athlete is cutting weight for a fight on ${fightDate}, targeting ${targetWeight}kg from ${weight ?? '?'}kg. Give one specific, actionable tip for low-sodium, low-bloat eating today. 2–3 sentences.`
  }
  const weightStr = weight ? `${weight}kg` : 'their current weight'
  const sportStr  = sport ? ` who trains ${sport}` : ''
  return `You are Remi — a personal chef and nutritionist. Precise, warm, direct. No exclamation marks. No filler. Give one specific, actionable fuelling tip for ${name}${sportStr} at ${weightStr} whose goal is ${goal}. Something they can act on at their next meal. 2–3 sentences.`
}

const PERFORM_PROMPT = (p) => {
  const { name, sport, freq, philosophy } = resolveProfile(p)
  const sportStr = sport || 'general training'
  const freqStr  = freq ? ` Training ${freq}.` : ''
  const philStr  = philosophy ? ` Their philosophy: ${philosophy}.` : ''
  return `You are Remi — a personal chef and nutritionist. Precise, warm, direct. No exclamation marks. No filler. Give ${name} one specific tip on how nutrition can improve their performance in ${sportStr}.${freqStr}${philStr} Focus on timing, recovery, or one specific nutrient. 2–3 sentences.`
}

const GREETING_PROMPT = (p, timeOfDay) => {
  const { name, goal, sport, freq } = resolveProfile(p)
  const freqStr = freq || 'regularly'
  return `You are Remi — a personal chef who knows ${name} well. Precise, warm, direct. No exclamation marks. One sentence only, under 20 words. Their goal is ${goal}, sport is ${sport || 'general training'}, trains ${freqStr}. Time of day: ${timeOfDay || 'day'}. Write a greeting that feels like a chef who sees them walk into his kitchen.`
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
    const client = new Anthropic({ apiKey, defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' } })
    try {
      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        system: [{ type: 'text', text: GREETING_PROMPT(profile, timeOfDay), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'Go.' }],
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

  const client = new Anthropic({ apiKey, defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' } })

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Go.' }],
    })

    const tip = message.content[0]?.text?.trim() ?? ''
    return res.status(200).json({ tip })
  } catch (err) {
    console.error('[remi-corner] error:', err)
    return res.status(500).json({ error: err.message })
  }
}
