import posthog from 'posthog-js'
import { useState, useRef, useEffect, useMemo } from 'react'
import remiLogoUrl from './assets/remi-logo.svg'

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

const LS_KEYS = ['remi_profile', 'lhc_profile', 'lhc_saved_recipes', 'lhc_sessions', 'lhc_streak', 'lhc_stats']

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

function parseMissingIngredients(rawText) {
  // Strip markdown bold/italic/headings first so **MISSING INGREDIENTS** still matches
  const text = rawText
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')

  // Accept heading variants, optional colon, optional blank line, then the bullet list.
  // \n+ (not \s*\n) lets a blank line sit between the heading and the first bullet.
  const m = text.match(
    /(?:MISSING INGREDIENTS|WHAT\s+YOU(?:'|'|')\s*LL\s+NEED|YOU(?:'|'|')\s*LL\s+NEED|SHOPPING\s+LIST)\s*:?\s*\n+([\s\S]+?)(?:\n{2,}|$)/i
  )
  if (m) {
    const items = m[1]
      .split('\n')
      .map(l => l.replace(/^[-•*\d.]+\s*/, '').trim())
      .filter(l => l.length > 0 && !/^nothing/i.test(l))
    if (items.length > 0) {
      return items
    }
  }

  // Fallback: scan for bullet/numbered lines appearing after known section markers
  const afterMarker = text.match(
    /(?:what\s+changes|you(?:'|'|')\s*ll\s+need|ingredients?\s*needed|shopping\s+list)\s*:?\s*\n([\s\S]+)/i
  )
  if (afterMarker) {
    const fallbackItems = afterMarker[1]
      .split('\n')
      .map(l => l.replace(/^[-•*\d.]+\s*/, '').trim())
      .filter(l => l.length > 0 && /[a-z]/i.test(l) && l.length < 100)
      .slice(0, 20)
    if (fallbackItems.length > 0) {
      return fallbackItems
    }
  }

  // Last resort: surface a helpful message so the section still renders
  return ['Check the full recipe above for ingredients needed.']
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
    <svg width={size} height={size} viewBox="0 0 44 44" fill="none">
      <path d="M22 8C22 8 14 16 14 24C14 28.4 17.6 32 22 32C26.4 32 30 28.4 30 24C30 16 22 8 22 8Z" fill="#00E5A0"/>
      <path d="M22 14C22 14 18 19 18 24C18 26.2 19.8 28 22 28" stroke="#00C080" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
    </svg>
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
  fat:     { border: '#7A6B5A', text: '#7A6B5A' },
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
          backgroundColor: '#1A1612',
          border: '1px solid #2A2A2A',
          width: 220,
        }}
      >
        <span
          className="text-[11px] font-medium uppercase tracking-[0.12em]"
          style={{ color: '#00E5A0' }}
        >
          {insight.tag}
        </span>
        <p className="text-[12px] font-semibold leading-snug" style={{ color: '#F0EAE0' }}>
          {insight.headline}
        </p>
      </div>
    )
  }
  return (
    <div
      className="rounded-2xl px-5 py-4 space-y-2"
      style={{
        backgroundColor: '#1A1612',
        border: '1px solid #2A2A2A',
        boxShadow: '0 1px 6px rgba(0,0,0,0.3)',
      }}
    >
      <span
        className="text-[11px] font-medium uppercase tracking-[0.12em]"
        style={{ color: '#00E5A0' }}
      >
        {insight.tag}
      </span>
      <p className="text-sm font-semibold leading-snug" style={{ color: '#F0EAE0' }}>
        {insight.headline}
      </p>
      <p className="text-xs leading-relaxed" style={{ color: '#7A6B5A' }}>
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
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] mb-1" style={{ color: '#7A6B5A' }}>
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
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
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
        backgroundColor: '#0F0D0B',
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
            style={{ color: active ? '#00E5A0' : '#7A6B5A' }}
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
            <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{item.label}</span>
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
          <span className="text-[11px] mt-0.5" style={{ color: '#7A6B5A' }}>{label}</span>
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
`

// ── Skeleton card (warm palette) ──────────────────────────────────────────────

const SHIMMER = '#2A2A2A'

function SkeletonCard() {
  return (
    <div
      className="rounded-2xl p-5 sm:p-6 space-y-4 animate-pulse"
      style={{
        backgroundColor: '#1A1612',
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
            {m.calories} kcal · {m.protein}P / {m.carbs}C / {m.fat}F
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
          <>
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
          </>
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
  return (
    <button
      onClick={onClick}
      className="w-full overflow-hidden text-left transition-all duration-200 hover:-translate-y-1.5 group"
      style={{ backgroundColor: '#1A1612', borderRadius: 12, border: '0.5px solid rgba(240,234,224,0.08)', boxShadow: '0 2px 12px rgba(0,0,0,0.3)' }}
    >
      <CardImageHeader dishName={dish.name} cuisine={dish.chef.cuisine} onImageResolved={onImageResolved} />

      <div className="space-y-3" style={{ backgroundColor: '#1A1612', borderRadius: '0 0 12px 12px', padding: 16 }}>
        {/* Cuisine badge */}
        {dish.chef.cuisine && (
          <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 10, fontWeight: 500, color: '#7A6B5A', letterSpacing: '0.12em', textTransform: 'uppercase', display: 'block' }}>
            {dish.chef.cuisine}
          </span>
        )}

        {/* Dish name */}
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: 18, color: '#F0EAE0', lineHeight: 1.2, margin: 0 }}>
          {dish.name}
        </h3>

        {/* 4-chip macro row */}
        <div className="flex gap-1.5 flex-wrap">
          {[
            { label: `${m.calories} kcal`, key: 'cal' },
            { label: `${m.protein}g P`,    key: 'pro' },
            { label: `${m.carbs}g C`,      key: 'carb' },
            { label: `${m.fat}g F`,        key: 'fat'  },
          ].map(chip => (
            <span
              key={chip.key}
              className="text-xs font-semibold px-2.5 py-1 rounded-full"
              style={{
                backgroundColor: 'rgba(122,158,126,0.12)',
                color: '#7A9E7E',
                border: '1px solid rgba(122,158,126,0.2)',
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {chip.label}
            </span>
          ))}
        </div>

        {/* Cook time + difficulty */}
        {(dish.dietician.cookTime !== '—' || dish.dietician.difficulty) && (
          <div className="flex gap-2 flex-wrap">
            {dish.dietician.cookTime !== '—' && (
              <span className="text-xs px-2.5 py-1 rounded-full" style={{ color: '#7A6B5A', backgroundColor: 'rgba(240,234,224,0.05)', border: '1px solid rgba(240,234,224,0.08)' }}>
                {dish.dietician.cookTime} mins
              </span>
            )}
            {dish.dietician.difficulty && (
              <span className="text-xs px-2.5 py-1 rounded-full" style={{ color: '#7A6B5A', backgroundColor: 'rgba(240,234,224,0.05)', border: '1px solid rgba(240,234,224,0.08)' }}>
                {dish.dietician.difficulty}
              </span>
            )}
          </div>
        )}

        <div className="pt-1 text-sm font-medium flex items-center gap-1.5 group-hover:gap-3 transition-all duration-200" style={{ color: '#C1683A', fontFamily: "'IBM Plex Sans', sans-serif" }}>
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
        style={{ borderRadius: 24, overflow: 'hidden', backgroundColor: '#111', border: '1px solid #2A2A2A' }}
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
            <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 10, color: '#F0EAE0', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
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
          <h2 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '1.375rem', color: '#F0EAE0', lineHeight: 1.2 }}>
            {dish.name}
          </h2>
        </div>

        {/* Macro strip */}
        <div className="grid grid-cols-4" style={{ borderTop: '1px solid #2A2A2A' }}>
          {macros.map(({ label, value }, i) => (
            <div
              key={label}
              className="flex flex-col items-center py-4 gap-0.5"
              style={{ borderRight: i < 3 ? '1px solid #2A2A2A' : 'none' }}
            >
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 15, fontWeight: 700, color: '#00E5A0' }}>
                {value}
              </span>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 9, color: '#555', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                {label}
              </span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 space-y-2.5" style={{ borderTop: '1px solid #2A2A2A' }}>
          <button
            disabled
            className="w-full py-3.5 rounded-xl text-sm font-semibold"
            style={{ backgroundColor: '#1A1612', color: '#444', border: '1px solid #2A2A2A', cursor: 'not-allowed' }}
          >
            Export card — coming next session
          </button>
          <button
            onClick={onClose}
            className="w-full py-3 rounded-xl text-sm font-medium"
            style={{ backgroundColor: 'transparent', color: '#666' }}
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
            backgroundColor: '#1A1612',
            border: '1px solid #2A2A2A',
            borderLeft: hovered === i ? `4px solid ${accentColor}` : `1px solid #2A2A2A`,
            color: '#F0EAE0',
            cursor: 'default',
          }}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered(null)}
        >
          <span className="shrink-0 w-6 h-6 rounded-full text-xs flex items-center justify-center font-bold mt-0.5"
            style={{ backgroundColor: accentColor, color: '#0F0D0B' }}>
            {i + 1}
          </span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  )
}

