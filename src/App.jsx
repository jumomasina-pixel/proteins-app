import posthog from 'posthog-js'
import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import remiLogoUrl from './assets/remi-logo.svg'
import ClientDetail from './components/ClientDetail'
import MealPlanner from './components/MealPlanner'

posthog.init('phc_oHAKVKsHMe6nw8gxiuZk5p3oFmDUJtN4YePvVpB5Sztv', {
  api_host: 'https://us.i.posthog.com',
  person_profiles: 'identified_only',
})

// ── Storage versioning ────────────────────────────────────────────────────────
// Bump this number whenever the stored data shape changes in a breaking way.
// Any existing storage that doesn't carry a matching version will be wiped and
// the user will restart from the welcome screen as a new user.

const PROFILE_VERSION = 7

const ADMIN_EMAILS = ['jumomasina@gmail.com']

const LS_KEYS = ['remi_profile', 'lhc_profile', 'lhc_sessions', 'lhc_streak', 'lhc_stats']

function loadProfileOrEvict() {
  try {
    const raw = localStorage.getItem('remi_profile') || localStorage.getItem('lhc_profile')
    if (!raw) return null
    const p = JSON.parse(raw)
    if (p?.version !== PROFILE_VERSION) {
      LS_KEYS.forEach(k => localStorage.removeItem(k))
      return null
    }
    return p
  } catch {
    LS_KEYS.forEach(k => localStorage.removeItem(k))
    return null
  }
}

// ── Map new remi_profile shape → old buildProfileSection shape ────────────────
function mapProfileForApi(p) {
  if (!p) return null
  const goalMap = { cut: 'lose', bulk: 'build', maintain: 'maintain', recomp: 'eat_clean', performance: 'energy' }
  const oldGoal = goalMap[p.goal] || 'maintain'
  const days = Number(p.daysPerWeek) || 0
  const freq = days === 0 ? 'rarely' : days <= 2 ? '1-2x' : days <= 4 ? '3-4x' : '5-6x'
  const typeMap = { weights: 'Weights', boxing: 'Boxing & Martial Arts', cardio: 'Cardio', sport: 'Team Sports' }
  const trainingTypes = (p.trainingTypes || p.training || []).filter(t => t !== 'none' && t !== 'None').map(t => typeMap[t] || t)
  const goalAmount = (p.currentWeight && p.targetWeight && p.goal === 'cut')
    ? String(Math.max(0, Number(p.currentWeight) - Number(p.targetWeight)))
    : ''
  return {
    name: p.name || 'there',
    weight: p.currentWeight,
    goal: oldGoal,
    goals: [oldGoal],
    goalAmount,
    trainingFreq: freq,
    trainingTypes: trainingTypes.length ? trainingTypes : ['None'],
    primarySport: p.primarySport || '',
    avoidFoods: p.avoidFoods || p.foodsToAvoid || '',
    kitchenLevel: p.kitchenSkill || 'home cook',
    sportGoal: p.sportGoal || '',
    weightCutMode: !!p.weightCutMode,
    fightDate: p.fightDate || '',
    targetWeight: p.targetWeight || null,
    trainingPhilosophy: p.trainingPhilosophy || null,
  }
}

// ── Parser ────────────────────────────────────────────────────────────────────

// ── Two small helpers used by parseDishChunk ─────────────────────────────────