function DetailView({ dish, onBack, imgUrl, photographer = null, isSaved, onSave, onRemove, onNavigateDashboard, missingIngredients = [] }) {
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
    <div className="animate-fade-in min-h-screen pb-44 sm:pb-28" style={{ backgroundColor: '#0F0D0B' }}>
      <PaperTexture />

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
          style={{ backgroundColor: '#1A1612', color: '#F0EAE0', border: '1px solid #2A2A2A', cursor: toast.action ? 'pointer' : 'default' }}
        >
          {toast.message}
          {toast.action && <span className="opacity-60 text-xs">→</span>}
        </button>
      </div>

      {/* ── Hero image — own row, full width, text never on top ── */}
      {heroImg ? (
        <>
          <div className="relative w-full overflow-hidden" style={{ height: '55vh' }}>
            <img src={heroImg} alt={dish.name} className="w-full h-full object-cover" />
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
          <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(1.875rem, 6vw, 2.5rem)', color: '#F0EAE0', lineHeight: 1.15 }}>{dish.name}</h1>
        </div>

        {/* ── Mode toggle + Share ── */}
        <div className="flex gap-2.5 items-center">
          <div className="flex gap-2 flex-1">
            <button
              onClick={() => setMode('diet')}
              className="flex-1 py-2.5 px-3 rounded-xl text-sm font-semibold transition-all duration-200"
              style={mode === 'diet'
                ? { backgroundColor: '#00E5A0', color: '#0F0D0B', boxShadow: '0 2px 10px rgba(0,229,160,0.35)' }
                : { backgroundColor: '#1A1612', color: '#7A6B5A', border: '1px solid #2A2A2A' }
              }
            >
              Performance Mode
            </button>
            <button
              onClick={() => setMode('chef')}
              className="flex-1 py-2.5 px-3 rounded-xl text-sm font-semibold transition-all duration-200"
              style={mode === 'chef'
                ? { backgroundColor: '#E55A5A', color: '#fff', boxShadow: '0 2px 10px rgba(229,90,90,0.35)' }
                : { backgroundColor: '#1A1612', color: '#7A6B5A', border: '1px solid #2A2A2A' }
              }
            >
              Cheat Day
            </button>
          </div>
          <button
            onClick={() => setShowShareModal(true)}
            className="shrink-0 flex items-center justify-center rounded-xl transition-all duration-200 active:scale-95"
            style={{ width: 44, height: 44, backgroundColor: '#1A1612', border: '1px solid #2A2A2A', color: '#7A6B5A' }}
            aria-label="Share recipe"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
          </button>
        </div>
        {isChef && (
          <p style={{ color: '#888888', fontSize: 13, fontFamily: 'Inter, sans-serif', textAlign: 'center', marginTop: 8, fontStyle: 'normal' }}>
            No judgment. Enjoy every bite.
          </p>
        )}

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
                style={{ backgroundColor: '#252525', borderColor: `${chefAccent}40`, color: '#7A6B5A' }}>
                <span className="font-bold" style={{ color: chefAccent }}>~{chef.calories}</span>
                <span>kcal · full version</span>
              </div>
            )}

            {chef.steps?.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: '#7A6B5A' }}>
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
                <h3 className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#7A6B5A' }}>What changes</h3>
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
                <h3 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#7A6B5A' }}>Key technique</h3>
                <p className="text-sm leading-relaxed" style={{ color: '#CCCCCC' }}>{dietician.keyTechnique}</p>
              </div>
            )}

            {dietician.cookSteps.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#7A6B5A' }}>Method</h3>
                  {dietician.cookTime && dietician.cookTime !== '—' && (
                    <span className="text-xs font-medium" style={{ color: '#7A6B5A' }}>
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
            <h3 className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#7A6B5A' }}>
              What You'll Need
            </h3>
            <div
              className="rounded-xl p-5 space-y-4"
              style={{ backgroundColor: '#1A1612', border: '1px solid #2A2A2A', boxShadow: '0 1px 6px rgba(0,0,0,0.3)' }}
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
                          color: '#F0EAE0',
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
                      color: allChecked ? '#7A6B5A' : '#0F0D0B',
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
      <div className="fixed bottom-0 inset-x-0 z-50 bg-[rgba(13,13,13,0.97)] border-t border-[#2A2A2A] backdrop-blur-sm sm:static sm:inset-auto sm:bg-transparent sm:border-0 sm:backdrop-blur-none sm:max-w-2xl sm:mx-auto sm:mt-8 sm:px-4">
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
              color: '#0F0D0B',
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

          {/* Copy button */}
          <button
            onClick={handleCopy}
            className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-sm transition-all duration-200 active:opacity-80"
            style={{
              backgroundColor: copied ? '#00E5A0' : 'transparent',
              color: copied ? '#0F0D0B' : '#7A6B5A',
              border: copied ? 'none' : '1.5px solid #2A2A2A',
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
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .splash-el   { animation: splash-fade 400ms ease both; }
  .splash-el-0 { animation-delay: 0ms; }
  .splash-el-1 { animation-delay: 150ms; }
  .splash-el-2 { animation-delay: 300ms; }
  .splash-el-3 { animation-delay: 450ms; }
`

function SplashScreen({ onGetStarted, referralCoachName = null, referralCapped = false }) {
  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', padding: '80px 24px 48px' }}>
      <style>{SPLASH_STYLES}</style>

      {/* Top: logo mark + wordmark group — kept together so space-between layout is unchanged */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

        {/* Logo row — glow contained here, never touches wordmark or subline */}
        <div className="splash-el splash-el-0" style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{
            position: 'absolute',
            width: 200, height: 200, borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(0,229,160,0.12) 0%, transparent 70%)',
            pointerEvents: 'none',
          }} />
          <img src="/remi-logo.svg" alt="Remi" style={{ height: '64px', width: 'auto' }} />
        </div>

        {/* Wordmark + subline */}
        <div className="splash-el splash-el-1" style={{ textAlign: 'center', marginTop: 20 }}>
          <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 48, color: '#F0F0F0', letterSpacing: '0.01em', margin: 0, lineHeight: 1 }}>
            Remi
          </h1>
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', marginTop: 12 }}>
            Personal Chef · Nutritionist · Guide
          </p>
        </div>

      </div>

      {/* Middle: tagline */}
      <div className="splash-el splash-el-2" style={{ textAlign: 'center', maxWidth: 320 }}>
        <p style={{ fontFamily: 'Inter, sans-serif', fontWeight: 300, fontSize: 16, color: '#888888', lineHeight: 1.65, margin: 0 }}>
          Eat like a chef. Train like an athlete. Live like both.
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

// ── Loading screen ────────────────────────────────────────────────────────────

function ChefLoader() {
  return (
    <div className="flex items-center gap-3.5">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="mint-dot"
          style={{ width: 14, height: 14, borderRadius: '50%', backgroundColor: '#00E5A0', display: 'inline-block' }}
        />
      ))}
    </div>
  )
}

// ── Saved recipe card ─────────────────────────────────────────────────────────

function SavedDishCard({ dish, onOpen, onRemove }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  return (
    <div className="rounded-2xl overflow-hidden relative" style={{ backgroundColor: '#1A1612', boxShadow: '0 2px 8px rgba(0,0,0,0.3)', border: '1px solid #2A2A2A' }}>
      <button onClick={onOpen} className="w-full text-left block">
        <CardImageHeader dishName={dish.name} cuisine={dish.chef?.cuisine} initialUrl={dish._imgUrl} initialCredit={dish._imgCredit ?? null} />
        <div className="px-4 pb-4 pt-3 space-y-2">
          <h3 style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: 16, color: '#F0EAE0', lineHeight: 1.2, margin: 0 }}>
            {dish.name}
          </h3>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-bold tabular-nums" style={{ color: '#7A9E7E', fontVariantNumeric: 'tabular-nums' }}>
              {dish.dietician?.macros?.calories ?? '—'}
            </span>
            <span className="text-xs" style={{ color: '#7A6B5A' }}>kcal</span>
          </div>
          {(dish.dietician?.cookTime && dish.dietician.cookTime !== '—') && (
            <p className="text-xs" style={{ color: '#7A6B5A' }}>
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
              style={{ backgroundColor: '#00E5A0', color: '#0F0D0B' }}>
              Remove
            </button>
            <button onClick={() => setConfirmDelete(false)}
              className="text-xs font-semibold px-2.5 py-1 rounded-lg"
              style={{ backgroundColor: '#1A1612', color: '#7A6B5A', border: '1px solid #2A2A2A' }}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={e => { e.stopPropagation(); setConfirmDelete(true) }}
            className="w-8 h-8 rounded-full flex items-center justify-center transition-colors duration-200"
            style={{ color: '#7A6B5A', backgroundColor: 'rgba(26,26,26,0.92)', border: '1px solid #2A2A2A' }}
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

function SavedRecipesView({ savedRecipes, onOpen, onRemove, onClose }) {
  return (
    <div className="animate-fade-in min-h-screen px-4 py-10 sm:py-14 relative" style={{ backgroundColor: '#0F0D0B' }}>
      <PaperTexture />
      <div className="max-w-3xl mx-auto space-y-8 relative">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-4xl font-extrabold tracking-tight" style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, color: '#F0EAE0' }}>My Recipes</h1>
            <p className="text-sm mt-1.5" style={{ color: '#7A6B5A' }}>
              {savedRecipes.length > 0
                ? `${savedRecipes.length} saved recipe${savedRecipes.length !== 1 ? 's' : ''}`
                : 'Your bookmarked recipes live here'}
            </p>
          </div>
          <button onClick={onClose}
            className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors duration-200 mt-1.5"
            style={{ color: '#7A6B5A', border: '1px solid #2A2A2A' }}>
            ← Back
          </button>
        </div>

        {savedRecipes.length === 0 ? (
          <div className="text-center py-24 space-y-4">
            <div className="text-6xl leading-none">📚</div>
            <p className="text-sm max-w-xs mx-auto leading-relaxed" style={{ color: '#7A6B5A' }}>
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

  const sectionCard = { backgroundColor: '#1A1612', border: '1px solid #2A2A2A', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }

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
              color: tab === t.id ? '#0F0D0B' : '#7A6B5A',
              border: tab === t.id ? 'none' : '1px solid #2A2A2A',
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
        <p className="text-xs" style={{ color: '#666' }}>{error}</p>
      ) : tip ? (
        <div>{renderTipMarkdown(tip)}</div>
      ) : null}
    </div>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

// Coach referral card — Phase 1. Surfaces the coach's own referral link, live client count,
// and the hard seat cap (20). Live count comes from the profile state (hydrated on session
// restore). PHASE 2: replace the seat cap copy with billing status + monthly credit total.
function CoachCard({ slug, clientCount, seatCap }) {
  const [copied, setCopied] = useState(false)
  const url = `https://myremi.io/join/${slug}`

  function handleCopy() {
    try {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
      })
    } catch {}
  }

  const atCap = (clientCount ?? 0) >= seatCap

  return (
    <div style={{
      backgroundColor: '#1A1A1A',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 10,
      padding: 20,
      marginBottom: 24,
      display: 'flex', flexDirection: 'column', gap: 18,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: 0 }}>
          Coach
        </p>
        {atCap && (
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#FF4D4D', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Roster full
          </span>
        )}
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
              cursor: 'pointer', touchAction: 'manipulation',
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Active clients + seat cap */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ backgroundColor: '#0D0D0D', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '14px 16px' }}>
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 6px' }}>
            Active clients
          </p>
          <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 28, fontWeight: 700, color: '#00E5A0', margin: 0, lineHeight: 1 }}>
            {clientCount ?? 0}
          </p>
        </div>
        <div style={{ backgroundColor: '#0D0D0D', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '14px 16px' }}>
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 6px' }}>
            Seat cap
          </p>
          <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 28, fontWeight: 700, color: '#F0F0F0', margin: 0, lineHeight: 1 }}>
            {seatCap}
          </p>
        </div>
      </div>

      <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', lineHeight: 1.5, margin: 0 }}>
        Every client you bring earns you $1/month. Build your roster.
      </p>
    </div>
  )
}

function Dashboard({ profile, savedRecipes, sessions, streak, stats, onClose, onOpenRecipe, onOpenSessionDish, onQuickStart, onEditProfile, onViewSaved, isAdmin = false, isCoach = false, onAdminPanel, onSignOut }) {
  const cuisineFreq = useMemo(() => {
    const counts = {}
    savedRecipes.forEach(r => {
      const raw = r.chef?.cuisine ?? ''
      const c = raw.split(/[/,]/)[0].trim()
      if (c.length > 1) counts[c] = (counts[c] || 0) + 1
    })
    sessions.forEach(s => {
      if (s.cuisine) counts[s.cuisine] = (counts[s.cuisine] || 0) + 1
    })
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3)
  }, [savedRecipes, sessions])

  const proteinFreq = useMemo(() => {
    const counts = {}
    sessions.forEach(s => {
      ;(s.proteins || []).forEach(p => { counts[p] = (counts[p] || 0) + 1 })
    })
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
  }, [sessions])

  const topProtein    = proteinFreq[0]
  const last4Recipes  = [...savedRecipes].reverse().slice(0, 4)
  const last3Sessions = sessions.slice(0, 3)

  const GOAL_LABEL_MAP = {
    lose:      { label: 'Fat Loss',                  emoji: '🔥' },
    build:     { label: 'Muscle Build',              emoji: '💪' },
    maintain:  { label: 'Maintain Weight',           emoji: '⚖️' },
    eat_clean: { label: 'Eat Cleaner',               emoji: '🥗' },
    energy:    { label: 'Energy & Performance',      emoji: '⚡' },
    fitness:   { label: 'Fitness & Endurance',       emoji: '🏃' },
    sleep:     { label: 'Better Sleep & Recovery',   emoji: '😴' },
    stress:    { label: 'Reduce Stress Eating',      emoji: '🧠' },
  }
  // Support both old single-goal profiles and new multi-goal ones
  const activeGoals = Array.isArray(profile?.goals)
    ? profile.goals
    : (profile?.goal ? [profile.goal] : [])
  const primaryGoal = activeGoals[0]
  const goalInfo = primaryGoal
    ? (GOAL_LABEL_MAP[primaryGoal] ?? { label: primaryGoal, emoji: '🎯' })
    : { label: 'Set a goal', emoji: '🎯' }
  // Extra goal chips beyond the first
  const extraGoals = activeGoals.slice(1).map(g => GOAL_LABEL_MAP[g]?.label ?? g)

  const isActive  = ['3-4x', '5-6x'].includes(profile?.trainingFreq)
  const calTarget = primaryGoal === 'build'    ? '2,200–2,600' :
                    primaryGoal === 'maintain' ? '2,000–2,200' :
                    isActive                   ? '1,800–2,100' : '1,500–1,800'
  const protTarget = profile?.weight ? Math.round(Number(profile.weight) * 1.8) : 160

  function fmtDate(iso) {
    const d    = new Date(iso)
    const days = Math.floor((Date.now() - d) / 86400000)
    if (days === 0) return 'Today'
    if (days === 1) return 'Yesterday'
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
  }

  const sectionCard = { backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10 }

  // Time-of-day greeting
  const hour = new Date().getHours()
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'

  // Goal bar: only shown for fat-loss goal with both weight and goalAmount
  const showGoalBar = activeGoals.includes('lose') &&
    profile?.weight && profile?.goalAmount &&
    Number(profile.goalAmount) > 0

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', padding: '48px 20px 96px' }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 32 }}>
          <div>
            <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(1.75rem, 6vw, 2.25rem)', color: '#F0F0F0', margin: 0, lineHeight: 1.1 }}>
              Back, {profile?.name}.
            </h1>
            {isAdmin && (
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', marginTop: 4 }}>Admin view</p>
            )}
            {!isAdmin && isCoach && (
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', marginTop: 4 }}>Coach access</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="hidden sm:block"
            style={{ background: 'none', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '6px 12px', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0, marginTop: 6 }}
          >
            Back
          </button>
        </div>

        {/* ── Hero calorie card ── */}
        <div style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '24px 20px', textAlign: 'center', marginBottom: 10 }}>
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 10px' }}>Daily Calorie Target</p>
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 'clamp(2rem, 7vw, 3rem)', fontWeight: 700, color: '#00E5A0', margin: 0, lineHeight: 1 }}>
            {calTarget}
          </p>
          <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', margin: '8px 0 0' }}>{protTarget}g+ protein</p>
        </div>

        {/* ── THREE-UP STAT HERO ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 10 }}>
          {[
            { label: 'Day streak',    value: streak?.count ?? 0, mint: true },
            { label: 'Recipes saved', value: stats?.totalRecipes ?? 0, mint: true },
            { label: 'Kcal saved',    value: stats?.totalCalSaved ? (stats.totalCalSaved >= 1000 ? `${(stats.totalCalSaved / 1000).toFixed(1)}k` : stats.totalCalSaved) : 0, mint: false },
          ].map(({ label, value, mint }) => (
            <div
              key={label}
              style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '16px 10px', textAlign: 'center' }}
            >
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 8px' }}>
                {label}
              </p>
              <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 'clamp(1.25rem, 4vw, 1.75rem)', fontWeight: 700, color: mint ? '#00E5A0' : '#F0F0F0', margin: 0, lineHeight: 1 }}>
                {value}
              </p>
            </div>
          ))}
        </div>

        {/* ── Remi's Note ── */}
        <div style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(0,229,160,0.15)', borderRadius: 10, marginBottom: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 0' }}>
            <span style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 15, color: '#00E5A0', lineHeight: 1, userSelect: 'none' }}>R</span>
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Remi's Corner</span>
          </div>
          <RemiCorner profile={profile} />
        </div>

        {/* ── Money saved + Weekly progress ring ── */}
        {(() => {
          const moneySaved = (stats?.totalRecipes ?? 0) * 14
          const WEEKLY_GOAL = 5
          const now = new Date()
          const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000)
          const sessionsThisWeek = sessions.filter(s => new Date(s.date) > weekAgo).length
          const ringProgress = Math.min(sessionsThisWeek, WEEKLY_GOAL)
          const radius = 40
          const circ = 2 * Math.PI * radius
          const offset = circ * (1 - ringProgress / WEEKLY_GOAL)
          return (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              {/* Money saved */}
              <div style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '20px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center' }}>
                <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: 0 }}>Money Saved</p>
                <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 'clamp(1.5rem, 5vw, 2rem)', fontWeight: 700, color: '#C9A84C', margin: 0, lineHeight: 1 }}>
                  ${moneySaved}
                </p>
              </div>
              {/* Weekly progress ring */}
              <div style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '20px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center' }}>
                <svg width="80" height="80" viewBox="0 0 100 100" style={{ transform: 'rotate(-90deg)' }}>
                  <circle cx="50" cy="50" r={radius} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" />
                  <circle
                    cx="50" cy="50" r={radius}
                    fill="none" stroke="#00E5A0" strokeWidth="8" strokeLinecap="round"
                    strokeDasharray={circ} strokeDashoffset={offset}
                    style={{ transition: 'stroke-dashoffset 0.6s ease' }}
                  />
                  <text
                    x="50" y="54" textAnchor="middle" dominantBaseline="middle"
                    style={{ fill: '#F0F0F0', fontSize: 16, fontWeight: 700, fontFamily: 'Syne, sans-serif', transform: 'rotate(90deg)', transformOrigin: '50px 50px' }}
                  >
                    {ringProgress}/{WEEKLY_GOAL}
                  </text>
                </svg>
                <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: 0 }}>This week</p>
              </div>
            </div>
          )
        })()}

        {/* ── Goal bar ── */}
        {showGoalBar && (() => {
          const start  = Number(profile.weight)
          const target = start - Number(profile.goalAmount)
          return (
            <div style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: 20, marginBottom: 10 }}>
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 12px' }}>Fat Loss Target</p>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: '#F0F0F0' }}>{start} kg</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: '#00E5A0' }}>→ {target} kg</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 3, width: `${Math.min(100, (sessions.length / 30) * 100)}%`, background: 'linear-gradient(90deg, #00E5A0, #00C080)', transition: 'width 0.7s ease' }} />
              </div>
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', margin: '8px 0 0' }}>
                Goal: lose {profile.goalAmount} kg · {sessions.length} session{sessions.length !== 1 ? 's' : ''} completed
              </p>
            </div>
          )
        })()}

        {/* ── Goals card ── */}
        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 10px' }}>Your Goals</p>
        <div style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: 20, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 4px' }}>
                {activeGoals.length > 1 ? 'Goals' : 'Goal'}
              </p>
              <p style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(1.125rem, 4vw, 1.375rem)', color: '#F0F0F0', margin: 0 }}>{goalInfo.label}</p>
              {extraGoals.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {extraGoals.map(g => (
                    <span key={g} style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, padding: '3px 10px', borderRadius: 6, backgroundColor: '#0D0D0D', color: '#888888', border: '1px solid rgba(255,255,255,0.08)' }}>
                      {g}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={onEditProfile}
              style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#00E5A0', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', flexShrink: 0 }}
            >
              Edit →
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ backgroundColor: '#0D0D0D', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
              <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 15, fontWeight: 700, color: '#00E5A0', margin: '0 0 4px' }}>{calTarget}</p>
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#888888', letterSpacing: '0.10em', textTransform: 'uppercase', margin: 0 }}>kcal / day</p>
            </div>
            <div style={{ backgroundColor: '#0D0D0D', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
              <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 15, fontWeight: 700, color: '#00E5A0', margin: '0 0 4px' }}>{protTarget}g+</p>
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#888888', letterSpacing: '0.10em', textTransform: 'uppercase', margin: 0 }}>protein / day</p>
            </div>
          </div>
          {profile?.weight && (
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', margin: '12px 0 0' }}>
              Based on {profile.weight}kg{profile.trainingFreq ? ` · trains ${profile.trainingFreq}/week` : ''}
            </p>
          )}
        </div>

        {/* ── Saved recipes mini-grid ── */}
        {last4Recipes.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: 0 }}>Saved Recipes</p>
              <button
                onClick={onViewSaved}
                style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#00E5A0', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                See all ({savedRecipes.length}) →
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {last4Recipes.map(recipe => (
                <button
                  key={recipe._id}
                  onClick={() => onOpenRecipe(recipe)}
                  style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, overflow: 'hidden', textAlign: 'left', cursor: 'pointer', display: 'block', padding: 0 }}
                >
                  <div style={{ width: '100%', aspectRatio: '16/9', backgroundColor: '#111111', overflow: 'hidden' }}>
                    {recipe._imgUrl && (
                      <img src={recipe._imgUrl} alt={recipe.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    )}
                  </div>
                  <div style={{ padding: '10px 12px' }}>
                    <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, color: '#F0F0F0', margin: '0 0 4px', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {recipe.name}
                    </p>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#888888' }}>
                      {recipe.dietician?.macros?.calories ?? '—'} kcal
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Favourite cuisines ── */}
        {cuisineFreq.length > 0 && (
          <div style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: 20, marginBottom: 10 }}>
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 16px' }}>Favourite Cuisines</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {cuisineFreq.map(([cuisine, count], i) => {
                const pct = Math.round((count / cuisineFreq[0][1]) * 100)
                const barColor = i === 0 ? '#00E5A0' : i === 1 ? '#C9A84C' : '#888888'
                return (
                  <div key={cuisine}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 500, color: '#F0F0F0' }}>{cuisine}</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#888888' }}>{count}×</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.08)' }}>
                      <div style={{ height: '100%', borderRadius: 2, width: `${pct}%`, backgroundColor: barColor, transition: 'width 0.5s ease' }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Go-to protein ── */}
        {topProtein && (
          <div style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: 20, marginBottom: 10 }}>
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 12px' }}>Go-to Protein</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 40, height: 40, borderRadius: 8, backgroundColor: '#0D0D0D', border: '1px solid rgba(0,229,160,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <span style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 16, color: '#00E5A0', textTransform: 'uppercase' }}>
                  {topProtein[0].charAt(0)}
                </span>
              </div>
              <div>
                <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 600, color: '#F0F0F0', margin: '0 0 3px', textTransform: 'capitalize' }}>{topProtein[0]}</p>
                <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', margin: 0 }}>
                  Used in {topProtein[1]} session{topProtein[1] !== 1 ? 's' : ''} — your most-cooked protein
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ── Recent sessions ── */}
        {last3Sessions.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '0 0 10px' }}>Recent Sessions</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {last3Sessions.map(session => (
                <div key={session.id} style={{ backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: session.proteins?.length > 0 || session.dishes?.length > 0 ? 10 : 0 }}>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#888888', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      {fmtDate(session.date)}
                    </span>
                    {session.cuisine && (
                      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, padding: '3px 10px', borderRadius: 6, backgroundColor: '#0D0D0D', color: '#888888', border: '1px solid rgba(255,255,255,0.08)' }}>
                        {session.cuisine}
                      </span>
                    )}
                  </div>
                  {session.proteins?.length > 0 && (
                    <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', margin: '0 0 8px' }}>
                      <span style={{ color: '#F0F0F0', fontWeight: 500 }}>Proteins:</span>{' '}
                      {session.proteins.join(', ')}
                    </p>
                  )}
                  {session.dishes?.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {session.dishes.map((d, i) => {
                        const dishName = typeof d === 'object' ? d.name : d
                        const isClickable = typeof d === 'object'
                        return isClickable ? (
                          <button
                            key={i}
                            onClick={() => onOpenSessionDish?.(d)}
                            style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, padding: '4px 10px', borderRadius: 6, backgroundColor: '#0D0D0D', color: '#00E5A0', border: '1px solid rgba(0,229,160,0.25)', fontWeight: 600, cursor: 'pointer' }}
                          >
                            {dishName} →
                          </button>
                        ) : (
                          <span key={i} style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, padding: '4px 10px', borderRadius: 6, backgroundColor: '#0D0D0D', color: '#888888', border: '1px solid rgba(255,255,255,0.08)' }}>
                            {dishName}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {last3Sessions.length === 0 && last4Recipes.length === 0 && (
          <div style={{ textAlign: 'center', padding: '64px 0 32px' }}>
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', lineHeight: 1.6, maxWidth: 280, margin: '0 auto' }}>
              Nothing here yet. Open the Cook tab and get your first dishes.
            </p>
          </div>
        )}

        {/* ── Coach card — Founding Coach Phase 1 ── */}
        {isCoach && profile?.referralSlug && (
          <CoachCard
            slug={profile.referralSlug}
            clientCount={profile.clientCount ?? 0}
            seatCap={20}
          />
        )}

        {/* ── Quick Start CTA ── */}
        <button
          onClick={onQuickStart}
          style={{ width: '100%', height: 56, borderRadius: 8, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 16, cursor: 'pointer', marginBottom: 24 }}
        >
          Start cooking →
        </button>

        {/* ── Sign out / Admin ── */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 24, paddingBottom: 8 }}>
          {isAdmin && (
            <button
              onClick={onAdminPanel}
              style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888', cursor: 'pointer', padding: '4px 0' }}
            >
              Admin
            </button>
          )}
          <button
            onClick={onSignOut}
            style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#555555', cursor: 'pointer', padding: '4px 0' }}
          >
            Sign out
          </button>
        </div>

      </div>
    </div>
  )
}