// Strip residual markdown from any display string
function clean(str) {
  if (!str) return str
  return str
    .replace(/\*\*([^*]*)\*\*/g, '$1')       // **bold** → plain
    .replace(/\*([^*]*)\*/g, '$1')            // *italic* → plain
    .replace(/^#{1,6}\s*/gm, '')              // ## headers
    .replace(/^\s*[-–—]{3,}\s*$/gm, '')       // --- hr lines
    .replace(/\|[-:| ]+\|/g, '')              // |---| table separators
    .replace(/\|/g, '')                       // remaining pipe chars
    .replace(/[ \t]{2,}/g, ' ')               // collapse multiple spaces
    .replace(/\n{3,}/g, '\n\n')               // collapse excess blank lines
    .trim()
}

function grab(text, ...regexps) {
  for (const re of regexps) {
    const m = text.match(re)
    if (m?.[1]?.trim()) return m[1].trim()
  }
  return ''
}

function grabNum(text, ...regexps) {
  for (const re of regexps) {
    const m = text.match(re)
    if (m?.[1]) return m[1].replace(/,/g, '')
  }
  return '—'
}

function parseDishChunk(chunk) {
  // Split the chunk into chef / dietician halves
  const splitIdx = chunk.search(/\n[^\n]*(?:✅|dietician.{0,8}version|✅\s*\[)/im)
  const chefPart = splitIdx > -1 ? chunk.slice(0, splitIdx) : chunk
  const dietPart = splitIdx > -1 ? chunk.slice(splitIdx) : ''
  // If the ✅ marker was missing (splitIdx === -1), search the whole chunk for macros
  // so a partially-streamed or mis-formatted third dish can still surface values.
  const macroArea = dietPart || chunk

  // Dish name — first line containing 🍽️, stripped of emoji and "— Chef Version"
  const nameLine = chunk.split('\n').find(l => l.includes('🍽️')) ?? ''
  const name = nameLine
    .replace(/🍽️\s*/g, '')
    .replace(/^dish\s*\d+\s*[:\-—–]\s*/i, '')
    .replace(/[-—–]+\s*chef\s+version\s*$/i, '')
    .trim() || 'Dish'

  // ── Chef fields ──────────────────────────────────────────────────────────────
  const cuisine    = grab(chefPart, /cuisine\s*style[^:\n]*:\s*([^\n]+)/i)
  const flavour    = grab(chefPart, /flavou?r\s*profile[^:\n]*:\s*([^\n]+)/i)
  const restaurant = grab(chefPart,
    /how\s+it\s+would[^:\n]*:\s*([\s\S]+?)(?=\nest\.|\n\s*\n|$)/i,
    /how\s+it\s+would[^:\n]*:\s*([^\n]+)/i,
  )
  const chefCal = grabNum(chefPart,
    /est[^:\n]*cal[^:\n]*:\s*~?\s*(\d[\d,]*)/i,
    /~\s*(\d[\d,]*)\s*kcal/i,
  )
  const chefStepsRaw = grab(chefPart,
    /chef.{0,5}s?\s*method[^:\n]*:\s*([\s\S]+?)(?=\nest\.|$)/i,
  )
  const chefSteps = chefStepsRaw
    .split('\n')
    .map(l => l.replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean)

  // ── Dietician fields ─────────────────────────────────────────────────────────
  const changesRaw = grab(dietPart,
    /what\s+changes[^:\n]*:\s*([\s\S]+?)(?=\nkey\s+tech|\nmacros|\nquick\s+cook|\ndietician|$)/i,
  )
  const whatChanges = changesRaw
    .split('\n')
    .map(l => l.replace(/^[-•*\d.)\s]+/, '').trim())
    .filter(Boolean)

  const keyTechnique = grab(dietPart,
    /key\s+technique[^:\n]*:\s*([\s\S]+?)(?=\nmacros|\nquick\s+cook|\ndietician|$)/i,
    /key\s+technique[^:\n]*:\s*([^\n]+)/i,
  )

  // Macros: search macroArea (dietPart when available, whole chunk as fallback)
  const calories = grabNum(macroArea,
    /calories\s*:\s*~?\s*(\d[\d,]*)/i,          // Calories: ~450
    /\|\s*~?\s*(\d[\d,]*)\s*kcal/i,             // | ~450 kcal  (table)
    /(\d[\d,]*)\s*kcal\b/i,                     // 450 kcal (bare)
  )
  const protein = grabNum(macroArea,
    /protein\s*:\s*~?\s*(\d[\d,]*)/i,           // Protein: ~45g
    /\|\s*~?\s*(\d[\d,]*)g[^a-z]/i,            // | ~45g  (first number with g, table)
    /(\d[\d,]*)g?\s+protein/i,                  // 45g protein (reversed)
  )
  const carbs = grabNum(macroArea,
    /carbs?\s*:\s*~?\s*(\d[\d,]*)/i,            // Carbs: ~30g
    /carbohydrate\s*:\s*~?\s*(\d[\d,]*)/i,      // Carbohydrate: ~30
    /(\d[\d,]*)g?\s+carbs?/i,                   // 30g carbs (reversed)
  )
  const fat = grabNum(macroArea,
    /\bfat\s*:\s*~?\s*(\d[\d,]*)/i,             // Fat: ~12g
    /(\d[\d,]*)g?\s+fat\b/i,                    // 12g fat (reversed)
  )
  const cookTime   = grabNum(macroArea, /cook\s*time\s*:\s*~?\s*(\d+)/i)
  const difficulty = grab(macroArea,    /difficulty\s*:\s*(Easy|Medium|Pro)/i)

  const stepsRaw = grab(dietPart,
    /quick\s+cook\s+steps[^:\n]*:\s*([\s\S]+?)(?=\ndietician|$)/i,
  )
  const cookSteps = stepsRaw
    .split('\n')
    .map(l => l.replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean)

  const note = grab(dietPart, /dietician.{0,5}s?\s*note[^:\n]*:\s*([^\n]+)/i)

  // Apply sanitisation to every displayed string field
  return {
    name:      clean(name),
    chef: {
      cuisine:    clean(cuisine),
      flavour:    clean(flavour),
      restaurant: clean(restaurant),
      calories:   chefCal,
      steps:      chefSteps.map(clean),
    },
    dietician: {
      whatChanges: whatChanges.map(clean),
      keyTechnique: clean(keyTechnique),
      macros: { calories, protein, carbs, fat },
      cookTime,
      difficulty,
      cookSteps: cookSteps.map(clean),
      note: clean(note),
    },
  }
}

function parseDishes(rawText) {
  // Strip markdown so patterns match regardless of bold/italic/heading formatting
  const text = rawText
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')

  // Split on 🍽️ boundaries — each chunk is one dish
  const chunks = text
    .split(/(?=🍽️)/g)
    .filter(c => c.includes('🍽️'))

  if (chunks.length === 0) return []
  const parsed = chunks.map(parseDishChunk).filter(d => d.name)

  // Log raw response whenever a dish has no macro data at all
  const brokenDishes = parsed.filter(d => {
    const m = d.dietician.macros
    return m.calories === '—' && m.protein === '—' && m.carbs === '—' && m.fat === '—'
  })
  if (brokenDishes.length > 0) {
    console.error(`[parser] ${brokenDishes.length} dish(es) with all-missing macros. Raw response:\n`, rawText)
  }

  // Omit dishes where every macro failed — never show "—" to the user
  return parsed.filter(d => {
    const m = d.dietician.macros
    return !(m.calories === '—' && m.protein === '—' && m.carbs === '—' && m.fat === '—')
  })
}

// Classifier — true iff this line looks like a real grocery-list ingredient,
// not a section header, macro readout, metadata line, version label, dish title,
// or a sentence from method prose. Used to scrub the AI's raw output of garbage
// before it reaches the user as a shopping list.
function isLikelyIngredient(line) {
  if (!line || typeof line !== 'string') return false
  const s = line.trim()
  if (s.length < 2 || s.length > 100) return false
  if (!/[a-z]/i.test(s)) return false
  if (/^nothing\b/i.test(s)) return false

  // Reject section headers / labels (with or without trailing colon/em-dash)
  if (/^(macros?|cuisine\s*style|cuisine|flavou?r\s*profile|flavou?r|how\s+it\s+would|chef'?s?\s+method|method|key\s+technique|quick\s+cook\s+steps|dietician'?s?\s+note|difficulty|cook\s*time|what\s+changes|missing\s+ingredients|shopping\s+list|chef\s+version|dietician\s+version|what\s+you(?:'|'|')?ll\s+need|what\s+you\s+need|ingredients?\s*needed|ingredients?|est\.?\s*calories|est\.?\s*cal)\b\s*[:—–-]?/i.test(s)) return false

  // Reject macro / nutrition readouts
  if (/\b(calories|protein|carbs?|carbohydrates?|fat|kcal)\s*[:~]/i.test(s)) return false
  if (/^~?\d[\d,.]*\s*(kcal|cal)\b/i.test(s)) return false
  if (/^~?\d[\d,.]*g\s*(protein|carbs?|fat)?\s*$/i.test(s)) return false
  if (/^(easy|medium|pro)\s*$/i.test(s)) return false
  if (/^~?\d[\d.,\s]*\s*(mins?|minutes?)\s*$/i.test(s)) return false

  // Reject dish-title / version markers
  if (/🍽️|✅|⚠️/.test(s)) return false
  if (/[—–-]\s*(chef|dietician)\s+version/i.test(s)) return false

  // Reject lines that look like sentences (method prose) — multiple sentence terminators
  if (/[.!?]\s+[A-Z].*[.!?]/.test(s)) return false

  return true
}

// Dedup a list of ingredient strings, case- and whitespace-insensitive,
// preserving the first occurrence (which usually has the best quantity prefix).
function dedupeIngredients(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = item.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

// Extract the combined "what you need" shopping list from the raw AI output.
// The system prompt emits ONE consolidated MISSING INGREDIENTS section on the
// third dish, between Difficulty and Quick cook steps. We pull ONLY that
// section, stop hard at the next known header, then per-line filter through
// isLikelyIngredient and dedup. If no clean section is found, return an empty
// list — better silence than garbage. (The old fallback that grabbed everything
// after "what changes" was the source of macros/headers leaking into the list.)
function parseMissingIngredients(rawText) {
  if (!rawText || typeof rawText !== 'string') return []
  const text = rawText
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')

  const sectionMatch = text.match(
    /(?:MISSING\s+INGREDIENTS|WHAT\s+YOU(?:'|'|')\s*LL\s+NEED|YOU(?:'|'|')\s*LL\s+NEED|SHOPPING\s+LIST)\s*:?\s*\n([\s\S]+?)(?=\n\s*(?:Quick\s+cook\s+steps|Chef'?s?\s+method|Macros|Key\s+technique|What\s+changes|Dietician'?s?\s+note|Difficulty|Cook\s*time|Cuisine|Flavou?r|How\s+it\s+would|Est\.?\s*calories|🍽️|✅|⚠️|MISSING\s+INGREDIENTS)|\n{2,}|$)/i
  )
  if (!sectionMatch) return []

  const items = sectionMatch[1]
    .split('\n')
    .map(l => l.replace(/^[\s>]*[-•*]\s*|^\s*\d+[.)]\s*/, '').trim())
    .filter(isLikelyIngredient)

  return dedupeIngredients(items)
}

// Heuristic per-dish filter — given the combined shopping list and a single
// dish, return only the ingredients whose key noun appears in this dish's
// method/note/key-technique text. Crude but functional: the AI doesn't emit
// per-dish ingredient arrays in the structured response, so this is the best
// honest split until the macro format block evolves to carry them.
const INGREDIENT_STOP_WORDS = new Set([
  'the','and','for','tbsp','tsp','cup','cups','gram','grams','kg','oz','lb','ml',
  'litre','liter','small','medium','large','fresh','dried','ground','sliced',
  'chopped','minced','optional','with','to','of','or','a','an','tin','can',
  'bunch','clove','cloves','piece','pieces','pinch','dash','about',
])
function ingredientsForDish(allIngredients, dish) {
  if (!Array.isArray(allIngredients) || allIngredients.length === 0) return []
  const haystack = [
    ...(dish?.dietician?.cookSteps   || []),
    ...(dish?.dietician?.whatChanges || []),
    dish?.dietician?.note         || '',
    dish?.dietician?.keyTechnique || '',
    dish?.chef?.restaurant        || '',
    dish?.chef?.flavour           || '',
    dish?.name                    || '',
  ].join(' ').toLowerCase()
  return allIngredients.filter(ing => {
    const words = ing.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
      .filter(w => w.length >= 3 && !INGREDIENT_STOP_WORDS.has(w))
    if (words.length === 0) return false
    return words.some(w => haystack.includes(w))
  })
}

// ── Seed conversation ─────────────────────────────────────────────────────────

// First-session philosophy question. Asked exactly once — only when the profile has a name
// but no trainingPhilosophy yet. After capture, subsequent sessions skip this entirely.
const PHILOSOPHY_OPENER = "Before we get into it — how do you train? Not the gym, the philosophy. Are you building something, maintaining it, or cutting?"

function createSeedMessages(profile, sessions) {
  // Philosophy capture takes precedence over both new-user and returning-user openers.
  // A user we know (has a name) but who hasn't told us their philosophy yet hits this once.
  const needsPhilosophy = profile?.name && (profile.trainingPhilosophy == null)
  if (needsPhilosophy) {
    return [
      { id: 'seed-u', role: 'user',      content: 'I want meal ideas', seed: true },
      { id: 'seed-a', role: 'assistant', content: PHILOSOPHY_OPENER, seed: true, philosophyAsk: true },
    ]
  }

  const isReturning = profile?.name && sessions?.length > 0
  let assistantContent

  if (isReturning) {
    const last = sessions[0]
    const proteins = last?.proteins?.length > 0 ? last.proteins.join(', ') : null
    const dishes = last?.dishes?.length > 0
      ? (typeof last.dishes[0] === 'object' ? last.dishes[0].name : last.dishes[0])
      : null
    if (proteins) {
      assistantContent = `Back again, ${profile.name}. Last time you worked with ${proteins}${dishes ? ` — made ${dishes}` : ''}. What are we building tonight?`
    } else {
      assistantContent = `Back again, ${profile.name}. Good timing — what are we building?`
    }
  } else {
    assistantContent = "Right. Let's see what we're working with. Open your fridge — what proteins have you got? Anything in the freezer counts."
  }

  return [
    { id: 'seed-u', role: 'user',      content: 'I want meal ideas', seed: true },
    { id: 'seed-a', role: 'assistant', content: assistantContent, seed: true },
  ]
}

const SEED = createSeedMessages(null, [])

// ── Helpers ───────────────────────────────────────────────────────────────────

function calorieSavings(dish) {
  const chef = parseInt(dish.chef.calories?.replace(',', '') || '0')
  const diet = parseInt(dish.dietician.macros.calories?.replace(',', '') || '0')
  if (!chef || !diet || chef <= diet) return null
  return chef - diet
}

function formatRecipe(dish) {
  const { chef, dietician } = dish
  const lines = [
    dish.name.toUpperCase(),
    '─'.repeat(40),
    '',
    '🍽️  CHEF VERSION',
    chef.cuisine    && `Cuisine: ${chef.cuisine}`,
    chef.flavour    && `Flavour: ${chef.flavour}`,
    chef.restaurant && chef.restaurant,
    chef.calories   && `Est. calories: ~${chef.calories} kcal`,
    '',
    '✅  DIETICIAN VERSION',
    `Calories: ${dietician.macros.calories} kcal  |  Protein: ${dietician.macros.protein}g  |  Carbs: ${dietician.macros.carbs}g  |  Fat: ${dietician.macros.fat}g`,
    '',
    dietician.whatChanges.length > 0 && 'What changes:',
    ...dietician.whatChanges.map(c => `  • ${c}`),
    '',
    dietician.keyTechnique && `Key technique:\n  ${dietician.keyTechnique}`,
    '',
    dietician.cookSteps.length > 0 && 'Quick cook steps:',
    ...dietician.cookSteps.map((s, i) => `  ${i + 1}. ${s}`),
    '',
    dietician.note && `💡 ${dietician.note}`,
  ]
  return lines.filter(l => l !== false && l !== null && l !== undefined).join('\n')
}

// ── Tier helper — single source of truth for all role-based feature gates ────
// Call getUserTier(user) anywhere you need to gate a feature. Never compare
// role strings directly outside this function.
function getUserTier(user) {
  const role = user?.role || 'free'
  return {
    role,
    isFree:       role === 'free',
    isPtReferred: role === 'pt_referred',
    isDirect:     role === 'direct',
    isPro:        role === 'pro' || role === 'fighter' || role === 'coach' || role === 'admin',
    isCoach:      role === 'coach',
    isFighter:    role === 'fighter',
    // Feature gates
    canUsePlanner:  ['pro', 'fighter', 'coach', 'admin'].includes(role),
    canUseIntel:    ['pro', 'fighter', 'coach', 'admin'].includes(role),
    unlimitedSaves: ['direct', 'pro', 'fighter', 'coach', 'admin'].includes(role),
    savesCap:       role === 'pt_referred' ? 20 : role === 'free' ? 5 : null,
  }
}

// Detect what quick-reply type to show next based on AI message text
function detectQuickReplyType(text) {
  const lower = text.toLowerCase()
  if (/any particular (cuisine|style)|what (cuisine|style|kind)|go for a style|something specific in mind|prefer.*cuisine|cuisine.*prefer/.test(lower)) return 'cuisine'
  if (/how (much time|long do)|time (constraint|available|have you got)|how long.*cook|under \d+ min/.test(lower)) return 'time'
  return null
}

// ── Paper texture overlay ─────────────────────────────────────────────────────

function PaperTexture() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0"
      style={{
        zIndex: 999,
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`,
        backgroundSize: '300px 300px',
        opacity: 0.045,
        mixBlendMode: 'multiply',
      }}
    />
  )
}

// ── Remi logo mark ────────────────────────────────────────────────────────────

function RemiLogo({ size = 32 }) {
  return (
    <img src="/remi-logo.svg" alt="Remi" style={{ height: size, width: 'auto', display: 'block' }} />
  )
}

// ── Remi onboarding constants ─────────────────────────────────────────────────

const REMI_GOAL_OPTIONS = [
  { value: 'cut',         label: 'Cut',         desc: 'lose fat' },
  { value: 'bulk',        label: 'Bulk',        desc: 'build muscle' },
  { value: 'maintain',    label: 'Maintain',    desc: '' },
  { value: 'recomp',      label: 'Recomp',      desc: '' },
  { value: 'performance', label: 'Performance', desc: '' },
]

const REMI_TRAINING_TYPES_V5 = [
  'Boxing', 'Muay Thai', 'BJJ / Grappling', 'MMA', 'Wrestling',
  'Weightlifting', 'Powerlifting', 'CrossFit', 'HIIT', 'Running',
  'Cycling', 'Swimming', 'Rowing', 'Pilates', 'Yoga',
  'Football / AFL', 'Basketball', 'Tennis', 'Golf', 'Other',
]

const COMBAT_SPORTS = ['Boxing', 'Muay Thai', 'BJJ / Grappling', 'MMA', 'Wrestling']

const SPORT_GOAL_OPTIONS = [
  "I have a fight / competition coming up",
  "I'm training for an event (race, tournament, game)",
  "I want to hit a performance milestone",
  "Just building the habit",
  "No specific goal right now",
]

const TRAINING_PHILOSOPHY_MAP = {
  'Boxing': {
    q: "Which school of boxing do you most identify with?",
    opts: ['Soviet / Eastern European system', 'Cuban system', 'Mexican style', 'American freestyle', 'Philly Shell / Defence-first', 'I just follow what works'],
  },
  'Muay Thai': {
    q: "What's your Muay Thai influence?",
    opts: ['Traditional Thai style', 'Dutch kickboxing hybrid', 'K-1 / sport Muay Thai', 'Pure Saenchai-style movement', "I'm still figuring it out"],
  },
  'BJJ / Grappling': {
    q: "What's your grappling philosophy?",
    opts: ['Gracie / self-defence roots', 'Sport BJJ / competition', 'Leg lock / modern meta', 'Wrestling-heavy base', 'I just want to survive on the mat'],
  },
  'MMA': {
    q: "Who shapes your MMA approach?",
    opts: ['Strikers who wrestle (GSP / Wonderboy style)', 'Grapplers who strike (Khabib / Usman style)', 'Pure pressure / volume', 'Counterpunching / movement', 'Still building my base'],
  },
  'Running': {
    q: "What kind of runner are you?",
    opts: ['Endurance / ultra distance', 'Road racing (5K–marathon)', 'Trail running', 'Speed / track work', 'Just building the base'],
  },
  'Swimming': {
    q: "What's your swimming focus?",
    opts: ['Open water / distance', 'Pool competition', 'Squad / club training', 'Fitness / cross-training', 'Just getting laps in'],
  },
  'CrossFit': {
    q: "What's your CrossFit motivation?",
    opts: ['Competition / Regionals', 'General fitness', 'Olympic lifting focus', 'Endurance WODs', 'Community and consistency'],
  },
  'Weightlifting': {
    q: "What's your lifting philosophy?",
    opts: ['Conjugate / Westside method', '5/3/1 or linear progression', 'Olympic / snatch and clean', 'Hypertrophy / bodybuilding hybrid', 'Intuitive / auto-regulation'],
  },
  'Powerlifting': {
    q: "What's your lifting philosophy?",
    opts: ['Conjugate / Westside method', '5/3/1 or linear progression', 'Olympic / snatch and clean', 'Hypertrophy / bodybuilding hybrid', 'Intuitive / auto-regulation'],
  },
  'Pilates': {
    q: "What draws you to Pilates?",
    opts: ['Injury rehabilitation', 'Strength and control', 'Flexibility and mobility', 'Complementing another sport', 'Mind-body connection'],
  },
  'Football / AFL': {
    q: "What's your football focus?",
    opts: ['Explosive power and speed', 'Endurance and engine', 'Skill and game sense', 'Strength and contested work', 'Team fitness / social footy'],
  },
  'Basketball': {
    q: "What's your basketball focus?",
    opts: ['Explosiveness and vertical', 'Conditioning and endurance', 'Skill development', 'Strength and physicality', 'Pickup / recreational'],
  },
  'Tennis': {
    q: "What's your tennis approach?",
    opts: ['Baseline power', 'Serve and volley', 'Consistency and defence', 'Athletic conditioning', 'Social / recreational'],
  },
}

const INGREDIENT_SUGGESTIONS = [
  'Chicken breast', 'Chicken thigh', 'Salmon', 'Tuna', 'Beef mince', 'Steak', 'Pork loin', 'Lamb',
  'Eggs', 'Tofu', 'Tempeh', 'Chickpeas', 'Lentils', 'Black beans', 'Kidney beans', 'Shrimp / Prawns',
  'Cod', 'Sardines', 'Turkey', 'Bacon', 'Ham', 'Greek yoghurt', 'Cottage cheese', 'Cheddar',
  'Mozzarella', 'Feta', 'Milk', 'Butter', 'Cream', 'Rice', 'Pasta', 'Quinoa', 'Oats', 'Bread',
  'Tortillas', 'Potato', 'Sweet potato', 'Noodles', 'Couscous', 'Garlic', 'Onion', 'Tomato',
  'Capsicum', 'Spinach', 'Broccoli', 'Zucchini', 'Mushroom', 'Carrot', 'Corn', 'Avocado',
  'Cucumber', 'Kale', 'Cabbage', 'Bok choy', 'Asparagus', 'Green beans', 'Peas', 'Celery',
  'Leek', 'Pumpkin', 'Eggplant', 'Olive oil', 'Coconut oil', 'Soy sauce', 'Fish sauce',
  'Oyster sauce', 'Hoisin sauce', 'Hot sauce', 'Sriracha', 'Tomato paste', 'Diced tomatoes',
  'Coconut milk', 'Stock / Broth', 'Lemon', 'Lime', 'Chilli', 'Ginger', 'Cumin', 'Paprika',
  'Turmeric', 'Oregano', 'Basil', 'Coriander', 'Parsley', 'Honey', 'Maple syrup',
  'Dijon mustard', 'Mayonnaise', 'Peanut butter', 'Almonds', 'Cashews', 'Walnuts',
]

function classifyIngredient(name) {
  const l = name.toLowerCase()
  if (/chicken|beef|fish|egg|tofu|salmon|tuna|lamb|pork|turkey|prawn|shrimp|mince|steak|brisket|duck/.test(l)) return 'protein'
  if (/rice|pasta|bread|potato|sweet potato|oat|noodle|quinoa|flour|tortilla|couscous|barley/.test(l)) return 'carb'
  if (/olive oil|butter|nut|avocado|cheese|cream|coconut|oil|ghee|tahini/.test(l)) return 'fat'
  return 'veg'
}

const CLASSIFY_COLORS = {
  protein: { border: '#00E5A0', text: '#00C080' },
  carb:    { border: '#C9A84C', text: '#C9A84C' },
  fat:     { border: '#888888', text: '#888888' },
  veg:     { border: '#00C080', text: '#00C080' },
}

// ── Legacy onboarding option constants (kept for Dashboard compatibility) ─────

const GOAL_OPTIONS = [
  { value: 'lose',      label: 'Lose fat',                    emoji: '🔥' },
  { value: 'build',     label: 'Build muscle',                emoji: '💪' },
  { value: 'maintain',  label: 'Maintain weight',             emoji: '⚖️' },
  { value: 'eat_clean', label: 'Eat cleaner',                 emoji: '🥗' },
  { value: 'energy',    label: 'Improve energy & performance', emoji: '⚡' },
  { value: 'fitness',   label: 'Improve fitness & endurance', emoji: '🏃' },
  { value: 'sleep',     label: 'Better sleep & recovery',     emoji: '😴' },
  { value: 'stress',    label: 'Reduce stress eating',        emoji: '🧠' },
]
const FREQ_OPTIONS = [
  { value: 'rarely', label: 'Rarely or never' },
  { value: '1-2x',   label: '1–2x a week'    },
  { value: '3-4x',   label: '3–4x a week'    },
  { value: '5-6x',   label: '5–6x a week'    },
]
const TRAINING_TYPES = [
  { value: 'Weights',            label: 'Weights',            emoji: '🏋️' },
  { value: 'Cardio',             label: 'Cardio',             emoji: '🫀' },
  { value: 'Boxing & Martial Arts', label: 'Boxing & Martial Arts', emoji: '🥊' },
  { value: 'Running',            label: 'Running',            emoji: '🏃' },
  { value: 'Cycling',            label: 'Cycling',            emoji: '🚴' },
  { value: 'Swimming',           label: 'Swimming',           emoji: '🏊' },
  { value: 'HIIT & Circuit',     label: 'HIIT & Circuit',     emoji: '💥' },
  { value: 'Yoga & Pilates',     label: 'Yoga & Pilates',     emoji: '🧘' },
  { value: 'Team Sports',        label: 'Team Sports',        emoji: '⚽' },
  { value: 'Hiking & Outdoors',  label: 'Hiking & Outdoors',  emoji: '🥾' },
  { value: 'CrossFit',           label: 'CrossFit',           emoji: '🔥' },
  { value: 'Dance & Aerobics',   label: 'Dance & Aerobics',   emoji: '💃' },
  { value: 'None',               label: 'None',               emoji: '🛋️' },
]
// ── Quick-reply card data ─────────────────────────────────────────────────────

const PROTEIN_CARDS = [
  { value: 'chicken',  label: 'Chicken'  },
  { value: 'beef',     label: 'Beef'     },
  { value: 'salmon',   label: 'Salmon'   },
  { value: 'eggs',     label: 'Eggs'     },
  { value: 'pork',     label: 'Pork'     },
  { value: 'tofu',     label: 'Tofu'     },
  { value: 'lamb',     label: 'Lamb'     },
  { value: 'prawns',   label: 'Prawns'   },
  { value: 'tuna',     label: 'Tuna'     },
  { value: 'turkey',   label: 'Turkey'   },
]

const CUISINE_CARDS = [
  { value: 'Mexican',           label: 'Mexican'           },
  { value: 'Asian',             label: 'Asian'             },
  { value: 'Italian',           label: 'Italian'           },
  { value: 'Indian',            label: 'Indian'            },
  { value: 'Modern Australian', label: 'Modern Australian' },
  { value: 'French',            label: 'French'            },
  { value: 'American',          label: 'American'          },
  { value: 'Middle Eastern',    label: 'Middle Eastern'    },
  { value: 'Japanese',          label: 'Japanese'          },
  { value: 'Thai',              label: 'Thai'              },
  { value: 'No preference',     label: 'No preference'     },
]

const TIME_CARDS = [
  { value: 'under 20 mins',             label: 'Under 20 mins'           },
  { value: '20–40 mins',                label: '20–40 mins'              },
  { value: '40–60 mins',                label: '40–60 mins'              },
  { value: 'all the time in the world', label: 'All the time in the world' },
]

const PANTRY_CARDS = [
  { value: 'garlic',          label: 'Garlic'          },
  { value: 'onion',           label: 'Onion'           },
  { value: 'rice',            label: 'Rice'            },
  { value: 'pasta',           label: 'Pasta'           },
  { value: 'tinned tomatoes', label: 'Tinned tomatoes' },
  { value: 'spinach',         label: 'Spinach'         },
  { value: 'broccoli',        label: 'Broccoli'        },
  { value: 'capsicum',        label: 'Capsicum'        },
  { value: 'zucchini',        label: 'Zucchini'        },
  { value: 'sweet potato',    label: 'Sweet potato'    },
  { value: 'lemon',           label: 'Lemon'           },
  { value: 'soy sauce',       label: 'Soy sauce'       },
  { value: 'chilli',          label: 'Chilli'          },
]

// ── Loading screen facts ──────────────────────────────────────────────────────

const LOADING_FACTS = [
  "Lamb mince has ~25g of protein per 100g — one of the most bioavailable sources going.",
  "Garlic activates within 10 minutes of being chopped — let it sit before cooking to maximise benefits.",
  "Eating protein first in a meal blunts the blood sugar spike from carbs.",
  "Cauliflower rice cuts ~150 calories vs white rice with almost identical volume.",
  "Your body builds muscle during rest, not during training — the kitchen matters as much as the gym.",
  "Greek yoghurt has more protein per gram than most protein bars.",
  "Cooking with olive oil below 180°C preserves most of its polyphenols.",
  "A high-protein breakfast reduces total daily calorie intake by an average of 400 kcal.",
  "Capsicum has more Vitamin C than oranges — gram for gram.",
  "The 30g protein per meal rule is outdated — your body can use significantly more in one sitting.",
]

// ── Health insights data ──────────────────────────────────────────────────────

const HEALTH_INSIGHTS = [
  {
    tag: 'PROTEIN TIMING',
    headline: 'Hit 20–40g within 30 min post-workout',
    body: 'Muscle protein synthesis spikes in the hour after training. Get protein in while the window is open.',
  },
  {
    tag: 'SLEEP & HORMONES',
    headline: 'Poor sleep raises hunger hormones by ~15%',
    body: 'Ghrelin goes up, leptin drops. Under 7 hours and your body actively fights the deficit.',
  },
  {
    tag: 'COOKING SCIENCE',
    headline: 'High heat gives you what fat used to.',
    body: 'The Maillard reaction creates hundreds of flavour compounds. High heat first replaces what you save in calories.',
  },
  {
    tag: 'FAT LOSS',
    headline: '~500 kcal deficit = ~0.5 kg/week',
    body: 'Sustainable rate. Faster than 1 kg/week and you start losing muscle alongside fat.',
  },
  {
    tag: 'PERFORMANCE',
    headline: 'Don\'t go below 100g carbs on training days',
    body: 'Glycogen is your fuel for high-intensity work. Drop too low and you\'re running on fumes.',
  },
  {
    tag: 'MUSCLE BUILDING',
    headline: 'Leucine is the key MPS trigger',
    body: 'You need ~2–3g of leucine per meal to switch on muscle protein synthesis. Eggs, fish, and dairy hit this easily.',
  },
  {
    tag: 'CALORIE BURN',
    headline: 'NEAT burns 200–400 kcal/day',
    body: 'Non-exercise activity thermogenesis — walking, fidgeting, standing — adds up fast. Stay moving outside the gym.',
  },
  {
    tag: 'HYDRATION',
    headline: '2–3L/day supports fat oxidation',
    body: 'Even mild dehydration blunts metabolism. Drink before you\'re thirsty.',
  },
  {
    tag: 'METABOLISM',
    headline: 'Chilli temporarily boosts burn by ~5%',
    body: 'Capsaicin creates thermogenic effect for 30–60 min post-meal. Small edge, but free calories.',
  },
  {
    tag: 'STRESS & CORTISOL',
    headline: 'Chronic stress shifts fat storage to your abdomen',
    body: 'Cortisol redirects fat to visceral stores. Managing stress is as important as the food.',
  },
  {
    tag: 'RECOVERY',
    headline: 'Omega-3s reduce training inflammation',
    body: 'Salmon, sardines, and walnuts reduce DOMS and support joint health. 2–3 serves of fatty fish a week is enough.',
  },
  {
    tag: 'MEAL TIMING',
    headline: 'Eat most carbs around your training window',
    body: 'Pre-workout carbs fuel performance. Post-workout carbs replenish glycogen. Keep dinner lighter on carbs.',
  },
  {
    tag: 'GUT HEALTH',
    headline: '25–30g fibre/day keeps you full longer',
    body: 'Fibre slows gastric emptying, stabilises blood sugar, and feeds gut bacteria. Vegetables, legumes, oats.',
  },
  {
    tag: 'CAFFEINE',
    headline: 'Up to 6mg/kg improves performance',
    body: 'Pre-workout caffeine is one of the few evidence-backed ergogenic aids. Time it 45–60 min before training.',
  },
  {
    tag: 'BODY COMPOSITION',
    headline: 'Scale weight is a lagging indicator',
    body: 'You can lose fat and gain muscle simultaneously at similar rates — especially if you\'re new to training. Trust the mirror and the energy levels.',
  },
]

// ── Insight card component ─────────────────────────────────────────────────────

function InsightCard({ insight, compact = false }) {
  if (compact) {
    return (
      <div
        className="shrink-0 rounded-xl px-3.5 py-3 space-y-1"
        style={{
          backgroundColor: '#1A1A1A',
          border: '1px solid rgba(255,255,255,0.08)',
          width: 220,
        }}
      >
        <span
          className="text-[11px] font-medium uppercase tracking-[0.12em]"
          style={{ color: '#00E5A0' }}
        >
          {insight.tag}
        </span>
        <p className="text-[12px] font-semibold leading-snug" style={{ color: '#F0F0F0' }}>
          {insight.headline}
        </p>
      </div>
    )
  }
  return (
    <div
      className="rounded-2xl px-5 py-4 space-y-2"
      style={{
        backgroundColor: '#1A1A1A',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 1px 6px rgba(0,0,0,0.3)',
      }}
    >
      <span
        className="text-[11px] font-medium uppercase tracking-[0.12em]"
        style={{ color: '#00E5A0' }}
      >
        {insight.tag}
      </span>
      <p className="text-sm font-semibold leading-snug" style={{ color: '#F0F0F0' }}>
        {insight.headline}
      </p>
      <p className="text-xs leading-relaxed" style={{ color: '#888888' }}>
        {insight.body}
      </p>
    </div>
  )
}

// ── Insights sidebar (desktop) + strip (mobile) ───────────────────────────────

function useInsights() {
  const dayIndex = Math.floor(Date.now() / 86400000)
  return [0,1,2,3].map(i => HEALTH_INSIGHTS[(dayIndex + i) % HEALTH_INSIGHTS.length])
}

function InsightsDesktopSidebar() {
  const visible = useInsights()
  return (
    <aside
      className="hidden lg:flex flex-col gap-3 w-[280px] shrink-0 overflow-y-auto py-6 pr-4 pl-2"
      style={{ maxHeight: '100dvh' }}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] mb-1" style={{ color: '#888888' }}>
        Today's Insights
      </p>
      {visible.map((ins, i) => (
        <InsightCard key={i} insight={ins} />
      ))}
    </aside>
  )
}

// ── Mobile bottom nav ─────────────────────────────────────────────────────────

function CrownBadge() {
  return (
    <svg viewBox="0 0 18 14" width="13" height="10" fill="#C9A84C" style={{ display: 'block' }}>
      <path d="M9 0L11.5 5L18 3.5L15 10H3L0 3.5L6.5 5L9 0Z"/>
      <rect x="3" y="11" width="12" height="2.5" rx="1"/>
    </svg>
  )
}

function BottomNav({ activeView, onNavigate, isPro = false }) {
  const NAV_ITEMS = [
    {
      id: 'chat',
      label: 'Cook',
      icon: (active) => (
        <svg viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={active ? 0 : 1.8} className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 18a3.75 3.75 0 00.495-7.467 5.99 5.99 0 00-1.925 3.546 5.974 5.974 0 01-2.133-1A3.75 3.75 0 0012 18z" />
        </svg>
      ),
    },
    {
      id: 'dashboard',
      label: 'Stats',
      icon: (active) => (
        <svg viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={active ? 0 : 1.8} className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
        </svg>
      ),
    },
    {
      id: 'intel',
      label: 'Intel',
      icon: (active) => (
        <svg viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={active ? 0 : 1.8} className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
        </svg>
      ),
    },
    {
      id: 'saved',
      label: 'Saved',
      icon: (active) => (
        <svg viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={active ? 0 : 1.8} className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z" />
        </svg>
      ),
    },
    {
      id: 'onboarding',
      label: 'Profile',
      icon: (active) => (
        <svg viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={active ? 0 : 1.8} className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
        </svg>
      ),
    },
  ]

  return (
    <nav
      className="lg:hidden fixed bottom-0 inset-x-0 z-50 flex"
      style={{
        backgroundColor: '#0D0D0D',
        borderTop: '1px solid rgba(240, 234, 224, 0.08)',
        paddingBottom: 'env(safe-area-inset-bottom, 0)',
      }}
    >
      {NAV_ITEMS.map(item => {
        const active = activeView === item.id ||
          (item.id === 'chat' && (activeView === 'cards' || activeView === 'chat'))
        return (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px] transition-colors duration-200"
            style={{ color: active ? '#00E5A0' : '#888888' }}
            aria-label={item.label}
          >
            <div style={{ position: 'relative', display: 'inline-flex' }}>
              {item.icon(active)}
              {item.id === 'intel' && !isPro && (
                <span style={{ position: 'absolute', top: -5, right: -7, lineHeight: 1 }}>
                  <CrownBadge />
                </span>
              )}
            </div>
            <span style={{ fontFamily: "Inter, sans-serif", fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

// ── Macro stat row ────────────────────────────────────────────────────────────

const MACROS = [
  { key: 'calories', label: 'Calories', unit: 'kcal' },
  { key: 'protein',  label: 'Protein',  unit: 'g'    },
  { key: 'carbs',    label: 'Carbs',    unit: 'g'    },
  { key: 'fat',      label: 'Fat',      unit: 'g'    },
]

function MacroRow({ macros }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {MACROS.map(({ key, label, unit }) => (
        <div key={key} className="flex flex-col items-center rounded-xl px-2 py-3"
          style={{ backgroundColor: 'rgba(0,229,160,0.07)', border: '1px solid rgba(0,229,160,0.18)' }}>
          <span className="text-lg sm:text-xl font-bold leading-none tabular-nums" style={{ color: '#00E5A0' }}>{macros[key]}</span>
          <span className="text-[9px] mt-0.5 uppercase tracking-wide" style={{ color: '#00C080' }}>{unit}</span>
          <span className="text-[11px] mt-0.5" style={{ color: '#888888' }}>{label}</span>
        </div>
      ))}
    </div>
  )
}

// ── Global chat animation styles ─────────────────────────────────────────────

const CHAT_STYLES = `
  @keyframes mintPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: 0.25; transform: scale(0.55); }
  }
  .mint-dot { animation: mintPulse 1.2s ease-in-out infinite; }
  .mint-dot:nth-child(2) { animation-delay: 0.18s; }
  .mint-dot:nth-child(3) { animation-delay: 0.36s; }

  /* Handoff card reveal — a plated moment, not a list item. */
  @keyframes handoffRise {
    0%   { opacity: 0; transform: translateY(8px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  @keyframes handoffGlow {
    0%   { opacity: 0; }
    35%  { opacity: 1; }
    100% { opacity: 0; }
  }
  .handoff-card { animation: handoffRise 300ms ease-out both; }
  .handoff-glow {
    position: absolute;
    inset: -24px;
    border-radius: 24px;
    background: radial-gradient(ellipse at center, rgba(0,229,160,0.10) 0%, rgba(0,229,160,0.06) 35%, transparent 70%);
    pointer-events: none;
    z-index: 0;
    animation: handoffGlow 1400ms ease-out both;
  }

  @keyframes presencePulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.4; }
  }
  .presence-dot-pulse { animation: presencePulse 2.5s ease-in-out infinite; }
`

// ── Skeleton card (warm palette) ──────────────────────────────────────────────

const SHIMMER = '#2A2A2A'

function SkeletonCard() {
  return (
    <div
      className="rounded-2xl p-5 sm:p-6 space-y-4 animate-pulse"
      style={{
        backgroundColor: '#1A1A1A',
        borderTop: '4px solid #00E5A0',
        boxShadow: '0 2px 12px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.2)',
      }}
    >
      <div className="h-5 w-20 rounded-full" style={{ backgroundColor: SHIMMER }} />
      <div className="space-y-2.5">
        <div className="h-6 w-4/5 rounded-lg" style={{ backgroundColor: SHIMMER }} />
        <div className="h-4 w-3/5 rounded-lg" style={{ backgroundColor: SHIMMER, opacity: 0.7 }} />
      </div>
      <div className="h-9 w-20 rounded-lg" style={{ backgroundColor: SHIMMER }} />
      <div className="h-5 w-40 rounded-full" style={{ backgroundColor: SHIMMER, opacity: 0.7 }} />
      <div className="h-4 w-24 rounded-full" style={{ backgroundColor: SHIMMER, opacity: 0.6 }} />
    </div>
  )
}

// ── Chat bubbles ──────────────────────────────────────────────────────────────

// Strip markdown italics/bold runs that occasionally leak through from the model.
function stripChatMarkdown(s) {
  if (typeof s !== 'string') return s
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
}

function ChatBubble({ role, content, isStreaming, isOpening }) {
  const isUser = role === 'user'
  const text = stripChatMarkdown(content)

  if (isUser) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div
          style={{
            maxWidth: '85%',
            whiteSpace: 'pre-wrap',
            backgroundColor: '#1A1A1A',
            color: '#F0F0F0',
            borderRadius: '10px 4px 10px 10px',
            fontFamily: 'Inter, sans-serif',
            fontStyle: 'normal',
            fontWeight: 400,
            fontSize: 15,
            lineHeight: 1.6,
            padding: '12px 16px',
          }}
        >
          {text}
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      {isOpening && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: '50%', left: '12%',
            transform: 'translate(-50%, -50%)',
            width: 320, height: 200,
            borderRadius: '50%',
            background: 'radial-gradient(ellipse, rgba(0,229,160,0.06) 0%, transparent 70%)',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      )}
      <div style={{ display: 'inline-block', maxWidth: '85%', position: 'relative', zIndex: 1 }}>
        <div
          style={{
            whiteSpace: 'pre-wrap',
            backgroundColor: '#1A1A1A',
            borderRadius: '10px 4px 10px 10px',
            padding: '16px 18px',
            fontFamily: 'Inter, sans-serif',
            fontStyle: 'normal',
            fontWeight: 400,
            fontSize: 15,
            color: '#F0F0F0',
            lineHeight: 1.65,
          }}
        >
          {text}
          {isStreaming && (
            <span
              className="animate-pulse"
              style={{ display: 'inline-block', width: 6, height: 14, marginLeft: 2, backgroundColor: '#888888', opacity: 0.5, verticalAlign: 'text-bottom', borderRadius: 2 }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// Cooking state — three mint dots + in-character line + plating sub-line. No spinner.
function CookingState() {
  return (
    <div style={{ display: 'inline-block', maxWidth: '85%' }}>
      <div
        style={{
          backgroundColor: '#1A1A1A',
          borderRadius: '10px 4px 10px 10px',
          padding: '16px 18px',
          fontFamily: 'Inter, sans-serif',
          color: '#F0F0F0',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          {[0, 1, 2].map(i => (
            <span
              key={i}
              className="mint-dot"
              style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: '#00E5A0', display: 'inline-block' }}
            />
          ))}
          <span style={{ marginLeft: 4, fontFamily: 'Inter, sans-serif', fontSize: 15, fontStyle: 'normal', color: '#F0F0F0' }}>
            Tasting it through.
          </span>
        </div>
        <p style={{ margin: 0, fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          Remi is plating · about 6 seconds
        </p>
      </div>
    </div>
  )
}

// A "real method" guardrail. A token method ≤ a few short phrases is a generation failure —
// re-request rather than rendering a method-less recipe. Threshold:
//   • at least 5 numbered steps (allows for genuinely simple dishes),
//   • AND total step text ≥ 300 chars (rejects 5×"do X" stubs),
//   • AND average step ≥ 40 chars (rejects "Sear. Flip. Rest. Plate. Eat.").
function isCompleteMethod(dish) {
  const steps = dish?.dietician?.cookSteps
  if (!Array.isArray(steps) || steps.length < 5) return false
  const cleaned = steps.map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
  if (cleaned.length < 5) return false
  const total = cleaned.reduce((sum, s) => sum + s.length, 0)
  if (total < 300) return false
  if (total / cleaned.length < 40) return false
  return true
}

// Lead-in line in Remi's voice presenting the plated dishes.
function handoffLeadIn(dishes) {
  if (dishes.length === 1) return `Here. ${dishes[0].name}.`
  if (dishes.length === 2) return 'Plated. Two ways to go — open one.'
  return 'Plated. Three ways to go — open one.'
}

// In-chat recipe handoff card — teaser only. Lands as a designed moment, not a list item.
// The WHOLE card is a tap target. Routes to the existing DetailView page where the full
// numbered method lives. Chat hands off — it never contains the full recipe.
function HandoffCard({ dish, onOpen, delay = 0 }) {
  const m = dish?.dietician?.macros || {}
  const cuisine = dish?.chef?.cuisine
  const hook    = dish?.dietician?.note || dish?.chef?.flavour || ''
  // Cache the resolved Unsplash URL so DetailView can use the same image without re-fetching.
  function handleImageResolved(url, credit) {
    dish._imgUrl    = url
    dish._imgCredit = credit
  }
  function open() { onOpen(dish) }
  function onKeyDown(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }
  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: 420 }}>
      <div className="handoff-glow" aria-hidden style={{ animationDelay: `${delay}ms` }} />
      <div
        className="handoff-card"
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={onKeyDown}
        style={{
          position: 'relative',
          zIndex: 1,
          backgroundColor: '#1A1A1A',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 10,
          overflow: 'hidden',
          cursor: 'pointer',
          touchAction: 'manipulation',
          animationDelay: `${delay}ms`,
        }}
        aria-label={`Open the recipe — ${dish.name}`}
      >
        <div style={{ width: '100%', height: 90, overflow: 'hidden', borderRadius: '8px 8px 0 0' }}>
          <CardImageHeader
            dishName={dish.name}
            cuisine={cuisine}
            initialUrl={dish._imgUrl ?? null}
            onImageResolved={handleImageResolved}
          />
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 18, color: '#F0F0F0', margin: 0, lineHeight: 1.2 }}>
            {dish.name}
          </h3>
          {hook && (
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', margin: 0, lineHeight: 1.5 }}>
              {hook}
            </p>
          )}
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: '#00E5A0' }}>
            {m.calories} kcal&nbsp;&nbsp;·&nbsp;&nbsp;{m.protein}g protein&nbsp;&nbsp;·&nbsp;&nbsp;{m.carbs}g carbs&nbsp;&nbsp;·&nbsp;&nbsp;{m.fat}g fat
          </div>
          <div
            style={{
              marginTop: 6,
              width: '100%', height: 44,
              backgroundColor: '#00E5A0',
              color: '#0D0D0D',
              borderRadius: 8,
              fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            Open the recipe →
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Quick-reply cards ─────────────────────────────────────────────────────────

function QuickReplyRow({ type, onSubmit, onDismiss, onFocusInput }) {
  const [selected, setSelected] = useState([])

  const chipStyle = (sel) => ({
    backgroundColor: sel ? '#00E5A0' : '#1A1A1A',
    border:          `1px solid ${sel ? '#00E5A0' : 'rgba(255,255,255,0.08)'}`,
    color:           sel ? '#0D0D0D' : '#F0F0F0',
    borderRadius:    8,
    fontSize:        14,
    fontFamily:      'Inter, sans-serif',
    fontWeight:      sel ? 600 : 500,
    padding:         '10px 18px',
    minHeight:       44,
    display:         'flex',
    alignItems:      'center',
    whiteSpace:      'nowrap',
    transition:      'background 200ms ease, border-color 200ms ease',
    cursor:          'pointer',
    touchAction:     'manipulation',
  })

  const labelStyle = { fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: 0 }

  function handleSomethingElse() {
    onDismiss()
    onFocusInput?.()
  }

  const somethingElseBtn = (
    <button
      onClick={handleSomethingElse}
      className="shrink-0 transition-colors duration-200"
      style={{ color: '#888888', backgroundColor: 'transparent', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, cursor: 'pointer', padding: '10px 4px' }}
    >
      Something else →
    </button>
  )

  if (type === 'proteins') {
    const [pantrySelected, setPantrySelected] = useState([])
    const [expanded,       setExpanded]       = useState(true)

    function toggleProtein(val) {
      setSelected(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])
    }
    function togglePantry(val) {
      setPantrySelected(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])
    }

    function buildList(items) {
      if (items.length === 0) return ''
      if (items.length === 1) return items[0]
      return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]
    }

    function handleSubmit() {
      if (selected.length === 0) return
      const proteinText = `I've got ${buildList(selected)}`
      const pantryText  = pantrySelected.length > 0
        ? `. In the pantry I've also got ${buildList(pantrySelected)}.`
        : '.'
      onSubmit(proteinText + pantryText, selected, pantrySelected)
    }

    const totalSelected = selected.length + pantrySelected.length

    return (
      <div data-tray="fridge" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* FRIDGE header + collapse/expand toggle */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ ...labelStyle }}>
            FRIDGE · {totalSelected} SELECTED
          </span>
          <button
            onClick={() => setExpanded(e => !e)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#888888', fontFamily: 'Inter, sans-serif', fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 500 }}
            aria-expanded={expanded}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </div>

        {expanded && (
          <div style={{ maxHeight: 180, overflowY: 'auto' }}>
            <p style={labelStyle}>Proteins</p>
            <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
              {PROTEIN_CARDS.map(card => (
                <button
                  key={card.value}
                  onClick={() => toggleProtein(card.value)}
                  className="shrink-0"
                  style={chipStyle(selected.includes(card.value))}
                >
                  {card.label}
                </button>
              ))}
            </div>

            <p style={labelStyle}>Also have</p>
            <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
              {PANTRY_CARDS.map(card => (
                <button
                  key={card.value}
                  onClick={() => togglePantry(card.value)}
                  className="shrink-0"
                  style={chipStyle(pantrySelected.includes(card.value))}
                >
                  {card.label}
                </button>
              ))}
            </div>

            <div className="flex gap-2 items-center">
              {selected.length > 0 && (
                <button
                  onClick={handleSubmit}
                  className="flex-1 transition-opacity active:opacity-80"
                  style={{ backgroundColor: '#00E5A0', color: '#0D0D0D', border: 'none', borderRadius: 8, height: 44, fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 14, cursor: 'pointer', touchAction: 'manipulation' }}
                >
                  {totalSelected > selected.length
                    ? `Use ${selected.length} protein${selected.length > 1 ? 's' : ''} + ${pantrySelected.length} extra →`
                    : `Use ${selected.length > 1 ? `these ${selected.length} proteins` : 'this protein'} →`
                  }
                </button>
              )}
              {somethingElseBtn}
            </div>
          </div>
        )}
      </div>
    )
  }

  if (type === 'cuisine') {
    return (
      <div className="space-y-2.5">
        <p style={labelStyle}>Pick a style</p>
        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
          {CUISINE_CARDS.map(card => (
            <button
              key={card.value}
              onClick={() => onSubmit(card.value, [card.value])}
              className="shrink-0 active:opacity-80"
              style={chipStyle(false)}
            >
              {card.label}
            </button>
          ))}
        </div>
        {somethingElseBtn}
      </div>
    )
  }

  if (type === 'time') {
    return (
      <div className="space-y-2.5">
        <p style={labelStyle}>How long have you got?</p>
        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
          {TIME_CARDS.map(card => (
            <button
              key={card.value}
              onClick={() => onSubmit(card.value, [card.value])}
              className="shrink-0 active:opacity-80"
              style={chipStyle(false)}
            >
              {card.label}
            </button>
          ))}
        </div>
        {somethingElseBtn}
      </div>
    )
  }

  return null
}

// ── Compact dish card ─────────────────────────────────────────────────────────

function CardImageHeader({ dishName, cuisine, onImageResolved, initialUrl, initialCredit = null }) {
  const [imgUrl,      setImgUrl]      = useState(initialUrl ?? null)
  const [imgLoaded,   setImgLoaded]   = useState(!!initialUrl)
  const [photographer, setPhotographer] = useState(initialCredit)

  useEffect(() => {
    if (initialUrl) return
    let cancelled = false
    const params = new URLSearchParams({ query: dishName })
    if (cuisine) params.set('cuisine', cuisine)
    fetch(`/api/unsplash?${params}`)
      .then(r => r.json())
      .then(d => {
        if (!cancelled && d.url) {
          setImgUrl(d.url)
          setPhotographer(d.credit?.name ?? null)
          onImageResolved?.(d.url, d.credit?.name ?? null)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [dishName])

  return (
    <div style={{ width: '100%' }}>
      <div
        style={{
          width: '100%',
          aspectRatio: '16/9',
          borderRadius: '12px 12px 0 0',
          overflow: 'hidden',
          backgroundColor: '#2A2A2A',
          position: 'relative',
        }}
      >
        {imgUrl && (
          <img
            src={imgUrl}
            alt={dishName}
            onLoad={() => setImgLoaded(true)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: imgLoaded ? 1 : 0,
              transition: 'opacity 700ms ease',
              display: 'block',
            }}
          />
        )}
      </div>
    </div>
  )
}

function DishCard({ dish, onClick, onImageResolved }) {
  const m = dish.dietician.macros
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="w-full overflow-hidden text-left"
      style={{
        backgroundColor: '#1A1A1A',
        borderRadius: 12,
        border: '0.5px solid rgba(240,234,224,0.08)',
        boxShadow: hovered ? '0 0 0 1px rgba(0,229,160,0.15)' : '0 2px 12px rgba(0,0,0,0.3)',
        transition: 'box-shadow 200ms ease',
      }}
    >
      <CardImageHeader dishName={dish.name} cuisine={dish.chef.cuisine} onImageResolved={onImageResolved} />

      <div className="space-y-3" style={{ backgroundColor: '#1A1A1A', borderRadius: '0 0 12px 12px', padding: 16 }}>
        {/* Cuisine badge */}
        {dish.chef.cuisine && (
          <span style={{ fontFamily: "Inter, sans-serif", fontSize: 10, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', display: 'block' }}>
            {dish.chef.cuisine}
          </span>
        )}

        {/* Dish name */}
        <h3 style={{ fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: 18, color: '#F0F0F0', lineHeight: 1.2, margin: 0 }}>
          {dish.name}
        </h3>

        {/* Macro strip */}
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: '#00E5A0' }}>
          {m.calories} kcal&nbsp;&nbsp;·&nbsp;&nbsp;{m.protein}g protein&nbsp;&nbsp;·&nbsp;&nbsp;{m.carbs}g carbs&nbsp;&nbsp;·&nbsp;&nbsp;{m.fat}g fat
        </div>

        {/* Cook time + difficulty */}
        {(dish.dietician.cookTime !== '—' || dish.dietician.difficulty) && (
          <div className="flex gap-2 flex-wrap">
            {dish.dietician.cookTime !== '—' && (
              <span className="text-xs px-2.5 py-1 rounded-full" style={{ color: '#888888', backgroundColor: 'rgba(240,234,224,0.05)', border: '1px solid rgba(240,234,224,0.08)' }}>
                {dish.dietician.cookTime} mins
              </span>
            )}
            {dish.dietician.difficulty && (
              <span className="text-xs px-2.5 py-1 rounded-full" style={{ color: '#888888', backgroundColor: 'rgba(240,234,224,0.05)', border: '1px solid rgba(240,234,224,0.08)' }}>
                {dish.dietician.difficulty}
              </span>
            )}
          </div>
        )}

        <div className="pt-1 text-sm font-medium flex items-center gap-1.5" style={{ color: '#888888', fontFamily: "Inter, sans-serif" }}>
          View recipe <span>→</span>
        </div>
      </div>
    </button>
  )
}

// ── Share card modal ──────────────────────────────────────────────────────────

function ShareCardModal({ dish, imgUrl, onClose }) {
  const m = dish.dietician.macros
  const macros = [
    { label: 'KCAL', value: m.calories },
    { label: 'PRO',  value: `${m.protein}g` },
    { label: 'CARB', value: `${m.carbs}g` },
    { label: 'FAT',  value: `${m.fat}g` },
  ]

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-end sm:items-center justify-center px-4 pb-4 sm:pb-0"
      style={{ backgroundColor: 'rgba(0,0,0,0.88)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-full max-w-sm animate-fade-in"
        style={{ borderRadius: 24, overflow: 'hidden', backgroundColor: '#111', border: '1px solid rgba(255,255,255,0.08)' }}
      >
        {/* Card preview */}
        <div className="relative w-full" style={{ height: 260 }}>
          {imgUrl
            ? <img src={imgUrl} alt={dish.name} className="w-full h-full object-cover" />
            : <div className="w-full h-full" style={{ backgroundColor: '#00E5A0' }} />
          }
          {/* Branding chip */}
          <div
            className="absolute top-4 left-4 flex items-center gap-1.5 px-3 py-1.5 rounded-full"
            style={{ backgroundColor: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.12)' }}
          >
            <RemiLogo size={14} />
            <span style={{ fontFamily: "Inter, sans-serif", fontSize: 10, color: '#F0F0F0', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Remi
            </span>
          </div>
        </div>

        {/* Dish name row — below image */}
        <div style={{ padding: '14px 20px 0' }}>
          {dish.chef.cuisine && (
            <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#888888', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>
              {dish.chef.cuisine}
            </p>
          )}
          <h2 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '1.375rem', color: '#F0F0F0', lineHeight: 1.2 }}>
            {dish.name}
          </h2>
        </div>

        {/* Macro strip */}
        <div className="grid grid-cols-4" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          {macros.map(({ label, value }, i) => (
            <div
              key={label}
              className="flex flex-col items-center py-4 gap-0.5"
              style={{ borderRight: i < 3 ? '1px solid rgba(255,255,255,0.08)' : 'none' }}
            >
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 15, fontWeight: 700, color: '#00E5A0' }}>
                {value}
              </span>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 9, color: '#888', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                {label}
              </span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 space-y-2.5" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <button
            disabled
            className="w-full py-3.5 rounded-xl text-sm font-semibold"
            style={{ backgroundColor: '#1A1A1A', color: '#444', border: '1px solid rgba(255,255,255,0.08)', cursor: 'not-allowed' }}
          >
            Export card — coming next session
          </button>
          <button
            onClick={onClose}
            className="w-full py-3 rounded-xl text-sm font-medium"
            style={{ backgroundColor: 'transparent', color: '#888' }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Detail view ───────────────────────────────────────────────────────────────

const BACK_ARROW = (
  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
  </svg>
)

function BookmarkIcon({ filled }) {
  return filled
    ? <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6.75 2.25A.75.75 0 016 3v18a.75.75 0 001.28.53L12 17.31l4.72 4.22A.75.75 0 0018 21V3a.75.75 0 00-.75-.75H6.75z"/></svg>
    : <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M17.25 3H6.75A.75.75 0 006 3.75v16.5a.75.75 0 001.28.53L12 16.81l4.72 4.22A.75.75 0 0018 20.25V3.75A.75.75 0 0017.25 3z"/></svg>
}

function CookStepsList({ steps, accentColor }) {
  const [hovered, setHovered] = useState(null)
  return (
    <ol className="space-y-3">
      {steps.map((step, i) => (
        <li
          key={i}
          className="flex gap-4 text-sm leading-relaxed rounded-xl px-4 py-3.5 transition-all duration-200"
          style={{
            backgroundColor: '#1A1A1A',
            border: '1px solid rgba(255,255,255,0.08)',
            borderLeft: hovered === i ? `4px solid ${accentColor}` : `1px solid rgba(255,255,255,0.08)`,
            color: '#F0F0F0',
            cursor: 'default',
          }}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered(null)}
        >
          <span className="shrink-0 w-6 h-6 rounded-full text-xs flex items-center justify-center font-bold mt-0.5"
            style={{ backgroundColor: accentColor, color: '#0D0D0D' }}>
            {i + 1}
          </span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  )
}

function DetailView({ dish, onBack, imgUrl, photographer = null, isSaved, onSave, onRemove, onNavigateDashboard, missingIngredients = [], onAddToDayPlan = null }) {
  const [mode,            setMode]            = useState('diet')
  const [copied,          setCopied]          = useState(false)
  const [toast,           setToast]           = useState({ visible: false, message: '', action: null })
  const [checkedItems,    setCheckedItems]    = useState(new Set())
  const [listCopied,      setListCopied]      = useState(false)
  const [showShareModal,  setShowShareModal]  = useState(false)
  const [resolvedImg,     setResolvedImg]     = useState(imgUrl || dish._imgUrl || null)
  const { chef, dietician } = dish

  // If the page opened without an image (e.g. routed straight from a chat handoff before the
  // thumbnail finished resolving), fetch the hero from /api/unsplash so the page never opens
  // on a flat mint bar. Uses the SAME source the dish cards already use.
  useEffect(() => {
    if (resolvedImg) return
    let cancelled = false
    const params = new URLSearchParams({ query: dish.name })
    if (chef?.cuisine) params.set('cuisine', chef.cuisine)
    fetch(`/api/unsplash?${params}`)
      .then(r => r.json())
      .then(d => { if (!cancelled && d.url) setResolvedImg(d.url) })
      .catch(() => {})
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const heroImg = resolvedImg

  function showToast(message, action = null) {
    setToast({ visible: true, message, action })
    setTimeout(() => setToast(t => ({ ...t, visible: false })), action ? 3500 : 2000)
  }

  function handleCopy() {
    navigator.clipboard.writeText(formatRecipe(dish)).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    })
  }

  function handleBookmark() {
    if (isSaved) {
      onRemove()
      showToast('✕ Removed from My Recipes')
    } else {
      onSave()
      showToast('✓ Saved — view in Dashboard', onNavigateDashboard)
    }
  }

  function toggleCheckedItem(i) {
    setCheckedItems(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  function handleCopyShoppingList() {
    const unchecked = missingIngredients.filter((_, i) => !checkedItems.has(i))
    if (unchecked.length === 0) return
    navigator.clipboard.writeText(unchecked.join('\n')).then(() => {
      setListCopied(true)
      setTimeout(() => setListCopied(false), 2000)
    })
  }

  const isChef = mode === 'chef'
  const chefAccent = '#C9A84C'

  return (
    <div className="animate-fade-in min-h-screen pb-44 sm:pb-28" style={{ backgroundColor: '#0D0D0D' }}>
      <style>{`@keyframes microLineFadeIn{from{opacity:0}to{opacity:1}}`}</style>
      <PaperTexture />

      {/* Dashboard back nav */}
      {onNavigateDashboard && (
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', position: 'relative', zIndex: 20 }}>
          <button
            onClick={onNavigateDashboard}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 400, color: '#888888' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Dashboard
          </button>
        </div>
      )}

      {/* Toast — tappable when action exists */}
      <div
        className="fixed bottom-44 sm:bottom-32 left-1/2 z-[1000] transition-all duration-300"
        style={{
          transform: `translateX(-50%) translateY(${toast.visible ? 0 : 8}px)`,
          opacity: toast.visible ? 1 : 0,
          pointerEvents: toast.visible && toast.action ? 'auto' : 'none',
        }}
      >
        <button
          onClick={toast.action ?? undefined}
          className="px-5 py-2.5 rounded-xl text-sm font-semibold shadow-lg flex items-center gap-1.5 whitespace-nowrap"
          style={{ backgroundColor: '#1A1A1A', color: '#F0F0F0', border: '1px solid rgba(255,255,255,0.08)', cursor: toast.action ? 'pointer' : 'default' }}
        >
          {toast.message}
          {toast.action && <span className="opacity-60 text-xs">→</span>}
        </button>
      </div>

      {/* ── Hero image — own row, full width, text never on top ── */}
      {heroImg ? (
        <>
          <div className="relative w-full overflow-hidden" style={{ height: '260px', maxHeight: '260px' }}>
            <img src={heroImg} alt={dish.name} className="w-full h-full object-cover" style={{ maxHeight: '260px', objectFit: 'cover' }} />
            <button
              onClick={onBack}
              style={{
                position: 'absolute', top: 16, left: 16, zIndex: 10,
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'rgba(13,13,13,0.75)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 20,
                padding: '8px 16px',
                color: '#F0F0F0',
                fontFamily: 'Inter, sans-serif',
                fontWeight: 500,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00E5A0" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Back to dishes
            </button>
          </div>
        </>
      ) : (
        <div className="relative w-full overflow-hidden" style={{ height: '55vh', backgroundColor: '#1A1A1A' }}>
          <button
            onClick={onBack}
            style={{
              position: 'absolute', top: 16, left: 16, zIndex: 10,
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'rgba(13,13,13,0.75)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 20,
              padding: '8px 16px',
              color: '#F0F0F0',
              fontFamily: 'Inter, sans-serif',
              fontWeight: 500,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00E5A0" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back to dishes
          </button>
        </div>
      )}

      {/* ── Content ── */}
      <div className="max-w-2xl mx-auto px-4 pt-6 space-y-8 relative">

        <div>
          {chef.cuisine && (
            <p className="text-xs font-medium uppercase tracking-widest mb-2" style={{ color: '#888888' }}>{chef.cuisine}</p>
          )}
          <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(1.875rem, 6vw, 2.5rem)', color: '#F0F0F0', lineHeight: 1.15 }}>{dish.name}</h1>
        </div>

        {/* ── Mode toggle + Share ── */}
        <div className="flex gap-2.5 items-center">
          <div className="flex gap-2 flex-1">
            <button
              onClick={() => setMode('diet')}
              className="flex-1 py-2.5 px-3 rounded-xl text-sm font-semibold transition-all duration-200"
              style={mode === 'diet'
                ? { backgroundColor: '#00E5A0', color: '#0D0D0D', boxShadow: '0 2px 10px rgba(0,229,160,0.35)' }
                : { backgroundColor: '#1A1A1A', color: '#888888', border: '1px solid rgba(255,255,255,0.08)' }
              }
            >
              Performance Mode
            </button>
            <button
              onClick={() => setMode('chef')}
              className="flex-1 py-2.5 px-3 rounded-xl text-sm font-semibold transition-all duration-200"
              style={mode === 'chef'
                ? { backgroundColor: '#E55A5A', color: '#fff', boxShadow: '0 2px 10px rgba(229,90,90,0.35)' }
                : { backgroundColor: '#1A1A1A', color: '#888888', border: '1px solid rgba(255,255,255,0.08)' }
              }
            >
              Cheat Day
            </button>
          </div>
          <button
            onClick={() => setShowShareModal(true)}
            className="shrink-0 flex items-center justify-center rounded-xl transition-all duration-200 active:scale-95"
            style={{ width: 44, height: 44, backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', color: '#888888' }}
            aria-label="Share recipe"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
          </button>
        </div>
        <p key={mode} style={{ color: '#888888', fontSize: 14, fontFamily: 'Inter, sans-serif', fontStyle: 'normal', margin: 0, animation: 'microLineFadeIn 200ms ease-out both' }}>
          {isChef ? "Earned. Here's the version you want tonight." : "This is the one that counts."}
        </p>

        {/* ── CHEF MODE ── */}
        {isChef && (
          <section className="space-y-6 pl-5 border-l-4" style={{ borderColor: chefAccent }}>
            <div className="flex flex-wrap gap-2">
              {chef.cuisine && (
                <span className="text-xs px-3 py-1 rounded-full border font-medium"
                  style={{ backgroundColor: '#252525', color: chefAccent, borderColor: `${chefAccent}40` }}>
                  {chef.cuisine}
                </span>
              )}
              {chef.flavour && (
                <span className="text-xs px-3 py-1 rounded-full border font-medium"
                  style={{ backgroundColor: '#252525', color: chefAccent, borderColor: `${chefAccent}40` }}>
                  {chef.flavour}
                </span>
              )}
            </div>

            {chef.restaurant && <p className="text-sm leading-relaxed" style={{ color: '#CCCCCC' }}>{chef.restaurant}</p>}

            {chef.calories && (
              <div className="inline-flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-full"
                style={{ backgroundColor: '#252525', borderColor: `${chefAccent}40`, color: '#888888' }}>
                <span className="font-bold" style={{ color: chefAccent }}>~{chef.calories}</span>
                <span>kcal · full version</span>
              </div>
            )}

            {chef.steps?.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: '#888888' }}>
                  Method
                </h3>
                <CookStepsList steps={chef.steps} accentColor={chefAccent} />
              </div>
            )}
          </section>
        )}

        {/* ── DIETICIAN MODE ── */}
        {!isChef && (
          <section className="space-y-6 pl-5 border-l-4" style={{ borderColor: '#00E5A0' }}>
            <MacroRow macros={dietician.macros} />

            {dietician.whatChanges.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#888888' }}>What changes</h3>
                <ul className="space-y-2">
                  {dietician.whatChanges.map((item, i) => (
                    <li key={i} className="flex gap-2.5 text-sm leading-snug" style={{ color: '#CCCCCC' }}>
                      <span className="font-bold shrink-0 mt-px" style={{ color: '#00E5A0' }}>✓</span>{item}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {dietician.keyTechnique && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#888888' }}>Key technique</h3>
                <p className="text-sm leading-relaxed" style={{ color: '#CCCCCC' }}>{dietician.keyTechnique}</p>
              </div>
            )}

            {dietician.cookSteps.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#888888' }}>Method</h3>
                  {dietician.cookTime && dietician.cookTime !== '—' && (
                    <span className="text-xs font-medium" style={{ color: '#888888' }}>
                      Total: ~{dietician.cookTime} mins
                    </span>
                  )}
                </div>
                <CookStepsList steps={dietician.cookSteps} accentColor="#00E5A0" />
              </div>
            )}

            {dietician.note && (
              <div className="rounded-xl px-5 py-4" style={{ backgroundColor: 'rgba(0,229,160,0.06)', border: '1px solid rgba(0,229,160,0.18)' }}>
                <p className="text-sm leading-relaxed" style={{ color: '#00C080' }}>{dietician.note}</p>
              </div>
            )}
          </section>
        )}

        {/* ── WHAT YOU'LL NEED ── */}
        {missingIngredients.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#888888' }}>
              What You'll Need
            </h3>
            <div
              className="rounded-xl p-5 space-y-4"
              style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 1px 6px rgba(0,0,0,0.3)' }}
            >
              <ul className="space-y-2.5">
                {missingIngredients.map((item, i) => {
                  const checked = checkedItems.has(i)
                  return (
                    <li
                      key={i}
                      className="flex items-center gap-3 text-sm leading-snug cursor-pointer select-none"
                      style={{
                        opacity: checked ? 0.4 : 1,
                        transition: 'opacity 200ms ease',
                      }}
                      onClick={() => toggleCheckedItem(i)}
                    >
                      {/* Checkbox */}
                      <span
                        className="shrink-0 flex items-center justify-center"
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: 4,
                          border: '2px solid #00E5A0',
                          backgroundColor: checked ? '#00E5A0' : 'transparent',
                          transition: 'background-color 200ms ease',
                        }}
                      >
                        {checked && (
                          <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
                            <path d="M1 4.5L4 7.5L10 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </span>
                      {/* Label */}
                      <span
                        style={{
                          color: '#F0F0F0',
                          textDecoration: checked ? 'line-through' : 'none',
                          transition: 'text-decoration 200ms ease',
                        }}
                      >
                        {item}
                      </span>
                    </li>
                  )
                })}
              </ul>

              {/* Copy Shopping List button */}
              {(() => {
                const allChecked = missingIngredients.every((_, i) => checkedItems.has(i))
                return (
                  <button
                    onClick={handleCopyShoppingList}
                    disabled={allChecked}
                    className="w-full py-3 rounded-xl font-semibold text-sm text-white transition-all duration-200 active:opacity-80"
                    style={{
                      backgroundColor: listCopied ? '#009966' : allChecked ? '#3A3A3A' : '#00B87A',
                      boxShadow: (listCopied || allChecked) ? 'none' : '0 2px 8px rgba(0,184,122,0.3)',
                      cursor: allChecked ? 'default' : 'pointer',
                      color: allChecked ? '#888888' : '#0D0D0D',
                    }}
                  >
                    {listCopied ? '✓ Copied' : allChecked ? '✓ All picked up' : 'Copy List'}
                  </button>
                )
              })()}
            </div>
          </div>
        )}
      </div>

      {/* ── Share card modal ── */}
      {showShareModal && (
        <ShareCardModal dish={dish} imgUrl={imgUrl} onClose={() => setShowShareModal(false)} />
      )}

      {/* ── Action bar ── */}
      <div className="fixed bottom-0 inset-x-0 z-50 bg-[rgba(13,13,13,0.97)] border-t border-[rgba(255,255,255,0.08)] backdrop-blur-sm sm:static sm:inset-auto sm:bg-transparent sm:border-0 sm:backdrop-blur-none sm:max-w-2xl sm:mx-auto sm:mt-8 sm:px-4">
        {/* Divider (mobile only — desktop uses mt-8 spacing above) */}
        <div className="sm:hidden h-px mx-4 mt-0" style={{ backgroundColor: '#2A2A2A' }} />
        <div className="p-4 space-y-2.5">
          {/* Save button */}
          <button
            onClick={handleBookmark}
            className="w-full flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-xl font-semibold text-sm text-white transition-all duration-200 active:opacity-80"
            style={{
              backgroundColor: isSaved ? '#009966' : '#00B87A',
              boxShadow: isSaved ? 'none' : '0 2px 8px rgba(0,229,160,0.35)',
              color: '#0D0D0D',
            }}
          >
            {isSaved ? (
              <>
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6.75 2.25A.75.75 0 016 3v18a.75.75 0 001.28.53L12 17.31l4.72 4.22A.75.75 0 0018 21V3a.75.75 0 00-.75-.75H6.75z"/>
                </svg>
                ✓ Saved
              </>
            ) : (
              <>Save This</>
            )}
          </button>

          {/* Add to Day Plan */}
          {onAddToDayPlan && (
            <button
              onClick={() => onAddToDayPlan(dish)}
              className="w-full flex items-center justify-center transition-all duration-200 active:opacity-80"
              style={{ height: 56, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#1A1A1A', color: '#F0F0F0', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15, cursor: 'pointer' }}
            >
              Add to Day Plan →
            </button>
          )}

          {/* Copy button */}
          <button
            onClick={handleCopy}
            className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-sm transition-all duration-200 active:opacity-80"
            style={{
              backgroundColor: copied ? '#00E5A0' : 'transparent',
              color: copied ? '#0D0D0D' : '#888888',
              border: copied ? 'none' : '1.5px solid rgba(255,255,255,0.08)',
            }}
          >
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Splash screen ─────────────────────────────────────────────────────────────

const SPLASH_STYLES = `
  @keyframes splash-fade {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .splash-el   { animation: splash-fade 400ms ease-out both; }
  .splash-el-0 { animation-delay: 0ms; }
  .splash-el-1 { animation-delay: 150ms; }
  .splash-el-2 { animation-delay: 300ms; }
  .splash-el-3 { animation-delay: 450ms; }
  .splash-el-4 { animation-delay: 600ms; }
`

function SplashScreen({ onGetStarted, referralCoachName = null, referralCapped = false }) {
  const [showReferralInput, setShowReferralInput] = useState(false)
  const [referralCode, setReferralCode] = useState('')
  const referralSectionRef = useRef(null)

  useEffect(() => {
    if (!showReferralInput) return
    function handleOut(e) {
      if (referralSectionRef.current && !referralSectionRef.current.contains(e.target)) {
        setShowReferralInput(false)
      }
    }
    document.addEventListener('mousedown', handleOut)
    document.addEventListener('touchstart', handleOut)
    return () => { document.removeEventListener('mousedown', handleOut); document.removeEventListener('touchstart', handleOut) }
  }, [showReferralInput])

  function handleApplyReferral() {
    const code = referralCode.trim()
    if (code) { try { localStorage.setItem('lhc_referral_code', code) } catch {} }
    setShowReferralInput(false)
    onGetStarted()
  }

  // Invited state — a personal invite from a real human is the highest-trust entry point
  // in the app, so the coach's name is the hero of the screen. Brand recedes, the
  // invitation leads. Capped roster falls through to the default layout below.
  const isInvited = !!referralCoachName && !referralCapped
  if (isInvited) {
    const firstName = (referralCoachName || '').trim().split(/\s+/)[0] || referralCoachName
    return (
      <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', padding: '64px 24px 48px' }}>
        <style>{SPLASH_STYLES}</style>

        {/* Top: brand mark, smaller — recedes so the invite leads */}
        <div className="splash-el splash-el-0" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <img src="/remi-logo.svg" alt="Remi" style={{ height: '40px', width: 'auto' }} />
          </div>
          <p style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 18, color: '#888888', letterSpacing: '0.01em', margin: '10px 0 0', lineHeight: 1 }}>
            Remi
          </p>
        </div>

        {/* HERO: the invitation */}
        <div style={{ textAlign: 'center', maxWidth: 420, width: '100%' }}>
          <p className="splash-el splash-el-1" style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 400, color: '#888888', margin: 0, lineHeight: 1.4 }}>
            You've been invited by
          </p>
          <h1 className="splash-el splash-el-2" style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(2.5rem, 11vw, 3rem)', color: '#00E5A0', letterSpacing: '-0.01em', margin: '12px 0 0', lineHeight: 1.05 }}>
            {firstName}
          </h1>
          <p className="splash-el splash-el-3" style={{ fontFamily: 'Inter, sans-serif', fontSize: 16, fontWeight: 400, color: '#888888', margin: '20px 0 0', lineHeight: 1.5 }}>
            {referralCoachName} has set up Remi for you.
          </p>
          <p className="splash-el splash-el-3" style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 400, color: '#666666', margin: '10px 0 0', lineHeight: 1.5, textAlign: 'center' }}>
            Used by fighters, coaches, and home cooks across Australia.
          </p>
          <p className="splash-el splash-el-3" style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 300, color: '#888888', lineHeight: 1.6, margin: '18px 0 0' }}>
            Eat like a chef. Train like an athlete.<br />Live like both.
          </p>
        </div>

        {/* CTA */}
        <div className="splash-el splash-el-4" style={{ width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <button
            onClick={onGetStarted}
            style={{ width: '100%', backgroundColor: '#00E5A0', color: '#0D0D0D', borderRadius: 8, height: 56, fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 16, border: 'none', cursor: 'pointer' }}
          >
            Get started
          </button>
          <button
            onClick={onGetStarted}
            style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', cursor: 'pointer', padding: '4px 0' }}
          >
            Already have an account? Sign in
          </button>
        </div>
      </div>
    )
  }

  // Default (no slug / capped roster) — UNCHANGED.
  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', padding: '80px 24px 48px' }}>
      <style>{SPLASH_STYLES}</style>

      {/* Top: logo mark + wordmark group — kept together so space-between layout is unchanged */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

        {/* Logo row */}
        <div className="splash-el splash-el-0" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src="/remi-logo.svg" alt="Remi" style={{ height: '64px', width: 'auto' }} />
        </div>

        {/* Wordmark + subline */}
        <div className="splash-el splash-el-1" style={{ textAlign: 'center', marginTop: 20 }}>
          <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 48, color: '#F0F0F0', letterSpacing: '0.01em', margin: 0, lineHeight: 1 }}>
            Remi
          </h1>
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#666666', letterSpacing: '0.12em', textTransform: 'uppercase', marginTop: 12 }}>
            Personal Chef · Nutritionist · Guide
          </p>
        </div>

      </div>

      {/* Middle: tagline */}
      <div className="splash-el splash-el-2" style={{ textAlign: 'center', maxWidth: 320 }}>
        <p style={{ fontFamily: 'Inter, sans-serif', fontWeight: 300, fontSize: 16, color: '#888888', lineHeight: 1.65, margin: 0 }}>
          Eat like a chef. Train like an athlete.<br />Live like both.
        </p>
        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 400, color: '#888888', margin: '8px auto 0', textAlign: 'center', maxWidth: 420, width: '100%' }}>
          Used by fighters, coaches, and home cooks across Australia.
        </p>
      </div>

      {/* Bottom: CTA */}
      <div className="splash-el splash-el-3" style={{ width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        {referralCoachName && !referralCapped && (
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#00E5A0', textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
            You've been invited by {referralCoachName}. Let's get started.
          </p>
        )}
        {referralCapped && (
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
            {referralCoachName ? `${referralCoachName}'s roster is full.` : "This coach's roster is full."} You can still sign up directly below.
          </p>
        )}
        <button
          onClick={onGetStarted}
          style={{ width: '100%', backgroundColor: '#00E5A0', color: '#0D0D0D', borderRadius: 8, height: 56, fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 16, border: 'none', cursor: 'pointer' }}
        >
          Get started
        </button>

        {/* Coach / PT referral code entry */}
        <div ref={referralSectionRef} style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {!showReferralInput ? (
            <button
              onClick={() => setShowReferralInput(true)}
              style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', cursor: 'pointer', padding: 0, marginTop: 16, textAlign: 'center', lineHeight: 1.5 }}
            >
              Joining via your coach or PT? Enter their code.
            </button>
          ) : (
            <div style={{ marginTop: 16, width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <button
                  onClick={() => setShowReferralInput(false)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6"/>
                  </svg>
                </button>
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888' }}>Enter your code</span>
              </div>
              <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                <input
                  type="text"
                  value={referralCode}
                  onChange={e => setReferralCode(e.target.value)}
                  placeholder="Coach referral code"
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && handleApplyReferral()}
                  style={{ flex: 1, height: 44, padding: '0 12px', borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', color: '#F0F0F0', fontFamily: 'Inter, sans-serif', fontSize: 16, outline: 'none', boxSizing: 'border-box' }}
                />
                <button
                  onClick={handleApplyReferral}
                  style={{ height: 44, padding: '0 20px', borderRadius: 8, backgroundColor: '#00E5A0', color: '#0D0D0D', border: 'none', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          onClick={onGetStarted}
          style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', cursor: 'pointer', padding: '4px 0' }}
        >
          Already have an account?{' '}<span style={{ color: '#F0F0F0' }}>Sign in</span>
        </button>
      </div>
    </div>
  )
}

// ── Loading screen ────────────────────────────────────────────────────────────

function ChefLoader() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      <div className="flex items-center gap-3.5">
        {[0, 1, 2].map(i => (
          <span
            key={i}
            className="mint-dot"
            style={{ width: 14, height: 14, borderRadius: '50%', backgroundColor: '#00E5A0', display: 'inline-block' }}
          />
        ))}
      </div>
      <p style={{ margin: 0, fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
        Remi is plating · about 6 seconds
      </p>
    </div>
  )
}

// ── Saved recipe card ─────────────────────────────────────────────────────────

function SavedDishCard({ dish, onOpen, onRemove }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  return (
    <div className="rounded-2xl overflow-hidden relative" style={{ backgroundColor: '#1A1A1A', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <button onClick={onOpen} className="w-full text-left block">
        <CardImageHeader dishName={dish.name} cuisine={dish.chef?.cuisine} initialUrl={dish._imgUrl} initialCredit={dish._imgCredit ?? null} />
        <div className="px-4 pb-4 pt-3 space-y-2">
          <h3 style={{ fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: 16, color: '#F0F0F0', lineHeight: 1.2, margin: 0 }}>
            {dish.name}
          </h3>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-bold tabular-nums" style={{ color: '#00E5A0', fontVariantNumeric: 'tabular-nums' }}>
              {dish.dietician?.macros?.calories ?? '—'}
            </span>
            <span className="text-xs" style={{ color: '#888888' }}>kcal</span>
          </div>
          {(dish.dietician?.cookTime && dish.dietician.cookTime !== '—') && (
            <p className="text-xs" style={{ color: '#888888' }}>
              {dish.dietician.cookTime} mins
              {dish.dietician.difficulty ? ` · ${dish.dietician.difficulty}` : ''}
            </p>
          )}
        </div>
      </button>

      {/* Trash / confirm */}
      <div className="absolute top-2.5 right-2.5 z-10">
        {confirmDelete ? (
          <div className="flex gap-1 items-center">
            <button onClick={() => { onRemove(); setConfirmDelete(false) }}
              className="text-xs font-semibold px-2.5 py-1 rounded-lg"
              style={{ backgroundColor: '#00E5A0', color: '#0D0D0D' }}>
              Remove
            </button>
            <button onClick={() => setConfirmDelete(false)}
              className="text-xs font-semibold px-2.5 py-1 rounded-lg"
              style={{ backgroundColor: '#1A1A1A', color: '#888888', border: '1px solid rgba(255,255,255,0.08)' }}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={e => { e.stopPropagation(); setConfirmDelete(true) }}
            className="w-8 h-8 rounded-full flex items-center justify-center transition-colors duration-200"
            style={{ color: '#888888', backgroundColor: 'rgba(26,26,26,0.92)', border: '1px solid rgba(255,255,255,0.08)' }}
            aria-label="Remove recipe"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd"/>
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

// ── Saved recipes view ────────────────────────────────────────────────────────

function SavedRecipesView({ savedRecipes, onOpen, onRemove, onClose, savesCap = null }) {
  return (
    <div className="animate-fade-in min-h-screen px-4 py-10 sm:py-14 relative" style={{ backgroundColor: '#0D0D0D' }}>
      <PaperTexture />
      <div className="max-w-3xl mx-auto space-y-8 relative">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-4xl font-extrabold tracking-tight" style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, color: '#F0F0F0' }}>My Recipes</h1>
            <p className="text-sm mt-1.5" style={{ color: '#888888' }}>
              {savesCap !== null
                ? `${savedRecipes.length} / ${savesCap} saved`
                : savedRecipes.length > 0
                  ? `${savedRecipes.length} saved recipe${savedRecipes.length !== 1 ? 's' : ''}`
                  : 'Your bookmarked recipes live here'}
            </p>
            {savesCap !== null && savedRecipes.length >= savesCap && (
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', margin: '4px 0 0' }}>
                Saved recipe limit reached. Upgrade to Pro.
              </p>
            )}
          </div>
          <button onClick={onClose}
            className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors duration-200 mt-1.5"
            style={{ color: '#888888', border: '1px solid rgba(255,255,255,0.08)' }}>
            ← Back
          </button>
        </div>

        {savedRecipes.length === 0 ? (
          <div className="text-center py-24 space-y-4">
            <div className="text-6xl leading-none">📚</div>
            <p className="text-sm max-w-xs mx-auto leading-relaxed" style={{ color: '#888888' }}>
              Nothing saved yet. Cook something worth keeping.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {savedRecipes.map(recipe => (
              <SavedDishCard
                key={recipe._id}
                dish={recipe}
                onOpen={() => onOpen(recipe)}
                onRemove={() => onRemove(recipe._id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Remi's Corner ─────────────────────────────────────────────────────────────

function renderTipMarkdown(text) {
  return text.split('\n').reduce((acc, line, i) => {
    if (!line.trim()) return acc
    if (/^##\s+/.test(line)) {
      acc.push(
        <p key={i} style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 16, color: '#F0F0F0', margin: '0 0 8px' }}>
          {line.replace(/^##\s+/, '')}
        </p>
      )
      return acc
    }
    const parts = line.split(/(\*\*[^*]+\*\*)/)
    const inline = parts.map((part, j) =>
      /^\*\*[^*]+\*\*$/.test(part)
        ? <span key={j} style={{ fontWeight: 600, color: '#F0F0F0' }}>{part.slice(2, -2)}</span>
        : part
    )
    acc.push(
      <p key={i} style={{ fontFamily: 'Inter, sans-serif', fontSize: 15, color: '#F0F0F0', lineHeight: 1.6, margin: '0 0 4px' }}>
        {inline}
      </p>
    )
    return acc
  }, [])
}

function RemiCorner({ profile }) {
  const [tab, setTab] = useState('fuel')
  const [tip, setTip] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const cacheKey = `lhc_corner_tips_${new Date().toISOString().slice(0, 10)}`

  async function fetchTip(activeTab) {
    setLoading(true)
    setError(null)
    try {
      const freshProfile = JSON.parse(localStorage.getItem('lhc_profile') || '{}')
      const res = await fetch('/api/remi-corner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab: activeTab, profile: freshProfile }),
      })
      const data = await res.json()
      if (data.tip) {
        setTip(data.tip)
        try {
          const cached = JSON.parse(localStorage.getItem(cacheKey) || '{}')
          cached[activeTab] = data.tip
          localStorage.setItem(cacheKey, JSON.stringify(cached))
        } catch {}
      } else {
        setError('Could not load tip.')
      }
    } catch {
      setError('Could not load tip.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || '{}')
      if (cached[tab]) { setTip(cached[tab]); return }
    } catch {}
    fetchTip(tab)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const sectionCard = { backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }

  return (
    <div className="rounded-2xl p-5 space-y-4" style={sectionCard}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={() => { setTip(null); fetchTip(tab) }}
          disabled={loading}
          className="text-[11px] font-medium transition-opacity active:opacity-70"
          style={{ color: '#00E5A0', opacity: loading ? 0.4 : 1 }}
        >
          Refresh
        </button>
      </div>

      {/* Tab toggle */}
      <div className="flex gap-2">
        {[{ id: 'fuel', label: '🥗 Fuel' }, { id: 'perform', label: '💪 Perform' }].map(t => (
          <button
            key={t.id}
            onClick={() => {
              // Clear cached tip for destination tab so stale tips from other users don't persist
              try {
                const cached = JSON.parse(localStorage.getItem(cacheKey) || '{}')
                delete cached[t.id]
                localStorage.setItem(cacheKey, JSON.stringify(cached))
              } catch {}
              setTab(t.id)
            }}
            className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all"
            style={{
              backgroundColor: tab === t.id ? '#00E5A0' : '#252525',
              color: tab === t.id ? '#0D0D0D' : '#888888',
              border: tab === t.id ? 'none' : '1px solid rgba(255,255,255,0.08)',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="space-y-2 animate-pulse">
          {[100, 85, 60].map(w => (
            <div key={w} className="h-3 rounded-full" style={{ backgroundColor: '#2A2A2A', width: `${w}%` }} />
          ))}
        </div>
      ) : error ? (
        <p className="text-xs" style={{ color: '#888' }}>{error}</p>
      ) : tip ? (
        <div>{renderTipMarkdown(tip)}</div>
      ) : null}
    </div>
  )
}

// ── Cookbook page ─────────────────────────────────────────────────────────────

const COOKBOOK_STYLES = `
  .cookbook-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }
  @media (min-width: 768px) {
    .cookbook-grid {
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
    }
  }
`

function CookbookCard({ recipe, onOpen, onAddToDayPlan }) {
  return (
    <div style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* Tappable image + name/kcal area */}
      <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onOpen()} style={{ cursor: 'pointer', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <CardImageHeader
          dishName={recipe.name}
          cuisine={recipe.chef?.cuisine}
          initialUrl={recipe._imgUrl ?? null}
          initialCredit={recipe._imgCredit ?? null}
        />
        <div style={{ padding: '10px 12px 8px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
          <p style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15, color: '#F0F0F0', margin: 0, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {recipe.name}
          </p>
          <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: '#00E5A0', margin: 0 }}>
            {recipe.dietician?.macros?.calories || '—'} kcal
          </p>
        </div>
      </div>
      {/* Add to Day Plan — does NOT open the recipe */}
      <div style={{ padding: '0 12px 12px' }}>
        <button
          onClick={e => { e.stopPropagation(); onAddToDayPlan(recipe) }}
          style={{ width: '100%', height: 44, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#1A1A1A', color: '#F0F0F0', fontFamily: 'Inter, sans-serif', fontWeight: 500, fontSize: 14, cursor: 'pointer' }}>
          Add to Day Plan →
        </button>
      </div>
    </div>
  )
}

function CookbookView({ savedRecipes, onBack, onOpenRecipe, onAddToDayPlan, onStartCooking }) {
  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', paddingBottom: 100 }}>
      <style>{COOKBOOK_STYLES}</style>

      {/* Back nav */}
      <div style={{ padding: '12px 16px' }}>
        <button
          onClick={onBack}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 400, color: '#888888' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Dashboard
        </button>
      </div>

      {/* Header */}
      <div style={{ padding: '8px 16px 24px' }}>
        <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(1.75rem, 6vw, 2.25rem)', color: '#F0F0F0', margin: '0 0 6px', lineHeight: 1.1 }}>
          MY COOKBOOK
        </h1>
        <p style={{ fontFamily: 'Inter, sans-serif', fontWeight: 400, fontSize: 14, color: '#888888', margin: 0 }}>
          {savedRecipes.length} saved recipe{savedRecipes.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Content */}
      <div style={{ padding: '0 16px' }}>
        {savedRecipes.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 0', textAlign: 'center', gap: 20 }}>
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', margin: 0, maxWidth: 280, lineHeight: 1.6 }}>
              No saved recipes yet. Start cooking to build your cookbook.
            </p>
            <button
              onClick={onStartCooking}
              style={{ height: 48, padding: '0 28px', borderRadius: 8, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15, cursor: 'pointer' }}>
              Start cooking →
            </button>
          </div>
        ) : (
          <div className="cookbook-grid">
            {savedRecipes.map((recipe, i) => (
              <CookbookCard
                key={recipe._id || i}
                recipe={recipe}
                onOpen={() => onOpenRecipe(recipe)}
                onAddToDayPlan={onAddToDayPlan}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function CoachRosterView({ slug, onBack, onSelectClient = () => {} }) {
  const [clients,       setClients]       = useState(null)
  const [error,         setError]         = useState(null)
  const [notes,         setNotes]         = useState({})
  const [notesLoading,  setNotesLoading]  = useState({})
  const [expandedNotes, setExpandedNotes] = useState({})
  const [hoveredRow,    setHoveredRow]    = useState(null)
  const tokenRef = useRef(null)

  function toggleNote(id, e) {
    if (e) e.stopPropagation()
    setExpandedNotes(prev => ({ ...prev, [id]: !prev[id] }))
  }

  // Roster fetch
  useEffect(() => {
    const token = (() => {
      try { return JSON.parse(localStorage.getItem('supabase.auth.token') || 'null')?.access_token ?? null } catch { return null }
    })()
    tokenRef.current = token
    if (!token || !slug) return
    fetch('/api/coach-roster', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ coachSlug: slug }),
    })
      .then(r => r.json())
      .then(data => {
        if (data?.clients) setClients(data.clients)
        else setError(data?.error || 'Failed to load roster')
      })
      .catch(() => setError('Failed to load roster'))
  }, [slug])

  // Sequential note fetch — runs after roster loads
  useEffect(() => {
    if (!Array.isArray(clients) || clients.length === 0) return
    let cancelled = false
    const today = new Date().toISOString().slice(0, 10)

    async function run() {
      for (const c of clients) {
        if (cancelled) break
        const cacheKey = `remi_coach_note_${c.id}`
        try {
          const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null')
          if (cached?.date === today && cached?.note) {
            setNotes(prev => ({ ...prev, [c.id]: cached.note }))
            continue
          }
        } catch {}

        setNotesLoading(prev => ({ ...prev, [c.id]: true }))
        try {
          const res  = await fetch('/api/coach-note', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ clientId: c.id, clientName: c.name, sport: c.sport, goal: c.goal }),
          })
          const data = await res.json()
          const note = data?.note ?? null
          if (!cancelled) {
            setNotes(prev => ({ ...prev, [c.id]: note }))
            if (note) {
              try { localStorage.setItem(cacheKey, JSON.stringify({ note, date: today })) } catch {}
            }
          }
        } catch {
          if (!cancelled) setNotes(prev => ({ ...prev, [c.id]: null }))
        }
        if (!cancelled) setNotesLoading(prev => ({ ...prev, [c.id]: false }))
      }
    }

    run()
    return () => { cancelled = true }
  }, [clients])

  function initials(name) {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return '?'
    if (parts.length === 1) return parts[0][0].toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }

  function formatJoined(iso) {
    if (!iso) return ''
    const d   = new Date(iso)
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]
    return `Joined ${d.getDate()} ${mon}`
  }

  function formatLogDate(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    const now = new Date()
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
    if (diffDays === 0) {
      const h = d.getHours()
      const m = d.getMinutes()
      const ampm = h >= 12 ? 'pm' : 'am'
      const h12 = h % 12 || 12
      return `Today ${h12}:${m < 10 ? '0' + m : m}${ampm}`
    }
    return `${diffDays}d ago`
  }

  function isNew(iso) {
    return !!iso && (Date.now() - new Date(iso).getTime()) < 7 * 24 * 60 * 60 * 1000
  }

  return (
    <div className="animate-fade-in" style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', paddingBottom: 40 }}>
      <style>{`
        @media (min-width: 768px) { .roster-card { display: none !important; } .roster-table { display: table !important; } }
        @media (max-width: 767px)  { .roster-table { display: none !important; } }
        .roster-skeleton { background: linear-gradient(90deg,#1A1A1A 25%,#222 50%,#1A1A1A 75%); background-size: 200% 100%; animation: rsk 1.4s infinite; border-radius: 6px; }
        @keyframes rsk { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
        @keyframes note-pulse { 0%,100%{opacity:0.4} 50%{opacity:0.9} }
        .note-skeleton { background-color: #1A1A1A; border-radius: 8px; animation: note-pulse 1.4s ease infinite; }
      `}</style>

      {/* Header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, backgroundColor: '#0D0D0D', borderBottom: '1px solid rgba(255,255,255,0.06)', padding: '0 20px', display: 'flex', alignItems: 'center', gap: 12, minHeight: 64 }}>
        <button
          onClick={onBack}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <div>
          <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 24, color: '#F0F0F0', margin: 0, lineHeight: 1 }}>
            Your Roster
          </h1>
          {clients !== null && (
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', margin: '4px 0 0' }}>
              {clients.length} {clients.length === 1 ? 'client' : 'clients'}
            </p>
          )}
        </div>
      </div>

      <div style={{ padding: '20px 16px' }}>
        {/* Initial loading skeletons */}
        {clients === null && !error && [0,1,2].map(i => (
          <div key={i} style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="roster-skeleton" style={{ width: 40, height: 40, borderRadius: '50%', flexShrink: 0 }} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="roster-skeleton" style={{ height: 14, width: '55%' }} />
              <div className="roster-skeleton" style={{ height: 11, width: '35%' }} />
            </div>
            <div className="roster-skeleton" style={{ height: 11, width: 72 }} />
          </div>
        ))}

        {/* Error */}
        {error && (
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', textAlign: 'center', marginTop: 40 }}>{error}</p>
        )}

        {/* Empty state */}
        {clients !== null && clients.length === 0 && (
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', textAlign: 'center', marginTop: 60, lineHeight: 1.6 }}>
            No clients yet. Share your link and build your roster.
          </p>
        )}

        {/* Mobile cards */}
        {clients !== null && clients.length > 0 && clients.map(c => {
          const note        = notes[c.id] ?? null
          const noteLoading = notesLoading[c.id] ?? false
          const hasNote     = !!note
          const noteExpanded = expandedNotes[c.id] ?? false
          const noteLong     = hasNote && note.length > 120
          const noteDisplay  = noteLong && !noteExpanded ? note.slice(0, 120) + '…' : note
          return (
            <div
              key={c.id}
              className="roster-card"
              onClick={() => onSelectClient({ ...c, remiNote: note })}
              style={{ position: 'relative', backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: 12, marginBottom: 8, display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}
            >
              <div style={{ position: 'absolute', top: 12, right: 12, width: 8, height: 8, borderRadius: '50%', backgroundColor: isNew(c.created_at) ? '#00E5A0' : '#888888' }} />
              <div style={{ width: 40, height: 40, borderRadius: '50%', backgroundColor: '#00E5A0', color: '#0D0D0D', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 14, flexShrink: 0 }}>
                {initials(c.name)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontFamily: 'Inter, sans-serif', fontWeight: 500, fontSize: 15, color: '#F0F0F0', margin: 0, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name || '—'}
                </p>
                <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', margin: '3px 0 0', letterSpacing: '0.06em', textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {[c.sport, c.goal].filter(Boolean).join(' · ') || '—'}
                </p>
                {/* Note skeleton */}
                {noteLoading && (
                  <div className="note-skeleton" style={{ height: 12, width: '80%', marginTop: 8 }} />
                )}
                {/* Note with Show more */}
                {hasNote && (
                  <div style={{ borderLeft: '4px solid #00E5A0', paddingLeft: 8, marginTop: 8 }}>
                    <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: noteExpanded ? '#F0F0F0' : '#888888', margin: 0, lineHeight: 1.5 }}>
                      {noteDisplay}
                    </p>
                    {noteLong && (
                      <button
                        onClick={e => toggleNote(c.id, e)}
                        style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#00E5A0', cursor: 'pointer', padding: '4px 0 0', display: 'block' }}
                      >
                        {noteExpanded ? 'Show less' : 'Show more'}
                      </button>
                    )}
                  </div>
                )}
                {/* Cook log */}
                {c.latestLog && (
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#00E5A0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.latestLog.client_name} cooked {c.latestLog.dish_name}
                    </span>
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', flexShrink: 0 }}>
                      {formatLogDate(c.latestLog.created_at)}
                    </span>
                  </div>
                )}
              </div>
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', margin: 0, flexShrink: 0, paddingRight: 16, paddingTop: 2 }}>
                {formatJoined(c.created_at)}
              </p>
            </div>
          )
        })}

        {/* Desktop table */}
        {clients !== null && clients.length > 0 && (
          <table className="roster-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '0 6px' }}>
            <thead>
              <tr>
                {['Client','Sport / Goal',"Remi's Note",'Joined','Status'].map(h => (
                  <th key={h} style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.1em', textTransform: 'uppercase', textAlign: 'left', padding: '0 12px 8px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clients.map(c => {
                const note         = notes[c.id] ?? null
                const noteLoading  = notesLoading[c.id] ?? false
                const noteExpanded = expandedNotes[c.id] ?? false
                const noteLong     = !!note && note.length > 120
                const noteDisplay  = noteLong && !noteExpanded ? note.slice(0, 120) + '…' : note
                const isHovered    = hoveredRow === c.id
                const rowBg        = isHovered ? '#222222' : '#1A1A1A'
                return (
                  <tr
                    key={c.id}
                    onClick={() => onSelectClient({ ...c, remiNote: note })}
                    onMouseEnter={() => setHoveredRow(c.id)}
                    onMouseLeave={() => setHoveredRow(null)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td style={{ padding: 12, backgroundColor: rowBg, borderRadius: '8px 0 0 8px', border: '1px solid rgba(255,255,255,0.08)', borderRight: 'none', transition: 'background-color 200ms ease' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 36, height: 36, borderRadius: '50%', backgroundColor: '#00E5A0', color: '#0D0D0D', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 13, flexShrink: 0 }}>
                          {initials(c.name)}
                        </div>
                        <span style={{ fontFamily: 'Inter, sans-serif', fontWeight: 500, fontSize: 14, color: '#F0F0F0' }}>{c.name || '—'}</span>
                      </div>
                    </td>
                    <td style={{ padding: 12, backgroundColor: rowBg, border: '1px solid rgba(255,255,255,0.08)', borderLeft: 'none', borderRight: 'none', transition: 'background-color 200ms ease' }}>
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                        {[c.sport, c.goal].filter(Boolean).join(' · ') || '—'}
                      </span>
                    </td>
                    <td style={{ padding: 12, backgroundColor: rowBg, border: '1px solid rgba(255,255,255,0.08)', borderLeft: 'none', borderRight: 'none', maxWidth: 280, transition: 'background-color 200ms ease' }}>
                      {noteLoading && (
                        <div className="note-skeleton" style={{ height: 12, width: '80%' }} />
                      )}
                      {note && (
                        <div>
                          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: noteExpanded ? '#F0F0F0' : '#888888' }}>
                            {noteDisplay}
                          </span>
                          {noteLong && (
                            <button
                              onClick={e => toggleNote(c.id, e)}
                              style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#00E5A0', cursor: 'pointer', marginLeft: 6, padding: 0 }}
                            >
                              {noteExpanded ? 'Show less' : 'Show more'}
                            </button>
                          )}
                        </div>
                      )}
                      {!noteLoading && !note && !c.latestLog && (
                        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#444' }}>—</span>
                      )}
                      {c.latestLog && (
                        <div style={{ marginTop: note ? 6 : 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#00E5A0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {c.latestLog.dish_name}
                          </span>
                          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', flexShrink: 0 }}>
                            {formatLogDate(c.latestLog.created_at)}
                          </span>
                        </div>
                      )}
                    </td>
                    <td style={{ padding: 12, backgroundColor: rowBg, border: '1px solid rgba(255,255,255,0.08)', borderLeft: 'none', borderRight: 'none', transition: 'background-color 200ms ease' }}>
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888' }}>{formatJoined(c.created_at)}</span>
                    </td>
                    <td style={{ padding: 12, backgroundColor: rowBg, borderRadius: '0 8px 8px 0', border: '1px solid rgba(255,255,255,0.08)', borderLeft: 'none', transition: 'background-color 200ms ease' }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: isNew(c.created_at) ? '#00E5A0' : '#888888' }} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function CoachCard({ slug, clientCount, seatCap, onViewRoster }) {
  const [copied, setCopied] = useState(false)
  const url   = `https://myremi.io/join/${slug}`
  const count = clientCount ?? 0

  function handleCopy() {
    try {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
    } catch {}
  }

  return (
    <div style={{
      backgroundColor: '#1A1A1A',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 10,
      padding: 20,
      marginBottom: 24,
      display: 'flex', flexDirection: 'column', gap: 18,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: 0 }}>
          Coach
        </p>
        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#00E5A0', letterSpacing: '0.08em', textTransform: 'uppercase', border: '1px solid #00E5A0', borderRadius: 20, padding: '3px 10px' }}>
          Founding Coach
        </span>
      </div>

      {/* Referral link */}
      <div>
        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 8px' }}>
          Your referral link
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <code style={{
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: '#F0F0F0',
            backgroundColor: '#0D0D0D', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8, padding: '10px 12px',
          }}>
            {url}
          </code>
          <button
            onClick={handleCopy}
            style={{
              flexShrink: 0, height: 38, padding: '0 14px', borderRadius: 8, border: 'none',
              backgroundColor: '#00E5A0', color: '#0D0D0D',
              fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 13,
              cursor: 'pointer', touchAction: 'manipulation', transition: 'opacity 200ms ease',
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Three stat boxes */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div style={{ backgroundColor: '#0D0D0D', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '12px 14px' }}>
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 6px' }}>Active</p>
          <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 28, fontWeight: 700, color: '#00E5A0', margin: 0, lineHeight: 1 }}>{count}</p>
        </div>
        <div style={{ backgroundColor: '#0D0D0D', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '12px 14px' }}>
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 6px' }}>Seats Left</p>
          <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 28, fontWeight: 700, color: '#F0F0F0', margin: 0, lineHeight: 1 }}>{Math.max(0, seatCap - count)}</p>
        </div>
        <div style={{ backgroundColor: '#0D0D0D', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '12px 14px' }}>
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 6px' }}>Est. Credit</p>
          <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 28, fontWeight: 700, color: '#C9A84C', margin: 0, lineHeight: 1 }}>${count}/mo</p>
        </div>
      </div>

      <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', lineHeight: 1.5, margin: 0 }}>
        Every client you bring earns you $1/month. Build your roster.
      </p>

      {/* View Roster */}
      <button
        onClick={onViewRoster}
        style={{
          width: '100%', height: 48, borderRadius: 8,
          backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)',
          color: '#F0F0F0', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 14,
          cursor: 'pointer', touchAction: 'manipulation', transition: 'opacity 200ms ease',
        }}
      >
        View Roster →
      </button>
    </div>
  )
}

function getDailyCalTarget(profile) {
  const weight = Number(profile?.weight)
  if (!weight) return 2100

  const freq = profile?.trainingFrequency || profile?.trainingFreq || ''
  const multiplierMap = {
    'Rarely':         1.2,
    '1–2× a week':   1.375,
    '1-2x':           1.375,
    '3–4× a week':   1.55,
    '3-4x':           1.55,
    '5–6× a week':   1.725,
    '5-6x':           1.725,
    'Every day':      1.9,
  }
  const multiplier = multiplierMap[freq] ?? 1.55

  const goals = Array.isArray(profile?.goals) ? profile.goals : (profile?.goal ? [profile.goal] : [])
  let adjustment = 0
  if (goals.some(g => g === 'Lose fat' || g === 'lose' || g === 'cut'))        adjustment = -300
  else if (goals.some(g => g === 'Build lean muscle' || g === 'build' || g === 'bulk')) adjustment = +200

  const raw = Math.round(weight * 24 * multiplier) + adjustment
  return Math.min(3500, Math.max(1400, raw))
}

const DASHBOARD_STYLES = `
  @keyframes ringGoalPulse {
    from { stroke: #00E5A0; }
    50%  { stroke: rgba(0,229,160,0.5); }
    to   { stroke: #00E5A0; }
  }
  .ring-goal-pulse { animation: ringGoalPulse 150ms ease-out 1 both; }

  .dash-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
  }
  @media (min-width: 768px) {
    .dash-grid {
      grid-template-columns: 320px 1fr;
    }
    .dash-col-left {
      position: sticky;
      top: 24px;
      align-self: start;
    }
    .day-plan-slots {
      grid-template-columns: repeat(3, 1fr) !important;
    }
  }
  .dash-action:hover {
    border-color: rgba(0, 229, 160, 0.3) !important;
    box-shadow: 0 0 0 1px rgba(0, 229, 160, 0.15) !important;
  }
  .dash-plan-btn:hover {
    color: #00E5A0 !important;
    border-color: #00E5A0 !important;
  }
`

function CoachStrip({ referredBy, savedRecipes, onLetKnow }) {
  const [coachName, setCoachName] = useState(() => {
    try {
      const c = JSON.parse(localStorage.getItem('remi_coach_name') || 'null')
      if (c?.slug === referredBy) return c.name
    } catch {}
    return null
  })

  useEffect(() => {
    if (!referredBy || coachName) return
    fetch('/api/referral', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'validate', slug: referredBy }),
    })
      .then(r => r.json())
      .then(data => {
        const name = data?.full || data?.coachName || null
        if (name) {
          setCoachName(name)
          try { localStorage.setItem('remi_coach_name', JSON.stringify({ name, slug: referredBy })) } catch {}
        }
      })
      .catch(() => {})
  }, [referredBy])

  if (!referredBy || !coachName) return null

  const firstName    = coachName.split(' ')[0] || coachName
  const latestDish   = savedRecipes?.length > 0 ? savedRecipes[savedRecipes.length - 1]?.name : null

  return (
    <div style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '12px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#00E5A0', flexShrink: 0 }} />
        <div>
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 2px' }}>Your Coach</p>
          <p style={{ fontFamily: 'Inter, sans-serif', fontWeight: 500, fontSize: 14, color: '#F0F0F0', margin: 0 }}>{coachName}</p>
        </div>
      </div>
      {latestDish && (
        <button
          onClick={() => onLetKnow(latestDish)}
          style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', cursor: 'pointer', padding: '4px 0', minHeight: 44, display: 'flex', alignItems: 'center', whiteSpace: 'nowrap' }}
        >
          Let {firstName} know →
        </button>
      )}
    </div>
  )
}

function CoachLogToast({ toast, onSend, onDismiss }) {
  const [opacity, setOpacity] = useState(0)
  const firstName = (toast.coachName || 'your coach').split(' ')[0]

  useEffect(() => {
    const t = requestAnimationFrame(() => setOpacity(1))
    return () => cancelAnimationFrame(t)
  }, [])

  useEffect(() => {
    if (toast.fadingOut) {
      const t = setTimeout(onDismiss, 200)
      return () => clearTimeout(t)
    }
  }, [toast.fadingOut])

  return (
    <div style={{
      position: 'fixed', bottom: 80, left: 16, right: 16,
      zIndex: 999, boxSizing: 'border-box',
      backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 8, padding: '12px 16px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      opacity: toast.fadingOut ? 0 : opacity,
      transition: 'opacity 200ms ease',
    }}>
      <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#F0F0F0', margin: 0, flex: 1 }}>
        Let {firstName} know what you cooked?
      </p>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button onClick={onSend} style={{ height: 32, padding: '0 14px', borderRadius: 8, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
          Send
        </button>
        <button onClick={onDismiss} style={{ height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#1A1A1A', color: '#888888', fontFamily: 'Inter, sans-serif', fontWeight: 500, fontSize: 13, cursor: 'pointer' }}>
          Skip
        </button>
      </div>
    </div>
  )
}

function CoachPitchScreen({ onViewRoster, onDashboard }) {
  const FEATURES = [
    { num: '01', label: 'Watch their fuelling, daily' },
    { num: '02', label: 'Your link, your roster' },
    { num: '03', label: 'Founding pricing, locked for life' },
  ]
  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px', boxSizing: 'border-box' }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 24px' }}>
          For Coaches
        </p>
        <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 40, lineHeight: 1.1, margin: 0 }}>
          <span style={{ color: '#F0F0F0', display: 'block' }}>Your training.</span>
          <span style={{ color: '#00E5A0', display: 'block' }}>Our kitchen.</span>
        </h1>
        <p style={{ fontFamily: 'Inter, sans-serif', fontWeight: 300, fontSize: 16, color: '#888888', margin: '16px 0 0', lineHeight: 1.6 }}>
          Remi handles the fuelling so you can focus on the training.
        </p>
        <div style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {FEATURES.map(({ num, label }) => (
            <div key={num} style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: '#00E5A0', flexShrink: 0 }}>{num}</span>
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#F0F0F0' }}>{label}</span>
            </div>
          ))}
        </div>
        <button
          onClick={onViewRoster}
          style={{ marginTop: 40, width: '100%', height: 56, borderRadius: 8, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 16, cursor: 'pointer' }}
        >
          Take me to my roster →
        </button>
        <button
          onClick={onDashboard}
          style={{ display: 'block', width: '100%', marginTop: 16, background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', cursor: 'pointer', textAlign: 'center', padding: '8px 0' }}
        >
          Go to dashboard
        </button>
      </div>
    </div>
  )
}

function Dashboard({ profile, savedRecipes, sessions, streak, stats, onClose, onOpenRecipe, onOpenSessionDish, onQuickStart, onEditProfile, onViewSaved, isAdmin = false, isCoach = false, isFighter = false, isProUser = false, isDirect = false, onAdminPanel, onSignOut, dayPlanVersion = 0, onOpenCookWithPrompt = () => {}, onLogSavedRecipe = () => {}, onDayPlanUpdated = () => {}, onOpenCookbook = () => {}, onAddManualSavedRecipe = () => {}, onViewRoster = () => {}, onLetCoachKnow = () => {}, onOpenMealPlanner = () => {}, authToken = null }) {

  const [dashToast,        setDashToast]        = useState(null)
  const [dayPlanModal,     setDayPlanModal]     = useState(null)
  const [savedRecipesDrawer, setSavedRecipesDrawer] = useState(false)
  const [plannerGateMsg,   setPlannerGateMsg]   = useState(false)
  const [dashboardPlan,    setDashboardPlan]    = useState(undefined)
  // Log meal modal state
  const [logMealOpen,  setLogMealOpen]  = useState(false)
  const [logName,      setLogName]      = useState('')
  const [logKcal,      setLogKcal]      = useState('')
  const [logProtein,   setLogProtein]   = useState('')
  const [logCarbs,     setLogCarbs]     = useState('')
  const [logFat,       setLogFat]       = useState('')
  const [logSlot,      setLogSlot]      = useState('dinner')
  const dayPlanRef        = useRef(null)
  const plannerGateTimer  = useRef(null)

  const isPro = isAdmin || isCoach || isFighter || isProUser
  const canViewHistory = isPro || isDirect

  function showDashToast(msg) {
    setDashToast(msg)
    setTimeout(() => setDashToast(null), 2500)
  }

  function showPlannerGate() {
    setPlannerGateMsg(true)
    clearTimeout(plannerGateTimer.current)
    plannerGateTimer.current = setTimeout(() => setPlannerGateMsg(false), 3000)
  }

  const todayISO = new Date().toISOString().slice(0, 10)

  const fuelTip = useMemo(() => {
    try {
      const tips = JSON.parse(localStorage.getItem(`lhc_corner_tips_${todayISO}`) || '{}')
      return tips.fuel || null
    } catch { return null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const greetingLine = useMemo(() => {
    try {
      const g = JSON.parse(localStorage.getItem('lhc_greeting') || '{}')
      return (g.date === todayISO && g.text) ? g.text : null
    } catch { return null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dayPlan = useMemo(() => {
    try {
      const raw = localStorage.getItem('remi_day_plan')
      if (!raw) return null
      const p = JSON.parse(raw)
      return p.date === todayISO ? p : null
    } catch { return null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayPlanVersion])

  // Load this week's meal plan for the Day Plan card
  useEffect(() => {
    if (!isPro || !authToken) { setDashboardPlan(null); return }
    const monday = (() => {
      const d = new Date()
      const day = d.getDay()
      d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
      return d.toISOString().slice(0, 10)
    })()
    let cancelled = false
    fetch(`/api/meal-plans?week_start=${monday}`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(data => { if (!cancelled) setDashboardPlan(data.plan ?? null) })
      .catch(() => { if (!cancelled) setDashboardPlan(null) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPro, authToken])

  const dailyCalTarget = profile?.dailyCalTarget || getDailyCalTarget(profile)

  const todayMacros = useMemo(() => {
    let cals = 0, protein = 0, carbs = 0, fat = 0
    sessions.filter(s => (s.date || '').startsWith(todayISO)).forEach(s => {
      ;(s.dishes || []).forEach(d => {
        const m = d?.dietician?.macros
        if (m) {
          cals    += parseInt(m.calories) || 0
          protein += parseInt(m.protein)  || 0
          carbs   += parseInt(m.carbs)    || 0
          fat     += parseInt(m.fat)      || 0
        }
      })
    })
    return { cals, protein, carbs, fat }
  }, [sessions, todayISO])

  const proteinTarget = profile?.weight ? Math.round(Number(profile.weight) * 1.8) : 160
  const carbsTarget   = Math.round((dailyCalTarget * 0.40) / 4)
  const fatTarget     = Math.round((dailyCalTarget * 0.25) / 9)

  const ringR      = 36
  const ringCirc   = 2 * Math.PI * ringR
  const ringOffset = ringCirc * (1 - Math.min(todayMacros.cals / dailyCalTarget, 1))

  const recentMeals = useMemo(() => {
    const results = []
    for (const r of [...savedRecipes].reverse()) {
      results.push({ name: r.name, kcal: r.dietician?.macros?.calories || r.chef?.calories || '—' })
      if (results.length >= 3) break
    }
    if (results.length < 3) {
      for (const s of sessions) {
        for (const d of (s.dishes || [])) {
          if (typeof d === 'object' && d?.name) {
            results.push({ name: d.name, kcal: d.dietician?.macros?.calories || '—' })
            if (results.length >= 3) break
          }
        }
        if (results.length >= 3) break
      }
    }
    return results
  }, [savedRecipes, sessions])

  const weekData = useMemo(() => {
    const now = new Date()
    const dow = now.getDay()
    const offset = dow === 0 ? -6 : 1 - dow
    const monday = new Date(now)
    monday.setHours(0, 0, 0, 0)
    monday.setDate(now.getDate() + offset)
    const letters = ['M','T','W','T','F','S','S']
    const todayEnd = new Date(todayISO + 'T23:59:59')
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i)
      const iso = d.toISOString().slice(0, 10)
      const isToday  = iso === todayISO
      const isFuture = d > todayEnd
      const daySessions = sessions.filter(s => (s.date || '').startsWith(iso))
      const hit  = daySessions.some(s => s.cooked === true)
      const miss = daySessions.length > 0 && !hit && !isFuture
      return { iso, letter: letters[i], isToday, isFuture, hit, miss }
    })
  }, [sessions, todayISO])

  const pastDays     = weekData.filter(d => !d.isFuture)
  const hitCount     = pastDays.filter(d => d.hit).length
  const filledSlots  = ['breakfast','lunch','dinner'].filter(k => !!dayPlan?.[k]?.name).length
  const adherencePct = Math.round((filledSlots / 3) * 100)
  const streakCount  = streak?.count || 0
  const isGoalHit    = dailyCalTarget > 0 && todayMacros.cals >= dailyCalTarget

  const avgProtein = useMemo(() => {
    const weekISOs = new Set(weekData.filter(d => !d.isFuture).map(d => d.iso))
    let total = 0, count = 0
    sessions.forEach(s => {
      if (weekISOs.has((s.date || '').slice(0, 10))) {
        ;(s.dishes || []).forEach(d => {
          const p = parseInt(d?.dietician?.macros?.protein)
          if (!isNaN(p)) { total += p; count++ }
        })
      }
    })
    return count > 0 ? Math.round(total / count) : null
  }, [sessions, weekData])

  const cardBase = {
    backgroundColor: '#1A1A1A',
    border: '0.5px solid rgba(255,255,255,0.08)',
    borderRadius: 10,
  }

  const secLabel = {
    fontFamily: 'Inter, sans-serif',
    fontSize: 11,
    fontWeight: 500,
    color: '#888888',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    margin: 0,
  }

  return (
    <>
      <style>{DASHBOARD_STYLES}</style>

      {dashToast && (
        <div style={{ position: 'fixed', bottom: 100, left: '50%', transform: 'translateX(-50%)', zIndex: 9999, backgroundColor: '#1A1A1A', border: '0.5px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '10px 18px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#E8E8E8', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
          {dashToast}
        </div>
      )}

      <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', padding: '24px 20px 120px' }}>
        <div style={{ maxWidth: 1140, margin: '0 auto' }}>

          <div className="dash-grid">

            {/* ══ LEFT COLUMN ══ */}
            <div className="dash-col-left" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

              {/* A. GREETING CARD */}
              <div style={{ ...cardBase, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#00E5A0', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                    {profile?.name || 'You'}
                  </span>
                  {streakCount > 0 && (
                    <span style={{ backgroundColor: '#0D2B1E', border: '0.5px solid #00E5A0', borderRadius: 20, padding: '3px 10px', fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#00E5A0' }}>
                      {streakCount} day streak
                    </span>
                  )}
                </div>
                <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#CCCCCC', lineHeight: 1.6, margin: 0 }}>
                  {greetingLine || "Good to have you back. Let's eat well tonight."}
                </p>
              </div>

              {/* B. MACRO RING CARD */}
              <div style={{ ...cardBase, padding: 16 }}>
                <p style={{ ...secLabel, marginBottom: 14 }}>Today's Targets</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{ position: 'relative', width: 88, height: 88, flexShrink: 0 }}>
                    <svg width="88" height="88" viewBox="0 0 88 88" style={{ display: 'block', transform: 'rotate(-90deg)' }}>
                      <circle cx="44" cy="44" r={ringR} fill="none" stroke="#2A2A2A" strokeWidth="7" />
                      <circle cx="44" cy="44" r={ringR} fill="none" stroke="#00E5A0" strokeWidth="7" strokeLinecap="round"
                        className={isGoalHit ? 'ring-goal-pulse' : ''}
                        strokeDasharray={ringCirc}
                        strokeDashoffset={todayMacros.cals === 0 ? ringCirc : ringOffset}
                        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
                      />
                    </svg>
                    <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, pointerEvents: 'none' }}>
                      {isGoalHit ? (
                        <span style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 13, color: '#F0F0F0', lineHeight: 1, textAlign: 'center' }}>Goal hit.</span>
                      ) : (
                        <>
                          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 700, color: '#E8E8E8', lineHeight: 1 }}>
                            {todayMacros.cals}
                          </span>
                          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 9, color: '#888888', lineHeight: 1 }}>
                            of {dailyCalTarget}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {[
                      { label: 'Protein', consumed: todayMacros.protein, target: proteinTarget, color: '#00E5A0' },
                      { label: 'Carbs',   consumed: todayMacros.carbs,   target: carbsTarget,   color: '#4DC8FF' },
                      { label: 'Fat',     consumed: todayMacros.fat,     target: fatTarget,     color: '#C9A84C' },
                    ].map(({ label, consumed, target, color }) => (
                      <div key={label}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#999999' }}>{label}</span>
                          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#E8E8E8' }}>{consumed}g / {target}g</span>
                        </div>
                        <div style={{ height: 4, backgroundColor: '#2A2A2A', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: '100%', borderRadius: 2, backgroundColor: color, width: target > 0 ? `${Math.min((consumed / target) * 100, 100)}%` : '0%', transition: 'width 0.5s ease' }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* C. QUICK ACTIONS */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <button className="dash-action" onClick={onQuickStart}
                  style={{ ...cardBase, border: '0.5px solid rgba(255,255,255,0.08)', padding: 12, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <i className="ti ti-flame" style={{ fontSize: 18, color: '#00E5A0' }} />
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 600, color: '#E8E8E8', display: 'block' }}>Cook</span>
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#888888', display: 'block' }}>Generate dinner</span>
                </button>

                <button className="dash-action" onClick={() => setLogMealOpen(true)}
                  style={{ ...cardBase, border: '0.5px solid rgba(255,255,255,0.08)', padding: 12, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <i className="ti ti-pencil" style={{ fontSize: 18, color: '#00E5A0' }} />
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 600, color: '#E8E8E8', display: 'block' }}>Log meal</span>
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#888888', display: 'block' }}>Manual entry</span>
                </button>

                <button className="dash-action"
                  onClick={() => {
                    if (isPro) {
                      onOpenMealPlanner()
                    } else {
                      showDashToast('Day planning is a Pro feature — coming soon.')
                    }
                  }}
                  style={{ gridColumn: '1 / -1', backgroundColor: '#0D2B1E', border: '0.5px solid #00E5A0', borderRadius: 10, padding: 12, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <i className="ti ti-calendar" style={{ fontSize: 18, color: '#00E5A0', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 600, color: '#E8E8E8', display: 'block' }}>Day Plan</span>
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#888888', display: 'block' }}>View today's plan</span>
                  </div>
                  {!isPro && (
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 600, color: '#C9A84C', letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0 }}>PRO</span>
                  )}
                </button>
              </div>

            </div>

            {/* ══ RIGHT COLUMN ══ */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

              {/* A. REMI'S READ */}
              <div style={{ ...cardBase, padding: '14px 16px' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', backgroundColor: '#0D2B1E', border: '1px solid #00E5A0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 13, color: '#00E5A0' }}>R</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ ...secLabel, color: '#00E5A0', marginBottom: 6 }}>Remi's Read</p>
                    <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#CCCCCC', lineHeight: 1.6, margin: 0 }}>
                      {fuelTip || "Train tomorrow — your carbs are low. Add rice or sourdough to dinner tonight and you'll wake up fuelled."}
                    </p>
                  </div>
                </div>
              </div>

              {/* STATS HIERARCHY */}
              <div style={{ ...cardBase, padding: 16 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                  {[
                    { label: 'Streak',         value: String(streakCount) },
                    { label: 'Recipes cooked', value: String(stats?.totalRecipes || 0) },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ textAlign: 'center', backgroundColor: '#111111', borderRadius: 8, padding: '14px 8px' }}>
                      <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 32, fontWeight: 700, color: '#F0F0F0', margin: '0 0 4px', lineHeight: 1 }}>{value}</p>
                      <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', margin: 0 }}>{label}</p>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { label: 'Calories saved', value: String(stats?.totalCalSaved || 0) },
                    { label: 'Money saved',    value: `$${(stats?.totalRecipes || 0) * 15}` },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ textAlign: 'center', backgroundColor: '#111111', borderRadius: 8, padding: '10px 8px' }}>
                      <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 700, color: '#00E5A0', margin: '0 0 3px', lineHeight: 1 }}>{value}</p>
                      <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#888888', margin: 0, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── MEAL PLANNER CARD ── */}
              <div style={{ position: 'relative' }}>
                <div
                  onClick={isPro ? onOpenMealPlanner : showPlannerGate}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    backgroundColor: '#1A1A1A',
                    borderLeft: '4px solid #00E5A0',
                    borderTop: '0.5px solid rgba(255,255,255,0.08)',
                    borderRight: '0.5px solid rgba(255,255,255,0.08)',
                    borderBottom: '0.5px solid rgba(255,255,255,0.08)',
                    borderRadius: 8,
                    padding: 16,
                    cursor: 'pointer',
                    opacity: isPro ? 1 : 0.5,
                    userSelect: 'none',
                    position: 'relative',
                  }}
                >
                  <div>
                    <p style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 15, color: '#F0F0F0', margin: '0 0 4px' }}>
                      This Week
                    </p>
                    <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', margin: 0, lineHeight: 1.4 }}>
                      Map your meals. Build your protocol.
                    </p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {!isPro && (
                      <div style={{ position: 'absolute', top: 8, right: 8 }}>
                        <svg viewBox="0 0 18 14" width="13" height="10" fill="#C9A84C">
                          <path d="M9 0L11.5 5L18 3.5L15 10H3L0 3.5L6.5 5L9 0Z"/>
                          <rect x="3" y="11" width="12" height="2.5" rx="1"/>
                        </svg>
                      </div>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); isPro ? onOpenMealPlanner() : showPlannerGate() }}
                      style={{
                        height: 44,
                        padding: '0 20px',
                        borderRadius: 8,
                        border: 'none',
                        backgroundColor: '#00E5A0',
                        color: '#0D0D0D',
                        fontFamily: 'Inter, sans-serif',
                        fontWeight: 600,
                        fontSize: 14,
                        cursor: 'pointer',
                      }}
                    >
                      Open
                    </button>
                  </div>
                </div>
                {plannerGateMsg && (
                  <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#C9A84C', margin: '6px 0 0', paddingLeft: 4 }}>
                    Meal Planner is a Pro feature. Upgrade from your profile.
                  </p>
                )}
              </div>

              {/* B. DAY PLAN */}
              <div ref={dayPlanRef} style={{ ...cardBase, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <p style={{ ...secLabel, margin: 0 }}>Day Plan</p>
                  {isPro ? (
                    <button
                      onClick={onOpenMealPlanner}
                      style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 600, color: '#00E5A0', cursor: 'pointer', padding: 0 }}
                    >
                      View Week
                    </button>
                  ) : (
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 600, color: '#C9A84C', letterSpacing: '0.08em', textTransform: 'uppercase' }}>PRO</span>
                  )}
                </div>

                {isPro ? (() => {
                  const weekdayToKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
                  const todayKey = weekdayToKey[new Date().getDay()]
                  const todaySlots = dashboardPlan?.[todayKey]
                  if (dashboardPlan === undefined) {
                    return <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', margin: 0 }}>Loading…</p>
                  }
                  if (!dashboardPlan) {
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', margin: 0, flex: 1 }}>No plan this week.</p>
                        <button
                          onClick={onOpenMealPlanner}
                          style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 600, color: '#00E5A0', cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' }}
                        >
                          Build your week →
                        </button>
                      </div>
                    )
                  }
                  return (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                      {[{ key: 'breakfast', label: 'BREAKFAST' }, { key: 'lunch', label: 'LUNCH' }, { key: 'dinner', label: 'DINNER' }].map(({ key, label }) => {
                        const slot = todaySlots?.[key]
                        return (
                          <button
                            key={key}
                            onClick={() => onOpenMealPlanner({ day: todayKey, meal: key })}
                            style={{ backgroundColor: '#111111', border: '0.5px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer', textAlign: 'left', width: '100%' }}
                          >
                            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#888888', letterSpacing: '0.10em', textTransform: 'uppercase', flexShrink: 0 }}>{label}</span>
                            {slot ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end', minWidth: 0 }}>
                                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 500, color: '#F0F0F0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{slot.title}</span>
                                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#00E5A0', flexShrink: 0 }}>{slot.macros?.kcal} kcal</span>
                              </div>
                            ) : (
                              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888' }}>—</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )
                })() : (
                  <div style={{ opacity: 0.5 }}>
                    <div className="day-plan-slots" style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
                      {[{ key: 'breakfast', label: 'BREAKFAST' }, { key: 'lunch', label: 'LUNCH' }, { key: 'dinner', label: 'DINNER' }].map(({ key, label }) => (
                        <div key={key} style={{ backgroundColor: '#111111', border: '0.5px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 12, minHeight: 56 }}>
                          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 8px' }}>{label}</p>
                          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888' }}>Unlock with Pro</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* C. BOTTOM ROW */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

                {/* Recent meals — gated: direct + pro tiers only */}
                <div style={{ ...cardBase, padding: 16 }}>
                  <p style={{ ...secLabel, marginBottom: 12 }}>Recent Meals</p>
                  {!canViewHistory ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <svg viewBox="0 0 18 14" width="13" height="10" fill="#C9A84C"><path d="M9 0L11.5 5L18 3.5L15 10H3L0 3.5L6.5 5L9 0Z"/><rect x="3" y="11" width="12" height="2.5" rx="1"/></svg>
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888' }}>Pro feature — session history is unlocked with Pro.</span>
                    </div>
                  ) : recentMeals.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      {recentMeals.map((meal, i) => (
                        <div key={i}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 10 }}>
                            <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#00E5A0', flexShrink: 0 }} />
                            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#CCCCCC', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meal.name}</span>
                            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#888888', flexShrink: 0 }}>{meal.kcal}</span>
                          </div>
                          {i < recentMeals.length - 1 && <div style={{ height: '0.5px', backgroundColor: '#222222', marginBottom: 10 }} />}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', margin: 0 }}>No meals cooked yet.</p>
                  )}
                </div>

                {/* Weekly adherence */}
                <div style={{ ...cardBase, padding: 16 }}>
                  <p style={{ ...secLabel, marginBottom: 12 }}>This Week</p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 14 }}>
                    {weekData.map((day, i) => {
                      let bg = '#111111', letterColor = '#888888', border = 'none'
                      if (day.hit)     { bg = '#0D2B1E'; letterColor = '#00E5A0' }
                      if (day.miss)    { bg = '#1E1515' }
                      if (day.isToday) { bg = '#0D2B1E'; border = '0.5px solid #00E5A0'; letterColor = '#00E5A0' }
                      return (
                        <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                          <div style={{ width: '100%', height: 28, borderRadius: 4, backgroundColor: bg, border }} />
                          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 9, color: letterColor }}>{day.letter}</span>
                        </div>
                      )
                    })}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-around' }}>
                    {[
                      { label: 'Adherence', value: `${adherencePct}%` },
                      { label: 'Streak',    value: String(streakCount)  },
                      { label: 'Avg protein', value: avgProtein != null ? `${avgProtein}g` : '—' },
                    ].map(({ label, value }) => (
                      <div key={label} style={{ textAlign: 'center' }}>
                        <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 700, color: '#00E5A0', margin: '0 0 4px', lineHeight: 1 }}>{value}</p>
                        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#888888', margin: 0, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* MY COOKBOOK — full-width button, taps to dedicated cookbook page */}
              <button
                onClick={onOpenCookbook}
                style={{ width: '100%', height: 56, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#1A1A1A', color: '#F0F0F0', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px' }}>
                <span>My Cookbook</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: '#888888' }}>{savedRecipes.length} saved</span>
                  <span style={{ color: '#888888', fontSize: 16 }}>→</span>
                </span>
              </button>

              {/* Coach card */}
              {isCoach && profile?.referralSlug && (
                <CoachCard slug={profile.referralSlug} clientCount={profile.clientCount ?? 0} seatCap={20} onViewRoster={onViewRoster} />
              )}

              {/* Coach strip — shown to referred clients only */}
              {!isCoach && profile?.referredBy && (
                <CoachStrip referredBy={profile.referredBy} savedRecipes={savedRecipes} onLetKnow={onLetCoachKnow} />
              )}

              {/* Quick Start + sign out */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 }}>
                <button onClick={onQuickStart}
                  style={{ width: '100%', height: 52, borderRadius: 8, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 16, cursor: 'pointer' }}>
                  Start cooking →
                </button>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 24 }}>
                  {isAdmin && (
                    <button onClick={onAdminPanel} style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', cursor: 'pointer', padding: '4px 0' }}>Admin</button>
                  )}
                  <button onClick={onSignOut} style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', cursor: 'pointer', padding: '4px 0' }}>Sign out</button>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>

      {/* Log meal bottom sheet — responsive: max-width 480px centred desktop, full-width mobile */}
      {logMealOpen && (
        <div
          onClick={() => setLogMealOpen(false)}
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 9500, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 480, backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px 10px 0 0', padding: '24px 20px 40px', boxSizing: 'border-box' }}>
            {/* Header */}
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 20px', textAlign: 'center' }}>
              Log a Meal
            </p>

            {/* Meal name */}
            <input
              type="text"
              value={logName}
              onChange={e => setLogName(e.target.value)}
              placeholder="Meal name"
              style={{ width: '100%', height: 48, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#0D0D0D', color: '#F0F0F0', fontFamily: 'Inter, sans-serif', fontSize: 16, padding: '0 14px', boxSizing: 'border-box', outline: 'none', marginBottom: 10 }}
            />

            {/* kcal */}
            <input
              type="number"
              value={logKcal}
              onChange={e => setLogKcal(e.target.value)}
              placeholder="Calories (kcal)"
              style={{ width: '100%', height: 48, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#0D0D0D', color: '#F0F0F0', fontFamily: 'Inter, sans-serif', fontSize: 16, padding: '0 14px', boxSizing: 'border-box', outline: 'none', marginBottom: 10 }}
            />

            {/* Optional macros row — 3 equal-width inputs */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
              {[
                { label: 'Protein (g)', val: logProtein, set: setLogProtein },
                { label: 'Carbs (g)',   val: logCarbs,   set: setLogCarbs   },
                { label: 'Fat (g)',     val: logFat,     set: setLogFat     },
              ].map(({ label, val, set }) => (
                <input
                  key={label}
                  type="number"
                  value={val}
                  onChange={e => set(e.target.value)}
                  placeholder={label}
                  style={{ height: 44, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#0D0D0D', color: '#F0F0F0', fontFamily: 'Inter, sans-serif', fontSize: 13, padding: '0 10px', boxSizing: 'border-box', outline: 'none', width: '100%' }}
                />
              ))}
            </div>

            {/* Meal slot chips */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              {['breakfast','lunch','dinner'].map(slot => {
                const active = logSlot === slot
                return (
                  <button
                    key={slot}
                    onClick={() => setLogSlot(slot)}
                    style={{ flex: 1, height: 44, borderRadius: 8, border: `1px solid ${active ? '#00E5A0' : 'rgba(255,255,255,0.08)'}`, backgroundColor: active ? '#00E5A0' : '#1A1A1A', color: active ? '#0D0D0D' : '#F0F0F0', fontFamily: 'Inter, sans-serif', fontWeight: active ? 600 : 500, fontSize: 13, cursor: 'pointer', textTransform: 'capitalize', transition: 'background-color 150ms ease, border-color 150ms ease' }}>
                    {slot.charAt(0).toUpperCase() + slot.slice(1)}
                  </button>
                )
              })}
            </div>

            {/* Confirm */}
            <button
              disabled={!logName.trim() || !logKcal}
              onClick={() => {
                if (!logName.trim() || !logKcal) return
                try {
                  const todayStr = new Date().toISOString().slice(0, 10)
                  const raw  = localStorage.getItem('remi_day_plan')
                  let plan   = raw ? JSON.parse(raw) : null
                  if (!plan || plan.date !== todayStr) {
                    plan = { date: todayStr, breakfast: null, lunch: null, dinner: null }
                  }
                  plan[logSlot] = {
                    name:    logName.trim(),
                    kcal:    parseInt(logKcal) || 0,
                    protein: parseInt(logProtein) || 0,
                    carbs:   parseInt(logCarbs)   || 0,
                    fat:     parseInt(logFat)     || 0,
                  }
                  localStorage.setItem('remi_day_plan', JSON.stringify(plan))
                  // Optionally append to saved recipes if not already present
                  const alreadySaved = savedRecipes.some(r => r.name?.toLowerCase() === logName.trim().toLowerCase())
                  if (!alreadySaved) {
                    onAddManualSavedRecipe({
                      name: logName.trim(),
                      dietician: { macros: { calories: logKcal, protein: logProtein || '—', carbs: logCarbs || '—', fat: logFat || '—' }, cookSteps: [], whatChanges: [] },
                      chef: { cuisine: '', flavour: '', steps: [], calories: '' },
                    })
                  }
                  onDayPlanUpdated()
                } catch {}
                const slotLabel = logSlot.charAt(0).toUpperCase() + logSlot.slice(1)
                showDashToast(`Logged to ${slotLabel}`)
                setLogMealOpen(false)
                setLogName(''); setLogKcal(''); setLogProtein(''); setLogCarbs(''); setLogFat(''); setLogSlot('dinner')
              }}
              style={{ width: '100%', height: 56, borderRadius: 8, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 10, opacity: (!logName.trim() || !logKcal) ? 0.4 : 1, transition: 'opacity 200ms ease' }}>
              Log meal
            </button>
            <button
              onClick={() => { setLogMealOpen(false); setLogName(''); setLogKcal(''); setLogProtein(''); setLogCarbs(''); setLogFat(''); setLogSlot('dinner') }}
              style={{ display: 'block', width: '100%', background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', cursor: 'pointer', textAlign: 'center', padding: '8px 0' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Saved recipes drawer */}
      {savedRecipesDrawer && (
        <div
          onClick={() => setSavedRecipesDrawer(false)}
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 9500, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 480, maxHeight: '72vh', backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px 10px 0 0', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxSizing: 'border-box' }}>
            <div style={{ padding: '20px 20px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: 0, textAlign: 'center' }}>
                Saved Recipes
              </p>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
              {savedRecipes.length === 0 ? (
                <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', padding: '24px 20px', textAlign: 'center', margin: 0 }}>
                  No saved recipes yet.
                </p>
              ) : (
                savedRecipes.map((recipe, i) => (
                  <div
                    key={recipe._id || i}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderBottom: i < savedRecipes.length - 1 ? '0.5px solid rgba(255,255,255,0.06)' : 'none' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontFamily: 'Inter, sans-serif', fontWeight: 500, fontSize: 14, color: '#F0F0F0', margin: '0 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {recipe.name}
                      </p>
                      <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: '#888888', margin: 0 }}>
                        {recipe.dietician?.macros?.calories || '—'} kcal
                      </p>
                    </div>
                    <button
                      onClick={() => { setSavedRecipesDrawer(false); onLogSavedRecipe(recipe) }}
                      style={{ flexShrink: 0, height: 32, padding: '0 14px', borderRadius: 16, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                      Log this
                    </button>
                  </div>
                ))
              )}
            </div>
            <div style={{ padding: '12px 20px 32px', flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <button
                onClick={() => setSavedRecipesDrawer(false)}
                style={{ display: 'block', width: '100%', background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 400, color: '#888888', cursor: 'pointer', textAlign: 'center', padding: '8px 0' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Day Plan bottom sheet modal */}
      {dayPlanModal && (
        <div
          onClick={() => setDayPlanModal(null)}
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 9000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 480, backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px 10px 0 0', padding: '24px 20px 40px', boxSizing: 'border-box' }}>
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 20px', textAlign: 'center' }}>
              {dayPlanModal.mealLabel}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                onClick={() => {
                  const prompt = `Give me a ${dayPlanModal.mealKey} for today`
                  const key = dayPlanModal.mealKey
                  setDayPlanModal(null)
                  onOpenCookWithPrompt(prompt, key)
                }}
                style={{ width: '100%', height: 56, borderRadius: 8, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15, cursor: 'pointer' }}>
                Generate with Remi
              </button>
              <button
                onClick={() => {
                  setDayPlanModal(null)
                  setSavedRecipesDrawer(true)
                }}
                style={{ width: '100%', height: 56, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#1A1A1A', color: '#F0F0F0', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15, cursor: 'pointer' }}>
                Choose from saved
              </button>
              <button
                onClick={() => {
                  setDayPlanModal(null)
                  showDashToast('Meal logging coming in the next build.')
                }}
                style={{ width: '100%', height: 56, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#1A1A1A', color: '#F0F0F0', fontFamily: 'Inter, sans-serif', fontWeight: 400, fontSize: 15, cursor: 'pointer' }}>
                Log manually
              </button>
            </div>
            <button
              onClick={() => setDayPlanModal(null)}
              style={{ display: 'block', width: '100%', marginTop: 16, background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 400, color: '#888888', cursor: 'pointer', textAlign: 'center', padding: '8px 0' }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  )
}


const ONBOARDING_STYLES = `
  @keyframes ob-fade-up {
    from { opacity: 0; transform: translateY(14px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .ob-step { animation: ob-fade-up 0.28s ease both; }

  @keyframes obProgressPulse {
    from { background-color: #00E5A0; opacity: 1; }
    50%  { background-color: rgba(0,229,160,0.5); opacity: 1; }
    to   { background-color: #00E5A0; opacity: 0; }
  }
  .ob-progress-pulse {
    position: absolute; top: 0; left: 0; height: 100%;
    border-radius: 0 2px 2px 0; pointer-events: none;
    animation: obProgressPulse 150ms ease-out 1 forwards;
  }

  @keyframes remi-scale-in {
    0%   { opacity: 0; transform: scale(0.55); }
    65%  { transform: scale(1.07); }
    100% { opacity: 1; transform: scale(1); }
  }
  .remi-scale-in { animation: remi-scale-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both; }

  @keyframes remi-word-up {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .remi-word-up { animation: remi-word-up 0.38s ease 0.28s both; }
`

// ── Onboarding v5 — 9 steps ────────────────────────────────────────────────────

const OB_GOALS_V5 = [
  'Lose fat',
  'Build lean muscle',
  'Improve performance',
  'Eat with more care',
  'Maintain',
]

const OB_FREQ_V5 = [
  'Rarely',
  '1–2× a week',
  '3–4× a week',
  '5–6× a week',
  'Every day',
]

const OB_KITCHEN_V5 = [
  'I follow recipes',
  'I know my way around',
  'I can improvise',
]

const OB_SPORT_GOALS_V5 = [
  'A fight or competition',
  'An event — race, tournament, game',
  'A performance milestone',
  'Building the habit',
  'Nothing specific right now',
]

const TRAINING_GROUPS_V5 = [
  { label: 'COMBAT',        sports: ['Boxing', 'Muay Thai', 'BJJ / Grappling', 'MMA', 'Wrestling'] },
  { label: 'STRENGTH',      sports: ['Weightlifting', 'Powerlifting', 'CrossFit', 'HIIT'] },
  { label: 'ENDURANCE',     sports: ['Running', 'Cycling', 'Swimming', 'Rowing'] },
  { label: 'MOVEMENT',      sports: ['Pilates', 'Yoga'] },
  { label: 'FIELD & COURT', sports: ['Football / AFL', 'Basketball', 'Tennis', 'Golf', 'Other'] },
]

function mapGoalForApi(goals) {
  if (goals.includes('Lose fat')) return 'cut'
  if (goals.includes('Build lean muscle')) return 'bulk'
  if (goals.includes('Improve performance')) return 'performance'
  if (goals.includes('Eat with more care')) return 'eat_clean'
  return 'maintain'
}

function inferPrimaryFromTypes(types) {
  if (types.length === 0) return ''
  if (types.length === 1) return types[0]
  const groups = [
    ['Boxing', 'Muay Thai', 'BJJ / Grappling', 'MMA', 'Wrestling'],
    ['Weightlifting', 'Powerlifting', 'CrossFit', 'HIIT'],
    ['Running', 'Cycling', 'Swimming', 'Rowing'],
    ['Pilates', 'Yoga'],
    ['Football / AFL', 'Basketball', 'Tennis', 'Golf', 'Other'],
  ]
  let bestSport = types[0]
  let bestCount = 0
  for (const g of groups) {
    const matches = types.filter(t => g.includes(t))
    if (matches.length > bestCount) { bestCount = matches.length; bestSport = matches[0] }
  }
  return bestSport
}

function NumericKeypad({ value, onChange }) {
  function press(k) {
    if (k === 'DEL') { onChange(v => v.slice(0, -1)); return }
    if (k === '.' && value.includes('.')) return
    if (value.length >= 6) return
    if (k === '.' && value === '') { onChange(() => '0.'); return }
    if (value === '0' && k !== '.') { onChange(() => k); return }
    onChange(v => v + k)
  }
  const keys = ['1','2','3','4','5','6','7','8','9','.','0','DEL']
  const kStyle = {
    height: 56, borderRadius: 8,
    backgroundColor: '#1A1A1A',
    border: '1px solid rgba(255,255,255,0.08)',
    color: '#F0F0F0',
    fontWeight: 500,
    cursor: 'pointer', touchAction: 'manipulation',
    transition: 'background 150ms ease', outline: 'none',
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
      {keys.map(k => (
        <button
          key={k}
          onClick={() => press(k)}
          style={{
            ...kStyle,
            fontFamily: k === 'DEL' ? 'Inter, sans-serif' : 'JetBrains Mono, monospace',
            fontSize: k === 'DEL' ? 18 : 22,
          }}
        >
          {k}
        </button>
      ))}
    </div>
  )
}

function Onboarding({ onComplete, onBack, onAlreadyOnboarded, existingProfile = null, userRole = 'free' }) {
  const [step,              setStep]          = useState(1)
  const [name,              setName]          = useState('')
  const [weight,            setWeight]        = useState('')
  const [goals,             setGoals]         = useState([])
  const [targetWeight,      setTargetWeight]  = useState('')
  const [trainingFreq,      setTrainingFreq]  = useState('')
  const [trainingTypes,     setTrainingTypes] = useState([])
  const [sportGoal,         setSportGoal]     = useState('')
  const [fightDay,          setFightDay]      = useState('')
  const [fightMonth,        setFightMonth]    = useState('')
  const [fightYear,         setFightYear]     = useState('')
  const [fightTargetWeight, setFightTargetWt] = useState('')
  const [foodsToAvoid,      setFoodsToAvoid]  = useState('')
  const [kitchenSkill,      setKitchenSkill]  = useState('')

  const isMaintainOnly = goals.length === 1 && goals.includes('Maintain')
  const isCombat       = trainingTypes.some(t => COMBAT_SPORTS.includes(t))
  const isFightGoal    = sportGoal === 'A fight or competition'

  // Visible-step model: counter + progress bar derive from this single source.
  // Step 4 (target weight) is hidden when goals are Maintain-only.
  const visibleSteps  = isMaintainOnly ? [1, 2, 3, 5, 6, 7, 8, 9] : [1, 2, 3, 4, 5, 6, 7, 8, 9]
  const visibleIndex  = visibleSteps.indexOf(step) + 1
  const visibleTotal  = visibleSteps.length
  const isFinalStep   = step === visibleSteps[visibleSteps.length - 1]

  function fightDateISO() {
    if (!fightDay || !fightMonth || !fightYear || fightYear.length < 4) return ''
    const d = parseInt(fightDay), m = parseInt(fightMonth), y = parseInt(fightYear)
    if (isNaN(d) || isNaN(m) || isNaN(y) || d < 1 || d > 31 || m < 1 || m > 12) return ''
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }

  function getWeeksOut() {
    const iso = fightDateISO()
    if (!iso) return null
    const ms = new Date(iso) - new Date()
    if (ms <= 0) return 0
    return Math.ceil(ms / (7 * 24 * 60 * 60 * 1000))
  }

  // Safety check — if this user already has a DB row, skip onboarding entirely
  useEffect(() => {
    if (!onAlreadyOnboarded) return
    let cancelled = false
    const raw = localStorage.getItem('supabase.auth.token')
    if (!raw) return
    let token
    try { token = JSON.parse(raw)?.access_token } catch { return }
    if (!token) return
    fetch('/api/auth-user', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { if (!cancelled && data.dbRowExists) onAlreadyOnboarded() })
      .catch(() => {})
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function advanceStep() {
    if (step === 3 && isMaintainOnly) return setStep(5)
    setStep(s => s + 1)
  }

  function retreatStep() {
    if (step === 1) { onBack(); return }
    if (step === 5 && isMaintainOnly) return setStep(3)
    setStep(s => s - 1)
  }

  function canProceed() {
    const validNum = v => v !== '' && !isNaN(Number(v)) && Number(v) > 0
    switch (step) {
      case 1: return name.trim().length > 0
      case 2: return validNum(weight)
      case 3: return goals.length > 0
      case 4: return validNum(targetWeight)
      case 5: return trainingFreq.length > 0
      case 6: return trainingTypes.length > 0
      case 7: {
        if (!sportGoal) return false
        if (isCombat && isFightGoal) {
          return !!fightDateISO() && fightTargetWeight !== '' && Number(fightTargetWeight) > 0
        }
        return true
      }
      case 8: return true
      case 9: return kitchenSkill.length > 0
      default: return false
    }
  }

  function handleComplete() {
    const resolvedPrimary = inferPrimaryFromTypes(trainingTypes)
    const isoDate   = fightDateISO()
    const weightCut = isCombat && isFightGoal && !!isoDate && !!fightTargetWeight
    const goal      = mapGoalForApi(goals)
    onComplete({
      version:            PROFILE_VERSION,
      name:               name.trim(),
      weight:             Number(weight) || null,
      currentWeight:      Number(weight) || null,
      goals,
      goal,
      targetWeight:       isMaintainOnly ? null : (Number(targetWeight) || null),
      trainingFrequency:  trainingFreq,
      trainingTypes,
      training:           trainingTypes,
      primarySport:       resolvedPrimary,
      sportGoal,
      fightDate:          weightCut ? isoDate : '',
      fightTargetWeight:  weightCut ? (Number(fightTargetWeight) || null) : null,
      weightCutMode:      weightCut,
      trainingPhilosophy: null,
      foodsToAvoid:       foodsToAvoid.trim(),
      avoidFoods:         foodsToAvoid.trim(),
      kitchenSkill,
    })
  }

  const HS = { fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(1.75rem, 6vw, 2.25rem)', color: '#F0F0F0', lineHeight: 1.1, margin: 0 }
  const IS = { width: '100%', borderRadius: 8, backgroundColor: '#0D0D0D', border: '1px solid rgba(255,255,255,0.12)', color: '#F0F0F0', padding: '14px 18px', fontFamily: 'Inter, sans-serif', fontSize: 16, outline: 'none', boxSizing: 'border-box', transition: 'border-color 150ms ease', touchAction: 'manipulation' }

  // Full-width stacked row (single/multi-select — steps 3 5 7 9)
  const RS = sel => ({
    display: 'flex', alignItems: 'center',
    width: '100%', minHeight: 56, borderRadius: 8,
    border: `1px solid ${sel ? '#00E5A0' : 'rgba(255,255,255,0.08)'}`,
    backgroundColor: sel ? '#00E5A0' : '#1A1A1A',
    color: sel ? '#0D0D0D' : '#F0F0F0',
    fontFamily: 'Inter, sans-serif', fontSize: 16, fontWeight: sel ? 600 : 500,
    padding: '0 20px', cursor: 'pointer',
    transition: 'background 200ms ease, border-color 200ms ease',
    textAlign: 'left', outline: 'none', touchAction: 'manipulation',
  })

  // Grouped chip (step 6 only)
  const CP = sel => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    padding: '0 16px', minHeight: 44, borderRadius: 8,
    border: `1px solid ${sel ? '#00E5A0' : 'rgba(255,255,255,0.08)'}`,
    backgroundColor: sel ? '#00E5A0' : '#1A1A1A',
    color: sel ? '#0D0D0D' : '#F0F0F0',
    fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: sel ? 600 : 500,
    cursor: 'pointer', transition: 'background 150ms ease, border-color 150ms ease',
    whiteSpace: 'nowrap', outline: 'none', touchAction: 'manipulation',
  })

  const weeksOutValue = getWeeksOut()

  const backChevron = (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd"/>
    </svg>
  )

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
      <style>{ONBOARDING_STYLES}</style>

      {/* Mint progress line — fixed top */}
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 3, backgroundColor: '#1A1A1A', zIndex: 100 }}>
        <div style={{ height: '100%', width: `${(visibleIndex / visibleTotal) * 100}%`, backgroundColor: '#00E5A0', transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)', borderRadius: '0 2px 2px 0' }} />
        <div key={step} className="ob-progress-pulse" style={{ width: `${(visibleIndex / visibleTotal) * 100}%` }} />
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', maxWidth: 480, width: '100%', margin: '0 auto', padding: '60px 24px 40px' }}>

        {/* Profile tier badge — shown only when editing an existing profile */}
        {existingProfile?.name && (() => {
          const t = getUserTier({ role: userRole })
          const BADGE_STYLES = {
            free:        { bg: '#1A1A1A', color: '#888888', border: 'rgba(255,255,255,0.08)' },
            pt_referred: { bg: '#1A1A1A', color: '#888888', border: 'rgba(255,255,255,0.08)' },
            direct:      { bg: '#1A1A1A', color: '#F0F0F0', border: 'rgba(255,255,255,0.08)' },
            pro:         { bg: '#00E5A0', color: '#0D0D0D', border: '#00E5A0' },
            coach:       { bg: '#0D0D0D', color: '#00E5A0', border: '#00E5A0' },
            fighter:     { bg: '#0D0D0D', color: '#00E5A0', border: '#00E5A0' },
            admin:       { bg: '#00E5A0', color: '#0D0D0D', border: '#00E5A0' },
          }
          const TIER_DESC = {
            free:        '5 saved recipes · Recipe generation',
            pt_referred: '20 saved recipes · Recipe generation',
            direct:      'Unlimited saves · Full dashboard',
            pro:         'Meal Planner · Intel Hub · Full access',
            coach:       'Full Pro access · Roster · Client plans',
            fighter:     'Full Pro access · Weight cut mode',
            admin:       'Full Pro access · Admin panel',
          }
          const bs    = BADGE_STYLES[t.role] || BADGE_STYLES.free
          const desc  = TIER_DESC[t.role]    || TIER_DESC.free
          const label = t.role === 'pt_referred' ? 'PT REFERRED' : t.role.toUpperCase()
          return (
            <div style={{ marginBottom: 28, paddingBottom: 20, borderBottom: '0.5px solid rgba(255,255,255,0.08)' }}>
              <p style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 22, color: '#F0F0F0', margin: '0 0 10px' }}>
                {existingProfile.name.split(' ')[0]}
              </p>
              <span style={{
                display: 'inline-block',
                fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 11,
                letterSpacing: '0.1em', textTransform: 'uppercase',
                padding: '4px 10px', borderRadius: 4,
                backgroundColor: bs.bg, color: bs.color,
                border: `1px solid ${bs.border}`,
              }}>
                {label}
              </span>
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', margin: '8px 0 0' }}>
                {desc}
              </p>
            </div>
          )
        })()}

        {/* Header: back chevron left + step counter centred */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative', marginBottom: 44 }}>
          <button onClick={retreatStep} style={{ background: 'none', border: 'none', color: '#888888', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', zIndex: 1 }}>
            {backChevron}
          </button>
          <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: '#888888', letterSpacing: '0.12em' }}>
            {visibleIndex.toString().padStart(2, '0')} / {visibleTotal.toString().padStart(2, '0')}
          </span>
          <div style={{ width: 20 }} />
        </div>

        {/* Step content */}
        <div key={step} className="ob-step" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 24 }}>

          {/* 1 — Name */}
          {step === 1 && (
            <>
              <div style={{ marginBottom: 4 }}>
                <img src={remiLogoUrl} alt="Remi" style={{ width: 44, height: 44, display: 'block' }} />
              </div>
              <h2 style={HS}>Let's start. What do I call you?</h2>
              <input
                type="text" value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && canProceed()) advanceStep() }}
                onFocus={e => { e.target.style.borderColor = '#00E5A0' }}
                onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.12)' }}
                placeholder="Your first name" style={IS} autoFocus
              />
            </>
          )}

          {/* 2 — Current weight */}
          {step === 2 && (
            <>
              <h2 style={HS}>Current weight in kg.</h2>
              <div style={{ textAlign: 'center', fontFamily: 'JetBrains Mono, monospace', fontSize: 'clamp(3.5rem, 14vw, 5.5rem)', fontWeight: 700, color: weight ? '#F0F0F0' : '#333333', letterSpacing: '-0.02em', lineHeight: 1 }}>
                {weight || '—'}
              </div>
              <div style={{ textAlign: 'center', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', marginTop: -8 }}>kg</div>
              <NumericKeypad value={weight} onChange={setWeight} />
            </>
          )}

          {/* 3 — Goals */}
          {step === 3 && (
            <>
              <h2 style={HS}>What are we working toward? Pick everything that applies.</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {OB_GOALS_V5.map(g => (
                  <button
                    key={g}
                    onClick={() => setGoals(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g])}
                    style={RS(goals.includes(g))}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* 4 — Target weight (skipped when Maintain-only) */}
          {step === 4 && (
            <>
              <h2 style={HS}>Target weight in kg. We'll work backward from here.</h2>
              <div style={{ textAlign: 'center', fontFamily: 'JetBrains Mono, monospace', fontSize: 'clamp(3.5rem, 14vw, 5.5rem)', fontWeight: 700, color: targetWeight ? '#F0F0F0' : '#333333', letterSpacing: '-0.02em', lineHeight: 1 }}>
                {targetWeight || '—'}
              </div>
              <div style={{ textAlign: 'center' }}>
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888' }}>kg</span>
                {weight && targetWeight && Number(targetWeight) > 0 && (() => {
                  const delta = Number(weight) - Number(targetWeight)
                  if (delta === 0) return null
                  const sign = delta > 0 ? '−' : '+'
                  return (
                    <span style={{ display: 'block', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', marginTop: 6 }}>
                      {sign}{Math.abs(delta).toFixed(1)} kg from today
                    </span>
                  )
                })()}
              </div>
              <NumericKeypad value={targetWeight} onChange={setTargetWeight} />
            </>
          )}

          {/* 5 — Frequency */}
          {step === 5 && (
            <>
              <h2 style={HS}>How often do you train. Honest answer.</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {OB_FREQ_V5.map(f => (
                  <button key={f} onClick={() => setTrainingFreq(f)} style={RS(trainingFreq === f)}>{f}</button>
                ))}
              </div>
            </>
          )}

          {/* 6 — Training types — grouped chips */}
          {step === 6 && (
            <>
              <h2 style={HS}>What does your training look like?</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                {TRAINING_GROUPS_V5.map(group => (
                  <div key={group.label}>
                    <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 10px' }}>
                      {group.label}
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {group.sports.map(sport => (
                        <button
                          key={sport}
                          onClick={() => setTrainingTypes(prev => prev.includes(sport) ? prev.filter(x => x !== sport) : [...prev, sport])}
                          style={CP(trainingTypes.includes(sport))}
                        >
                          {sport}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* 7 — Sport goal + conditional weight-cut sub-step */}
          {step === 7 && (
            <>
              <h2 style={HS}>Do you have a specific goal coming up?</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {OB_SPORT_GOALS_V5.map(g => (
                  <button
                    key={g}
                    onClick={() => setSportGoal(g)}
                    style={{ ...RS(sportGoal === g), whiteSpace: 'normal', lineHeight: 1.4, paddingTop: 14, paddingBottom: 14 }}
                  >
                    {g}
                  </button>
                ))}
              </div>

              {isCombat && isFightGoal && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 20, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#00E5A0', letterSpacing: '0.12em', textTransform: 'uppercase', margin: 0 }}>
                    WEIGHT-CUT MODE
                  </p>

                  {/* Fight date DD · MM · YYYY */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="text" inputMode="numeric" maxLength={2}
                      value={fightDay}
                      onChange={e => setFightDay(e.target.value.replace(/\D/g, '').slice(0, 2))}
                      placeholder="DD"
                      style={{ width: 50, textAlign: 'center', fontFamily: 'JetBrains Mono, monospace', fontSize: 16, backgroundColor: '#0D0D0D', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#F0F0F0', padding: '10px 4px', outline: 'none', touchAction: 'manipulation' }}
                    />
                    <span style={{ color: '#888888', fontFamily: 'JetBrains Mono, monospace', fontSize: 16 }}>·</span>
                    <input
                      type="text" inputMode="numeric" maxLength={2}
                      value={fightMonth}
                      onChange={e => setFightMonth(e.target.value.replace(/\D/g, '').slice(0, 2))}
                      placeholder="MM"
                      style={{ width: 50, textAlign: 'center', fontFamily: 'JetBrains Mono, monospace', fontSize: 16, backgroundColor: '#0D0D0D', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#F0F0F0', padding: '10px 4px', outline: 'none', touchAction: 'manipulation' }}
                    />
                    <span style={{ color: '#888888', fontFamily: 'JetBrains Mono, monospace', fontSize: 16 }}>·</span>
                    <input
                      type="text" inputMode="numeric" maxLength={4}
                      value={fightYear}
                      onChange={e => setFightYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      placeholder="YYYY"
                      style={{ width: 72, textAlign: 'center', fontFamily: 'JetBrains Mono, monospace', fontSize: 16, backgroundColor: '#0D0D0D', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#F0F0F0', padding: '10px 6px', outline: 'none', touchAction: 'manipulation' }}
                    />
                    {weeksOutValue !== null && weeksOutValue > 0 && (
                      <span style={{ marginLeft: 8, fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: '#888888' }}>
                        {weeksOutValue}w out
                      </span>
                    )}
                  </div>

                  {/* Fight-week weight */}
                  <input
                    type="number"
                    value={fightTargetWeight}
                    onChange={e => setFightTargetWt(e.target.value)}
                    placeholder="Fight week weight (kg)"
                    inputMode="decimal"
                    onFocus={e => { e.target.style.borderColor = '#00E5A0' }}
                    onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.12)' }}
                    style={{ ...IS }}
                  />

                  {/* Pace row (+ advisory flag when weekly pace exceeds 1% of current bodyweight) */}
                  {fightDateISO() && fightTargetWeight && Number(fightTargetWeight) > 0 && (() => {
                    const cutKg = Number(weight) - Number(fightTargetWeight)
                    const weeks = weeksOutValue
                    if (!weeks || weeks <= 0 || cutKg <= 0) return null
                    const perWeek    = cutKg / weeks
                    const currentKg  = Number(weight)
                    const pacePct    = currentKg > 0 ? (perWeek / currentKg) * 100 : 0
                    const sharpCut   = pacePct > 1.0
                    const firstName  = name.trim()
                    const sharpLine  = firstName
                      ? `That's a sharp cut, ${firstName}. We can do it — but the kitchen has to be exact, or give yourself more weeks.`
                      : `That's a sharp cut. We can do it — but the kitchen has to be exact, or give yourself more weeks.`
                    return (
                      <>
                        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: '#888888' }}>
                          To cut {cutKg.toFixed(1)} kg&nbsp;&nbsp;/&nbsp;&nbsp;Per week {perWeek.toFixed(2)} kg
                        </div>
                        {sharpCut && (
                          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontStyle: 'normal', lineHeight: 1.5, color: '#FF4D4D' }}>
                            {sharpLine}
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>
              )}
            </>
          )}

          {/* 8 — Foods to avoid (optional) */}
          {step === 8 && (
            <>
              <h2 style={HS}>Anything off the table — allergies, dislikes, non-negotiables?</h2>
              <input
                type="text" value={foodsToAvoid}
                onChange={e => setFoodsToAvoid(e.target.value)}
                onFocus={e => { e.target.style.borderColor = '#00E5A0' }}
                onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.12)' }}
                placeholder="Optional — e.g. no nuts, no pork"
                style={IS} autoFocus
              />
            </>
          )}

          {/* 9 — Kitchen skill */}
          {step === 9 && (
            <>
              <h2 style={HS}>Kitchen confidence. Be honest — I'm not judging.</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {OB_KITCHEN_V5.map(k => (
                  <button key={k} onClick={() => setKitchenSkill(k)} style={RS(kitchenSkill === k)}>{k}</button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* CTAs */}
        <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {step === 8 && (
            <button
              onClick={advanceStep}
              style={{ width: '100%', height: 44, backgroundColor: 'transparent', color: '#888888', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontWeight: 500, fontSize: 14, border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer' }}
            >
              Skip
            </button>
          )}
          {!isFinalStep ? (
            <button
              onClick={() => canProceed() && advanceStep()}
              disabled={!canProceed()}
              style={{ width: '100%', height: 56, backgroundColor: canProceed() ? '#00E5A0' : '#1A1A1A', color: canProceed() ? '#0D0D0D' : '#444444', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 16, border: canProceed() ? 'none' : '1px solid rgba(255,255,255,0.08)', cursor: canProceed() ? 'pointer' : 'not-allowed', transition: 'all 200ms ease' }}
            >
              Continue
            </button>
          ) : (
            <button
              onClick={() => canProceed() && handleComplete()}
              disabled={!canProceed()}
              style={{ width: '100%', height: 56, backgroundColor: canProceed() ? '#00E5A0' : '#1A1A1A', color: canProceed() ? '#0D0D0D' : '#444444', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 16, border: canProceed() ? 'none' : '1px solid rgba(255,255,255,0.08)', cursor: canProceed() ? 'pointer' : 'not-allowed', transition: 'all 200ms ease' }}
            >
              Let's Cook
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Profile complete ───────────────────────────────────────────────────────────

function ProfileComplete({ profile, onEnter }) {
  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 24px' }}>
      <style>{ONBOARDING_STYLES}</style>
      <div style={{ textAlign: 'center', maxWidth: 360, width: '100%' }}>
        <div className="remi-scale-in" style={{ display: 'flex', justifyContent: 'center', marginBottom: 32 }}>
          <RemiLogo size={64} />
        </div>
        <h2 className="remi-word-up" style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(2.5rem, 8vw, 3.5rem)', color: '#F0F0F0', lineHeight: 1.05, marginBottom: 16 }}>
          Remi is ready.
        </h2>
        <p className="remi-word-up" style={{ fontSize: '0.9375rem', color: '#888', fontFamily: "Inter, sans-serif", lineHeight: 1.6, marginBottom: 48, animationDelay: '0.42s' }}>
          Built around you. Let's get to work.
        </p>
        <button
          onClick={onEnter}
          style={{ width: '100%', padding: '16px 24px', borderRadius: 14, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '1rem', cursor: 'pointer', boxShadow: '0 2px 16px rgba(0,229,160,0.3)', transition: 'opacity 0.15s ease' }}
          onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
          onMouseLeave={e => e.currentTarget.style.opacity = '1'}
        >
          Enter the kitchen →
        </button>
      </div>
    </div>
  )
}

// ── Pre-cook confirmation modal ───────────────────────────────────────────────

// ── Pro waitlist modal ────────────────────────────────────────────────────────

// ── Generation cap paywall modal ──────────────────────────────────────────────
function GenCapModal({ onClose }) {
  const isDesktop = window.innerWidth >= 768
  const now = new Date()
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const resetLabel = nextMonth.toLocaleDateString('en-AU', { month: 'long', day: 'numeric' })

  function handleUpgrade() {
    onClose()
    setTimeout(() => {
      const evt = new CustomEvent('remi:upgrade-toast')
      window.dispatchEvent(evt)
    }, 200)
  }

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0,
        backgroundColor: 'rgba(0,0,0,0.85)',
        zIndex: 9999,
        display: 'flex',
        alignItems: isDesktop ? 'center' : 'flex-end',
        justifyContent: 'center',
      }}
    >
      <div style={{
        backgroundColor: '#1A1A1A',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        padding: '28px 24px 32px',
        width: '100%',
        maxWidth: 480,
        marginBottom: isDesktop ? 0 : 'env(safe-area-inset-bottom, 0px)',
      }}>
        <p style={{ fontFamily: 'Inter, sans-serif', fontWeight: 400, fontSize: 11, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 14px' }}>
          THAT'S YOUR 20 FOR THE MONTH
        </p>
        <p style={{ fontFamily: 'Inter, sans-serif', fontWeight: 400, fontSize: 16, color: '#F0F0F0', margin: '0 0 8px', lineHeight: 1.5 }}>
          You've hit the free limit. Upgrade to keep cooking with Remi.
        </p>
        <p style={{ fontFamily: 'Inter, sans-serif', fontWeight: 400, fontSize: 14, color: '#888888', margin: '0 0 28px' }}>
          Resets {resetLabel}
        </p>
        <button
          onClick={handleUpgrade}
          style={{
            display: 'block', width: '100%',
            backgroundColor: '#00E5A0', color: '#0D0D0D',
            fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15,
            height: 56, borderRadius: 8, border: 'none', cursor: 'pointer',
            marginBottom: 16,
          }}
        >
          Upgrade to Pro →
        </button>
        <button
          onClick={onClose}
          style={{
            display: 'block', width: '100%',
            background: 'none', border: 'none', cursor: 'pointer',
            fontFamily: 'Inter, sans-serif', fontWeight: 400, fontSize: 14, color: '#888888',
            padding: '8px 0',
          }}
        >
          Maybe later
        </button>
      </div>
    </div>
  )
}

function ProModal({ onClose }) {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!email.trim()) return
    setSubmitting(true)
    try {
      await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), timestamp: new Date().toISOString() }),
      })
    } catch {}
    setSubmitted(true)
    setSubmitting(false)
  }

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.9)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.25rem' }}
    >
      <div style={{ position: 'relative', backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 20, padding: '2rem', maxWidth: 400, width: '100%' }}>
        <button
          onClick={onClose}
          style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: '#888888', cursor: 'pointer', fontSize: '1.375rem', lineHeight: 1 }}
          aria-label="Close"
        >×</button>

        {submitted ? (
          <p style={{ color: '#F0F0F0', textAlign: 'center', fontSize: '1rem', padding: '1rem 0' }}>
            You're on the list. We'll be in touch.
          </p>
        ) : (
          <>
            <h2 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '1.625rem', color: '#F0F0F0', marginBottom: 8 }}>
              Remi Pro
            </h2>
            <p style={{ color: '#888888', fontSize: '0.875rem', marginBottom: 16, lineHeight: 1.5 }}>
              Unlimited cooking. Training day mode. Meal history. Shopping lists.
            </p>
            <p style={{ color: '#00E5A0', fontWeight: 700, fontSize: '1.125rem', marginBottom: 24 }}>
              $4.99 / month or $39 / year
            </p>
            <form onSubmit={handleSubmit}>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                style={{ display: 'block', width: '100%', boxSizing: 'border-box', backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '12px 14px', color: '#F0F0F0', fontSize: 16, marginBottom: 12, fontFamily: "Inter, sans-serif" }}
              />
              <button
                type="submit"
                disabled={submitting || !email.trim()}
                style={{ width: '100%', backgroundColor: '#00E5A0', color: '#0D0D0D', borderRadius: 12, padding: '13px 0', fontSize: '0.9375rem', fontWeight: 600, border: 'none', cursor: submitting || !email.trim() ? 'not-allowed' : 'pointer', fontFamily: "Inter, sans-serif", opacity: submitting ? 0.7 : 1, marginBottom: 10 }}
              >
                {submitting ? 'Sending…' : 'Notify me when it\'s live'}
              </button>
              <p style={{ textAlign: 'center', color: '#888888', fontSize: '0.75rem' }}>No spam. Just Remi.</p>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

// ── PT Founders page ──────────────────────────────────────────────────────────

function PTFounderPage({ onClose }) {
  const [form, setForm] = useState({ name: '', email: '', gym: '', clientCount: '' })
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  function set(field) {
    return e => setForm(prev => ({ ...prev, [field]: e.target.value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.name.trim() || !form.email.trim()) return
    setSubmitting(true)
    try {
      await fetch('/api/pt-waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, timestamp: new Date().toISOString() }),
      })
    } catch {}
    setSubmitted(true)
    setSubmitting(false)
  }

  const inputStyle = {
    display: 'block', width: '100%', boxSizing: 'border-box',
    backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10,
    padding: '12px 14px', color: '#F0F0F0', fontSize: 16,
    fontFamily: "Inter, sans-serif", marginBottom: 12,
  }

  return (
    <div className="animate-fade-in min-h-screen" style={{ backgroundColor: '#0D0D0D' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '3rem 1.25rem 4rem' }}>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#888888', cursor: 'pointer', fontSize: '0.875rem', fontFamily: "Inter, sans-serif", marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: 6, padding: 0 }}
        >
          ← Back
        </button>

        <p style={{ fontFamily: "Inter, sans-serif", fontSize: '0.75rem', letterSpacing: '0.1em', textTransform: 'uppercase', color: '#00E5A0', marginBottom: 12 }}>
          Founding Partner Programme
        </p>
        <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '2rem', color: '#F0F0F0', marginBottom: 10, lineHeight: 1.2 }}>
          Remi for Personal Trainers
        </h1>
        <p style={{ color: '#888888', fontSize: '1rem', marginBottom: '2.5rem', lineHeight: 1.6 }}>
          The first 10 PTs who join get full dashboard access — free for life.
        </p>

        <div style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: '1.5rem', marginBottom: '2rem' }}>
          <p style={{ color: '#F0F0F0', fontSize: '0.9375rem', lineHeight: 1.7, marginBottom: '1.25rem' }}>
            Give your clients a personal chef that adjusts every meal to their goals and training. No logging. No meal plans. Just open the fridge and cook.
          </p>
          <p style={{ color: '#888888', fontSize: '0.8125rem', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.75rem' }}>
            As a founding PT partner, you get:
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              'Free Pro account for life',
              'Early access to the PT dashboard',
              'Discounted rates for your clients ($2.99/mo)',
              'A direct line to shape what gets built',
            ].map(item => (
              <li key={item} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ color: '#00E5A0', fontWeight: 700, marginTop: 1, flexShrink: 0 }}>→</span>
                <span style={{ color: '#F0F0F0', fontSize: '0.9375rem', lineHeight: 1.5 }}>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        {submitted ? (
          <div style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: '2rem', textAlign: 'center' }}>
            <p style={{ color: '#F0F0F0', fontSize: '1rem', lineHeight: 1.6 }}>
              You're in. We'll be in touch before anyone else.<br />Welcome to the kitchen.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <input
              type="text"
              value={form.name}
              onChange={set('name')}
              placeholder="Full name"
              required
              style={inputStyle}
            />
            <input
              type="email"
              value={form.email}
              onChange={set('email')}
              placeholder="Email"
              required
              style={inputStyle}
            />
            <input
              type="text"
              value={form.gym}
              onChange={set('gym')}
              placeholder="Gym / studio name"
              style={inputStyle}
            />
            <select
              value={form.clientCount}
              onChange={set('clientCount')}
              style={{ ...inputStyle, color: form.clientCount ? '#F0F0F0' : '#888888' }}
            >
              <option value="" disabled>Approx number of active clients</option>
              <option value="1-5">1–5</option>
              <option value="5-15">5–15</option>
              <option value="15-30">15–30</option>
              <option value="30+">30+</option>
            </select>
            <button
              type="submit"
              disabled={submitting || !form.name.trim() || !form.email.trim()}
              style={{ width: '100%', backgroundColor: '#00E5A0', color: '#0D0D0D', borderRadius: 12, padding: '14px 0', fontSize: '0.9375rem', fontWeight: 600, border: 'none', cursor: submitting ? 'not-allowed' : 'pointer', fontFamily: "Inter, sans-serif", opacity: submitting ? 0.7 : 1, marginBottom: 14 }}
            >
              {submitting ? 'Sending…' : 'Apply as a Founding PT'}
            </button>
            <p style={{ textAlign: 'center', color: '#888888', fontSize: '0.8125rem', lineHeight: 1.5 }}>
              Spots 1–10 get lifetime free access. After that, Pro features are $19.99/mo.
            </p>
          </form>
        )}
      </div>
    </div>
  )
}

function PreCookModal({ onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center px-5"
      style={{ backgroundColor: 'rgba(13,13,13,0.92)' }}>
      <div className="w-full max-w-sm p-7 space-y-6 animate-fade-in"
        style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 20 }}>
        <h2 style={{ fontFamily: "Inter, sans-serif", fontWeight: 500, fontSize: '1.375rem', color: '#F0F0F0' }}>
          Ready to cook?
        </h2>
        <p style={{ fontSize: '0.875rem', color: '#888888', lineHeight: 1.6 }}>
          Make sure you've grabbed everything from the fridge — once Remi starts cooking, your generations reset tomorrow.
        </p>
        <div className="space-y-3">
          <button onClick={onConfirm}
            style={{ width: '100%', backgroundColor: '#00E5A0', color: '#0D0D0D', borderRadius: 14, padding: '14px 0', fontFamily: "Inter, sans-serif", fontWeight: 500, fontSize: '0.9375rem', border: 'none', cursor: 'pointer' }}>
            Let's cook
          </button>
          <button onClick={onCancel}
            style={{ width: '100%', backgroundColor: 'transparent', color: '#888888', borderRadius: 14, padding: '12px 0', fontFamily: "Inter, sans-serif", fontSize: '0.875rem', border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer' }}>
            Wait, I missed something
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Auth screen (email + password) ───────────────────────────────────────────

function AuthScreen({ onBack, onAuthSuccess }) {
  // mode: 'signin' | 'signup' | 'forgot'
  const [mode,         setMode]         = useState('signin')
  const [name,         setName]         = useState('')
  const [email,        setEmail]        = useState('')
  const [password,     setPassword]     = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error,        setError]        = useState('')
  const [loading,      setLoading]      = useState(false)
  const [forgotSent,   setForgotSent]   = useState(false)

  const isValidEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

  function clearError() { if (error) setError('') }

  function switchMode(next) {
    setMode(next)
    setError('')
    setForgotSent(false)
    setShowPassword(false)
  }

  async function handleSignIn() {
    if (!isValidEmail(email)) { setError('Enter a valid email address.'); return }
    if (!password)            { setError('Enter your password.'); return }
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/auth-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'signin', email: email.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Sign in failed.'); return }
      onAuthSuccess(data.access_token, data.refresh_token)
    } catch {
      setError('Something went wrong. Try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleSignUp() {
    if (!isValidEmail(email)) { setError('Enter a valid email address.'); return }
    if (password.length < 6)  { setError('Password must be at least 6 characters.'); return }
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/auth-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'signup', email: email.trim(), password, name: name.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Sign up failed.'); return }
      onAuthSuccess(data.access_token, data.refresh_token)
    } catch {
      setError('Something went wrong. Try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleForgot() {
    if (!isValidEmail(email)) { setError('Enter a valid email address.'); return }
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/auth-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'forgot', email: email.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Failed to send reset email.'); return }
      setForgotSent(true)
    } catch {
      setError('Something went wrong. Try again.')
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit() {
    if (mode === 'signin') handleSignIn()
    else if (mode === 'signup') handleSignUp()
    else handleForgot()
  }

  // Base input style — no inline error-driven border so focus handler works cleanly
  const IS = {
    display: 'block', width: '100%', boxSizing: 'border-box',
    backgroundColor: '#111111',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 10, padding: '16px 16px', color: '#F0F0F0',
    fontFamily: 'Inter, sans-serif', fontSize: 16, outline: 'none',
    marginBottom: 12, transition: 'border-color 150ms ease',
    WebkitAppearance: 'none',
  }

  const btnLabels = { signin: 'Sign in', signup: 'Create account', forgot: 'Send reset link' }

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '100%', maxWidth: 420, padding: '72px 24px 56px', display: 'flex', flexDirection: 'column' }}>

        {/* Remi wordmark + subline */}
        <div style={{ textAlign: 'center', marginBottom: 52 }}>
          <p style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(2.75rem, 12vw, 3.5rem)', color: '#00E5A0', margin: 0, lineHeight: 1 }}>
            Remi
          </p>
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 500, color: '#888888', letterSpacing: '0.14em', margin: '10px 0 0', textTransform: 'uppercase' }}>
            Personal Chef · Nutritionist · Guide
          </p>
        </div>

        {/* Mode heading */}
        <h2 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '1.375rem', color: '#F0F0F0', margin: '0 0 24px', lineHeight: 1.2 }}>
          {mode === 'signin' ? 'Welcome back.' : mode === 'signup' ? 'Create your account.' : 'Reset your password.'}
        </h2>

        {/* Name — signup only */}
        {mode === 'signup' && (
          <input
            type="text"
            value={name}
            onChange={e => { setName(e.target.value); clearError() }}
            onFocus={e => { e.target.style.borderColor = '#00E5A0' }}
            onBlur={e  => { e.target.style.borderColor = 'rgba(255,255,255,0.1)' }}
            placeholder="Your name"
            autoComplete="name"
            style={IS}
          />
        )}

        {/* Email — hidden after reset link is sent */}
        {!(mode === 'forgot' && forgotSent) && (
          <input
            type="email"
            value={email}
            onChange={e => { setEmail(e.target.value); clearError() }}
            onKeyDown={e => { if (e.key === 'Enter' && mode === 'forgot') handleForgot() }}
            onFocus={e => { e.target.style.borderColor = '#00E5A0' }}
            onBlur={e  => { e.target.style.borderColor = 'rgba(255,255,255,0.1)' }}
            placeholder="you@example.com"
            autoComplete="email"
            inputMode="email"
            style={IS}
          />
        )}

        {/* Password with show/hide toggle — signin and signup only */}
        {mode !== 'forgot' && (
          <div style={{ position: 'relative', marginBottom: 20 }}>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => { setPassword(e.target.value); clearError() }}
              onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
              onFocus={e => { e.target.style.borderColor = '#00E5A0' }}
              onBlur={e  => { e.target.style.borderColor = 'rgba(255,255,255,0.1)' }}
              placeholder={mode === 'signup' ? 'Choose a password (min 6 chars)' : 'Password'}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              style={{ ...IS, marginBottom: 0, paddingRight: 52 }}
            />
            <button
              type="button"
              onClick={() => setShowPassword(v => !v)}
              style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#888888', padding: 4, display: 'flex', alignItems: 'center', lineHeight: 1 }}
            >
              {showPassword ? (
                /* Eye-off icon */
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              ) : (
                /* Eye icon */
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              )}
            </button>
          </div>
        )}

        {/* Forgot password success */}
        {forgotSent && (
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', margin: '0 0 16px', lineHeight: 1.5, textAlign: 'center' }}>
            Reset link sent. Check your inbox.
          </p>
        )}

        {/* Error */}
        {error && (
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#FF4D4D', margin: '0 0 16px', lineHeight: 1.4 }}>
            {error}
          </p>
        )}

        {/* Primary button */}
        {!forgotSent && (
          <button
            onClick={handleSubmit}
            disabled={loading}
            style={{ width: '100%', height: 54, backgroundColor: '#00E5A0', color: '#0D0D0D', borderRadius: 10, fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: 16, border: 'none', cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.7 : 1, transition: 'opacity 150ms ease', marginBottom: 28 }}
          >
            {loading ? '…' : btnLabels[mode]}
          </button>
        )}

        {/* Secondary nav links */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
          {mode === 'signin' && (
            <>
              <button onClick={() => switchMode('forgot')} style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', cursor: 'pointer', padding: 0 }}>
                Forgot password?
              </button>
              <button onClick={() => switchMode('signup')} style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', cursor: 'pointer', padding: 0 }}>
                New here?{' '}<span style={{ color: '#F0F0F0', fontWeight: 500 }}>Create an account</span>
              </button>
            </>
          )}
          {mode === 'signup' && (
            <button onClick={() => switchMode('signin')} style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', cursor: 'pointer', padding: 0 }}>
              Already have an account?{' '}<span style={{ color: '#F0F0F0', fontWeight: 500 }}>Sign in</span>
            </button>
          )}
          {mode === 'forgot' && (
            <button onClick={() => switchMode('signin')} style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', cursor: 'pointer', padding: 0 }}>
              ← Back to sign in
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Welcome Back screen ────────────────────────────────────────────────────────

const WELCOME_BACK_STYLES = `
  .remi-pill {
    background: transparent;
    border: 1px solid #00E5A0;
    color: #00E5A0;
    font-family: Inter, sans-serif;
    font-weight: 600;
    font-size: 15px;
    border-radius: 100px;
    padding: 12px 24px;
    min-height: 44px;
    cursor: pointer;
    transition: background 150ms ease, color 150ms ease;
  }
  .remi-pill:hover, .remi-pill:active {
    background: #00E5A0;
    color: #0D0D0D;
  }
`

function WelcomeBackScreen({ name, lastSignInAt, onKitchen, onDashboard }) {
  function getGreeting() {
    if (name === 'there') return "Back in the kitchen. Where do you want to start?"
    if (!lastSignInAt) return `Been a while, ${name}. No judgment. Let's get back on it.`
    const diffHours = (Date.now() - new Date(lastSignInAt).getTime()) / (1000 * 60 * 60)
    if (diffHours <= 48) return `${name}. Back again. The fridge is still cold.`
    if (diffHours <= 7 * 24) return `${name}. Good timing. Let's make tonight count.`
    return `Been a while, ${name}. No judgment. Let's get back on it.`
  }

  return (
    <div style={{
      minHeight: '100dvh',
      backgroundColor: '#0D0D0D',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
    }}>
      <style>{WELCOME_BACK_STYLES}</style>

      {/* Logo row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 24 }}>
        <img src="/remi-logo.svg" alt="Remi" style={{ height: '64px', width: 'auto' }} />
      </div>

      <p style={{
        fontFamily: 'Inter, sans-serif',
        fontSize: 22,
        fontWeight: 400,
        color: '#F0F0F0',
        textAlign: 'center',
        maxWidth: 360,
        lineHeight: 1.4,
        margin: 0,
      }}>
        {getGreeting()}
      </p>
      <div style={{ display: 'flex', gap: 12, marginTop: 32 }}>
        <button className="remi-pill" onClick={onKitchen}>Head to the Kitchen</button>
        <button className="remi-pill" onClick={onDashboard}>Refine my Approach</button>
      </div>
    </div>
  )
}

// ── Set new password screen (recovery link flow) ───────────────────────────────

function SetPasswordScreen({ accessToken, onSuccess }) {
  const [newPassword,     setNewPassword]     = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNew,         setShowNew]         = useState(false)
  const [showConfirm,     setShowConfirm]     = useState(false)
  const [error,           setError]           = useState('')
  const [loading,         setLoading]         = useState(false)

  async function handleUpdate() {
    if (newPassword.length < 6)          { setError('Password must be at least 6 characters.'); return }
    if (newPassword !== confirmPassword)  { setError("Passwords don't match."); return }
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/auth-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-password', access_token: accessToken, password: newPassword }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Failed to update password.'); return }
      onSuccess()
    } catch {
      setError('Something went wrong. Try again.')
    } finally {
      setLoading(false)
    }
  }

  const IS = {
    display: 'block', width: '100%', boxSizing: 'border-box',
    backgroundColor: '#111111',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 10, padding: '16px 52px 16px 16px', color: '#F0F0F0',
    fontFamily: 'Inter, sans-serif', fontSize: 16, outline: 'none',
    transition: 'border-color 150ms ease',
    WebkitAppearance: 'none',
  }

  function EyeIcon({ show }) {
    return show ? (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
      </svg>
    ) : (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    )
  }

  function eyeBtn(show, toggle) {
    return (
      <button
        type="button"
        onClick={toggle}
        style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#888888', padding: 4, display: 'flex', alignItems: 'center', lineHeight: 1 }}
      >
        <EyeIcon show={show} />
      </button>
    )
  }

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '100%', maxWidth: 420, padding: '72px 24px 56px', display: 'flex', flexDirection: 'column' }}>

        <div style={{ textAlign: 'center', marginBottom: 52 }}>
          <p style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(2.75rem, 12vw, 3.5rem)', color: '#00E5A0', margin: 0, lineHeight: 1 }}>Remi</p>
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 500, color: '#888888', letterSpacing: '0.14em', margin: '10px 0 0', textTransform: 'uppercase' }}>
            Personal Chef · Nutritionist · Guide
          </p>
        </div>

        <h2 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '1.375rem', color: '#F0F0F0', margin: '0 0 24px', lineHeight: 1.2 }}>
          Set new password.
        </h2>

        <div style={{ position: 'relative', marginBottom: 12 }}>
          <input
            type={showNew ? 'text' : 'password'}
            value={newPassword}
            onChange={e => { setNewPassword(e.target.value); setError('') }}
            onFocus={e => { e.target.style.borderColor = '#00E5A0' }}
            onBlur={e  => { e.target.style.borderColor = 'rgba(255,255,255,0.1)' }}
            placeholder="New password"
            autoComplete="new-password"
            style={IS}
          />
          {eyeBtn(showNew, () => setShowNew(v => !v))}
        </div>

        <div style={{ position: 'relative', marginBottom: 20 }}>
          <input
            type={showConfirm ? 'text' : 'password'}
            value={confirmPassword}
            onChange={e => { setConfirmPassword(e.target.value); setError('') }}
            onKeyDown={e => { if (e.key === 'Enter') handleUpdate() }}
            onFocus={e => { e.target.style.borderColor = '#00E5A0' }}
            onBlur={e  => { e.target.style.borderColor = 'rgba(255,255,255,0.1)' }}
            placeholder="Confirm password"
            autoComplete="new-password"
            style={IS}
          />
          {eyeBtn(showConfirm, () => setShowConfirm(v => !v))}
        </div>

        {error && (
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#FF4D4D', margin: '0 0 16px', lineHeight: 1.4 }}>
            {error}
          </p>
        )}

        <button
          onClick={handleUpdate}
          disabled={loading || !newPassword || !confirmPassword}
          style={{ width: '100%', height: 54, backgroundColor: '#00E5A0', color: '#0D0D0D', borderRadius: 10, fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: 16, border: 'none', cursor: loading || !newPassword || !confirmPassword ? 'not-allowed' : 'pointer', opacity: loading || !newPassword || !confirmPassword ? 0.7 : 1, transition: 'opacity 150ms ease' }}
        >
          {loading ? '…' : 'Update password'}
        </button>
      </div>
    </div>
  )
}

// ── Admin panel ──────────────────────────────────────────────────────────────

function AdminPanel({ onBack }) {
  const [searchEmail,      setSearchEmail]      = useState('')
  const [user,             setUser]             = useState(null)
  const [selectedRole,     setSelectedRole]     = useState('')
  const [loading,          setLoading]          = useState(false)
  const [lookupError,      setLookupError]      = useState('')
  const [status,           setStatus]           = useState(null)
  const [statusMsg,        setStatusMsg]        = useState('')
  const [resetEmail,       setResetEmail]       = useState('')
  const [resetConfirmText, setResetConfirmText] = useState('')
  const [resetLoading,     setResetLoading]     = useState(false)
  const [resetStatus,      setResetStatus]      = useState(null)  // null | 'success' | 'error' | 'notfound'
  const [resetMsg,         setResetMsg]         = useState('')

  async function handleLookup() {
    const q = searchEmail.trim()
    if (!q) return
    setLoading(true); setUser(null); setLookupError(''); setStatus(null)
    try {
      const res  = await fetch(`/api/get-user?email=${encodeURIComponent(q)}`)
      const data = await res.json()
      if (res.ok && data.user) {
        setUser(data.user)
        setSelectedRole(data.user.role || 'free')
      } else {
        setLookupError(data.error || 'User not found.')
      }
    } catch {
      setLookupError('Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  async function handleUpdateRole() {
    if (!user || !selectedRole) return
    setLoading(true); setStatus(null)
    try {
      const res = await fetch('/api/update-role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, role: selectedRole }),
      })
      if (!res.ok) throw new Error('non-ok')
      setStatus('success'); setStatusMsg('Role updated.')
      setUser(prev => ({ ...prev, role: selectedRole }))
    } catch {
      setStatus('error'); setStatusMsg('Update failed. Try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleResetUser() {
    const target = resetEmail.trim().toLowerCase()
    if (!target || resetConfirmText.trim().toLowerCase() !== target) return
    setResetLoading(true); setResetStatus(null); setResetMsg('')
    try {
      const res = await fetch('/api/admin-reset-users', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${import.meta.env.VITE_ADMIN_RESET_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: target }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Reset failed')
      if (data.found === false) {
        setResetStatus('notfound')
        setResetMsg(data.message)
      } else {
        setResetStatus('success')
        setResetMsg(`${data.email} has been reset.`)
        setResetEmail('')
        setResetConfirmText('')
      }
    } catch (err) {
      setResetStatus('error')
      setResetMsg(err.message)
    } finally {
      setResetLoading(false)
    }
  }

  const MUTED = { fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 12 }

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', padding: '48px 24px 96px' }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <button
          onClick={onBack}
          style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', cursor: 'pointer', padding: 0, marginBottom: 32 }}
        >
          ← Dashboard
        </button>
        <h1 style={{ fontFamily: 'Syne, sans-serif', fontSize: 24, fontWeight: 700, color: '#F0F0F0', margin: '0 0 40px' }}>
          Admin
        </h1>

        <p style={MUTED}>Manage user roles</p>

        {/* Search row */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <input
            type="email"
            value={searchEmail}
            onChange={e => { setSearchEmail(e.target.value); setLookupError('') }}
            onKeyDown={e => { if (e.key === 'Enter') handleLookup() }}
            onFocus={e  => { e.target.style.borderColor = '#00E5A0' }}
            onBlur={e   => { e.target.style.borderColor = 'rgba(255,255,255,0.12)' }}
            placeholder="user@email.com"
            autoComplete="off"
            style={{
              flex: 1, backgroundColor: '#0D0D0D',
              border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
              padding: '14px 16px', color: '#F0F0F0',
              fontFamily: 'Inter, sans-serif', fontSize: 16, outline: 'none',
              transition: 'border-color 150ms ease',
            }}
          />
          <button
            onClick={handleLookup}
            disabled={loading || !searchEmail.trim()}
            style={{
              backgroundColor: '#00E5A0', color: '#0D0D0D', border: 'none',
              borderRadius: 8, padding: '0 20px', height: 52,
              fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 14,
              cursor: loading || !searchEmail.trim() ? 'not-allowed' : 'pointer',
              opacity: loading || !searchEmail.trim() ? 0.5 : 1,
              whiteSpace: 'nowrap', transition: 'opacity 150ms ease',
            }}
          >
            {loading && !user ? 'Looking…' : 'Look up user'}
          </button>
        </div>

        {lookupError && (
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#FF4D4D', marginBottom: 16 }}>
            {lookupError}
          </p>
        )}

        {/* User result card */}
        {user && (
          <div style={{ backgroundColor: '#1A1A1A', borderRadius: 10, padding: 24 }}>
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 15, fontWeight: 600, color: '#F0F0F0', margin: '0 0 4px' }}>
              {user.name || '(no name)'}
            </p>
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', margin: '0 0 24px' }}>
              {user.email}
            </p>

            <p style={MUTED}>Role</p>

            {/* Role chips */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              {['free', 'coach', 'admin'].map(r => (
                <button
                  key={r}
                  onClick={() => { setSelectedRole(r); setStatus(null) }}
                  style={{
                    flex: 1, height: 44, borderRadius: 8, border: 'none',
                    fontFamily: 'Inter, sans-serif',
                    fontWeight: selectedRole === r ? 600 : 500,
                    fontSize: 14, cursor: 'pointer', transition: 'all 150ms ease',
                    backgroundColor: selectedRole === r ? '#00E5A0' : '#242424',
                    color: selectedRole === r ? '#0D0D0D' : '#F0F0F0',
                    boxShadow: selectedRole === r ? 'none' : 'inset 0 0 0 1px rgba(255,255,255,0.08)',
                  }}
                >
                  {r}
                </button>
              ))}
            </div>

            <button
              onClick={handleUpdateRole}
              disabled={loading || selectedRole === user.role}
              style={{
                width: '100%', height: 44, borderRadius: 8,
                backgroundColor: !loading && selectedRole !== user.role ? '#00E5A0' : '#242424',
                color: !loading && selectedRole !== user.role ? '#0D0D0D' : '#888888',
                border: !loading && selectedRole !== user.role ? 'none' : '1px solid rgba(255,255,255,0.08)',
                fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 14,
                cursor: loading || selectedRole === user.role ? 'not-allowed' : 'pointer',
                transition: 'all 150ms ease',
              }}
            >
              {loading ? 'Updating…' : selectedRole === user.role ? 'No change' : 'Update role'}
            </button>

            {status === 'success' && (
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#00E5A0', marginTop: 12, textAlign: 'center' }}>
                {statusMsg}
              </p>
            )}
            {status === 'error' && (
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#FF4D4D', marginTop: 12, textAlign: 'center' }}>
                {statusMsg}
              </p>
            )}
          </div>
        )}

        {/* Danger Zone */}
        <div style={{ marginTop: 56, borderTop: '1px solid rgba(255,77,77,0.25)', paddingTop: 40 }}>
          <p style={{ ...MUTED, color: '#FF4D4D' }}>Danger zone</p>

          <div style={{ backgroundColor: '#1A1A1A', borderRadius: 10, padding: 24 }}>
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 15, fontWeight: 600, color: '#F0F0F0', margin: '0 0 6px' }}>
              Reset a user
            </p>
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', margin: '0 0 20px', lineHeight: 1.5 }}>
              Deletes the auth account and profile row for a single email. Type the email again to confirm.
            </p>

            <input
              type="email"
              value={resetEmail}
              onChange={e => { setResetEmail(e.target.value); setResetStatus(null); setResetConfirmText('') }}
              onFocus={e => { e.target.style.borderColor = '#FF4D4D' }}
              onBlur={e  => { e.target.style.borderColor = 'rgba(255,255,255,0.12)' }}
              placeholder="Email to reset"
              autoComplete="off"
              style={{
                width: '100%', boxSizing: 'border-box',
                backgroundColor: '#0D0D0D',
                border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
                padding: '14px 16px', color: '#F0F0F0',
                fontFamily: 'Inter, sans-serif', fontSize: 16, outline: 'none',
                marginBottom: 10, transition: 'border-color 150ms ease',
              }}
            />

            <input
              type="email"
              value={resetConfirmText}
              onChange={e => { setResetConfirmText(e.target.value); setResetStatus(null) }}
              onFocus={e => { e.target.style.borderColor = '#FF4D4D' }}
              onBlur={e  => { e.target.style.borderColor = 'rgba(255,255,255,0.12)' }}
              placeholder="Type the email again to confirm"
              autoComplete="off"
              style={{
                width: '100%', boxSizing: 'border-box',
                backgroundColor: '#0D0D0D',
                border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
                padding: '14px 16px', color: '#F0F0F0',
                fontFamily: 'Inter, sans-serif', fontSize: 16, outline: 'none',
                marginBottom: 12, transition: 'border-color 150ms ease',
              }}
            />

            {(() => {
              const target = resetEmail.trim().toLowerCase()
              const confirmed = resetConfirmText.trim().toLowerCase() === target && target.length > 0
              return (
                <button
                  onClick={handleResetUser}
                  disabled={resetLoading || !confirmed}
                  style={{
                    width: '100%', height: 48, borderRadius: 8, border: 'none',
                    backgroundColor: resetLoading || !confirmed ? '#2A1A1A' : '#FF4D4D',
                    color: resetLoading || !confirmed ? '#888888' : '#FFFFFF',
                    fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 14,
                    cursor: resetLoading || !confirmed ? 'not-allowed' : 'pointer',
                    transition: 'all 150ms ease',
                  }}
                >
                  {resetLoading ? 'Resetting…' : 'Reset this user'}
                </button>
              )
            })()}

            {resetStatus === 'success' && (
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', marginTop: 12, textAlign: 'center' }}>
                {resetMsg}
              </p>
            )}
            {resetStatus === 'notfound' && (
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', marginTop: 12, textAlign: 'center' }}>
                {resetMsg}
              </p>
            )}
            {resetStatus === 'error' && (
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#FF4D4D', marginTop: 12, textAlign: 'center' }}>
                {resetMsg}
              </p>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}

// ── Intel view ────────────────────────────────────────────────────────────────

const INTEL_CARDS = [
  {
    category: 'RECOVERY',
    headline: 'Post-workout protein within 45 minutes doubles muscle protein synthesis rate compared to delayed intake.',
    source: 'J. International Society of Sports Nutrition · 2017',
  },
  {
    category: 'HORMONES',
    headline: 'Chronic under-eating elevates cortisol to the same level as acute psychological stress, impairing fat oxidation.',
    source: 'American Journal of Physiology · 2019',
  },
  {
    category: 'FAT LOSS',
    headline: 'Time-restricted eating within an 8-hour window reduces visceral fat by up to 3% without caloric restriction.',
    source: 'Cell Metabolism · 2022',
  },
  {
    category: 'PERFORMANCE',
    headline: 'Dietary nitrates from beetroot and leafy greens improve VO₂ max by ~3% in trained athletes over 4 weeks.',
    source: 'Medicine & Science in Sports & Exercise · 2021',
  },
]

function IntelView({ isPro, onProClick }) {
  return (
    <div className="animate-fade-in min-h-screen" style={{ backgroundColor: '#0D0D0D', paddingBottom: 96 }}>

      {/* Header */}
      <div style={{ padding: '3rem 1.25rem 1.75rem', maxWidth: 600, margin: '0 auto' }}>
        <p style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: '0.6rem', letterSpacing: '0.14em', color: '#C9A84C', textTransform: 'uppercase', marginBottom: 12 }}>
          Remi Intel
        </p>
        <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(1.75rem, 6vw, 2.5rem)', color: '#F0F0F0', lineHeight: 1.1, marginBottom: 10 }}>
          The science behind the meal.
        </h1>
        <p style={{ fontSize: '0.875rem', color: '#888', fontFamily: "Inter, sans-serif", lineHeight: 1.6 }}>
          Research-backed nutrition and performance insights, curated weekly.
        </p>
      </div>

      {/* Cards + overlay wrapper */}
      <div style={{ padding: '0 1.25rem', maxWidth: 600, margin: '0 auto', position: 'relative' }}>

        {/* Card stack */}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 14,
          filter: isPro ? 'none' : 'blur(5px)',
          pointerEvents: isPro ? 'auto' : 'none',
          userSelect: isPro ? 'auto' : 'none',
        }}>
          {INTEL_CARDS.map((card, i) => (
            <div
              key={i}
              style={{
                backgroundColor: '#141414',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 16,
                padding: '1.25rem 1.375rem',
              }}
            >
              <span style={{
                display: 'block',
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                fontSize: '0.6rem',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: '#C9A84C',
                fontWeight: 700,
                marginBottom: 10,
              }}>
                {card.category}
              </span>
              <p style={{
                fontFamily: "Inter, sans-serif",
                fontWeight: 500,
                fontSize: '0.9375rem',
                color: '#F0F0F0',
                lineHeight: 1.55,
                marginBottom: 12,
              }}>
                {card.headline}
              </p>
              <p style={{
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                fontSize: '0.625rem',
                color: '#444',
                letterSpacing: '0.03em',
                lineHeight: 1.5,
              }}>
                {card.source}
              </p>
            </div>
          ))}
        </div>

        {/* Upgrade overlay — free users only */}
        {!isPro && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '1.5rem',
          }}>
            <div style={{
              backgroundColor: '#1A1A1A',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 20,
              padding: '2rem 1.75rem',
              textAlign: 'center',
              maxWidth: 300,
              width: '100%',
              boxShadow: '0 16px 48px rgba(0,0,0,0.7)',
            }}>
              {/* Crown icon */}
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
                <svg viewBox="0 0 32 24" width="40" height="30" fill="#C9A84C">
                  <path d="M16 0L20.5 9L32 6.5L27 18H5L0 6.5L11.5 9L16 0Z"/>
                  <rect x="5" y="20" width="22" height="4" rx="2"/>
                </svg>
              </div>
              <h3 style={{
                fontFamily: 'Syne, sans-serif', fontWeight: 700,
                fontSize: '1.375rem', color: '#F0F0F0',
                marginBottom: 8, lineHeight: 1.2,
              }}>
                Remi Pro
              </h3>
              <p style={{
                fontSize: '0.8125rem', color: '#888',
                fontFamily: "Inter, sans-serif", lineHeight: 1.6,
                marginBottom: 24,
              }}>
                Unlock weekly research cards, unlimited sessions, and full dashboard access.
              </p>
              <button
                onClick={onProClick}
                style={{
                  width: '100%', backgroundColor: '#C9A84C', color: '#0D0D0D',
                  borderRadius: 12, padding: '13px 0',
                  fontFamily: 'Syne, sans-serif', fontWeight: 700,
                  fontSize: '0.9375rem', border: 'none', cursor: 'pointer',
                  marginBottom: 10,
                  boxShadow: '0 2px 12px rgba(201,168,76,0.35)',
                }}
              >
                Upgrade to Pro →
              </button>
              <p style={{ fontSize: '0.7rem', color: '#888', fontFamily: "Inter, sans-serif" }}>
                $4.99 / month
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Recipe Reveal — the ah-huh moment ────────────────────────────────────────
//
// After plating completes, the chat gives way to this dedicated full-screen
// view: a presenting header in Remi's voice, three (or fewer) recipe cards
// staggered into view, and the combined "What You Need" shopping list anchored
// at the bottom. The cards land — they don't just appear.
//
// Self-contained animation styles so this works whether or not CHAT_STYLES has
// been injected by the chat view earlier in the session.

const REVEAL_STYLES = `
  @keyframes revealFade {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes revealRise {
    0%   { opacity: 0; transform: translateY(8px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  @keyframes revealGlow {
    0%   { opacity: 0; }
    35%  { opacity: 1; }
    100% { opacity: 0; }
  }
  .reveal-header { animation: revealFade 400ms ease both; }
  .reveal-card   { animation: revealRise 320ms ease-out both; }
  .reveal-glow   {
    position: absolute; inset: -24px; border-radius: 24px;
    background: radial-gradient(ellipse at center, rgba(0,229,160,0.10) 0%, rgba(0,229,160,0.06) 35%, transparent 70%);
    pointer-events: none; z-index: 0;
    animation: revealGlow 1400ms ease-out both;
  }
  .reveal-foot   { animation: revealFade 400ms ease 600ms both; }

  @keyframes card1Ring {
    0%   { box-shadow: 0 0 0 1px rgba(0,229,160,0); }
    24%  { box-shadow: 0 0 0 1px rgba(0,229,160,0); }
    30%  { box-shadow: 0 0 0 1px rgba(0,229,160,0.2); }
    84%  { box-shadow: 0 0 0 1px rgba(0,229,160,0.2); }
    100% { box-shadow: 0 0 0 1px rgba(0,229,160,0); }
  }
  .reveal-card-highlight { animation: card1Ring 2.5s ease-out 1 both; }
`

function RevealCard({ dish, onOpen, delay = 0, onAddToDayPlan = null, isFirst = false }) {
  const m = dish?.dietician?.macros || {}
  const cuisine = dish?.chef?.cuisine
  const hook    = dish?.dietician?.note || dish?.chef?.flavour || ''
  // Cache the resolved Unsplash URL onto the dish so DetailView opens with the
  // hero already populated — no second fetch, no flash of empty state.
  function handleImageResolved(url, credit) {
    dish._imgUrl    = url
    dish._imgCredit = credit
  }
  function open() { onOpen(dish) }
  function onKeyDown(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {/* Bloom-then-settle mint glow — behind the card container ONLY, never behind text */}
      <div className="reveal-glow" aria-hidden style={{ animationDelay: `${delay}ms` }} />
      <div
        className={`reveal-card${isFirst ? ' reveal-card-highlight' : ''}`}
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={onKeyDown}
        aria-label={`Open the recipe — ${dish.name}`}
        style={{
          position: 'relative',
          zIndex: 1,
          backgroundColor: '#1A1A1A',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 10,
          overflow: 'hidden',
          cursor: 'pointer',
          touchAction: 'manipulation',
          animationDelay: `${delay}ms`,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Image — own row, full width, ZERO text overlay */}
        <div style={{ width: '100%', aspectRatio: '16 / 9', overflow: 'hidden', borderRadius: '8px 8px 0 0', backgroundColor: '#1A1A1A' }}>
          <CardImageHeader
            dishName={dish.name}
            cuisine={cuisine}
            initialUrl={dish._imgUrl ?? null}
            onImageResolved={handleImageResolved}
          />
        </div>
        {/* Content row — separate vertical row, never overlaps the image */}
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cuisine && (
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: 0 }}>
              {cuisine}
            </p>
          )}
          <h3 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 18, color: '#F0F0F0', margin: 0, lineHeight: 1.2 }}>
            {dish.name}
          </h3>
          {hook && (
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', margin: 0, lineHeight: 1.5 }}>
              {hook}
            </p>
          )}
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: '#00E5A0', marginTop: 4 }}>
            {m.calories} kcal · {m.protein}P / {m.carbs}C / {m.fat}F
          </div>
          {onAddToDayPlan && (
            <button
              onClick={e => { e.stopPropagation(); onAddToDayPlan(dish) }}
              style={{ width: '100%', height: 56, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#1A1A1A', color: '#F0F0F0', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginTop: 4 }}>
              Add to Day Plan →
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function RecipeReveal({ dishes, missingIngredients, onBack, onOpenDish, onAddToDayPlan = null, onNavigateDashboard = null }) {
  const [checkedItems, setCheckedItems] = useState(new Set())
  const [listCopied,   setListCopied]   = useState(false)

  function toggleCheckedItem(i) {
    setCheckedItems(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }
  function handleCopyShoppingList() {
    const unchecked = (missingIngredients || []).filter((_, i) => !checkedItems.has(i))
    if (unchecked.length === 0) return
    navigator.clipboard.writeText(unchecked.join('\n')).then(() => {
      setListCopied(true)
      setTimeout(() => setListCopied(false), 2000)
    })
  }

  // Split the existing handoffLeadIn output into a Syne headline + Inter sub-line.
  // 1 dish:  "Here. <name>."          → headline "Here.", sub "<name>."
  // 2 dishes: "Plated. Two ways…"     → headline "Plated.", sub "Two ways…"
  // 3 dishes: "Plated. Three ways…"   → headline "Plated.", sub "Three ways…"
  const lead = handoffLeadIn(dishes || [])
  const idx  = lead.indexOf('. ')
  const headerTitle = idx >= 0 ? lead.slice(0, idx + 1) : lead
  const headerSub   = idx >= 0 ? lead.slice(idx + 2)    : ''

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', display: 'flex', flexDirection: 'column' }}>
      <style>{REVEAL_STYLES}</style>

      {/* Top bar: back affordances */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        {onNavigateDashboard ? (
          <button
            onClick={onNavigateDashboard}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, color: '#888888', cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 400 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Dashboard
          </button>
        ) : <div />}
        <button
          onClick={onBack}
          aria-label="Back to chat"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, color: '#888888', cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 500 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00E5A0" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to chat
        </button>
      </div>

      {/* Presenting header — Syne title + Inter sub-line */}
      <div className="reveal-header" style={{ padding: '40px 20px 24px', maxWidth: 1120, margin: '0 auto', width: '100%' }}>
        <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(2rem, 6vw, 3rem)', color: '#F0F0F0', letterSpacing: '-0.01em', lineHeight: 1.05, margin: 0 }}>
          {headerTitle}
        </h1>
        {headerSub && (
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 16, color: '#888888', margin: '10px 0 0', lineHeight: 1.5 }}>
            {headerSub}
          </p>
        )}
      </div>

      {/* The three cards — side-by-side on desktop, stacked on mobile */}
      <div style={{ padding: '8px 20px 28px', maxWidth: 1120, margin: '0 auto', width: '100%' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {(dishes || []).map((dish, i) => (
            <RevealCard key={i} dish={dish} delay={i * 150} onOpen={onOpenDish} onAddToDayPlan={onAddToDayPlan} isFirst={i === 0} />
          ))}
        </div>
      </div>

      {/* What You Need — anchored under the cards, last to fade in */}
      {missingIngredients && missingIngredients.length > 0 && (
        <div className="reveal-foot" style={{ padding: '24px 20px 48px', maxWidth: 1120, margin: '0 auto', width: '100%' }}>
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 12px' }}>
            What You Need
          </p>
          <div style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: 20 }}>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {missingIngredients.map((item, i) => {
                const checked = checkedItems.has(i)
                return (
                  <li
                    key={i}
                    onClick={() => toggleCheckedItem(i)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      fontFamily: 'Inter, sans-serif', fontSize: 14, lineHeight: 1.5,
                      cursor: 'pointer', userSelect: 'none',
                      opacity: checked ? 0.4 : 1,
                      transition: 'opacity 200ms ease',
                    }}
                  >
                    <span
                      style={{
                        width: 20, height: 20, borderRadius: 4,
                        border: '2px solid #00E5A0',
                        backgroundColor: checked ? '#00E5A0' : 'transparent',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'background-color 200ms ease',
                        flexShrink: 0,
                      }}
                    >
                      {checked && (
                        <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
                          <path d="M1 4.5L4 7.5L10 1" stroke="#0D0D0D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </span>
                    <span style={{ color: '#F0F0F0', textDecoration: checked ? 'line-through' : 'none', transition: 'text-decoration 200ms ease' }}>
                      {item}
                    </span>
                  </li>
                )
              })}
            </ul>
            {(() => {
              const allChecked = missingIngredients.every((_, i) => checkedItems.has(i))
              return (
                <button
                  onClick={handleCopyShoppingList}
                  disabled={allChecked}
                  style={{
                    marginTop: 20, width: '100%', height: 44, borderRadius: 8,
                    backgroundColor: listCopied ? '#009966' : allChecked ? '#1A1A1A' : '#00E5A0',
                    color: allChecked ? '#888888' : '#0D0D0D',
                    border: allChecked ? '1px solid rgba(255,255,255,0.08)' : 'none',
                    cursor: allChecked ? 'default' : 'pointer',
                    fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 14,
                    touchAction: 'manipulation',
                  }}
                >
                  {listCopied ? '✓ Copied' : allChecked ? '✓ All picked up' : 'Copy List'}
                </button>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const FORCE_RESET_VERSION = 1
  if (localStorage.getItem('remi_force_reset') !== String(FORCE_RESET_VERSION)) {
    localStorage.clear()
    localStorage.setItem('remi_force_reset', String(FORCE_RESET_VERSION))
    window.location.reload()
  }

  // ── Recovery detection — must run before any useState ────────────────────────
  const hash = window.location.hash
  const hashParams = new URLSearchParams(hash.replace('#', ''))
  const isRecovery = hashParams.get('type') === 'recovery'
  const recoveryAccessToken = isRecovery ? hashParams.get('access_token') : null
  if (isRecovery) window.history.replaceState(null, '', '/')

  // ── Referral slug detection — /join/:slug routing ────────────────────────────
  // Capture the slug from the URL into localStorage so it survives sign-up / sign-in.
  // Validation (does the coach exist, are they capped) happens in a useEffect below.
  if (!isRecovery) {
    const pathMatch = window.location.pathname.match(/^\/join\/([a-z0-9][a-z0-9-]{1,30})\/?$/i)
    if (pathMatch) {
      const slug = pathMatch[1].toLowerCase()
      try { localStorage.setItem('remi_referral_slug', slug) } catch {}
      window.history.replaceState(null, '', '/')
    }
  }

  const [messages,       setMessages]       = useState(() => {
    const p = loadProfileOrEvict()
    const s = (() => { try { const r = localStorage.getItem('lhc_sessions'); return r ? JSON.parse(r) : [] } catch { return [] } })()
    return createSeedMessages(p, s)
  })
  const [input,          setInput]          = useState('')
  const [streaming,      setStreaming]       = useState(false)
  const [streamContent,  setStreamContent]  = useState('')
  const [awaitingDishes, setAwaitingDishes] = useState(false)
  const [dishes,         setDishes]         = useState(null)
  const [dishImages,     setDishImages]     = useState([])
  const [quickReplyType, setQuickReplyType] = useState(() => {
    // Hold off on the fridge tray while we're still waiting on the first-session philosophy
    // answer — the user needs to type freely, not pick chips.
    const p = loadProfileOrEvict()
    return (p?.name && p.trainingPhilosophy == null) ? null : 'proteins'
  })   // 'proteins'|'cuisine'|'time'|null
  const [profile,        setProfile]        = useState(() => {
    // Never pre-populate profile if there is no active session —
    // prevents the returning-user screen from showing after sign-out.
    const hasSession = !!localStorage.getItem('supabase.auth.token')
    return hasSession ? loadProfileOrEvict() : null
  })
  const [savedRecipes,   setSavedRecipes]   = useState([])
  const [sessions,       setSessions]       = useState(() => {
    try { const s = localStorage.getItem('lhc_sessions'); return s ? JSON.parse(s) : [] } catch { return [] }
  })
  const [streak,         setStreak]         = useState(() => {
    try { const s = localStorage.getItem('lhc_streak'); return s ? JSON.parse(s) : { count: 0, lastDate: null } } catch { return { count: 0, lastDate: null } }
  })
  const [stats,          setStats]          = useState(() => {
    try { const s = localStorage.getItem('lhc_stats'); return s ? JSON.parse(s) : { totalRecipes: 0, totalCalSaved: 0 } } catch { return { totalRecipes: 0, totalCalSaved: 0 } }
  })
  const [view,          _setView]           = useState(isRecovery ? 'set-password' : 'loading')
  const [selectedDish,   setSelectedDish]   = useState(null)
  const [viewingDish,    setViewingDish]    = useState(null)
  const [viewingDishImg, setViewingDishImg] = useState(null)
  const [savedBackTo,         setSavedBackTo]         = useState('cards')
  const [missingIngredients,  setMissingIngredients]  = useState([])
  const [shoppingListCopied,  setShoppingListCopied]  = useState(false)
  const [checkedIngredients,  setCheckedIngredients]  = useState(new Set())
  const [error,               setError]               = useState(null)
  const [isAdmin,             setIsAdmin]             = useState(() => localStorage.getItem('remi_role') === 'admin')
  const [userRole,            setUserRole]            = useState(() => localStorage.getItem('remi_role') || 'free')
  const [genCount,            setGenCount]            = useState(() => {
    try {
      const currentMonth = new Date().toISOString().slice(0, 7)
      const raw = localStorage.getItem('remi_gen_count')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed.month === currentMonth) return parsed.count ?? 0
      }
    } catch {}
    return 0
  })
  const [showProModal,        setShowProModal]        = useState(false)
  const [showGenCapModal,     setShowGenCapModal]     = useState(false)
  const [showPTPage,          setShowPTPage]          = useState(
    () => new URLSearchParams(window.location.search).get('pt') === 'founder'
  )

  const [inputFocused,      setInputFocused]      = useState(false)
  const [cookedConfirmation, setCookedConfirmation] = useState(null)
  const [suggestions,        setSuggestions]        = useState([])
  const [welcomeBackData,    setWelcomeBackData]    = useState(null)
  const [recoveryToken,      setRecoveryToken]      = useState(recoveryAccessToken)
  const [referralCoachName,  setReferralCoachName]  = useState(() => {
    try { return localStorage.getItem('remi_referral_coach_name') || null } catch { return null }
  })
  const [referralCapped,     setReferralCapped]     = useState(false)
  const [dayPlanVersion,     setDayPlanVersion]     = useState(0)
  const [targetMeal,         setTargetMeal]         = useState(null)
  const [dayPlanSlotSheet,   setDayPlanSlotSheet]   = useState(null)
  const [plannerInitialSlot, setPlannerInitialSlot] = useState(null)
  const [appToast,           setAppToast]           = useState(null)
  const [coachLogToast,      setCoachLogToast]      = useState(null)
  const [selectedClient,     setSelectedClient]     = useState(null)
  const coachLogTimerRef = useRef(null)

  // Tier helper — single source of truth for all role-based feature gates
  const tier     = getUserTier({ role: isAdmin ? 'admin' : userRole })
  const isCoach  = tier.isCoach
  const isFighter = tier.isFighter
  const isProUser = tier.isPro
  const isPro    = tier.isPro

  // Did You Cook — find the most recent session that is 12–48h old
  const didYouCookSession = useMemo(() => {
    const now = Date.now()
    return sessions.find(s => {
      const age = now - new Date(s.date).getTime()
      return age >= 12 * 3600 * 1000 && age <= 48 * 3600 * 1000
    }) ?? null
  }, [sessions])

  function handleCookedYes() {
    // Update streak
    const today = new Date().toISOString().slice(0, 10)
    const last  = streak.lastDate
    const isConsecutive = last === new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    const next  = { count: isConsecutive ? streak.count + 1 : 1, lastDate: today }
    setStreak(next)
    localStorage.setItem('lhc_streak', JSON.stringify(next))
    setCookedConfirmation('Streak updated. Keep it going.')
  }

  function handleCookedNo() {
    setCookedConfirmation("No worries — what are we making today?")
  }

  const scrollRef        = useRef(null)
  const abortRef         = useRef(null)
  // Synchronous re-entrancy guard for submitMessage. React state (streaming) is
  // async; if a second send fires before React has applied setStreaming(true),
  // both calls see streaming===false AND stale profile.trainingPhilosophy,
  // both push messages, both fire fetch. This ref blocks the second call deterministically.
  const sendingRef       = useRef(false)
  const inputRef         = useRef(null)
  const sessionDataRef   = useRef({ proteins: [], cuisine: '', time: '' })
  const viewContainerRef = useRef(null)
  const firstViewRef     = useRef(true)

  // ── View transition system ─────────────────────────────────────────────────
  // Inject keyframe CSS once on mount so the classes work across all views.
  useEffect(() => {
    const s = document.createElement('style')
    s.id = '__vt-styles'
    s.textContent = [
      '.view-exit{opacity:0;transition:opacity 80ms ease-in}',
      '.view-enter{animation:__vEnter 200ms ease-out both}',
      '@keyframes __vEnter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
    ].join('')
    document.head.appendChild(s)
    return () => s.remove()
  }, [])

  // Apply .view-enter to the incoming container before paint to avoid flash.
  useLayoutEffect(() => {
    if (firstViewRef.current) { firstViewRef.current = false; return }
    const el = viewContainerRef.current || document.getElementById('root')
    if (!el) return
    el.classList.remove('view-exit')
    void el.offsetWidth // force reflow so animation restart is clean
    el.classList.add('view-enter')
    const t = setTimeout(() => el.classList.remove('view-enter'), 200)
    return () => clearTimeout(t)
  }, [view])

  function setView(newView) {
    const el = viewContainerRef.current
      || (viewContainerRef.current = document.getElementById('root'))
    if (!el) { _setView(newView); return }
    el.classList.add('view-exit')
    setTimeout(() => { _setView(newView) }, 80)
  }

  // ── Supabase auth helpers ──────────────────────────────────────────────────

  function applySession(session, dbRole) {
    const email = session?.user?.email?.toLowerCase() ?? ''
    // Hardcoded admin list always wins over DB value
    const role = ADMIN_EMAILS.includes(email) ? 'admin' : (dbRole || 'free')
    localStorage.setItem('remi_role', role)
    setIsAdmin(role === 'admin')
    setUserRole(role)
  }

  // ── Session detection on mount ─────────────────────────────────────────────

  // ── Shared: process a valid access_token + refresh_token into a session ──────
  // Called from:
  //   • AuthScreen.onAuthSuccess — direct password sign-in / sign-up
  //   • useEffect hash callback  — password-reset link that lands with a token in the URL

  function getAccessToken() {
    try { return JSON.parse(localStorage.getItem('supabase.auth.token') || 'null')?.access_token ?? null } catch { return null }
  }

  async function loadSavedRecipes(token) {
    if (!token) return
    try {
      const r = await fetch('/api/saved-recipes', { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) return
      const rows = await r.json()
      setSavedRecipes(rows.map(row => ({ ...row.recipe_data, _id: row.id, _savedAt: new Date(row.saved_at).getTime() })))
    } catch {
      // Non-fatal — saved recipes simply stay empty until next load
    }
  }

  function processAuthResult(accessToken, refreshToken = '') {
    if (!accessToken) { setView('splash'); return }
    loadSavedRecipes(accessToken)
    fetch('/api/auth-user', { headers: { Authorization: `Bearer ${accessToken}` } })
      .then(r => r.json())
      .then(data => {
        if (!data.user) { setView('splash'); return }

        const session = { access_token: accessToken, refresh_token: refreshToken, user: data.user }
        localStorage.setItem('supabase.auth.token', JSON.stringify(session))
        applySession(session, data.role)

        const userId = data.user.id
        if (localStorage.getItem('lhc_stats_user_id') !== userId) {
          ;['lhc_stats', 'lhc_streak', 'lhc_sessions', 'lhc_greeting', 'remi_coach_name'].forEach(k => localStorage.removeItem(k))
          Object.keys(localStorage).filter(k => k.startsWith('lhc_corner_tips')).forEach(k => localStorage.removeItem(k))
          localStorage.setItem('lhc_stats_user_id', userId)
          setSessions([])
          setStreak({ count: 0, lastDate: null })
          setStats({ totalRecipes: 0, totalCalSaved: 0 })
        }

        // Source 1: localStorage profile
        let currentProfile = loadProfileOrEvict()
        const localName = (currentProfile?.name || '').trim()

        // Source 2: Supabase DB row (cross-device returning user)
        const dbName = (data.dbProfile?.name || '').trim()

        if (!localName && dbName) {
          const dp = data.dbProfile
          currentProfile = {
            version: PROFILE_VERSION,
            name: dbName,
            primarySport: dp.sport || '',
            trainingTypes: dp.sport ? [dp.sport] : [],
            training: dp.sport ? [dp.sport] : [],
            goal: dp.goal || 'maintain',
            goals: [dp.goal || 'maintain'],
            currentWeight: dp.weight || null,
            trainingPhilosophy: dp.trainingPhilosophy ?? null,
            referralSlug: dp.referralSlug ?? null,
            referredBy: dp.referredBy ?? null,
            clientCount: dp.clientCount ?? 0,
            completedAt: Date.now(),
          }
          localStorage.setItem('lhc_profile', JSON.stringify(currentProfile))
        } else if (currentProfile && data.dbProfile) {
          // Both local and DB profiles exist. DB is the authoritative source for the fields
          // it tracks — always overwrite them so a stale lhc_profile from a previous session
          // is never used. Local-only fields (training types, kitchen skill, etc.) are kept.
          const dp = data.dbProfile
          currentProfile = {
            ...currentProfile,
            name:               dp.name               || currentProfile.name               || '',
            trainingPhilosophy: dp.trainingPhilosophy  ?? currentProfile.trainingPhilosophy ?? null,
            referralSlug:       dp.referralSlug        ?? currentProfile.referralSlug       ?? null,
            referredBy:         dp.referredBy          ?? currentProfile.referredBy         ?? null,
            clientCount:        dp.clientCount         ?? currentProfile.clientCount        ?? 0,
          }
          localStorage.setItem('lhc_profile', JSON.stringify(currentProfile))
        }

        if (data.dbRowExists) {
          setProfile(currentProfile)
          const prevSignIn = localStorage.getItem('remi_prev_sign_in')
          const firstName = (dbName || localName || 'there').split(' ')[0]
          setWelcomeBackData({ name: firstName, lastSignInAt: prevSignIn })
          localStorage.setItem('remi_prev_sign_in', new Date().toISOString())
          setView('welcome-back')
        } else {
          setProfile(null)
          setView('onboarding')
        }
      })
      .catch(() => setView('splash'))
  }

  // Warm-up ping — fires once on mount to keep the /api/meals function warm
  useEffect(() => {
    fetch('/api/meals').catch(() => {})
  }, [])

  // ── Validate referral slug (if any) — runs once, fires the splash line ───────
  useEffect(() => {
    let slug
    try { slug = localStorage.getItem('remi_referral_slug') } catch { return }
    if (!slug) return
    // Skip validation if we already have the coach name cached for this slug
    let cancelled = false
    fetch('/api/referral', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'validate', slug }),
    })
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        if (data?.valid) {
          setReferralCoachName(data.coachName || null)
          setReferralCapped(false)
          try { localStorage.setItem('remi_referral_coach_name', data.coachName || '') } catch {}
        } else if (data?.reason === 'capped') {
          setReferralCoachName(data.coachName || null)
          setReferralCapped(true)
          // Clear the slug so we don't try to attribute the signup to a full coach.
          try { localStorage.removeItem('remi_referral_slug') } catch {}
        } else {
          // not_found or unknown — drop the slug silently
          setReferralCoachName(null)
          setReferralCapped(false)
          try {
            localStorage.removeItem('remi_referral_slug')
            localStorage.removeItem('remi_referral_coach_name')
          } catch {}
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    // Recovery links are fully handled synchronously before this effect runs.
    if (isRecovery) return

    // ── URL hash callback — non-recovery access_token ─────────────────────────
    const currentHash = window.location.hash
    if (currentHash.includes('access_token')) {
      const params       = new URLSearchParams(currentHash.startsWith('#') ? currentHash.slice(1) : currentHash)
      const accessToken  = params.get('access_token')
      const refreshToken = params.get('refresh_token') ?? ''
      window.history.replaceState(null, '', '/')
      processAuthResult(accessToken, refreshToken)
      return
    }

    // ── Session restore — stored token ──────────────────────────────────────
    const raw = localStorage.getItem('supabase.auth.token')
    if (!raw) { setView('splash'); return }
    let stored
    try { stored = JSON.parse(raw) } catch { localStorage.removeItem('supabase.auth.token'); setView('splash'); return }

    const token = stored?.access_token
    if (!token) { setView('splash'); return }

    loadSavedRecipes(token)
    fetch('/api/auth-user', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        if (data.user) {
          applySession({ ...stored, user: data.user }, data.role)

          const userId = data.user.id
          if (localStorage.getItem('lhc_stats_user_id') !== userId) {
            ;['lhc_stats', 'lhc_streak', 'lhc_sessions', 'lhc_greeting', 'remi_coach_name'].forEach(k => localStorage.removeItem(k))
            Object.keys(localStorage).filter(k => k.startsWith('lhc_corner_tips')).forEach(k => localStorage.removeItem(k))
            localStorage.setItem('lhc_stats_user_id', userId)
            setSessions([])
            setStreak({ count: 0, lastDate: null })
            setStats({ totalRecipes: 0, totalCalSaved: 0 })
          }

          let currentProfile = loadProfileOrEvict()
          const localName = (currentProfile?.name || '').trim()
          const dbName = (data.dbProfile?.name || '').trim()

          if (!localName && dbName) {
            const dp = data.dbProfile
            currentProfile = {
              version: PROFILE_VERSION,
              name: dbName,
              primarySport: dp.sport || '',
              trainingTypes: dp.sport ? [dp.sport] : [],
              training: dp.sport ? [dp.sport] : [],
              goal: dp.goal || 'maintain',
              goals: [dp.goal || 'maintain'],
              currentWeight: dp.weight || null,
              trainingPhilosophy: dp.trainingPhilosophy ?? null,
              referralSlug: dp.referralSlug ?? null,
              referredBy: dp.referredBy ?? null,
              clientCount: dp.clientCount ?? 0,
              completedAt: Date.now(),
            }
            localStorage.setItem('lhc_profile', JSON.stringify(currentProfile))
          } else if (currentProfile && data.dbProfile) {
            // DB is authoritative — always overwrite tracked fields to prevent a stale
            // lhc_profile from a previous session reaching the dashboard.
            const dp = data.dbProfile
            currentProfile = {
              ...currentProfile,
              name:               dp.name               || currentProfile.name               || '',
              trainingPhilosophy: dp.trainingPhilosophy  ?? currentProfile.trainingPhilosophy ?? null,
              referralSlug:       dp.referralSlug        ?? currentProfile.referralSlug       ?? null,
              referredBy:         dp.referredBy          ?? currentProfile.referredBy         ?? null,
              clientCount:        dp.clientCount         ?? currentProfile.clientCount        ?? 0,
            }
            localStorage.setItem('lhc_profile', JSON.stringify(currentProfile))
          }

          setProfile(currentProfile)

          if (data.dbRowExists) {
            const prevSignIn = localStorage.getItem('remi_prev_sign_in')
            const firstName = (dbName || localName || 'there').split(' ')[0]
            setWelcomeBackData({ name: firstName, lastSignInAt: prevSignIn })
            if (data.user.last_sign_in_at) {
              localStorage.setItem('remi_prev_sign_in', data.user.last_sign_in_at)
            }
            setView('welcome-back')
          } else {
            setView('onboarding')
          }
        } else {
          // Expired / invalid — clear and show splash
          localStorage.removeItem('supabase.auth.token')
          localStorage.removeItem('remi_role')
          setIsAdmin(false)
          setUserRole('free')
          setView('splash')
        }
      })
      .catch(() => { setView('splash') })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, streamContent])

  // Reset textarea height when input is cleared
  useEffect(() => {
    if (!input && inputRef.current) {
      inputRef.current.style.height = 'auto'
    }
  }, [input])

  // Ingredient autocomplete suggestions
  useEffect(() => {
    if (input.length < 2) { setSuggestions([]); return }
    const q = input.toLowerCase()
    const lastWord = q.split(/[,\s]+/).filter(Boolean).pop() || ''
    if (lastWord.length < 2) { setSuggestions([]); return }
    const matches = INGREDIENT_SUGGESTIONS
      .filter(s => s.toLowerCase().includes(lastWord) && !input.toLowerCase().includes(s.toLowerCase()))
      .slice(0, 8)
    setSuggestions(matches)
  }, [input])

  // Listen for the upgrade-coming-soon toast fired by GenCapModal
  useEffect(() => {
    function handleUpgradeToast() {
      showAppToast('Upgrade coming soon — you\'re on the list.')
    }
    window.addEventListener('remi:upgrade-toast', handleUpgradeToast)
    return () => window.removeEventListener('remi:upgrade-toast', handleUpgradeToast)
  }, [])

  const displayMessages = messages.filter(m => !(m.seed && m.role === 'user'))

  // ── Core message send ──────────────────────────────────────────────────────

  async function submitMessage(text) {
    if (sendingRef.current) return                // synchronous re-entrancy guard
    if (!text.trim() || streaming) return

    // ── Free-tier generation cap (20 / month) ─────────────────────────────────
    if (!tier.isPro) {
      const currentMonth = new Date().toISOString().slice(0, 7)
      let capCount = 0
      try {
        const raw = localStorage.getItem('remi_gen_count')
        if (raw) {
          const parsed = JSON.parse(raw)
          capCount = parsed.month === currentMonth ? (parsed.count || 0) : 0
        }
      } catch {}
      if (capCount >= 20) {
        setShowGenCapModal(true)
        return
      }
    }
    sendingRef.current = true
    const trimmed = text.trim()

    // If philosophy was just captured AND the user already mentioned ingredients,
    // we fall through to the LLM call with the updated profile. This variable
    // lets the fetch body use the freshly-captured trainingPhilosophy even though
    // React state (profile) hasn't re-rendered yet.
    let profileForApi = profile

    // First-session philosophy capture. If we don't yet have a trainingPhilosophy on the
    // profile, the first message Remi sees in this Cook session IS the answer to his opener.
    if (profile?.name && (profile.trainingPhilosophy == null)) {
      const updatedProfile = { ...profile, trainingPhilosophy: trimmed }
      setProfile(updatedProfile)
      localStorage.setItem('lhc_profile', JSON.stringify(updatedProfile))

      // Persist to Supabase via the same auth-user POST path onboarding uses.
      try {
        const sessRaw = localStorage.getItem('supabase.auth.token')
        const token   = sessRaw ? (JSON.parse(sessRaw)?.access_token) : null
        if (token) {
          fetch('/api/auth-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              name:  updatedProfile.name,
              sport: updatedProfile.primarySport || '',
              goal:  updatedProfile.goal || '',
              training_philosophy: trimmed,
            }),
          })
            .then(r => r.json())
            .then(result => console.log('[philosophy] saved:', result))
            .catch(err  => console.error('[philosophy] save error:', err))
        }
      } catch (err) {
        console.error('[philosophy] persist exception:', err)
      }

      posthog.capture('training_philosophy_captured')

      // Check if the user's answer (or any prior non-seed user message) already
      // contains ingredient information. If so, continue the conversation naturally
      // from that context rather than resetting with the default fridge opener.
      const ingredientRe = /\b(chicken|beef|salmon|egg|pork|lamb|fish|tuna|tofu|prawn|shrimp|steak|mince|turkey|rice|pasta|noodle|potato|fridge|freezer|cook|meal|protein|veg|broccoli|spinach)\b/i
      const answerHasIngredients = ingredientRe.test(trimmed)
      const priorHasIngredients  = messages.some(m => !m.seed && m.role === 'user' && ingredientRe.test(m.content))

      if (!answerHasIngredients && !priorHasIngredients) {
        // No ingredient context yet — ask for the fridge.
        const userMsg = { id: Date.now(), role: 'user', content: trimmed }
        const ackMsg  = {
          id: Date.now() + 1,
          role: 'assistant',
          content: 'Noted. Open your fridge — what proteins have you got?',
          seed: true,
        }
        setMessages(prev => [...prev, userMsg, ackMsg])
        setInput('')
        setQuickReplyType('proteins')
        // Defer reset past the current tick — same double-tap guard as before.
        setTimeout(() => { sendingRef.current = false }, 0)
        return
      }

      // Ingredient context exists — continue the LLM call naturally.
      // Use updatedProfile so trainingPhilosophy is included in the system prompt.
      profileForApi = updatedProfile
    }

    const userMsg      = { id: Date.now(), role: 'user', content: trimmed }
    const nextMessages = [...messages, userMsg]

    setMessages(nextMessages)
    setInput('')
    setStreaming(true)
    setStreamContent('')
    setAwaitingDishes(false)
    setError(null)
    setQuickReplyType(null)

    abortRef.current = new AbortController()

    // Track whether we received the [DONE] sentinel — if the stream closes without
    // it (server crash, Vercel timeout, network drop) we can surface a proper error.
    let sawDone = false

    try {
      const res = await fetch('/api/meals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-POSTHOG-DISTINCT-ID': posthog.get_distinct_id(),
          'X-POSTHOG-SESSION-ID': posthog.get_session_id() ?? '',
        },
        body: JSON.stringify({
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
          profile: mapProfileForApi(profileForApi),
          isReturningUser: sessions.length > 0,
          lastSessionSummary: sessions[0]
            ? `proteins: ${(sessions[0].proteins || []).join(', ') || 'unspecified'}; cuisine: ${sessions[0].cuisine || 'unspecified'}; dishes: ${(sessions[0].dishes || []).map(d => typeof d === 'object' ? d.name : d).join(', ') || 'unspecified'}`
            : null,
        }),
        signal: abortRef.current.signal,
      })

      if (!res.ok) {
        // Non-200 before streaming starts — safe to read body as JSON
        let errMsg = `Server error ${res.status}`
        try { const data = await res.json(); errMsg = data.error || errMsg } catch {}
        console.error('[meals] Non-OK response:', res.status, errMsg)
        throw new Error(errMsg)
      }

      const reader    = res.body.getReader()
      const decoder   = new TextDecoder()
      let sseBuffer   = ''
      let accumulated = ''
      let sawDishes   = false

      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break

        sseBuffer += decoder.decode(value, { stream: true })
        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6)

          if (payload === '[DONE]') {
            sawDone = true
            const parsed = parseDishes(accumulated)
            if (parsed.length > 0) {
              setDishes(parsed)
              setDishImages([])
              const _ingredients = parseMissingIngredients(accumulated)
              setMissingIngredients(_ingredients)
              setShoppingListCopied(false)
              setCheckedIngredients(new Set())
              saveSession(parsed)
              posthog.capture('dishes_received', { dish_count: parsed.length, proteins: sessionDataRef.current.proteins })
              const _currentMonth = new Date().toISOString().slice(0, 7)
              let _newCount = 1
              try {
                const _raw = localStorage.getItem('remi_gen_count')
                if (_raw) {
                  const _parsed = JSON.parse(_raw)
                  _newCount = _parsed.month === _currentMonth ? (_parsed.count || 0) + 1 : 1
                }
              } catch {}
              localStorage.setItem('remi_gen_count', JSON.stringify({ count: _newCount, month: _currentMonth }))
              setGenCount(_newCount)
              // Guardrail: each surfaced dish MUST carry a real method, not a token summary.
              const validDishes = parsed.filter(isCompleteMethod)
              if (validDishes.length > 0) {
                // Chat conversation gives way to the dedicated reveal page — the moment
                // of arrival. A quiet breadcrumb in chat preserves the conversation log
                // and gives the user a re-entry door if they back out to chat.
                setMessages(prev => [...prev, {
                  id: Date.now(),
                  role: 'assistant',
                  content: handoffLeadIn(validDishes),
                  revealBreadcrumb: true,
                }])
                setView('reveal')
              } else {
                console.error('[meals] Generation completed but no dish carried a complete method. Rejecting.', parsed.map(d => ({ name: d.name, steps: d?.dietician?.cookSteps?.length ?? 0 })))
                setMessages(prev => [...prev, {
                  id: Date.now(),
                  role: 'assistant',
                  content: "Remi's thinking. Give it a moment.",
                }])
              }
              setQuickReplyType(null)
            } else {
              setMessages(prev => [...prev, { id: Date.now(), role: 'assistant', content: accumulated }])
              const nextType = detectQuickReplyType(accumulated)
              setQuickReplyType(nextType)
            }
            break outer
          }

          // Parse the SSE JSON payload — keep the JSON parse error separate from
          // a server-reported error so we can handle each correctly.
          let chunkData
          try {
            chunkData = JSON.parse(payload)
          } catch {
            // Truly malformed JSON in the SSE frame — skip silently
            continue
          }

          const { text: chunk, error: chunkErr } = chunkData
          if (chunkErr) {
            // Server signalled an error inside the stream — propagate it so the
            // outer catch can surface it to the user instead of swallowing it.
            console.error('[meals] Server stream error:', chunkErr)
            throw new Error(chunkErr)
          }

          if (chunk) {
            accumulated += chunk
            if (!sawDishes) {
              const looksLikeRecipes =
                accumulated.includes('🍽️') ||
                (accumulated.match(/chef\s+version/gi) || []).length >= 2
              if (looksLikeRecipes) {
                sawDishes = true
                setAwaitingDishes(true)
                setStreamContent('')
              } else {
                setStreamContent(accumulated)
              }
            }
          }
        }
      }

      // Stream closed without [DONE] — the connection dropped or the server timed
      // out after headers were already sent (so res.ok was true but no sentinel).
      if (!sawDone) {
        console.error('[meals] Stream ended without [DONE]. Accumulated length:', accumulated.length, '| Preview:', accumulated.slice(0, 200))
        // Try to salvage partial content before giving up
        const parsed = accumulated ? parseDishes(accumulated) : []
        if (parsed.length > 0) {
          setDishes(parsed)
          setDishImages([])
          const _ingredients2 = parseMissingIngredients(accumulated)
          setMissingIngredients(_ingredients2)
          setShoppingListCopied(false)
          setCheckedIngredients(new Set())
          saveSession(parsed)
          const _currentMonth2 = new Date().toISOString().slice(0, 7)
          let _newCount2 = 1
          try {
            const _raw2 = localStorage.getItem('remi_gen_count')
            if (_raw2) {
              const _parsed2 = JSON.parse(_raw2)
              _newCount2 = _parsed2.month === _currentMonth2 ? (_parsed2.count || 0) + 1 : 1
            }
          } catch {}
          localStorage.setItem('remi_gen_count', JSON.stringify({ count: _newCount2, month: _currentMonth2 }))
          setGenCount(_newCount2)
          const validDishes2 = parsed.filter(isCompleteMethod)
          if (validDishes2.length > 0) {
            setMessages(prev => [...prev, {
              id: Date.now(),
              role: 'assistant',
              content: handoffLeadIn(validDishes2),
              revealBreadcrumb: true,
            }])
            setView('reveal')
          } else {
            console.error('[meals] Salvage parse produced no dish with a complete method. Rejecting.', parsed.map(d => ({ name: d.name, steps: d?.dietician?.cookSteps?.length ?? 0 })))
            setMessages(prev => [...prev, {
              id: Date.now(),
              role: 'assistant',
              content: "Remi's thinking. Give it a moment.",
            }])
          }
          setQuickReplyType(null)
        } else {
          throw new Error('The connection dropped before your recipes arrived. Try again.')
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return  // user tapped Stop — no error needed

      console.error('[meals] Request failed:', err)

      // Add error as an assistant message so the user sees it in context, not just
      // a banner they might miss. Keep the banner too for dev visibility.
      setMessages(prev => [...prev, {
        id: Date.now(),
        role: 'assistant',
        content: 'Something went wrong on our end. Try again.',
      }])
      setError(err.message)
    } finally {
      setStreaming(false)
      setStreamContent('')
      setAwaitingDishes(false)
      sendingRef.current = false
    }
  }

  function handleSubmit(e) {
    e?.preventDefault()
    submitMessage(input)
  }

  function handleQuickReply(text, data, type) {
    if (type === 'proteins') sessionDataRef.current.proteins = data
    else if (type === 'cuisine') sessionDataRef.current.cuisine = data[0] ?? ''
    else if (type === 'time') sessionDataRef.current.time = data[0] ?? ''
    submitMessage(text)
  }

  function handleStop() { abortRef.current?.abort() }

  function handleReset() {
    posthog.capture('chat_reset')
    setMessages(createSeedMessages(profile, sessions))
    setDishes(null)
    setDishImages([])
    setMissingIngredients([])
    setShoppingListCopied(false)
    setCheckedIngredients(new Set())
    setSelectedDish(null)
    setViewingDish(null)
    setViewingDishImg(null)
    setError(null)
    setInput('')
    setQuickReplyType('proteins')
    sessionDataRef.current = { proteins: [], cuisine: '', time: '' }
    setView('chat')
  }

  function handleOpenCookWithPrompt(text, mealType = null) {
    posthog.capture('day_plan_generate', { meal_type: mealType })
    setTargetMeal(mealType)
    setMessages(createSeedMessages(profile, sessions))
    setDishes(null)
    setDishImages([])
    setMissingIngredients([])
    setShoppingListCopied(false)
    setCheckedIngredients(new Set())
    setSelectedDish(null)
    setViewingDish(null)
    setViewingDishImg(null)
    setError(null)
    setInput(text)
    setQuickReplyType('proteins')
    sessionDataRef.current = { proteins: [], cuisine: '', time: '' }
    setView('chat')
  }

  function handleAddToDayPlan(dish) {
    setDayPlanSlotSheet({ dish, imgUrl: dish._imgUrl ?? null, imgCredit: dish._imgCredit ?? null, selected: 'breakfast' })
  }

  function handleLogSavedRecipe(dish) {
    setDayPlanSlotSheet({ dish, imgUrl: dish._imgUrl ?? null, imgCredit: dish._imgCredit ?? null, selected: targetMeal ?? 'breakfast' })
  }

  function showAppToast(msg) {
    setAppToast(msg)
    setTimeout(() => setAppToast(null), 2400)
  }

  function showCoachLogToast(toast) {
    clearTimeout(coachLogTimerRef.current)
    setCoachLogToast({ ...toast, fadingOut: false })
    coachLogTimerRef.current = setTimeout(() => {
      setCoachLogToast(prev => prev ? { ...prev, fadingOut: true } : null)
      coachLogTimerRef.current = setTimeout(() => {
        if (toast?.dishName) {
          try {
            const notified = JSON.parse(localStorage.getItem('remi_notified_dishes') || '[]')
            if (!notified.includes(toast.dishName)) {
              notified.push(toast.dishName)
              localStorage.setItem('remi_notified_dishes', JSON.stringify(notified.slice(-50)))
            }
          } catch {}
        }
        setCoachLogToast(null)
      }, 200)
    }, 7800)
  }

  function handleCoachLogSend() {
    if (!coachLogToast) return
    const { coachSlug, dishName, clientName, sport, goal } = coachLogToast
    try {
      const notified = JSON.parse(localStorage.getItem('remi_notified_dishes') || '[]')
      if (!notified.includes(dishName)) {
        notified.push(dishName)
        localStorage.setItem('remi_notified_dishes', JSON.stringify(notified.slice(-50)))
      }
    } catch {}
    fetch('/api/coach-note', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'client_log', coachSlug, clientName, dishName, sport, goal }),
    }).catch(() => {})
    clearTimeout(coachLogTimerRef.current)
    setCoachLogToast(null)
  }

  function dismissCoachLogToast() {
    if (coachLogToast?.dishName) {
      try {
        const notified = JSON.parse(localStorage.getItem('remi_notified_dishes') || '[]')
        if (!notified.includes(coachLogToast.dishName)) {
          notified.push(coachLogToast.dishName)
          localStorage.setItem('remi_notified_dishes', JSON.stringify(notified.slice(-50)))
        }
      } catch {}
    }
    clearTimeout(coachLogTimerRef.current)
    setCoachLogToast(null)
  }

  function handleResetProfile() {
    posthog.capture('profile_reset')
    // Wipe all persisted data
    LS_KEYS.forEach(k => localStorage.removeItem(k))
    localStorage.removeItem('lhc_greeting')
    localStorage.removeItem('remi_training_today')
    localStorage.removeItem('remi_first_recipe_saved')
    localStorage.removeItem('remi_prev_sign_in')
    Object.keys(localStorage)
      .filter(k => k.startsWith('lhc_corner_tips'))
      .forEach(k => localStorage.removeItem(k))
    // Reset all in-memory state
    setProfile(null)
    setSavedRecipes([])
    setSessions([])
    setStreak({ count: 0, lastDate: null })
    setStats({ totalRecipes: 0, totalCalSaved: 0 })
    setCookedConfirmation(null)
    setMessages(SEED)
    setDishes(null)
    setDishImages([])
    setMissingIngredients([])
    setSelectedDish(null)
    setViewingDish(null)
    setViewingDishImg(null)
    setError(null)
    setInput('')
    setQuickReplyType(null)
    sessionDataRef.current = { proteins: [], cuisine: '', time: '' }
    setView('splash')
  }

  function handleSignOut() {
    // 1. Wipe auth and role keys from localStorage
    ;[
      'supabase.auth.token',
      'remi_role',
      'remi_email_captured',
      'lhc_profile',
      'remi_profile',
      'remi_user_email',
      'remi_first_recipe_saved',
      'remi_prev_sign_in',
    ].forEach(k => localStorage.removeItem(k))

    // 2. Reset all React state — no reload, no stale screen
    setProfile(null)
    setIsAdmin(false)
    setUserRole('free')
    setMessages(SEED)
    setDishes(null)
    setDishImages([])
    setMissingIngredients([])
    setShoppingListCopied(false)
    setCheckedIngredients(new Set())
    setSelectedDish(null)
    setViewingDish(null)
    setViewingDishImg(null)
    setError(null)
    setInput('')
    setQuickReplyType('proteins')
    setStreaming(false)
    setStreamContent('')
    setAwaitingDishes(false)
    setCookedConfirmation(null)
    sessionDataRef.current = { proteins: [], cuisine: '', time: '' }
    setView('splash')
  }

  function saveSession(parsedDishes) {
    const data = sessionDataRef.current
    if (!data.proteins?.length && !parsedDishes?.length) return
    const session = {
      id:       Date.now(),
      date:     new Date().toISOString(),
      proteins: data.proteins || [],
      cuisine:  data.cuisine  || '',
      time:     data.time     || '',
      dishes:   parsedDishes  || [],   // full dish objects
    }
    setSessions(prev => {
      const next = [session, ...prev].slice(0, 10)
      localStorage.setItem('lhc_sessions', JSON.stringify(next))
      return next
    })
    // Update streak
    updateStreak()
    // Update stats
    updateStats(parsedDishes || [])
    sessionDataRef.current = { proteins: [], cuisine: '', time: '' }
  }

  function updateStreak() {
    const today = new Date().toDateString()
    setStreak(prev => {
      if (prev?.lastDate === today) return prev  // already counted today
      const yesterday = new Date(Date.now() - 86400000).toDateString()
      const newCount = prev?.lastDate === yesterday ? (prev.count ?? 0) + 1 : 1
      const next = { count: newCount, lastDate: today }
      localStorage.setItem('lhc_streak', JSON.stringify(next))
      return next
    })
  }

  function updateStats(dishes) {
    const calSaved = dishes.reduce((sum, d) => {
      const s = calorieSavings(d)
      return sum + (s || 0)
    }, 0)
    setStats(prev => {
      const next = {
        totalRecipes:  (prev?.totalRecipes  ?? 0) + dishes.length,
        totalCalSaved: (prev?.totalCalSaved ?? 0) + calSaved,
      }
      localStorage.setItem('lhc_stats', JSON.stringify(next))
      return next
    })
  }

  async function handleSaveRecipe(dish, imgUrl, imgCredit) {
    // Enforce saves cap for capped tiers
    if (tier.savesCap !== null && savedRecipes.length >= tier.savesCap) {
      showAppToast(`Saved recipe limit reached. Upgrade to Pro.`)
      return
    }
    const isFirst = !localStorage.getItem('remi_first_recipe_saved')
    const tempId  = `temp_${Date.now()}`
    const entry   = { ...dish, _id: tempId, _savedAt: Date.now(), _imgUrl: imgUrl ?? null, _imgCredit: imgCredit ?? null }

    // Optimistic — add immediately so the UI feels instant
    setSavedRecipes(prev => [...prev.filter(r => r.name !== dish.name), entry])
    posthog.capture('recipe_saved', { dish_name: dish.name, cuisine: dish.chef?.cuisine })

    if (isFirst) {
      localStorage.setItem('remi_first_recipe_saved', 'true')
      setMessages(prev => [...prev, {
        id: `dash-prompt-${Date.now()}`,
        role: 'assistant',
        content: "That's the standard. Your dashboard is ready.",
        dashboardPrompt: true,
      }])
    }

    // Persist to Supabase — swap temp id for the real UUID on success, rollback on error
    const token = getAccessToken()
    if (!token) return
    try {
      const r = await fetch('/api/saved-recipes', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ recipe_data: entry }),
      })
      if (r.ok) {
        const { id } = await r.json()
        setSavedRecipes(prev => prev.map(rec => rec._id === tempId ? { ...rec, _id: id } : rec))
        if (profile?.referredBy) {
          try {
            const notified = JSON.parse(localStorage.getItem('remi_notified_dishes') || '[]')
            if (!notified.includes(dish.name)) {
              const cached = JSON.parse(localStorage.getItem('remi_coach_name') || 'null')
              const coachName = (cached?.slug === profile.referredBy ? cached?.name : null) || 'your coach'
              showCoachLogToast({
                coachName,
                coachSlug:  profile.referredBy,
                dishName:   dish.name,
                clientName: profile.name,
                sport:      profile.sport || profile.primarySport || '',
                goal:       Array.isArray(profile.goals) ? profile.goals[0] : (profile.goal || ''),
              })
            }
          } catch {}
        }
      } else {
        setSavedRecipes(prev => prev.filter(rec => rec._id !== tempId))
      }
    } catch {
      setSavedRecipes(prev => prev.filter(rec => rec._id !== tempId))
    }
  }

  async function handleRemoveRecipe(nameOrId) {
    // Capture the recipe before removing so we can rollback if the API call fails
    const recipe    = savedRecipes.find(r => r._id === nameOrId || r.name === nameOrId)
    const supabaseId = recipe?._id

    // Optimistic removal
    setSavedRecipes(prev => prev.filter(r => r._id !== nameOrId && r.name !== nameOrId))
    posthog.capture('recipe_removed', { name_or_id: nameOrId })

    // Skip the API call for temp ids (save still in flight) or if no id found
    if (!supabaseId || supabaseId.startsWith('temp_')) return

    const token = getAccessToken()
    if (!token) return
    try {
      const r = await fetch('/api/saved-recipes', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ id: supabaseId }),
      })
      if (!r.ok && recipe) {
        // Rollback — re-insert at end of list
        setSavedRecipes(prev => [...prev, recipe])
      }
    } catch {
      if (recipe) setSavedRecipes(prev => [...prev, recipe])
    }
  }

  function isRecipeSaved(dishName) {
    return savedRecipes.some(r => r.name === dishName)
  }

  function handleCopyShoppingList() {
    // Only include items that haven't been checked off
    const unchecked = missingIngredients.filter((_, i) => !checkedIngredients.has(i))
    if (unchecked.length === 0) return
    const date = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })
    const lines = [
      'Remi — Shopping List',
      date,
      '',
      "For tonight's recipes you'll need:",
      ...unchecked.map(i => `• ${i}`),
      '',
      'Generated by myremi.io',
    ].join('\n')
    navigator.clipboard.writeText(lines).then(() => {
      setShoppingListCopied(true)
      posthog.capture('shopping_list_copied', { item_count: unchecked.length })
      setTimeout(() => setShoppingListCopied(false), 2000)
    })
  }

  // ── View: PT Founders ────────────────────────────────────────────────────────
  if (showPTPage) {
    return (
      <>
        <PTFounderPage onClose={() => setShowPTPage(false)} />
        {showProModal && <ProModal onClose={() => setShowProModal(false)} />}
      </>
    )
  }

  // ── View: Loading (auth callback in progress) ───────────────────────────────
  if (view === 'loading') {
    return (
      <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <style>{CHAT_STYLES}</style>
        <div className="flex items-center gap-3.5">
          {[0, 1, 2].map(i => (
            <span key={i} className="mint-dot" style={{ width: 14, height: 14, borderRadius: '50%', backgroundColor: '#00E5A0', display: 'inline-block' }} />
          ))}
        </div>
      </div>
    )
  }

  // ── View: Splash ─────────────────────────────────────────────────────────────
  if (view === 'splash') {
    return <SplashScreen
      onGetStarted={() => setView('auth')}
      referralCoachName={referralCoachName}
      referralCapped={referralCapped}
    />
  }

  // ── View: Auth (email + password) ────────────────────────────────────────────
  if (view === 'auth') {
    return <AuthScreen onBack={() => setView('splash')} onAuthSuccess={processAuthResult} />
  }

  // ── View: Onboarding (new users — 3 steps) ───────────────────────────────────
  if (view === 'onboarding') {
    return (
      <>
        <Onboarding
          existingProfile={profile}
          userRole={userRole}
          onBack={() => setView(profile ? 'dashboard' : 'splash')}
          onAlreadyOnboarded={() => {
            const currentProfile = loadProfileOrEvict()
            const firstName = (currentProfile?.name || 'there').split(' ')[0]
            const prevSignIn = localStorage.getItem('remi_prev_sign_in')
            setWelcomeBackData({ name: firstName, lastSignInAt: prevSignIn })
            setView('welcome-back')
          }}
          onComplete={remiProfile => {
            const saved = { ...remiProfile, completedAt: Date.now(), version: PROFILE_VERSION }
            localStorage.setItem('lhc_profile', JSON.stringify(saved))
            setProfile(saved)
            // Re-seed the chat against the just-saved profile so the philosophy opener
            // actually fires for the post-onboarding Cook session. The fridge tray waits.
            setMessages(createSeedMessages(saved, sessions))
            setQuickReplyType(saved.trainingPhilosophy == null ? null : 'proteins')
            posthog.identify(posthog.get_distinct_id(), { name: remiProfile.name, goal: remiProfile.goal })
            posthog.capture('onboarding_completed', { goal: remiProfile.goal, sport: remiProfile.primarySport })
            // Upsert profile to DB via auth-user POST (uses service role key, bypasses RLS)
            const session = (() => { try { return JSON.parse(localStorage.getItem('supabase.auth.token') || 'null') } catch { return null } })()
            // Founding Coach — attribute this signup to the referring coach (if any).
            // The slug is stripped from localStorage after a successful record so it never
            // double-counts on profile re-saves.
            let referralSlugForWrite = null
            try { referralSlugForWrite = localStorage.getItem('remi_referral_slug') } catch {}
            const profileData = {
              name:                 saved.name,
              sport:                saved.primarySport || '',
              goal:                 saved.goal || '',
              training_philosophy:  null,
              role:                 referralSlugForWrite ? 'pt_referred' : 'free',
              ...(referralSlugForWrite ? { referred_by: referralSlugForWrite } : {}),
            }
            console.log('Onboarding complete, writing profile:', profileData)
            if (session?.access_token) {
              fetch('/api/auth-user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                body: JSON.stringify(profileData),
              })
                .then(r => r.json())
                .then(result => {
                  console.log('auth-user POST result:', result)
                  // Once the profile row exists, attribute the seat to the coach.
                  if (referralSlugForWrite) {
                    fetch('/api/referral', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'record', slug: referralSlugForWrite }),
                    })
                      .then(r => r.json())
                      .then(rec => {
                        console.log('[referral] record result:', rec)
                        posthog.capture('referral_signup_attributed', { slug: referralSlugForWrite, capped: !!rec?.capped })
                      })
                      .catch(err => console.error('[referral] record error:', err))
                      .finally(() => {
                        try {
                          localStorage.removeItem('remi_referral_slug')
                          localStorage.removeItem('remi_referral_coach_name')
                        } catch {}
                      })
                  }
                })
                .catch(err => { console.error('auth-user POST error:', err) })
            } else {
              console.warn('Onboarding complete but no session token — profile not written to DB')
            }
            setView('chat')
          }}
        />
        {showProModal && <ProModal onClose={() => setShowProModal(false)} />}
      </>
    )
  }

  // ── View: Profile complete ───────────────────────────────────────────────────
  if (view === 'profile-complete') {
    return <ProfileComplete profile={profile} onEnter={() => setView('chat')} />
  }

  // ── View: Dashboard ──────────────────────────────────────────────────────────
  if (view === 'dashboard') {
    return (
      <>
        <Dashboard
          profile={profile}
          savedRecipes={savedRecipes}
          sessions={sessions}
          streak={streak}
          stats={stats}
          onClose={() => setView('chat')}
          onOpenRecipe={recipe => {
            setViewingDish(recipe)
            setViewingDishImg(recipe._imgUrl ?? null)
            setSavedBackTo('dashboard')
            setView('detail')
          }}
          onOpenSessionDish={dish => {
            setViewingDish(dish)
            setViewingDishImg(dish._imgUrl ?? null)
            setSavedBackTo('dashboard')
            setView('detail')
          }}
          onQuickStart={handleReset}
          onEditProfile={() => setView('onboarding')}
          onViewSaved={() => { setSavedBackTo('dashboard'); setView('saved') }}
          isAdmin={isAdmin}
          isCoach={isCoach}
          isFighter={isFighter}
          isProUser={isProUser}
          isDirect={tier.isDirect}
          onAdminPanel={() => setView('admin-panel')}
          onSignOut={handleSignOut}
          dayPlanVersion={dayPlanVersion}
          onOpenCookWithPrompt={handleOpenCookWithPrompt}
          onLogSavedRecipe={handleLogSavedRecipe}
          onDayPlanUpdated={() => setDayPlanVersion(v => v + 1)}
          onOpenCookbook={() => setView('cookbook')}
          onAddManualSavedRecipe={dish => handleSaveRecipe(dish, null, null)}
          onViewRoster={() => setView('coach-roster')}
          onOpenMealPlanner={(slot) => { setPlannerInitialSlot(slot || null); setView('planner') }}
          authToken={getAccessToken()}
          onLetCoachKnow={dishName => {
            const c = (() => { try { return JSON.parse(localStorage.getItem('remi_coach_name') || 'null') } catch { return null } })()
            const coachName = (c?.slug === profile?.referredBy ? c?.name : null) || 'your coach'
            showCoachLogToast({ coachName, coachSlug: profile?.referredBy, dishName, clientName: profile?.name, sport: profile?.sport || profile?.primarySport || '', goal: Array.isArray(profile?.goals) ? profile?.goals[0] : (profile?.goal || '') })
          }}
        />
        <BottomNav activeView="dashboard" onNavigate={v => {
          if (v === 'saved') { setSavedBackTo('dashboard'); setView('saved') }
          else setView(v)
        }} isPro={tier.canUseIntel} />
        {dayPlanSlotSheet && (() => {
          const SLOTS = ['breakfast', 'lunch', 'dinner']
          const cap   = s => s.charAt(0).toUpperCase() + s.slice(1)
          const confirmSlot = (slot) => {
            try {
              const todayStr = new Date().toISOString().slice(0, 10)
              const raw  = localStorage.getItem('remi_day_plan')
              let plan   = raw ? JSON.parse(raw) : null
              if (!plan || plan.date !== todayStr) {
                plan = { date: todayStr, breakfast: null, lunch: null, dinner: null }
              }
              const d = dayPlanSlotSheet.dish
              plan[slot] = {
                name:    d.name,
                kcal:    parseInt(d.dietician?.macros?.calories) || 0,
                protein: parseInt(d.dietician?.macros?.protein)  || 0,
                carbs:   parseInt(d.dietician?.macros?.carbs)    || 0,
                fat:     parseInt(d.dietician?.macros?.fat)      || 0,
              }
              localStorage.setItem('remi_day_plan', JSON.stringify(plan))
              setDayPlanVersion(v => v + 1)
            } catch {}
            if (!isRecipeSaved(dayPlanSlotSheet.dish.name)) {
              handleSaveRecipe(dayPlanSlotSheet.dish, dayPlanSlotSheet.imgUrl, dayPlanSlotSheet.imgCredit)
            }
            setDayPlanSlotSheet(null)
            setTargetMeal(null)
            showAppToast(`Logged to ${cap(slot)}`)
          }
          return (
            <div
              onClick={() => setDayPlanSlotSheet(null)}
              style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 9100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              <div
                onClick={e => e.stopPropagation()}
                style={{ width: '100%', maxWidth: 480, backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px 10px 0 0', padding: '24px 20px 40px', boxSizing: 'border-box' }}>
                <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 16px', textAlign: 'center' }}>
                  Log this for...
                </p>
                <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                  {SLOTS.map(slot => {
                    const active = dayPlanSlotSheet.selected === slot
                    return (
                      <button
                        key={slot}
                        onClick={() => setDayPlanSlotSheet(s => ({ ...s, selected: slot }))}
                        style={{
                          flex: 1, height: 44, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)',
                          backgroundColor: active ? '#00E5A0' : '#1A1A1A',
                          color: active ? '#0D0D0D' : '#F0F0F0',
                          fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 13,
                          cursor: 'pointer', transition: 'background-color 150ms ease, color 150ms ease',
                        }}>
                        {cap(slot)}
                      </button>
                    )
                  })}
                </div>
                <button
                  onClick={() => confirmSlot(dayPlanSlotSheet.selected)}
                  style={{ width: '100%', height: 56, borderRadius: 8, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 10 }}>
                  Confirm
                </button>
                <button
                  onClick={() => setDayPlanSlotSheet(null)}
                  style={{ display: 'block', width: '100%', background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 400, color: '#888888', cursor: 'pointer', textAlign: 'center', padding: '8px 0' }}>
                  Cancel
                </button>
              </div>
            </div>
          )
        })()}
        {appToast && (
          <div style={{ position: 'fixed', bottom: 100, left: '50%', transform: 'translateX(-50%)', zIndex: 9200, backgroundColor: '#1A1A1A', border: '0.5px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '10px 18px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#E8E8E8', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
            {appToast}
          </div>
        )}
        {coachLogToast && <CoachLogToast toast={coachLogToast} onSend={handleCoachLogSend} onDismiss={dismissCoachLogToast} />}
      </>
    )
  }

  // ── View: Meal Planner ───────────────────────────────────────────────────────
  if (view === 'planner' && tier.canUsePlanner) {
    return (
      <MealPlanner
        user={{ role: isAdmin ? 'admin' : userRole }}
        authToken={getAccessToken()}
        savedRecipes={savedRecipes}
        profile={profile}
        initialOpenSlot={plannerInitialSlot}
        onOpenCook={() => { setPlannerInitialSlot(null); setView('cook') }}
        onClose={() => { setPlannerInitialSlot(null); setView('dashboard') }}
      />
    )
  }

  // ── View: Admin panel ────────────────────────────────────────────────────────
  if (view === 'admin-panel' && isAdmin) {
    return <AdminPanel onBack={() => setView('dashboard')} />
  }

  // ── View: Coach roster ───────────────────────────────────────────────────────
  if (view === 'coach-roster' && isCoach) {
    return (
      <CoachRosterView
        slug={profile?.referralSlug}
        onBack={() => setView('dashboard')}
        onSelectClient={client => { setSelectedClient(client); setView('clientDetail') }}
      />
    )
  }

  if (view === 'clientDetail' && selectedClient) {
    return (
      <ClientDetail
        selectedClient={selectedClient}
        onClose={() => setView('coach-roster')}
        authToken={getAccessToken()}
      />
    )
  }

  // ── View: Coach Pitch (first login for new coaches with a slug) ──────────────
  if (view === 'welcome-back' && welcomeBackData && isCoach && profile?.referralSlug && !localStorage.getItem('remi_coach_pitch_seen')) {
    return (
      <CoachPitchScreen
        onViewRoster={() => {
          localStorage.setItem('remi_coach_pitch_seen', 'true')
          setView('coach-roster')
        }}
        onDashboard={() => {
          localStorage.setItem('remi_coach_pitch_seen', 'true')
          setView('dashboard')
        }}
      />
    )
  }

  // ── View: Welcome Back ───────────────────────────────────────────────────────
  if (view === 'welcome-back' && welcomeBackData) {
    return (
      <WelcomeBackScreen
        name={welcomeBackData.name}
        lastSignInAt={welcomeBackData.lastSignInAt}
        onKitchen={handleReset}
        onDashboard={() => setView('dashboard')}
      />
    )
  }

  // ── View: Set Password (recovery link) ────────────────────────────────────────
  if (view === 'set-password') {
    return (
      <SetPasswordScreen
        accessToken={recoveryToken}
        onSuccess={() => {
          setRecoveryToken(null)
          setView('auth')
        }}
      />
    )
  }

  // ── View: Intel ──────────────────────────────────────────────────────────────
  if (view === 'intel') {
    return (
      <>
        <IntelView isPro={tier.canUseIntel} onProClick={() => setShowProModal(true)} />
        <BottomNav activeView="intel" onNavigate={v => {
          if (v === 'saved') { setSavedBackTo('intel'); setView('saved') }
          else if (v === 'chat') handleReset()
          else setView(v)
        }} isPro={tier.canUseIntel} />
        {showProModal && <ProModal onClose={() => setShowProModal(false)} />}
      </>
    )
  }

  // ── View: Cookbook ───────────────────────────────────────────────────────────
  if (view === 'cookbook') {
    return (
      <>
        <CookbookView
          savedRecipes={savedRecipes}
          onBack={() => setView('dashboard')}
          onStartCooking={handleReset}
          onOpenRecipe={recipe => {
            setViewingDish(recipe)
            setViewingDishImg(recipe._imgUrl ?? null)
            setSavedBackTo('cookbook')
            setView('detail')
          }}
          onAddToDayPlan={handleAddToDayPlan}
        />
        <BottomNav activeView="saved" onNavigate={v => {
          if (v === 'saved') { setSavedBackTo('cookbook'); setView('saved') }
          else setView(v)
        }} isPro={tier.canUseIntel} />
        {dayPlanSlotSheet && (() => {
          const SLOTS = ['breakfast', 'lunch', 'dinner']
          const cap   = s => s.charAt(0).toUpperCase() + s.slice(1)
          const confirmSlot = (slot) => {
            try {
              const todayStr = new Date().toISOString().slice(0, 10)
              const raw  = localStorage.getItem('remi_day_plan')
              let plan   = raw ? JSON.parse(raw) : null
              if (!plan || plan.date !== todayStr) {
                plan = { date: todayStr, breakfast: null, lunch: null, dinner: null }
              }
              const d = dayPlanSlotSheet.dish
              plan[slot] = {
                name:    d.name,
                kcal:    parseInt(d.dietician?.macros?.calories) || 0,
                protein: parseInt(d.dietician?.macros?.protein)  || 0,
                carbs:   parseInt(d.dietician?.macros?.carbs)    || 0,
                fat:     parseInt(d.dietician?.macros?.fat)      || 0,
              }
              localStorage.setItem('remi_day_plan', JSON.stringify(plan))
              setDayPlanVersion(v => v + 1)
            } catch {}
            if (!isRecipeSaved(dayPlanSlotSheet.dish.name)) {
              handleSaveRecipe(dayPlanSlotSheet.dish, dayPlanSlotSheet.imgUrl, dayPlanSlotSheet.imgCredit)
            }
            setDayPlanSlotSheet(null)
            setTargetMeal(null)
            showAppToast(`Logged to ${cap(slot)}`)
          }
          return (
            <div
              onClick={() => setDayPlanSlotSheet(null)}
              style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 9100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              <div
                onClick={e => e.stopPropagation()}
                style={{ width: '100%', maxWidth: 480, backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px 10px 0 0', padding: '24px 20px 40px', boxSizing: 'border-box' }}>
                <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 16px', textAlign: 'center' }}>
                  Log this for...
                </p>
                <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                  {SLOTS.map(slot => {
                    const active = dayPlanSlotSheet.selected === slot
                    return (
                      <button
                        key={slot}
                        onClick={() => setDayPlanSlotSheet(s => ({ ...s, selected: slot }))}
                        style={{ flex: 1, height: 44, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: active ? '#00E5A0' : '#1A1A1A', color: active ? '#0D0D0D' : '#F0F0F0', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 13, cursor: 'pointer', transition: 'background-color 150ms ease, color 150ms ease' }}>
                        {cap(slot)}
                      </button>
                    )
                  })}
                </div>
                <button
                  onClick={() => confirmSlot(dayPlanSlotSheet.selected)}
                  style={{ width: '100%', height: 56, borderRadius: 8, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 10 }}>
                  Confirm
                </button>
                <button
                  onClick={() => setDayPlanSlotSheet(null)}
                  style={{ display: 'block', width: '100%', background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 400, color: '#888888', cursor: 'pointer', textAlign: 'center', padding: '8px 0' }}>
                  Cancel
                </button>
              </div>
            </div>
          )
        })()}
        {appToast && (
          <div style={{ position: 'fixed', bottom: 100, left: '50%', transform: 'translateX(-50%)', zIndex: 9200, backgroundColor: '#1A1A1A', border: '0.5px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '10px 18px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#E8E8E8', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
            {appToast}
          </div>
        )}
        {coachLogToast && <CoachLogToast toast={coachLogToast} onSend={handleCoachLogSend} onDismiss={dismissCoachLogToast} />}
      </>
    )
  }

  // ── View: Saved recipes ──────────────────────────────────────────────────────
  if (view === 'saved') {
    return (
      <>
        <SavedRecipesView
          savedRecipes={savedRecipes}
          savesCap={tier.savesCap}
          onClose={() => setView(savedBackTo)}
          onRemove={handleRemoveRecipe}
          onOpen={recipe => {
            setViewingDish(recipe)
            setViewingDishImg(recipe._imgUrl ?? null)
            setView('detail')
          }}
        />
        <BottomNav activeView="saved" onNavigate={v => {
          if (v === 'saved') return
          setSavedBackTo('saved')
          setView(v)
        }} isPro={tier.canUseIntel} />
      </>
    )
  }

  // ── View: Recipe Reveal — the ah-huh page ────────────────────────────────────
  // Reads from the existing dishes + missingIngredients state populated by the
  // chat completion path. If a user lands here without dishes (e.g. via direct
  // navigation/back from detail after a reload), fall through to the chat.
  if (view === 'reveal' && Array.isArray(dishes) && dishes.length > 0) {
    return (
      <>
        <RecipeReveal
          dishes={dishes}
          missingIngredients={missingIngredients}
          onBack={() => setView('chat')}
          onOpenDish={d => {
            setViewingDish(d)
            setViewingDishImg(d._imgUrl ?? null)
            setSavedBackTo('reveal')
            posthog.capture('recipe_detail_viewed', { dish_name: d.name, source: 'reveal' })
            setView('detail')
          }}
          onAddToDayPlan={handleAddToDayPlan}
          onNavigateDashboard={() => setView('dashboard')}
        />
        <BottomNav activeView="chat" onNavigate={v => {
          if (v === 'saved') { setSavedBackTo('reveal'); setView('saved') }
          else setView(v)
        }} isPro={tier.canUseIntel} />
        {dayPlanSlotSheet && (() => {
          const SLOTS = ['breakfast', 'lunch', 'dinner']
          const cap   = s => s.charAt(0).toUpperCase() + s.slice(1)
          const confirmSlot = (slot) => {
            try {
              const todayStr = new Date().toISOString().slice(0, 10)
              const raw  = localStorage.getItem('remi_day_plan')
              let plan   = raw ? JSON.parse(raw) : null
              if (!plan || plan.date !== todayStr) {
                plan = { date: todayStr, breakfast: null, lunch: null, dinner: null }
              }
              const d = dayPlanSlotSheet.dish
              plan[slot] = {
                name:    d.name,
                kcal:    parseInt(d.dietician?.macros?.calories) || 0,
                protein: parseInt(d.dietician?.macros?.protein)  || 0,
                carbs:   parseInt(d.dietician?.macros?.carbs)    || 0,
                fat:     parseInt(d.dietician?.macros?.fat)      || 0,
              }
              localStorage.setItem('remi_day_plan', JSON.stringify(plan))
              setDayPlanVersion(v => v + 1)
            } catch {}
            if (!isRecipeSaved(dayPlanSlotSheet.dish.name)) {
              handleSaveRecipe(dayPlanSlotSheet.dish, dayPlanSlotSheet.imgUrl, dayPlanSlotSheet.imgCredit)
            }
            setDayPlanSlotSheet(null)
            setTargetMeal(null)
            showAppToast(`Logged to ${cap(slot)}`)
          }
          return (
            <div
              onClick={() => setDayPlanSlotSheet(null)}
              style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 9100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              <div
                onClick={e => e.stopPropagation()}
                style={{ width: '100%', maxWidth: 480, backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px 10px 0 0', padding: '24px 20px 40px', boxSizing: 'border-box' }}>
                <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 16px', textAlign: 'center' }}>
                  Log this for...
                </p>
                <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                  {SLOTS.map(slot => {
                    const active = dayPlanSlotSheet.selected === slot
                    return (
                      <button
                        key={slot}
                        onClick={() => setDayPlanSlotSheet(s => ({ ...s, selected: slot }))}
                        style={{
                          flex: 1, height: 44, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)',
                          backgroundColor: active ? '#00E5A0' : '#1A1A1A',
                          color: active ? '#0D0D0D' : '#F0F0F0',
                          fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 13,
                          cursor: 'pointer', transition: 'background-color 150ms ease, color 150ms ease',
                        }}>
                        {cap(slot)}
                      </button>
                    )
                  })}
                </div>
                <button
                  onClick={() => confirmSlot(dayPlanSlotSheet.selected)}
                  style={{ width: '100%', height: 56, borderRadius: 8, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 10 }}>
                  Confirm
                </button>
                <button
                  onClick={() => setDayPlanSlotSheet(null)}
                  style={{ display: 'block', width: '100%', background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 400, color: '#888888', cursor: 'pointer', textAlign: 'center', padding: '8px 0' }}>
                  Cancel
                </button>
              </div>
            </div>
          )
        })()}
        {appToast && (
          <div style={{ position: 'fixed', bottom: 100, left: '50%', transform: 'translateX(-50%)', zIndex: 9200, backgroundColor: '#1A1A1A', border: '0.5px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '10px 18px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#E8E8E8', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
            {appToast}
          </div>
        )}
        {coachLogToast && <CoachLogToast toast={coachLogToast} onSend={handleCoachLogSend} onDismiss={dismissCoachLogToast} />}
      </>
    )
  }

  // ── View: Detail ─────────────────────────────────────────────────────────────
  if (view === 'detail' && (selectedDish !== null || viewingDish !== null)) {
    const dish       = viewingDish ?? dishes[selectedDish]
    const imgUrl     = viewingDish ? viewingDishImg : (dishImages[selectedDish]?.url ?? null)
    const imgCredit  = viewingDish ? (viewingDish._imgCredit ?? null) : (dishImages[selectedDish]?.credit ?? null)
    const backTo     = viewingDish ? savedBackTo : 'cards'
    // DetailView shows ingredients for THIS dish only — filter the combined list
    // by the dish's own method/note/technique text via ingredientsForDish().
    // Opened from 'cards' (legacy path) keeps the full list.
    const detailIngredients = viewingDish
      ? ingredientsForDish(missingIngredients, viewingDish)
      : missingIngredients
    return (
      <>
        <DetailView
          dish={dish}
          onBack={() => { setViewingDish(null); setViewingDishImg(null); setView(backTo) }}
          imgUrl={imgUrl}
          photographer={imgCredit}
          isSaved={isRecipeSaved(dish.name)}
          onSave={() => handleSaveRecipe(dish, imgUrl, imgCredit)}
          onRemove={() => handleRemoveRecipe(dish.name)}
          onNavigateDashboard={() => setView('dashboard')}
          missingIngredients={detailIngredients}
          onAddToDayPlan={handleAddToDayPlan}
        />

        {/* Day-plan slot picker — appears on top of detail view after save */}
        {dayPlanSlotSheet && (() => {
          const SLOTS = ['breakfast', 'lunch', 'dinner']
          const cap   = s => s.charAt(0).toUpperCase() + s.slice(1)
          const confirmSlot = (slot) => {
            try {
              const todayStr = new Date().toISOString().slice(0, 10)
              const raw  = localStorage.getItem('remi_day_plan')
              let plan   = raw ? JSON.parse(raw) : null
              if (!plan || plan.date !== todayStr) {
                plan = { date: todayStr, breakfast: null, lunch: null, dinner: null }
              }
              const d = dayPlanSlotSheet.dish
              plan[slot] = {
                name:    d.name,
                kcal:    parseInt(d.dietician?.macros?.calories) || 0,
                protein: parseInt(d.dietician?.macros?.protein)  || 0,
                carbs:   parseInt(d.dietician?.macros?.carbs)    || 0,
                fat:     parseInt(d.dietician?.macros?.fat)      || 0,
              }
              localStorage.setItem('remi_day_plan', JSON.stringify(plan))
              setDayPlanVersion(v => v + 1)
            } catch {}
            if (!isRecipeSaved(dayPlanSlotSheet.dish.name)) {
              handleSaveRecipe(dayPlanSlotSheet.dish, dayPlanSlotSheet.imgUrl, dayPlanSlotSheet.imgCredit)
            }
            setDayPlanSlotSheet(null)
            setTargetMeal(null)
            showAppToast(`Logged to ${cap(slot)}`)
          }
          return (
            <div
              onClick={() => setDayPlanSlotSheet(null)}
              style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 9100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              <div
                onClick={e => e.stopPropagation()}
                style={{ width: '100%', maxWidth: 480, backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px 10px 0 0', padding: '24px 20px 40px', boxSizing: 'border-box' }}>
                <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 16px', textAlign: 'center' }}>
                  Log this for...
                </p>
                <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                  {SLOTS.map(slot => {
                    const active = dayPlanSlotSheet.selected === slot
                    return (
                      <button
                        key={slot}
                        onClick={() => setDayPlanSlotSheet(s => ({ ...s, selected: slot }))}
                        style={{
                          flex: 1, height: 44, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)',
                          backgroundColor: active ? '#00E5A0' : '#1A1A1A',
                          color: active ? '#0D0D0D' : '#F0F0F0',
                          fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 13,
                          cursor: 'pointer', transition: 'background-color 150ms ease, color 150ms ease',
                        }}>
                        {cap(slot)}
                      </button>
                    )
                  })}
                </div>
                <button
                  onClick={() => confirmSlot(dayPlanSlotSheet.selected)}
                  style={{ width: '100%', height: 56, borderRadius: 8, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 15, cursor: 'pointer', marginBottom: 10 }}>
                  Confirm
                </button>
                <button
                  onClick={() => setDayPlanSlotSheet(null)}
                  style={{ display: 'block', width: '100%', background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 400, color: '#888888', cursor: 'pointer', textAlign: 'center', padding: '8px 0' }}>
                  Cancel
                </button>
              </div>
            </div>
          )
        })()}

        {/* App-level toast */}
        {appToast && (
          <div style={{ position: 'fixed', bottom: 100, left: '50%', transform: 'translateX(-50%)', zIndex: 9200, backgroundColor: '#1A1A1A', border: '0.5px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '10px 18px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#E8E8E8', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
            {appToast}
          </div>
        )}
        {coachLogToast && <CoachLogToast toast={coachLogToast} onSend={handleCoachLogSend} onDismiss={dismissCoachLogToast} />}
      </>
    )
  }

  // ── View: Cards ──────────────────────────────────────────────────────────────
  if (view === 'cards' && dishes) {
    return (
      <>
        <div className="animate-fade-in flex h-[100dvh]" style={{ backgroundColor: '#0D0D0D' }}>
          {/* Main content */}
          <div className="flex-1 min-w-0 overflow-y-auto px-4 py-10 sm:py-14 pb-20 lg:pb-14" style={{ backgroundColor: '#0D0D0D' }}>
            <div className="max-w-3xl mx-auto space-y-8 relative">
              {/* Gen counter + locked banner */}
              {!isPro && genCount >= 3 ? (
                <div className="rounded-2xl px-5 py-4" style={{ backgroundColor: '#1A1A0A', border: '1px solid #C9A84C' }}>
                  <div className="flex items-center gap-3">
                    <span style={{ fontSize: '1.25rem' }}>🔒</span>
                    <div className="flex-1">
                      <p style={{ color: '#C9A84C', fontWeight: 600, fontSize: '0.875rem' }}>Kitchen's closed for today</p>
                      <p style={{ color: '#888888', fontSize: '0.75rem', marginTop: 2 }}>You've used all 3 free sessions. Come back tomorrow or upgrade.</p>
                    </div>
                    <button onClick={() => setShowProModal(true)} style={{ color: '#C9A84C', fontSize: '0.75rem', fontWeight: 700, whiteSpace: 'nowrap', background: 'none', border: 'none', cursor: 'pointer' }}>Go Pro →</button>
                  </div>
                  <p style={{ marginTop: 8, paddingLeft: '2rem' }}>
                    <button onClick={() => setShowPTPage(true)} style={{ background: 'none', border: 'none', color: '#888888', cursor: 'pointer', padding: 0, fontSize: '0.7rem', fontFamily: "Inter, sans-serif", textDecoration: 'underline' }}>Are you a PT?</button>
                  </p>
                </div>
              ) : (
                <p style={{ color: '#888888', fontSize: '0.75rem', textAlign: 'right' }}>{genCount} of 3 sessions used today</p>
              )}
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="font-sans text-3xl sm:text-4xl font-bold" style={{ color: '#F0F0F0' }}>
                    Your meals
                  </h1>
                  <p style={{ color: '#888888', fontSize: '0.875rem', marginTop: 4 }}>
                    Tap a card to open the full recipe.
                  </p>
                </div>
                {/* Desktop nav buttons only */}
                <div className="hidden sm:flex flex-col gap-2 mt-1.5 shrink-0 items-end">
                  <button
                    onClick={() => setView('dashboard')}
                    className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors duration-200"
                    style={{ color: '#888888', border: '1px solid rgba(255,255,255,0.08)' }}
                  >
                    Stats
                  </button>
                  <div className="flex gap-2">
                    {savedRecipes.length > 0 && (
                      <button
                        onClick={() => { setSavedBackTo('cards'); setView('saved') }}
                        className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors duration-200 flex items-center gap-1"
                        style={{ color: '#888888', border: '1px solid rgba(255,255,255,0.08)' }}
                      >
                        Saved
                        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold" style={{ backgroundColor: '#00E5A0', color: '#0D0D0D' }}>
                          {savedRecipes.length}
                        </span>
                      </button>
                    )}
                    <button
                      onClick={handleReset}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors duration-200"
                      style={{ color: '#888888', border: '1px solid rgba(255,255,255,0.08)' }}
                    >
                      Cook again
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                {dishes.map((dish, i) => (
                  <DishCard
                    key={i}
                    dish={dish}
                    onClick={() => { setSelectedDish(i); posthog.capture('recipe_detail_viewed', { dish_name: dish.name }); setView('detail') }}
                    onImageResolved={(url, credit) => setDishImages(prev => {
                      const next = [...prev]; next[i] = { url, credit }; return next
                    })}
                  />
                ))}
              </div>

              {/* ── What You'll Need ── */}
              {missingIngredients.length > 0 && (
                <div className="space-y-3 animate-fade-in">
                  <p
                    className="text-[11px] font-bold uppercase tracking-widest"
                    style={{ color: '#00E5A0' }}
                  >
                    What You'll Need
                  </p>
                  <div
                    className="rounded-2xl p-5 space-y-4"
                    style={{ backgroundColor: '#1A1A1A', border: '0.5px solid rgba(255,255,255,0.08)' }}
                  >
                    <ul className="space-y-2">
                      {missingIngredients.map((item, i) => {
                        const checked = checkedIngredients.has(i)
                        function toggleChecked() {
                          setCheckedIngredients(prev => {
                            const next = new Set(prev)
                            if (next.has(i)) next.delete(i)
                            else next.add(i)
                            return next
                          })
                        }
                        return (
                          <li
                            key={i}
                            className="flex items-center gap-3 text-sm leading-snug cursor-pointer select-none"
                            style={{
                              color: '#F0F0F0',
                              opacity: checked ? 0.35 : 1,
                              transition: 'opacity 200ms ease',
                            }}
                            onClick={toggleChecked}
                          >
                            {/* Custom checkbox */}
                            <span
                              className="shrink-0 flex items-center justify-center"
                              style={{
                                width: 20,
                                height: 20,
                                borderRadius: 4,
                                border: '2px solid #00E5A0',
                                backgroundColor: checked ? '#00E5A0' : 'transparent',
                                transition: 'background-color 200ms ease',
                              }}
                            >
                              {checked && (
                                <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
                                  <path d="M1 4.5L4 7.5L10 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              )}
                            </span>
                            {/* Item text */}
                            <span
                              style={{
                                textDecoration: checked ? 'line-through' : 'none',
                                transition: 'text-decoration 200ms ease',
                              }}
                            >
                              {item}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                    {(() => {
                      const allChecked = missingIngredients.every((_, i) => checkedIngredients.has(i))
                      return (
                        <button
                          onClick={handleCopyShoppingList}
                          disabled={allChecked}
                          className="w-full py-3 rounded-xl font-semibold text-sm text-white transition-all duration-200 active:opacity-80"
                          style={{
                            backgroundColor: shoppingListCopied ? '#009966' : allChecked ? '#2A2A2A' : '#00E5A0',
                            boxShadow: (shoppingListCopied || allChecked) ? 'none' : '0 2px 8px rgba(0,229,160,0.3)',
                            cursor: allChecked ? 'default' : 'pointer',
                            color: allChecked ? '#888888' : '#0D0D0D',
                          }}
                        >
                          {shoppingListCopied ? '✓ Copied' : allChecked ? '✓ All picked up' : 'Copy List'}
                        </button>
                      )
                    })()}
                  </div>
                </div>
              )}
            </div>
          </div>
          {/* Desktop insights sidebar */}
          <InsightsDesktopSidebar />
        </div>
        <BottomNav activeView="cards" onNavigate={v => {
          if (v === 'saved') { setSavedBackTo('cards'); setView('saved') }
          else if (v === 'chat') handleReset()
          else setView(v)
        }} isPro={tier.canUseIntel} />
        {showProModal && <ProModal onClose={() => setShowProModal(false)} />}
      </>
    )
  }

  // ── View: Loading (streaming dishes) ────────────────────────────────────────
  if (awaitingDishes) {
    return (
      <div className="animate-fade-in min-h-screen flex flex-col items-center justify-center px-6 py-14" style={{ backgroundColor: '#0D0D0D' }}>
        <style>{CHAT_STYLES}</style>
        <ChefLoader />
      </div>
    )
  }

  // ── View: Chat ───────────────────────────────────────────────────────────────
  return (
    <>
      <style>{CHAT_STYLES}</style>
      <div className="animate-fade-in flex relative" style={{ position: 'fixed', inset: 0, backgroundColor: '#0D0D0D' }}>

        {/* ── Main chat column ── */}
        <div className="flex flex-col flex-1 min-w-0">

          {/* Cook header — Dashboard back · Remi presence */}
          <div
            className="shrink-0"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 20px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              backgroundColor: '#0D0D0D',
            }}
          >
            <button
              onClick={() => setView('dashboard')}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 400, color: '#888888' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              Dashboard
            </button>
            <div style={{ textAlign: 'center' }}>
              <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 20, color: '#F0F0F0', lineHeight: 1, margin: 0 }}>
                Remi
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 4 }}>
                <span className="presence-dot-pulse" style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#00E5A0', display: 'inline-block' }} />
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#888888' }}>In the kitchen</span>
              </div>
              {!tier.isPro && (
                <p style={{ fontFamily: 'Inter, sans-serif', fontWeight: 400, fontSize: 13, color: '#888888', margin: '3px 0 0', lineHeight: 1 }}>
                  {genCount} / 20 generations this month
                </p>
              )}
            </div>
            <div style={{ width: 80 }} />
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-3 relative z-10 pb-20 lg:pb-5">
            {displayMessages.map(msg => (
              <div key={msg.id}>
                <ChatBubble role={msg.role} content={msg.content} isOpening={!!(msg.seed && msg.role === 'assistant')} />
                {msg.dashboardPrompt && (
                  <div style={{ marginTop: 12 }}>
                    <button
                      onClick={() => setView('dashboard')}
                      style={{ backgroundColor: '#00E5A0', color: '#0D0D0D', borderRadius: 20, padding: '12px 24px', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 14, border: 'none', cursor: 'pointer' }}
                    >
                      See my dashboard
                    </button>
                  </div>
                )}
                {msg.revealBreadcrumb && (
                  <div style={{ marginTop: 12 }}>
                    <button
                      onClick={() => setView('reveal')}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        background: 'none', border: 'none', padding: '6px 0',
                        color: '#00E5A0', cursor: 'pointer',
                        fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 600,
                      }}
                    >
                      View the recipes →
                    </button>
                  </div>
                )}
              </div>
            ))}
            {streaming && streamContent && (
              <ChatBubble role="assistant" content={streamContent} isStreaming />
            )}
            {streaming && !streamContent && <CookingState />}
            <div className="h-2" />
          </div>

          {/* Error banner */}
          {error && (
            <div className="shrink-0 mx-4 mb-2 rounded-xl px-4 py-2.5 text-xs relative z-10" style={{ backgroundColor: 'rgba(229,90,90,0.1)', border: '1px solid rgba(229,90,90,0.3)', color: '#E55A5A' }}>
              {error}
            </div>
          )}

          {/* Docked tray — always above the input bar, never inline in the message flow */}
          {quickReplyType && !streaming && (
            <div className="shrink-0 px-4 pt-3 pb-2 relative z-10" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#0D0D0D' }}>
              <QuickReplyRow
                type={quickReplyType}
                onSubmit={(text, data) => handleQuickReply(text, data, quickReplyType)}
                onDismiss={() => setQuickReplyType(null)}
                onFocusInput={() => setTimeout(() => inputRef.current?.focus(), 50)}
              />
            </div>
          )}

          {/* Ingredient autocomplete chips */}
          {suggestions.length > 0 && (
            <div
              className="shrink-0 px-4 py-2 flex gap-2 overflow-x-auto"
              style={{ borderTop: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#0D0D0D', scrollbarWidth: 'none' }}
            >
              {suggestions.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    // Strip the partial word the user was typing and replace with the selection
                    const prefix = input.replace(/\S+$/, '').trimEnd()
                    const separator = prefix.endsWith(',') ? ' ' : prefix ? ', ' : ''
                    setInput(prefix + (prefix ? separator : '') + s)
                    setSuggestions([])
                    setTimeout(() => inputRef.current?.focus(), 0)
                  }}
                  className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-full whitespace-nowrap active:opacity-70 transition-opacity"
                  style={{ backgroundColor: '#1A1A1A', color: '#00E5A0', border: '1px solid #00C080' }}
                >
                  + {s}
                </button>
              ))}
            </div>
          )}

          {/* Input bar */}
          <div
            className="shrink-0 px-4 pt-2.5 relative z-10"
            style={{
              borderTop: suggestions.length > 0 ? 'none' : '1px solid rgba(255,255,255,0.08)',
              backgroundColor: '#0D0D0D',
              touchAction: 'manipulation',
              paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
            }}
          >
            <form onSubmit={handleSubmit} className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                onInput={e => {
                  const ta = e.target
                  ta.style.height = 'auto'
                  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (!streaming && input.trim()) submitMessage(input)
                  }
                }}
                placeholder="Type here..."
                rows={1}
                disabled={streaming}
                className="flex-1 focus:outline-none disabled:opacity-50 leading-snug"
                style={{
                  fontSize: 16,
                  minHeight: 44,
                  maxHeight: 120,
                  resize: 'none',
                  overflowY: 'auto',
                  backgroundColor: '#1A1A1A',
                  border: inputFocused ? '1px solid #00E5A0' : '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8,
                  padding: '12px 14px',
                  color: '#F0F0F0',
                  fontFamily: 'Inter, sans-serif',
                  transition: 'border-color 200ms ease',
                }}
              />
              {streaming ? (
                <button
                  type="button"
                  onClick={handleStop}
                  style={{ backgroundColor: '#1A1A1A', width: 44, height: 44, flexShrink: 0, color: '#F0F0F0', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer' }}
                  className="flex items-center justify-center text-xs font-semibold active:opacity-80 transition-opacity"
                  aria-label="Stop"
                >
                  ■
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  style={{
                    backgroundColor: input.trim() ? '#00E5A0' : '#1A1A1A',
                    color: input.trim() ? '#0D0D0D' : '#444444',
                    width: 44,
                    height: 44,
                    flexShrink: 0,
                    borderRadius: 8,
                    border: input.trim() ? 'none' : '1px solid rgba(255,255,255,0.08)',
                    cursor: input.trim() ? 'pointer' : 'not-allowed',
                    transition: 'background-color 200ms ease',
                  }}
                  className="flex items-center justify-center active:opacity-80"
                  aria-label="Send"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5" style={{ marginLeft: 2 }}>
                    <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
                  </svg>
                </button>
              )}
            </form>
          </div>

          {/* Spacer — reserves height for the fixed BottomNav on mobile */}
          <div
            className="shrink-0 lg:hidden"
            style={{ height: 56 }}
          />
        </div>
      </div>

      {/* Mobile bottom nav */}
      <BottomNav activeView="chat" onNavigate={v => {
        if (v === 'saved') { setSavedBackTo('chat'); setView('saved') }
        else setView(v)
      }} isPro={tier.canUseIntel} />
      {showProModal && <ProModal onClose={() => setShowProModal(false)} />}
      {showGenCapModal && <GenCapModal onClose={() => setShowGenCapModal(false)} />}
    </>
  )
}