const ONBOARDING_STYLES = `
  @keyframes ob-fade-up {
    from { opacity: 0; transform: translateY(14px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .ob-step { animation: ob-fade-up 0.28s ease both; }

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

function Onboarding({ onComplete, onBack, onAlreadyOnboarded }) {
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
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', maxWidth: 480, width: '100%', margin: '0 auto', padding: '60px 24px 40px' }}>

        {/* Header: back chevron left + step counter centred */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative', marginBottom: 44 }}>
          <button onClick={retreatStep} style={{ background: 'none', border: 'none', color: '#555555', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', zIndex: 1 }}>
            {backChevron}
          </button>
          <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: '#555555', letterSpacing: '0.12em' }}>
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
              style={{ width: '100%', height: 44, backgroundColor: 'transparent', color: '#555555', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontWeight: 500, fontSize: 14, border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer' }}
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
    <div style={{ minHeight: '100dvh', backgroundColor: '#0F0D0B', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 24px' }}>
      <style>{ONBOARDING_STYLES}</style>
      <div style={{ textAlign: 'center', maxWidth: 360, width: '100%' }}>
        <div className="remi-scale-in" style={{ display: 'flex', justifyContent: 'center', marginBottom: 32 }}>
          <RemiLogo size={64} />
        </div>
        <h2 className="remi-word-up" style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(2.5rem, 8vw, 3.5rem)', color: '#F0EAE0', lineHeight: 1.05, marginBottom: 16 }}>
          Remi is ready.
        </h2>
        <p className="remi-word-up" style={{ fontSize: '0.9375rem', color: '#666', fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.6, marginBottom: 48, animationDelay: '0.42s' }}>
          Built around you. Let's get to work.
        </p>
        <button
          onClick={onEnter}
          style={{ width: '100%', padding: '16px 24px', borderRadius: 14, border: 'none', backgroundColor: '#00E5A0', color: '#0F0D0B', fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '1rem', cursor: 'pointer', boxShadow: '0 2px 16px rgba(0,229,160,0.3)', transition: 'opacity 0.15s ease' }}
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
      <div style={{ position: 'relative', backgroundColor: '#1A1612', border: '1px solid #2A2A2A', borderRadius: 20, padding: '2rem', maxWidth: 400, width: '100%' }}>
        <button
          onClick={onClose}
          style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: '#555555', cursor: 'pointer', fontSize: '1.375rem', lineHeight: 1 }}
          aria-label="Close"
        >×</button>

        {submitted ? (
          <p style={{ color: '#F0EAE0', textAlign: 'center', fontSize: '1rem', padding: '1rem 0' }}>
            You're on the list. We'll be in touch.
          </p>
        ) : (
          <>
            <h2 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '1.625rem', color: '#F0EAE0', marginBottom: 8 }}>
              Remi Pro
            </h2>
            <p style={{ color: '#7A6B5A', fontSize: '0.875rem', marginBottom: 16, lineHeight: 1.5 }}>
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
                style={{ display: 'block', width: '100%', boxSizing: 'border-box', backgroundColor: '#1A1612', border: '1px solid #2A2A2A', borderRadius: 10, padding: '12px 14px', color: '#F0EAE0', fontSize: 16, marginBottom: 12, fontFamily: "'IBM Plex Sans', sans-serif" }}
              />
              <button
                type="submit"
                disabled={submitting || !email.trim()}
                style={{ width: '100%', backgroundColor: '#00E5A0', color: '#0F0D0B', borderRadius: 12, padding: '13px 0', fontSize: '0.9375rem', fontWeight: 600, border: 'none', cursor: submitting || !email.trim() ? 'not-allowed' : 'pointer', fontFamily: "'IBM Plex Sans', sans-serif", opacity: submitting ? 0.7 : 1, marginBottom: 10 }}
              >
                {submitting ? 'Sending…' : 'Notify me when it\'s live'}
              </button>
              <p style={{ textAlign: 'center', color: '#555555', fontSize: '0.75rem' }}>No spam. Just Remi.</p>
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
    backgroundColor: '#1A1612', border: '1px solid #2A2A2A', borderRadius: 10,
    padding: '12px 14px', color: '#F0EAE0', fontSize: 16,
    fontFamily: "'IBM Plex Sans', sans-serif", marginBottom: 12,
  }

  return (
    <div className="animate-fade-in min-h-screen" style={{ backgroundColor: '#0F0D0B' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '3rem 1.25rem 4rem' }}>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#555555', cursor: 'pointer', fontSize: '0.875rem', fontFamily: "'IBM Plex Sans', sans-serif", marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: 6, padding: 0 }}
        >
          ← Back
        </button>

        <p style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: '0.75rem', letterSpacing: '0.1em', textTransform: 'uppercase', color: '#00E5A0', marginBottom: 12 }}>
          Founding Partner Programme
        </p>
        <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '2rem', color: '#F0EAE0', marginBottom: 10, lineHeight: 1.2 }}>
          Remi for Personal Trainers
        </h1>
        <p style={{ color: '#7A6B5A', fontSize: '1rem', marginBottom: '2.5rem', lineHeight: 1.6 }}>
          The first 10 PTs who join get full dashboard access — free for life.
        </p>

        <div style={{ backgroundColor: '#1A1612', border: '1px solid #2A2A2A', borderRadius: 16, padding: '1.5rem', marginBottom: '2rem' }}>
          <p style={{ color: '#F0EAE0', fontSize: '0.9375rem', lineHeight: 1.7, marginBottom: '1.25rem' }}>
            Give your clients a personal chef that adjusts every meal to their goals and training. No logging. No meal plans. Just open the fridge and cook.
          </p>
          <p style={{ color: '#7A6B5A', fontSize: '0.8125rem', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.75rem' }}>
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
                <span style={{ color: '#F0EAE0', fontSize: '0.9375rem', lineHeight: 1.5 }}>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        {submitted ? (
          <div style={{ backgroundColor: '#1A1612', border: '1px solid #2A2A2A', borderRadius: 16, padding: '2rem', textAlign: 'center' }}>
            <p style={{ color: '#F0EAE0', fontSize: '1rem', lineHeight: 1.6 }}>
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
              style={{ ...inputStyle, color: form.clientCount ? '#F0EAE0' : '#555555' }}
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
              style={{ width: '100%', backgroundColor: '#00E5A0', color: '#0F0D0B', borderRadius: 12, padding: '14px 0', fontSize: '0.9375rem', fontWeight: 600, border: 'none', cursor: submitting ? 'not-allowed' : 'pointer', fontFamily: "'IBM Plex Sans', sans-serif", opacity: submitting ? 0.7 : 1, marginBottom: 14 }}
            >
              {submitting ? 'Sending…' : 'Apply as a Founding PT'}
            </button>
            <p style={{ textAlign: 'center', color: '#555555', fontSize: '0.8125rem', lineHeight: 1.5 }}>
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
        style={{ backgroundColor: '#1A1612', border: '1px solid #2A2A2A', borderRadius: 20 }}>
        <h2 style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500, fontSize: '1.375rem', color: '#F0EAE0' }}>
          Ready to cook?
        </h2>
        <p style={{ fontSize: '0.875rem', color: '#7A6B5A', lineHeight: 1.6 }}>
          Make sure you've grabbed everything from the fridge — once Remi starts cooking, your generations reset tomorrow.
        </p>
        <div className="space-y-3">
          <button onClick={onConfirm}
            style={{ width: '100%', backgroundColor: '#00E5A0', color: '#0F0D0B', borderRadius: 14, padding: '14px 0', fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500, fontSize: '0.9375rem', border: 'none', cursor: 'pointer' }}>
            Let's cook
          </button>
          <button onClick={onCancel}
            style={{ width: '100%', backgroundColor: 'transparent', color: '#7A6B5A', borderRadius: 14, padding: '12px 0', fontFamily: "'IBM Plex Sans', sans-serif", fontSize: '0.875rem', border: '1px solid #2A2A2A', cursor: 'pointer' }}>
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
              style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#666666', padding: 4, display: 'flex', alignItems: 'center', lineHeight: 1 }}
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

      {/* Logo row — glow is contained here, never touches greeting row */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 24 }}>
        <div style={{
          position: 'absolute',
          width: 170,
          height: 170,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(0,229,160,0.10) 0%, transparent 70%)',
          pointerEvents: 'none',
        }} />
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
        style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#666666', padding: 4, display: 'flex', alignItems: 'center', lineHeight: 1 }}
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
                color: !loading && selectedRole !== user.role ? '#0D0D0D' : '#555555',
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
                    color: resetLoading || !confirmed ? '#555555' : '#FFFFFF',
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
    <div className="animate-fade-in min-h-screen" style={{ backgroundColor: '#0F0D0B', paddingBottom: 96 }}>

      {/* Header */}
      <div style={{ padding: '3rem 1.25rem 1.75rem', maxWidth: 600, margin: '0 auto' }}>
        <p style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: '0.6rem', letterSpacing: '0.14em', color: '#C9A84C', textTransform: 'uppercase', marginBottom: 12 }}>
          Remi Intel
        </p>
        <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 'clamp(1.75rem, 6vw, 2.5rem)', color: '#F0EAE0', lineHeight: 1.1, marginBottom: 10 }}>
          The science behind the meal.
        </h1>
        <p style={{ fontSize: '0.875rem', color: '#555', fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.6 }}>
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
                border: '1px solid #2A2A2A',
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
                fontFamily: "'IBM Plex Sans', sans-serif",
                fontWeight: 500,
                fontSize: '0.9375rem',
                color: '#F0EAE0',
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
              backgroundColor: '#1A1612',
              border: '1px solid #2A2A2A',
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
                fontSize: '1.375rem', color: '#F0EAE0',
                marginBottom: 8, lineHeight: 1.2,
              }}>
                Remi Pro
              </h3>
              <p style={{
                fontSize: '0.8125rem', color: '#666',
                fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.6,
                marginBottom: 24,
              }}>
                Unlock weekly research cards, unlimited sessions, and full dashboard access.
              </p>
              <button
                onClick={onProClick}
                style={{
                  width: '100%', backgroundColor: '#C9A84C', color: '#0F0D0B',
                  borderRadius: 12, padding: '13px 0',
                  fontFamily: 'Syne, sans-serif', fontWeight: 700,
                  fontSize: '0.9375rem', border: 'none', cursor: 'pointer',
                  marginBottom: 10,
                  boxShadow: '0 2px 12px rgba(201,168,76,0.35)',
                }}
              >
                Upgrade to Pro →
              </button>
              <p style={{ fontSize: '0.7rem', color: '#555', fontFamily: "'IBM Plex Sans', sans-serif" }}>
                $4.99 / month
              </p>
            </div>
          </div>
        )}
      </div>
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
  const [savedRecipes,   setSavedRecipes]   = useState(() => {
    // loadProfileOrEvict() already cleared storage if version mismatched,
    // so a missing key here just means a genuine empty list.
    try { const s = localStorage.getItem('lhc_saved_recipes'); return s ? JSON.parse(s) : [] } catch { return [] }
  })
  const [sessions,       setSessions]       = useState(() => {
    try { const s = localStorage.getItem('lhc_sessions'); return s ? JSON.parse(s) : [] } catch { return [] }
  })
  const [streak,         setStreak]         = useState(() => {
    try { const s = localStorage.getItem('lhc_streak'); return s ? JSON.parse(s) : { count: 0, lastDate: null } } catch { return { count: 0, lastDate: null } }
  })
  const [stats,          setStats]          = useState(() => {
    try { const s = localStorage.getItem('lhc_stats'); return s ? JSON.parse(s) : { totalRecipes: 0, totalCalSaved: 0 } } catch { return { totalRecipes: 0, totalCalSaved: 0 } }
  })
  const [view,           setView]           = useState(isRecovery ? 'set-password' : 'loading')
  const [selectedDish,   setSelectedDish]   = useState(null)
  const [viewingDish,    setViewingDish]    = useState(null)
  const [viewingDishImg, setViewingDishImg] = useState(null)
  const [savedBackTo,         setSavedBackTo]         = useState('cards')
  const [missingIngredients,  setMissingIngredients]  = useState([])
  const [shoppingListCopied,  setShoppingListCopied]  = useState(false)
  const [checkedIngredients,  setCheckedIngredients]  = useState(new Set())
  const [error,               setError]               = useState(null)
  const [isAdmin,             setIsAdmin]             = useState(() => localStorage.getItem('remi_role') === 'admin')
  const [isCoach,             setIsCoach]             = useState(() => localStorage.getItem('remi_role') === 'coach')
  const [genCount,            setGenCount]            = useState(() => {
    const key = 'remi_gens_' + new Date().toISOString().slice(0, 10)
    return parseInt(localStorage.getItem(key) || '0', 10)
  })
  const [showProModal,        setShowProModal]        = useState(false)
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

  // Derived role flags — isPro unlocks all Pro-gated features
  const isPro = isAdmin || isCoach

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

  const scrollRef      = useRef(null)
  const abortRef       = useRef(null)
  const inputRef       = useRef(null)
  const sessionDataRef = useRef({ proteins: [], cuisine: '', time: '' })

  // ── Supabase auth helpers ──────────────────────────────────────────────────

  function applySession(session, dbRole) {
    const email = session?.user?.email?.toLowerCase() ?? ''
    // Hardcoded admin list always wins over DB value
    const role = ADMIN_EMAILS.includes(email) ? 'admin' : (dbRole || 'free')
    localStorage.setItem('remi_role', role)
    setIsAdmin(role === 'admin')
    setIsCoach(role === 'coach')
  }

  // ── Session detection on mount ─────────────────────────────────────────────

  // ── Shared: process a valid access_token + refresh_token into a session ──────
  // Called from:
  //   • AuthScreen.onAuthSuccess — direct password sign-in / sign-up
  //   • useEffect hash callback  — password-reset link that lands with a token in the URL

  function processAuthResult(accessToken, refreshToken = '') {
    if (!accessToken) { setView('splash'); return }
    fetch('/api/auth-user', { headers: { Authorization: `Bearer ${accessToken}` } })
      .then(r => r.json())
      .then(data => {
        if (!data.user) { setView('splash'); return }

        const session = { access_token: accessToken, refresh_token: refreshToken, user: data.user }
        localStorage.setItem('supabase.auth.token', JSON.stringify(session))
        applySession(session, data.role)

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
          // Cross-device: localStorage exists but might be missing recent DB-only fields. Hydrate.
          const dp = data.dbProfile
          const hydrated = { ...currentProfile }
          let dirty = false
          if (hydrated.trainingPhilosophy == null && dp.trainingPhilosophy) { hydrated.trainingPhilosophy = dp.trainingPhilosophy; dirty = true }
          if (hydrated.referralSlug == null && dp.referralSlug)             { hydrated.referralSlug       = dp.referralSlug;       dirty = true }
          if ((hydrated.clientCount ?? 0) !== (dp.clientCount ?? 0))        { hydrated.clientCount        = dp.clientCount ?? 0;   dirty = true }
          if (hydrated.referredBy == null && dp.referredBy)                 { hydrated.referredBy         = dp.referredBy;         dirty = true }
          if (dirty) {
            currentProfile = hydrated
            localStorage.setItem('lhc_profile', JSON.stringify(currentProfile))
          }
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

    fetch('/api/auth-user', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        if (data.user) {
          applySession({ ...stored, user: data.user }, data.role)

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
              completedAt: Date.now(),
            }
            localStorage.setItem('lhc_profile', JSON.stringify(currentProfile))
          } else if (currentProfile && data.dbProfile && currentProfile.trainingPhilosophy == null && data.dbProfile.trainingPhilosophy) {
            currentProfile = { ...currentProfile, trainingPhilosophy: data.dbProfile.trainingPhilosophy }
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
          setIsCoach(false)
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

  const displayMessages = messages.filter(m => !(m.seed && m.role === 'user'))

  // ── Core message send ──────────────────────────────────────────────────────

  async function submitMessage(text) {
    if (!text.trim() || streaming) return
    const trimmed = text.trim()

    // First-session philosophy capture. If we don't yet have a trainingPhilosophy on the
    // profile, the first message Remi sees in this Cook session IS the answer to his opener.
    // Don't burn an LLM call on it — store it, acknowledge, then drop into the normal flow.
    if (profile?.name && (profile.trainingPhilosophy == null)) {
      const userMsg = { id: Date.now(), role: 'user', content: trimmed }
      const ackMsg  = {
        id: Date.now() + 1,
        role: 'assistant',
        content: 'Noted. Open your fridge — what proteins have you got?',
        seed: true,
      }
      setMessages(prev => [...prev, userMsg, ackMsg])
      setInput('')

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
      setQuickReplyType('proteins')   // Open the fridge tray for the standard flow
      return
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
          profile: mapProfileForApi(profile),
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
              const _gKey = 'remi_gens_' + new Date().toISOString().slice(0, 10)
              const _newCount = parseInt(localStorage.getItem(_gKey) || '0', 10) + 1
              localStorage.setItem(_gKey, String(_newCount))
              setGenCount(_newCount)
              // Guardrail: each surfaced dish MUST carry a real method, not a token summary.
              const validDishes = parsed.filter(isCompleteMethod)
              if (validDishes.length > 0) {
                setMessages(prev => [...prev, {
                  id: Date.now(),
                  role: 'assistant',
                  content: handoffLeadIn(validDishes),
                  handoffDishes: validDishes,
                }])
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
          const _gKey2 = 'remi_gens_' + new Date().toISOString().slice(0, 10)
          const _newCount2 = parseInt(localStorage.getItem(_gKey2) || '0', 10) + 1
          localStorage.setItem(_gKey2, String(_newCount2))
          setGenCount(_newCount2)
          const validDishes2 = parsed.filter(isCompleteMethod)
          if (validDishes2.length > 0) {
            setMessages(prev => [...prev, {
              id: Date.now(),
              role: 'assistant',
              content: handoffLeadIn(validDishes2),
              handoffDishes: validDishes2,
            }])
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
    setIsCoach(false)
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

  function handleSaveRecipe(dish, imgUrl, imgCredit) {
    const isFirst = !localStorage.getItem('remi_first_recipe_saved')
    const entry = { ...dish, _id: `${dish.name}_${Date.now()}`, _savedAt: Date.now(), _imgUrl: imgUrl ?? null, _imgCredit: imgCredit ?? null }
    setSavedRecipes(prev => {
      const next = [...prev.filter(r => r.name !== dish.name), entry]
      localStorage.setItem('lhc_saved_recipes', JSON.stringify(next))
      return next
    })
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
  }

  function handleRemoveRecipe(nameOrId) {
    setSavedRecipes(prev => {
      const next = prev.filter(r => r._id !== nameOrId && r.name !== nameOrId)
      localStorage.setItem('lhc_saved_recipes', JSON.stringify(next))
      return next
    })
    posthog.capture('recipe_removed', { name_or_id: nameOrId })
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
          onAdminPanel={() => setView('admin-panel')}
          onSignOut={handleSignOut}
        />
        <BottomNav activeView="dashboard" onNavigate={v => {
          if (v === 'saved') { setSavedBackTo('dashboard'); setView('saved') }
          else setView(v)
        }} isPro={isPro} />
      </>
    )
  }

  // ── View: Admin panel ────────────────────────────────────────────────────────
  if (view === 'admin-panel' && isAdmin) {
    return <AdminPanel onBack={() => setView('dashboard')} />
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
        <IntelView isPro={isPro} onProClick={() => setShowProModal(true)} />
        <BottomNav activeView="intel" onNavigate={v => {
          if (v === 'saved') { setSavedBackTo('intel'); setView('saved') }
          else if (v === 'chat') handleReset()
          else setView(v)
        }} isPro={isPro} />
        {showProModal && <ProModal onClose={() => setShowProModal(false)} />}
      </>
    )
  }

  // ── View: Saved recipes ──────────────────────────────────────────────────────
  if (view === 'saved') {
    return (
      <>
        <SavedRecipesView
          savedRecipes={savedRecipes}
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
        }} isPro={isPro} />
      </>
    )
  }

  // ── View: Detail ─────────────────────────────────────────────────────────────
  if (view === 'detail' && (selectedDish !== null || viewingDish !== null)) {
    const dish       = viewingDish ?? dishes[selectedDish]
    const imgUrl     = viewingDish ? viewingDishImg : (dishImages[selectedDish]?.url ?? null)
    const imgCredit  = viewingDish ? (viewingDish._imgCredit ?? null) : (dishImages[selectedDish]?.credit ?? null)
    const backTo     = viewingDish ? savedBackTo : 'cards'
    const detailIngredients = viewingDish ? [] : missingIngredients
    return (
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
      />
    )
  }

  // ── View: Cards ──────────────────────────────────────────────────────────────
  if (view === 'cards' && dishes) {
    return (
      <>
        <div className="animate-fade-in flex h-[100dvh]" style={{ backgroundColor: '#0F0D0B' }}>
          {/* Main content */}
          <div className="flex-1 min-w-0 overflow-y-auto px-4 py-10 sm:py-14 pb-20 lg:pb-14" style={{ backgroundColor: '#0F0D0B' }}>
            <div className="max-w-3xl mx-auto space-y-8 relative">
              {/* Gen counter + locked banner */}
              {!isPro && genCount >= 3 ? (
                <div className="rounded-2xl px-5 py-4" style={{ backgroundColor: '#1A1A0A', border: '1px solid #C9A84C' }}>
                  <div className="flex items-center gap-3">
                    <span style={{ fontSize: '1.25rem' }}>🔒</span>
                    <div className="flex-1">
                      <p style={{ color: '#C9A84C', fontWeight: 600, fontSize: '0.875rem' }}>Kitchen's closed for today</p>
                      <p style={{ color: '#7A6B5A', fontSize: '0.75rem', marginTop: 2 }}>You've used all 3 free sessions. Come back tomorrow or upgrade.</p>
                    </div>
                    <button onClick={() => setShowProModal(true)} style={{ color: '#C9A84C', fontSize: '0.75rem', fontWeight: 700, whiteSpace: 'nowrap', background: 'none', border: 'none', cursor: 'pointer' }}>Go Pro →</button>
                  </div>
                  <p style={{ marginTop: 8, paddingLeft: '2rem' }}>
                    <button onClick={() => setShowPTPage(true)} style={{ background: 'none', border: 'none', color: '#555555', cursor: 'pointer', padding: 0, fontSize: '0.7rem', fontFamily: "'IBM Plex Sans', sans-serif", textDecoration: 'underline' }}>Are you a PT?</button>
                  </p>
                </div>
              ) : (
                <p style={{ color: '#7A6B5A', fontSize: '0.75rem', textAlign: 'right' }}>{genCount} of 3 sessions used today</p>
              )}
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="font-sans text-3xl sm:text-4xl font-bold" style={{ color: '#F0EAE0' }}>
                    Your meals
                  </h1>
                  <p style={{ color: '#7A6B5A', fontSize: '0.875rem', marginTop: 4 }}>
                    Tap a card to open the full recipe.
                  </p>
                </div>
                {/* Desktop nav buttons only */}
                <div className="hidden sm:flex flex-col gap-2 mt-1.5 shrink-0 items-end">
                  <button
                    onClick={() => setView('dashboard')}
                    className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors duration-200"
                    style={{ color: '#7A6B5A', border: '1px solid #2A2A2A' }}
                  >
                    Stats
                  </button>
                  <div className="flex gap-2">
                    {savedRecipes.length > 0 && (
                      <button
                        onClick={() => { setSavedBackTo('cards'); setView('saved') }}
                        className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors duration-200 flex items-center gap-1"
                        style={{ color: '#7A6B5A', border: '1px solid #2A2A2A' }}
                      >
                        Saved
                        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold" style={{ backgroundColor: '#00E5A0', color: '#0F0D0B' }}>
                          {savedRecipes.length}
                        </span>
                      </button>
                    )}
                    <button
                      onClick={handleReset}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors duration-200"
                      style={{ color: '#7A6B5A', border: '1px solid #2A2A2A' }}
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
                    style={{ backgroundColor: '#1A1612', border: '0.5px solid #2A2A2A' }}
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
                              color: '#F0EAE0',
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
                            color: allChecked ? '#7A6B5A' : '#0F0D0B',
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
        }} isPro={isPro} />
        {showProModal && <ProModal onClose={() => setShowProModal(false)} />}
      </>
    )
  }

  // ── View: Loading (streaming dishes) ────────────────────────────────────────
  if (awaitingDishes) {
    return (
      <div className="animate-fade-in min-h-screen flex flex-col items-center justify-center px-6 py-14" style={{ backgroundColor: '#0F0D0B' }}>
        <style>{CHAT_STYLES}</style>
        <ChefLoader />
      </div>
    )
  }

  // ── View: Chat ───────────────────────────────────────────────────────────────
  return (
    <>
      <style>{CHAT_STYLES}</style>
      <div className="animate-fade-in flex relative" style={{ position: 'fixed', inset: 0, backgroundColor: '#0F0D0B' }}>

        {/* ── Main chat column ── */}
        <div className="flex flex-col flex-1 min-w-0">

          {/* Cook header — Remi + presence + overflow */}
          <div
            className="shrink-0"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '16px 20px 12px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              backgroundColor: '#0D0D0D',
            }}
          >
            <div>
              <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 22, color: '#F0F0F0', lineHeight: 1, margin: 0 }}>
                Remi
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#00E5A0', display: 'inline-block' }} />
                <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888' }}>In the kitchen</span>
              </div>
            </div>
            <button
              onClick={() => setView('dashboard')}
              aria-label="More"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 8, color: '#888888', display: 'flex' }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5"  cy="12" r="2"/>
                <circle cx="12" cy="12" r="2"/>
                <circle cx="19" cy="12" r="2"/>
              </svg>
            </button>
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
                {msg.handoffDishes && msg.handoffDishes.length > 0 && (
                  <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {msg.handoffDishes.map((dish, i) => (
                      <HandoffCard
                        key={i}
                        dish={dish}
                        delay={i * 120}
                        onOpen={d => {
                          setViewingDish(d)
                          setViewingDishImg(d._imgUrl ?? null)
                          setSavedBackTo('chat')
                          posthog.capture('recipe_detail_viewed', { dish_name: d.name, source: 'chat_handoff' })
                          setView('detail')
                        }}
                      />
                    ))}
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
              style={{ borderTop: '1px solid #2A2A2A', backgroundColor: '#0F0D0B', scrollbarWidth: 'none' }}
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
                  style={{ backgroundColor: '#1A1612', color: '#00E5A0', border: '1px solid #00C080' }}
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
      }} isPro={isPro} />
      {showProModal && <ProModal onClose={() => setShowProModal(false)} />}
    </>
  )
}
