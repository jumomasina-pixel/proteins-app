import posthog from 'posthog-js'
import { useState, useRef, useEffect, useMemo } from 'react'

// ── Storage versioning ────────────────────────────────────────────────────────
// Bump this number whenever the stored data shape changes in a breaking way.
// Any existing storage that doesn't carry a matching version will be wiped and
// the user will restart from the welcome screen as a new user.

const PROFILE_VERSION = 5

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
  const trainingTypes = (p.training || []).filter(t => t !== 'none').map(t => typeMap[t] || t)
  const goalAmount = (p.currentWeight && p.targetWeight && p.goal === 'cut')
    ? String(Math.max(0, Number(p.currentWeight) - Number(p.targetWeight)))
    : ''
  return {
    name: p.name || 'Chef',
    weight: p.currentWeight,
    goal: oldGoal,
    goals: [oldGoal],
    goalAmount,
    trainingFreq: freq,
    trainingTypes: trainingTypes.length ? trainingTypes : ['None'],
    avoidFoods: p.avoidFoods || '',
    kitchenLevel: 'home cook',
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

  // Macros: search the entire dietPart — robust against bullets, indentation, bold, table format
  const calories = grabNum(dietPart,
    /calories\s*:\s*~?\s*(\d[\d,]*)/i,          // Calories: ~450
    /\|\s*~?\s*(\d[\d,]*)\s*kcal/i,             // | ~450 kcal  (table)
    /(\d[\d,]*)\s*kcal\b/i,                     // 450 kcal (bare)
  )
  const protein = grabNum(dietPart,
    /protein\s*:\s*~?\s*(\d[\d,]*)/i,           // Protein: ~45g
    /\|\s*~?\s*(\d[\d,]*)g[^a-z]/i,            // | ~45g  (first number with g, table)
    /(\d[\d,]*)g?\s+protein/i,                  // 45g protein (reversed)
  )
  const carbs = grabNum(dietPart,
    /carbs?\s*:\s*~?\s*(\d[\d,]*)/i,            // Carbs: ~30g
    /carbohydrate\s*:\s*~?\s*(\d[\d,]*)/i,      // Carbohydrate: ~30
    /(\d[\d,]*)g?\s+carbs?/i,                   // 30g carbs (reversed)
  )
  const fat = grabNum(dietPart,
    /\bfat\s*:\s*~?\s*(\d[\d,]*)/i,             // Fat: ~12g
    /(\d[\d,]*)g?\s+fat\b/i,                    // 12g fat (reversed)
  )
  const cookTime   = grabNum(dietPart, /cook\s*time\s*:\s*~?\s*(\d+)/i)
  const difficulty = grab(dietPart,    /difficulty\s*:\s*(Easy|Medium|Pro)/i)

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
  return chunks.map(parseDishChunk).filter(d => d.name)
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
      console.log('[shopping] parseMissingIngredients — found', items.length, 'item(s):', items)
      return items
    }
  }

  console.log('[shopping] parseMissingIngredients — no match found, trying fallback. Last 500 chars:\n', text.slice(-500))

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
      console.log('[shopping] fallback found', fallbackItems.length, 'item(s):', fallbackItems)
      return fallbackItems
    }
  }

  // Last resort: surface a helpful message so the section still renders
  return ['Check the full recipe above for ingredients needed.']
}

// ── Seed conversation ─────────────────────────────────────────────────────────

const SEED = [
  { id: 'seed-u', role: 'user',      content: 'I want meal ideas', seed: true },
  { id: 'seed-a', role: 'assistant', content: "Let's see what we can build. Open your fridge — what proteins do you have? Anything in the freezer, pantry, or veggie drawer counts too.", seed: true },
]

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
      <path d="M22 8C22 8 14 16 14 24C14 28.4 17.6 32 22 32C26.4 32 30 28.4 30 24C30 16 22 8 22 8Z" fill="#1D9E75"/>
      <path d="M22 14C22 14 18 19 18 24C18 26.2 19.8 28 22 28" stroke="#5DCAA5" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
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

const REMI_TRAINING_OPTIONS = [
  { value: 'weights', label: 'Weights' },
  { value: 'boxing',  label: 'Boxing' },
  { value: 'cardio',  label: 'Cardio' },
  { value: 'sport',   label: 'Sport' },
  { value: 'none',    label: "None / I don't train" },
]

function classifyIngredient(name) {
  const l = name.toLowerCase()
  if (/chicken|beef|fish|egg|tofu|salmon|tuna|lamb|pork|turkey|prawn|shrimp|mince|steak|brisket|duck/.test(l)) return 'protein'
  if (/rice|pasta|bread|potato|sweet potato|oat|noodle|quinoa|flour|tortilla|couscous|barley/.test(l)) return 'carb'
  if (/olive oil|butter|nut|avocado|cheese|cream|coconut|oil|ghee|tahini/.test(l)) return 'fat'
  return 'veg'
}

const CLASSIFY_COLORS = {
  protein: { border: '#1D9E75', text: '#5DCAA5' },
  carb:    { border: '#EF9F27', text: '#EF9F27' },
  fat:     { border: '#6b8a72', text: '#6b8a72' },
  veg:     { border: '#5DCAA5', text: '#5DCAA5' },
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
const KITCHEN_OPTIONS = [
  { value: 'beginner',    label: 'Beginner'         },
  { value: 'home cook',   label: 'Home cook'        },
  { value: 'confident',   label: 'Pretty confident' },
]

// ── Quick-reply card data ─────────────────────────────────────────────────────

const PROTEIN_CARDS = [
  { value: 'chicken',  label: 'Chicken',  emoji: '🍗' },
  { value: 'beef',     label: 'Beef',     emoji: '🥩' },
  { value: 'salmon',   label: 'Salmon',   emoji: '🐟' },
  { value: 'eggs',     label: 'Eggs',     emoji: '🥚' },
  { value: 'pork',     label: 'Pork',     emoji: '🥓' },
  { value: 'tofu',     label: 'Tofu',     emoji: '🫘' },
  { value: 'lamb',     label: 'Lamb',     emoji: '🍖' },
  { value: 'prawns',   label: 'Prawns',   emoji: '🦐' },
  { value: 'tuna',     label: 'Tuna',     emoji: '🐟' },
  { value: 'turkey',   label: 'Turkey',   emoji: '🦃' },
]

const CUISINE_CARDS = [
  { value: 'Mexican',           label: 'Mexican',           emoji: '🌮' },
  { value: 'Asian',             label: 'Asian',             emoji: '🥢' },
  { value: 'Italian',           label: 'Italian',           emoji: '🍝' },
  { value: 'Indian',            label: 'Indian',            emoji: '🍛' },
  { value: 'Modern Australian', label: 'Modern Australian', emoji: '🦘' },
  { value: 'French',            label: 'French',            emoji: '🥖' },
  { value: 'American',          label: 'American',          emoji: '🍔' },
  { value: 'Middle Eastern',    label: 'Middle Eastern',    emoji: '🧆' },
  { value: 'Japanese',          label: 'Japanese',          emoji: '🍱' },
  { value: 'Thai',              label: 'Thai',              emoji: '🌿' },
  { value: 'No preference',     label: 'No preference',     emoji: '🎲' },
]

const TIME_CARDS = [
  { value: 'under 20 mins',           label: 'Under 20 mins',           emoji: '⚡' },
  { value: '20–40 mins',              label: '20–40 mins',              emoji: '🕐' },
  { value: '40–60 mins',              label: '40–60 mins',              emoji: '👨‍🍳' },
  { value: 'all the time in the world', label: 'All the time in the world', emoji: '🌟' },
]

const PANTRY_CARDS = [
  { value: 'garlic',          label: 'Garlic',          emoji: '🧄' },
  { value: 'onion',           label: 'Onion',           emoji: '🧅' },
  { value: 'rice',            label: 'Rice',            emoji: '🍚' },
  { value: 'pasta',           label: 'Pasta',           emoji: '🍝' },
  { value: 'tinned tomatoes', label: 'Tinned tomatoes', emoji: '🍅' },
  { value: 'spinach',         label: 'Spinach',         emoji: '🥬' },
  { value: 'broccoli',        label: 'Broccoli',        emoji: '🥦' },
  { value: 'capsicum',        label: 'Capsicum',        emoji: '🫑' },
  { value: 'zucchini',        label: 'Zucchini',        emoji: '🥒' },
  { value: 'sweet potato',    label: 'Sweet potato',    emoji: '🍠' },
  { value: 'lemon',           label: 'Lemon',           emoji: '🍋' },
  { value: 'soy sauce',       label: 'Soy sauce',       emoji: '🫙' },
  { value: 'chilli',          label: 'Chilli',          emoji: '🌶️' },
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
    headline: 'Browning = flavour fat used to give you',
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
          backgroundColor: '#FAF6EE',
          border: '1px solid #C8B090',
          width: 220,
        }}
      >
        <span
          className="text-[9px] font-bold uppercase tracking-widest"
          style={{ color: '#C1683A' }}
        >
          {insight.tag}
        </span>
        <p className="text-[12px] font-semibold leading-snug" style={{ color: '#1A1108' }}>
          {insight.headline}
        </p>
      </div>
    )
  }
  return (
    <div
      className="rounded-2xl px-5 py-4 space-y-2"
      style={{
        backgroundColor: '#FAF6EE',
        border: '1px solid #C8B090',
        boxShadow: '0 1px 6px rgba(26,17,8,0.06)',
      }}
    >
      <span
        className="text-[9px] font-bold uppercase tracking-widest"
        style={{ color: '#C1683A' }}
      >
        {insight.tag}
      </span>
      <p className="text-sm font-semibold leading-snug" style={{ color: '#1A1108' }}>
        {insight.headline}
      </p>
      <p className="text-xs leading-relaxed" style={{ color: '#7A6548' }}>
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
      <p className="text-[9px] font-bold uppercase tracking-widest mb-1" style={{ color: '#7A6548' }}>
        Today's Insights
      </p>
      {visible.map((ins, i) => (
        <InsightCard key={i} insight={ins} />
      ))}
    </aside>
  )
}

function InsightsMobileStrip() {
  const visible = useInsights()
  return (
    <div
      className="shrink-0 border-b px-4 py-2.5"
      style={{ borderColor: '#C8B090', backgroundColor: '#EDE0C8' }}
    >
      <p className="text-[9px] font-bold uppercase tracking-widest mb-2" style={{ color: '#7A6548' }}>
        Today's Insights
      </p>
      <div
        className="flex gap-2.5 overflow-x-auto pb-1"
        style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}
      >
        {visible.map((ins, i) => (
          <InsightCard key={i} insight={ins} compact />
        ))}
      </div>
    </div>
  )
}

// ── Mobile bottom nav ─────────────────────────────────────────────────────────

function BottomNav({ activeView, onNavigate }) {
  const NAV_ITEMS = [
    {
      id: 'chat',
      label: 'Home',
      icon: (active) => (
        <svg viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={active ? 0 : 1.8} className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
        </svg>
      ),
    },
    {
      id: 'dashboard',
      label: 'Dashboard',
      icon: (active) => (
        <svg viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={active ? 0 : 1.8} className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
        </svg>
      ),
    },
    {
      id: 'saved',
      label: 'My Recipes',
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
        backgroundColor: '#0f2318',
        borderTop: '1px solid #1a3020',
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
            className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px] transition-colors"
            style={{ color: active ? '#1D9E75' : '#6b8a72' }}
            aria-label={item.label}
          >
            {item.icon(active)}
            <span className="text-[9px] font-semibold uppercase tracking-wider">{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

// ── Avatars ───────────────────────────────────────────────────────────────────

function ChefAvatar() {
  return (
    <img
      src="https://images.unsplash.com/photo-1629407119384-d42320c3e576?w=100&q=80"
      alt=""
      aria-hidden
      className="shrink-0 select-none"
      style={{
        width: 36,
        height: 36,
        borderRadius: '50%',
        objectFit: 'cover',
        border: '2px solid #C1683A',
      }}
    />
  )
}

function UserAvatar({ name }) {
  const initial = name ? name[0].toUpperCase() : 'Y'
  return (
    <div
      className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-xs font-bold text-white select-none"
      style={{ backgroundColor: '#A8522A' }}
      aria-hidden
    >
      {initial}
    </div>
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
        <div key={key} className="flex flex-col items-center bg-sage-pale rounded-xl px-2 py-3 border border-sage/25">
          <span className="text-lg sm:text-xl font-bold leading-none tabular-nums text-sage-dark">{macros[key]}</span>
          <span className="text-[9px] text-sage mt-0.5 uppercase tracking-wide">{unit}</span>
          <span className="text-[11px] text-charcoal-light mt-0.5">{label}</span>
        </div>
      ))}
    </div>
  )
}

// ── Skeleton card (warm palette) ──────────────────────────────────────────────

const SHIMMER = '#E8D9BC'

function SkeletonCard() {
  return (
    <div
      className="rounded-2xl p-5 sm:p-6 space-y-4 animate-pulse"
      style={{
        backgroundColor: '#FAF6EE',
        borderTop: '4px solid #C1683A',
        boxShadow: '0 2px 12px rgba(44,36,22,0.07), 0 1px 3px rgba(44,36,22,0.05)',
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

function ChatBubble({ role, content, isStreaming, userName }) {
  const isUser = role === 'user'
  return (
    <div className={`flex items-end gap-2.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {isUser ? <UserAvatar name={userName} /> : <ChefAvatar />}
      <div
        className="max-w-[75%] sm:max-w-[65%] px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap"
        style={isUser
          ? {
              backgroundColor: '#C1683A',
              color: '#FFFFFF',
              borderRadius: '16px 16px 4px 16px',
              fontSize: '0.875rem',
            }
          : {
              backgroundColor: '#FFFFFF',
              color: '#2C1810',
              border: '1px solid rgba(193,104,58,0.12)',
              borderRadius: '16px',
              boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
              fontSize: '15px',
              lineHeight: 1.7,
              fontFamily: 'DM Sans, sans-serif',
            }
        }
      >
        {content}
        {isStreaming && (
          <span className="inline-block w-1.5 h-4 ml-0.5 animate-pulse align-text-bottom rounded-sm" style={{ backgroundColor: '#7A6548', opacity: 0.5 }} />
        )}
      </div>
    </div>
  )
}

function TypingIndicator() {
  return (
    <div className="flex items-end gap-2.5">
      <ChefAvatar />
      <div
        className="flex items-center gap-1.5 px-4 py-3.5"
        style={{ backgroundColor: '#FFFFFF', border: '1px solid rgba(193,104,58,0.12)', borderRadius: '16px', boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}
      >
        {[0, 1, 2].map(i => (
          <span
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-charcoal-muted animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    </div>
  )
}

// ── Quick-reply cards ─────────────────────────────────────────────────────────

function QuickReplyRow({ type, onSubmit, onDismiss, onFocusInput }) {
  const [selected, setSelected] = useState([])

  const chipStyle = (sel) => ({
    backgroundColor: sel ? '#FFF5EE' : '#FAF6EE',
    borderColor:     sel ? '#C1683A' : 'rgba(193,104,58,0.25)',
    color:           sel ? '#C1683A' : '#2C1810',
    borderRadius:    20,
    fontSize:        13,
    fontFamily:      'DM Sans, sans-serif',
    fontWeight:      400,
  })

  // "Something else" focuses the textarea rather than just vanishing the row
  function handleSomethingElse() {
    onDismiss()
    onFocusInput?.()
  }

  const somethingElseBtn = (
    <button
      onClick={handleSomethingElse}
      className="shrink-0 py-2 px-4 rounded-xl text-sm font-medium transition-colors"
      style={{ color: '#7A6548', backgroundColor: '#FAF3E4', border: '1px solid #C8B090' }}
    >
      Something else →
    </button>
  )

  if (type === 'proteins') {
    const [pantrySelected, setPantrySelected] = useState([])

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
      <div className="space-y-2.5">
        {/* Proteins row */}
        <p className="text-[11px] font-semibold uppercase tracking-widest text-charcoal-muted">Proteins</p>
        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
          {PROTEIN_CARDS.map(card => (
            <button
              key={card.value}
              onClick={() => toggleProtein(card.value)}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 border transition-all"
              style={chipStyle(selected.includes(card.value))}
            >
              <span>{card.emoji}</span>
              <span className="whitespace-nowrap">{card.label}</span>
            </button>
          ))}
        </div>

        {/* Pantry / veggie row */}
        <p className="text-[11px] font-semibold uppercase tracking-widest text-charcoal-muted">Also have:</p>
        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
          {PANTRY_CARDS.map(card => (
            <button
              key={card.value}
              onClick={() => togglePantry(card.value)}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 border transition-all"
              style={chipStyle(pantrySelected.includes(card.value))}
            >
              <span>{card.emoji}</span>
              <span className="whitespace-nowrap">{card.label}</span>
            </button>
          ))}
        </div>

        <div className="flex gap-2 items-center">
          {selected.length > 0 && (
            <button
              onClick={handleSubmit}
              className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white transition-opacity active:opacity-80"
              style={{ backgroundColor: '#C1683A' }}
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
    )
  }

  if (type === 'cuisine') {
    return (
      <div className="space-y-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-charcoal-muted">Pick a style</p>
        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
          {CUISINE_CARDS.map(card => (
            <button
              key={card.value}
              onClick={() => onSubmit(card.value, [card.value])}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 border transition-all active:scale-95"
              style={chipStyle(false)}
            >
              <span>{card.emoji}</span>
              <span className="whitespace-nowrap">{card.label}</span>
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
        <p className="text-[11px] font-semibold uppercase tracking-widest text-charcoal-muted">How long have you got?</p>
        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
          {TIME_CARDS.map(card => (
            <button
              key={card.value}
              onClick={() => onSubmit(card.value, [card.value])}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 border transition-all active:scale-95"
              style={chipStyle(false)}
            >
              <span>{card.emoji}</span>
              <span className="whitespace-nowrap">{card.label}</span>
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

function CardImageHeader({ dishName, cuisine, onImageResolved, initialUrl }) {
  const [imgUrl,    setImgUrl]    = useState(initialUrl ?? null)
  const [imgLoaded, setImgLoaded] = useState(!!initialUrl)

  useEffect(() => {
    if (initialUrl) return  // already have URL — skip fetch
    let cancelled = false
    const params = new URLSearchParams({ query: dishName })
    if (cuisine) params.set('cuisine', cuisine)
    fetch(`/api/unsplash?${params}`)
      .then(r => r.json())
      .then(d => {
        if (!cancelled && d.url) {
          setImgUrl(d.url)
          onImageResolved?.(d.url)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [dishName])

  return (
    <div className="relative w-full h-44 overflow-hidden rounded-t-2xl">
      {/* Terracotta placeholder — always behind */}
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ backgroundColor: '#C1683A' }}
      >
        <svg viewBox="0 0 64 64" className="w-14 h-14 opacity-30" fill="white">
          <path d="M32 6C18 6 8 16 8 30c0 10 6 18 14 22v4h20v-4c8-4 14-12 14-22C56 16 46 6 32 6zm0 4c11 0 20 9 20 20 0 8-5 15-12 18.5V50H24v-1.5C17 45 12 38 12 30c0-11 9-20 20-20z"/>
          <rect x="28" y="2" width="8" height="8" rx="2"/>
          <circle cx="32" cy="30" r="6"/>
        </svg>
      </div>

      {/* Real photo */}
      {imgUrl && (
        <img
          src={imgUrl}
          alt={dishName}
          onLoad={() => setImgLoaded(true)}
          className="absolute inset-0 w-full h-full object-cover transition-opacity duration-700"
          style={{ opacity: imgLoaded ? 1 : 0 }}
        />
      )}

      {/* Dark gradient so text reads cleanly */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.18) 50%, transparent 100%)' }}
      />

      {/* Dish name + cuisine overlaid at bottom */}
      <div className="absolute bottom-0 left-0 right-0 px-4 pb-3 pt-6">
        {cuisine && (
          <span className="block text-[11px] font-medium text-white/70 mb-0.5 uppercase tracking-wider">
            {cuisine}
          </span>
        )}
        <h3 className="font-serif text-lg font-bold text-white leading-snug drop-shadow">
          {dishName}
        </h3>
      </div>
    </div>
  )
}

function DishCard({ dish, onClick, onImageResolved }) {
  const m = dish.dietician.macros
  return (
    <button
      onClick={onClick}
      className="w-full rounded-2xl overflow-hidden text-left transition-all duration-200 hover:-translate-y-1.5 group"
      style={{ backgroundColor: '#0f2318', border: '0.5px solid #1a3020', boxShadow: '0 2px 12px rgba(0,0,0,0.3)' }}
    >
      <CardImageHeader dishName={dish.name} cuisine={dish.chef.cuisine} onImageResolved={onImageResolved} />

      <div className="px-4 pb-4 pt-3 space-y-3">
        {/* 4-chip macro row */}
        <div className="flex gap-1.5 flex-wrap">
          {[
            { label: `${m.calories} kcal`, key: 'cal' },
            { label: `${m.protein}g P`, key: 'pro' },
            { label: `${m.carbs}g C`, key: 'carb' },
            { label: `${m.fat}g F`, key: 'fat' },
          ].map(chip => (
            <span
              key={chip.key}
              className="text-xs font-semibold px-2.5 py-1 rounded-full"
              style={{ backgroundColor: 'rgba(93,202,165,0.12)', color: '#5DCAA5', border: '1px solid rgba(93,202,165,0.2)' }}
            >
              {chip.label}
            </span>
          ))}
        </div>

        {/* Cook time + difficulty */}
        {(dish.dietician.cookTime !== '—' || dish.dietician.difficulty) && (
          <div className="flex gap-2 flex-wrap">
            {dish.dietician.cookTime !== '—' && (
              <span className="text-xs px-2.5 py-1 rounded-full" style={{ color: '#6b8a72', backgroundColor: '#132b1a' }}>
                {dish.dietician.cookTime} mins
              </span>
            )}
            {dish.dietician.difficulty && (
              <span className="text-xs px-2.5 py-1 rounded-full" style={{ color: '#6b8a72', backgroundColor: '#132b1a' }}>
                {dish.dietician.difficulty}
              </span>
            )}
          </div>
        )}

        <div className="pt-1 text-sm font-medium flex items-center gap-1.5 group-hover:gap-3 transition-all duration-200" style={{ color: '#1D9E75' }}>
          View recipe <span>→</span>
        </div>
      </div>
    </button>
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
            backgroundColor: '#FAF6EE',
            border: '1px solid #C8B090',
            borderLeft: hovered === i ? `4px solid ${accentColor}` : `1px solid #C8B090`,
            color: '#1A1108',
            cursor: 'default',
          }}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered(null)}
        >
          <span className="shrink-0 w-6 h-6 rounded-full text-xs flex items-center justify-center font-bold mt-0.5"
            style={{ backgroundColor: accentColor, color: '#FFFFFF' }}>
            {i + 1}
          </span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  )
}

function DetailView({ dish, onBack, imgUrl, isSaved, onSave, onRemove, onNavigateDashboard, missingIngredients = [] }) {
  const [mode,         setMode]         = useState('diet')
  const [copied,       setCopied]       = useState(false)
  const [toast,        setToast]        = useState({ visible: false, message: '', action: null })
  const [checkedItems, setCheckedItems] = useState(new Set())
  const [listCopied,   setListCopied]   = useState(false)
  const { chef, dietician } = dish
  console.log('[debug] missingIngredients:', missingIngredients)

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
  const chefAccent = '#D4900A'

  return (
    <div className="animate-fade-in min-h-screen bg-sandy pb-44 sm:pb-28">
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
          className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white shadow-lg flex items-center gap-1.5 whitespace-nowrap"
          style={{ backgroundColor: '#1A1108', cursor: toast.action ? 'pointer' : 'default' }}
        >
          {toast.message}
          {toast.action && <span className="opacity-60 text-xs">→</span>}
        </button>
      </div>

      {/* ── Hero image ── */}
      {imgUrl ? (
        <div className="relative w-full h-72 sm:h-[50vh] overflow-hidden">
          <img src={imgUrl} alt={dish.name} className="w-full h-full object-cover" />
          <div className="absolute inset-0"
            style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.25) 40%, rgba(0,0,0,0.05) 75%, transparent 100%)' }} />
          <div className="absolute top-0 left-0 right-0 px-4 pt-6 max-w-2xl mx-auto">
            <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 hover:text-white transition-colors drop-shadow">
              {BACK_ARROW} Back to dishes
            </button>
          </div>
          <div className="absolute bottom-0 left-0 right-0 px-4 pb-8 max-w-2xl mx-auto">
            {chef.cuisine && <p className="text-xs font-medium text-white/65 uppercase tracking-widest mb-2">{chef.cuisine}</p>}
            <h1 className="font-serif text-3xl sm:text-5xl font-bold text-white leading-tight"
              style={{ textShadow: '0 2px 12px rgba(0,0,0,0.45)' }}>
              {dish.name}
            </h1>
          </div>
        </div>
      ) : (
        <div className="relative w-full h-24 sm:h-32 flex items-end" style={{ backgroundColor: '#C1683A' }}>
          <div className="px-4 pb-5 max-w-2xl mx-auto w-full">
            <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 hover:text-white transition-colors">
              {BACK_ARROW} Back to dishes
            </button>
          </div>
        </div>
      )}

      {/* ── Content ── */}
      <div className="max-w-2xl mx-auto px-4 pt-6 space-y-8 relative">

        {!imgUrl && (
          <h1 className="font-serif text-3xl sm:text-4xl font-bold text-charcoal leading-tight">{dish.name}</h1>
        )}

        {/* ── Mode toggle ── */}
        <div className="p-1 rounded-2xl flex gap-1" style={{ backgroundColor: '#E0CFA8' }}>
          {[
            { value: 'diet', label: "I'm being good 🥗" },
            { value: 'chef', label: 'Cheat meal 🍔'     },
          ].map(opt => (
            <button key={opt.value} onClick={() => setMode(opt.value)}
              className="flex-1 py-2.5 px-3 rounded-xl text-sm font-semibold transition-all duration-200"
              style={mode === opt.value
                ? { backgroundColor: '#FAF6EE', color: '#1A1108', boxShadow: '0 1px 6px rgba(26,17,8,0.14)' }
                : { color: '#7A6548' }
              }>
              {opt.label}
            </button>
          ))}
        </div>
        {isChef && (
          <p className="text-center text-sm italic" style={{ color: chefAccent, marginTop: '-1.5rem' }}>
            No judgment. Enjoy every bite.
          </p>
        )}

        {/* ── CHEF MODE ── */}
        {isChef && (
          <section className="space-y-6 pl-5 border-l-4" style={{ borderColor: chefAccent }}>
            <div className="flex flex-wrap gap-2">
              {chef.cuisine && (
                <span className="text-xs px-3 py-1 rounded-full border font-medium"
                  style={{ backgroundColor: '#FFF8E7', color: chefAccent, borderColor: `${chefAccent}40` }}>
                  {chef.cuisine}
                </span>
              )}
              {chef.flavour && (
                <span className="text-xs px-3 py-1 rounded-full border font-medium"
                  style={{ backgroundColor: '#FFF8E7', color: chefAccent, borderColor: `${chefAccent}40` }}>
                  {chef.flavour}
                </span>
              )}
            </div>

            {chef.restaurant && <p className="text-sm text-charcoal leading-relaxed">{chef.restaurant}</p>}

            {chef.calories && (
              <div className="inline-flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-full"
                style={{ backgroundColor: '#FFF8E7', borderColor: `${chefAccent}40`, color: '#4A3728' }}>
                <span className="font-bold" style={{ color: chefAccent }}>~{chef.calories}</span>
                <span>kcal · full version</span>
              </div>
            )}

            {chef.steps?.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: '#7A6548' }}>
                  Chef's method
                </h3>
                <CookStepsList steps={chef.steps} accentColor={chefAccent} />
              </div>
            )}
          </section>
        )}

        {/* ── DIETICIAN MODE ── */}
        {!isChef && (
          <section className="space-y-6 pl-5 border-l-4 border-sage">
            <MacroRow macros={dietician.macros} />

            {dietician.whatChanges.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-widest text-charcoal-muted mb-3">What changes</h3>
                <ul className="space-y-2">
                  {dietician.whatChanges.map((item, i) => (
                    <li key={i} className="flex gap-2.5 text-sm text-charcoal leading-snug">
                      <span className="text-sage font-bold shrink-0 mt-px">✓</span>{item}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {dietician.keyTechnique && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-widest text-charcoal-muted mb-2">Key technique</h3>
                <p className="text-sm text-charcoal leading-relaxed">{dietician.keyTechnique}</p>
              </div>
            )}

            {dietician.cookSteps.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-charcoal-muted">Quick cook steps</h3>
                  {dietician.cookTime && dietician.cookTime !== '—' && (
                    <span className="text-xs font-medium" style={{ color: '#7A6548' }}>
                      Total: ~{dietician.cookTime} mins
                    </span>
                  )}
                </div>
                <CookStepsList steps={dietician.cookSteps} accentColor="#C1683A" />
              </div>
            )}

            {dietician.note && (
              <div className="rounded-xl bg-sage-pale border border-sage/25 px-5 py-4">
                <p className="text-sm text-sage-dark leading-relaxed">{dietician.note}</p>
              </div>
            )}
          </section>
        )}

        {/* ── WHAT YOU'LL NEED ── */}
        {missingIngredients.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-charcoal-muted">
              What You'll Need
            </h3>
            <div
              className="rounded-xl p-5 space-y-4"
              style={{ backgroundColor: '#FAF6EE', border: '1px solid #C8B090', boxShadow: '0 1px 6px rgba(26,17,8,0.06)' }}
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
                          border: '2px solid #C1683A',
                          backgroundColor: checked ? '#C1683A' : 'transparent',
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
                          color: '#1A1108',
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
                      backgroundColor: listCopied ? '#4E7A53' : allChecked ? '#A8C5AC' : '#7A9E7E',
                      boxShadow: (listCopied || allChecked) ? 'none' : '0 2px 8px rgba(122,158,126,0.3)',
                      cursor: allChecked ? 'default' : 'pointer',
                    }}
                  >
                    {listCopied ? '✓ Copied to clipboard!' : allChecked ? '✓ All picked up' : '🛒 Copy Shopping List'}
                  </button>
                )
              })()}
            </div>
          </div>
        )}
      </div>

      {/* ── Action bar ── */}
      <div className="fixed bottom-0 inset-x-0 z-50 bg-sandy/95 backdrop-blur-sm border-t border-sandy-border sm:static sm:inset-auto sm:bg-transparent sm:backdrop-blur-none sm:border-0 sm:max-w-2xl sm:mx-auto sm:mt-8 sm:px-4">
        {/* Divider (mobile only — desktop uses mt-8 spacing above) */}
        <div className="sm:hidden h-px mx-4 mt-0" style={{ backgroundColor: '#C8B090' }} />
        <div className="p-4 space-y-2.5">
          {/* Save button */}
          <button
            onClick={handleBookmark}
            className="w-full flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-xl font-semibold text-sm text-white transition-all duration-200 active:opacity-80"
            style={{
              backgroundColor: isSaved ? '#5C8260' : '#7A9E7E',
              boxShadow: isSaved ? 'none' : '0 2px 8px rgba(122,158,126,0.35)',
            }}
          >
            {isSaved ? (
              <>
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6.75 2.25A.75.75 0 016 3v18a.75.75 0 001.28.53L12 17.31l4.72 4.22A.75.75 0 0018 21V3a.75.75 0 00-.75-.75H6.75z"/>
                </svg>
                ✓ Saved to My Recipes
              </>
            ) : (
              <>🔖 Save to My Recipes</>
            )}
          </button>

          {/* Copy button */}
          <button
            onClick={handleCopy}
            className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-sm transition-all duration-200 active:opacity-80"
            style={{
              backgroundColor: copied ? '#C1683A' : 'transparent',
              color: copied ? '#FFFFFF' : '#7A6548',
              border: copied ? 'none' : '1.5px solid #C8B090',
            }}
          >
            {copied ? '✓ Copied!' : 'Copy Recipe 📋'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Welcome screen ────────────────────────────────────────────────────────────

const WELCOME_STYLES = ``

function WelcomeScreen({ onStart }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ backgroundColor: '#0A1A12' }}>
      <style>{WELCOME_STYLES}</style>
      <div className="text-center space-y-10 w-full max-w-xs">
        <div className="flex flex-col items-center gap-5">
          <RemiLogo size={56} />
          <div>
            <h1 style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '2rem', fontWeight: 500, color: '#F5F2EC', letterSpacing: '0.02em' }}>Remi</h1>
            <p style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.75rem', color: '#6b8a72', letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 4 }}>Personal AI Chef</p>
          </div>
        </div>
        <div className="space-y-3 text-left">
          {[
            'Built around what you have',
            'Macros adjusted to your training',
            'Chef quality. Nutritionist approved.',
          ].map(text => (
            <div key={text} className="flex items-center gap-3">
              <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#1D9E75', flexShrink: 0, display: 'inline-block' }} />
              <span style={{ fontSize: '0.875rem', color: '#c8e0cc' }}>{text}</span>
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <button
            onClick={onStart}
            style={{ width: '100%', backgroundColor: '#1D9E75', color: '#fff', borderRadius: 14, padding: '14px 0', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, fontSize: '0.9375rem' }}
          >
            Get started →
          </button>
          <p style={{ fontSize: '0.7rem', color: '#4a6b52', letterSpacing: '0.04em' }}>Free · No account needed</p>
        </div>
      </div>
    </div>
  )
}

// ── Loading screen ────────────────────────────────────────────────────────────

const LOADER_STYLES = `
  @keyframes logoPulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.3; }
  }
  .remi-loader-pulse { animation: logoPulse 2s ease-in-out infinite; }
`

function ChefLoader({ profile }) {
  const isTrainingDay = profile?.trainingToday !== false
  const subtext = isTrainingDay
    ? 'Training day · High protein · Moderate carbs'
    : 'Rest day · Lean and clean'
  return (
    <>
      <style>{LOADER_STYLES}</style>
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="remi-loader-pulse">
          <RemiLogo size={56} />
        </div>
        <p style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '1.125rem', fontStyle: 'italic', color: '#5DCAA5' }}>
          Let him cook...
        </p>
        {profile && (
          <p style={{ fontSize: '0.8125rem', color: '#6b8a72' }}>{subtext}</p>
        )}
      </div>
    </>
  )
}

// ── Saved recipe card ─────────────────────────────────────────────────────────

function SavedDishCard({ dish, onOpen, onRemove }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  return (
    <div className="rounded-2xl bg-cream shadow-card overflow-hidden relative">
      <button onClick={onOpen} className="w-full text-left block">
        <CardImageHeader dishName={dish.name} cuisine={dish.chef?.cuisine} initialUrl={dish._imgUrl} />
        <div className="px-5 pb-5 pt-4 space-y-2">
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold tabular-nums" style={{ color: '#C1683A' }}>
              {dish.dietician?.macros?.calories ?? '—'}
            </span>
            <span className="text-sm text-charcoal-muted">kcal</span>
          </div>
          {(dish.dietician?.cookTime && dish.dietician.cookTime !== '—') && (
            <p className="text-xs text-charcoal-muted">
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
              className="text-xs font-semibold px-2.5 py-1 rounded-lg text-white"
              style={{ backgroundColor: '#C1683A' }}>
              Remove
            </button>
            <button onClick={() => setConfirmDelete(false)}
              className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-sandy-border bg-sandy text-charcoal">
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={e => { e.stopPropagation(); setConfirmDelete(true) }}
            className="w-8 h-8 rounded-full flex items-center justify-center text-charcoal-muted hover:text-terracotta transition-colors"
            style={{ backgroundColor: 'rgba(255,253,247,0.92)', border: '1px solid #C8B090' }}
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
    <div className="animate-fade-in min-h-screen bg-sandy px-4 py-10 sm:py-14 relative">
      <PaperTexture />
      <div className="max-w-3xl mx-auto space-y-8 relative">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-serif text-4xl font-extrabold tracking-wide text-charcoal">My Recipes 📖</h1>
            <p className="text-charcoal-muted text-sm mt-1.5">
              {savedRecipes.length > 0
                ? `${savedRecipes.length} saved recipe${savedRecipes.length !== 1 ? 's' : ''}`
                : 'Your bookmarked recipes live here'}
            </p>
          </div>
          <button onClick={onClose}
            className="shrink-0 text-xs font-medium text-charcoal-muted hover:text-terracotta border border-sandy-border hover:border-terracotta/40 px-3 py-1.5 rounded-lg transition-colors mt-1.5">
            ← Back
          </button>
        </div>

        {savedRecipes.length === 0 ? (
          <div className="text-center py-24 space-y-4">
            <div className="text-6xl leading-none">📚</div>
            <p className="text-charcoal-muted text-sm max-w-xs mx-auto leading-relaxed">
              Nothing saved yet. Start cooking and bookmark your favourites.
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

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({ profile, savedRecipes, sessions, streak, stats, onClose, onOpenRecipe, onOpenSessionDish, onQuickStart, onEditProfile, onViewSaved }) {
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

  const sectionCard = { backgroundColor: '#FAF6EE', border: '1px solid #C8B090', boxShadow: '0 2px 8px rgba(26,17,8,0.07)' }

  // Time-of-day greeting
  const hour = new Date().getHours()
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'

  // Goal bar: only shown for fat-loss goal with both weight and goalAmount
  const showGoalBar = activeGoals.includes('lose') &&
    profile?.weight && profile?.goalAmount &&
    Number(profile.goalAmount) > 0

  return (
    <div className="animate-fade-in min-h-screen bg-sandy px-4 pt-10 pb-24 lg:pb-14 sm:pt-14 relative">
      <PaperTexture />
      <div className="max-w-2xl mx-auto space-y-5 relative">

        {/* Header — back button only on desktop; mobile uses BottomNav */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: '#7A6548' }}>
              Good {timeOfDay}
            </p>
            <h1 className="font-serif text-4xl font-extrabold leading-none" style={{ color: '#1A1108' }}>
              {profile?.name ?? 'Chef'}.
            </h1>
          </div>
          <button
            onClick={onClose}
            className="hidden sm:block shrink-0 text-xs font-medium text-charcoal-muted hover:text-terracotta border border-sandy-border hover:border-terracotta/40 px-3 py-1.5 rounded-lg transition-colors mt-1.5"
          >
            ← Back
          </button>
        </div>

        {/* ── Hero calorie stat ── */}
        <div
          className="rounded-2xl p-6 text-center space-y-1"
          style={{ backgroundColor: '#FAF6EE', border: '1px solid #C8B090', boxShadow: '0 2px 8px rgba(26,17,8,0.07)' }}
        >
          <p className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#7A6548' }}>Daily calorie target</p>
          <p className="font-serif font-extrabold leading-none" style={{ fontSize: 'clamp(2.5rem, 8vw, 4rem)', color: '#C1683A' }}>
            {calTarget}
          </p>
          <p className="text-sm font-medium" style={{ color: '#7A6548' }}>kcal · {protTarget}g+ protein</p>
        </div>

        {/* ── 3-up stats ── */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Day streak', value: streak?.count ?? 0, unit: streak?.count === 1 ? 'day' : 'days', icon: '🔥' },
            { label: 'Recipes saved', value: stats?.totalRecipes ?? 0, unit: 'total', icon: '📖' },
            { label: 'Kcal saved', value: stats?.totalCalSaved ? (stats.totalCalSaved >= 1000 ? `${(stats.totalCalSaved / 1000).toFixed(1)}k` : stats.totalCalSaved) : 0, unit: 'vs full version', icon: '💪' },
          ].map(({ label, value, unit, icon }) => (
            <div
              key={label}
              className="rounded-2xl px-3 py-4 text-center space-y-1"
              style={sectionCard}
            >
              <span className="text-xl leading-none">{icon}</span>
              <p className="font-serif text-2xl font-extrabold tabular-nums leading-none" style={{ color: '#1A1108' }}>
                {value}
              </p>
              <p className="text-[9px] font-semibold uppercase tracking-widest" style={{ color: '#7A6548' }}>
                {label}
              </p>
            </div>
          ))}
        </div>

        {/* ── Goal bar ── */}
        {showGoalBar && (() => {
          const start  = Number(profile.weight)
          const target = start - Number(profile.goalAmount)
          return (
            <div className="rounded-2xl p-5 space-y-3" style={sectionCard}>
              <p className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#7A6548' }}>Fat loss target</p>
              <div className="flex items-center justify-between text-xs font-semibold" style={{ color: '#1A1108' }}>
                <span>{start} kg</span>
                <span style={{ color: '#C1683A' }}>→ {target} kg</span>
              </div>
              <div className="relative h-2.5 rounded-full overflow-hidden" style={{ backgroundColor: '#D4C4A0' }}>
                {/* Progress = sessions count as proxy (capped at 100%) */}
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${Math.min(100, (sessions.length / 30) * 100)}%`,
                    background: 'linear-gradient(90deg, #C1683A, #D4845A)',
                  }}
                />
              </div>
              <p className="text-xs" style={{ color: '#7A6548' }}>
                Goal: lose {profile.goalAmount} kg · {sessions.length} session{sessions.length !== 1 ? 's' : ''} completed
              </p>
            </div>
          )
        })()}

        {/* ── Goal card ── */}
        <p className="text-[9px] font-bold uppercase tracking-widest pt-2" style={{ color: '#7A6548' }}>Your Goals</p>
        <div className="rounded-2xl p-5 space-y-4" style={sectionCard}>
          <div className="flex items-center gap-3">
            <span className="text-3xl leading-none">{goalInfo.emoji}</span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-charcoal-muted mb-0.5">
                {activeGoals.length > 1 ? 'Goals' : 'Goal'}
              </p>
              <p className="font-serif text-xl font-bold text-charcoal">{goalInfo.label}</p>
              {extraGoals.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {extraGoals.map(g => (
                    <span key={g} className="text-[11px] px-2.5 py-0.5 rounded-full font-medium"
                      style={{ backgroundColor: '#FAF3E4', color: '#4A3728', border: '1px solid #C8B090' }}>
                      {g}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={onEditProfile}
              className="text-xs font-medium transition-colors shrink-0"
              style={{ color: '#C1683A' }}
            >
              Edit →
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl px-4 py-3 text-center" style={{ backgroundColor: '#FAF3E4', border: '1px solid #C8B090' }}>
              <p className="text-base font-bold tabular-nums" style={{ color: '#C1683A' }}>{calTarget}</p>
              <p className="text-[10px] uppercase tracking-wide text-charcoal-muted mt-0.5">kcal / day</p>
            </div>
            <div className="rounded-xl px-4 py-3 text-center" style={{ backgroundColor: '#FAF3E4', border: '1px solid #C8B090' }}>
              <p className="text-base font-bold tabular-nums" style={{ color: '#7A9E7E' }}>{protTarget}g+</p>
              <p className="text-[10px] uppercase tracking-wide text-charcoal-muted mt-0.5">protein / day</p>
            </div>
          </div>
          {profile?.weight && (
            <p className="text-xs text-charcoal-muted">
              Based on {profile.weight}kg
              {profile.trainingFreq ? ` · trains ${profile.trainingFreq}/week` : ''}
            </p>
          )}
        </div>

        {/* ── Saved recipes mini-grid ── */}
        {last4Recipes.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#7A6548' }}>Saved Recipes</p>
              <button
                onClick={onViewSaved}
                className="text-xs font-medium transition-colors"
                style={{ color: '#C1683A' }}
              >
                See all ({savedRecipes.length}) →
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {last4Recipes.map(recipe => (
                <button
                  key={recipe._id}
                  onClick={() => onOpenRecipe(recipe)}
                  className="rounded-xl overflow-hidden text-left active:opacity-80 transition-opacity"
                  style={{ backgroundColor: '#FAF6EE', border: '1px solid #C8B090' }}
                >
                  <div className="relative w-full h-24 overflow-hidden" style={{ backgroundColor: '#C1683A' }}>
                    {recipe._imgUrl && (
                      <img src={recipe._imgUrl} alt={recipe.name} className="w-full h-full object-cover" />
                    )}
                    <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.65) 0%, transparent 60%)' }} />
                    <p className="absolute bottom-0 left-0 right-0 px-2.5 pb-1.5 text-xs font-semibold text-white leading-tight line-clamp-2">
                      {recipe.name}
                    </p>
                  </div>
                  <div className="px-2.5 py-2 flex items-center justify-between">
                    <span className="text-sm font-bold tabular-nums" style={{ color: '#C1683A' }}>
                      {recipe.dietician?.macros?.calories ?? '—'} kcal
                    </span>
                    {recipe.dietician?.difficulty && (
                      <span className="text-[10px] font-medium text-charcoal-muted">{recipe.dietician.difficulty}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Favourite cuisines ── */}
        {cuisineFreq.length > 0 && (
          <div className="rounded-2xl p-5 space-y-4" style={sectionCard}>
            <p className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#7A6548' }}>Favourite Cuisines</p>
            <div className="space-y-3">
              {cuisineFreq.map(([cuisine, count], i) => {
                const pct = Math.round((count / cuisineFreq[0][1]) * 100)
                const barColor = i === 0 ? '#C1683A' : i === 1 ? '#D4900A' : '#7A9E7E'
                return (
                  <div key={cuisine} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-charcoal">{cuisine}</span>
                      <span className="text-xs text-charcoal-muted">{count} {count === 1 ? 'time' : 'times'}</span>
                    </div>
                    <div className="h-1.5 rounded-full" style={{ backgroundColor: '#E8D9BC' }}>
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${pct}%`, backgroundColor: barColor }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Go-to protein ── */}
        {topProtein && (
          <div className="rounded-2xl p-5" style={sectionCard}>
            <p className="text-[9px] font-bold uppercase tracking-widest mb-3" style={{ color: '#7A6548' }}>Go-to Protein</p>
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full flex items-center justify-center text-2xl shrink-0"
                style={{ backgroundColor: '#FDF0E8', border: '2px solid #C1683A' }}>
                {PROTEIN_CARDS.find(p => p.value === topProtein[0])?.emoji ?? '🍽️'}
              </div>
              <div>
                <p className="font-semibold text-charcoal capitalize">{topProtein[0]}</p>
                <p className="text-xs text-charcoal-muted mt-0.5">
                  Used in {topProtein[1]} session{topProtein[1] !== 1 ? 's' : ''} — your most-cooked protein
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ── Recent sessions ── */}
        {last3Sessions.length > 0 && (
          <div className="space-y-3">
            <p className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#7A6548' }}>Recent Sessions</p>
            <div className="space-y-2">
              {last3Sessions.map(session => (
                <div key={session.id} className="rounded-xl px-4 py-3.5 space-y-2" style={sectionCard}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-charcoal-muted">
                      {fmtDate(session.date)}
                    </span>
                    {session.cuisine && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full"
                        style={{ backgroundColor: '#FDF0E8', color: '#7A6548', border: '1px solid #C8B090' }}>
                        {session.cuisine}
                      </span>
                    )}
                  </div>
                  {session.proteins?.length > 0 && (
                    <p className="text-sm text-charcoal">
                      <span className="font-medium">Proteins:</span>{' '}
                      <span className="text-charcoal-muted">{session.proteins.join(', ')}</span>
                    </p>
                  )}
                  {session.dishes?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {session.dishes.map((d, i) => {
                        // d may be a full dish object (new) or a string (old)
                        const dishName = typeof d === 'object' ? d.name : d
                        const isClickable = typeof d === 'object'
                        return isClickable ? (
                          <button
                            key={i}
                            onClick={() => onOpenSessionDish?.(d)}
                            className="text-[11px] px-2.5 py-1 rounded-full transition-all hover:shadow-sm active:opacity-80"
                            style={{ backgroundColor: '#FDF0E8', color: '#C1683A', border: '1px solid #D4845A', fontWeight: 600 }}
                          >
                            {dishName} →
                          </button>
                        ) : (
                          <span key={i} className="text-[11px] px-2.5 py-1 rounded-full"
                            style={{ backgroundColor: '#FDF0E8', color: '#4A3728', border: '1px solid #C8B090' }}>
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
          <div className="text-center py-16 space-y-4">
            <div className="text-5xl leading-none">🍽️</div>
            <p className="text-charcoal-muted text-sm max-w-xs mx-auto leading-relaxed">
              Your dashboard fills up as you cook. Start a session and get your first recipes.
            </p>
          </div>
        )}

        {/* ── Quick Start CTA ── */}
        <button
          onClick={onQuickStart}
          className="w-full py-4 rounded-xl font-semibold text-base text-white active:opacity-80 transition-opacity"
          style={{ backgroundColor: '#C1683A', boxShadow: '0 2px 8px rgba(193,104,58,0.35)' }}
        >
          Start cooking →
        </button>
      </div>
    </div>
  )
}

// ── Onboarding (3-step) ──────────────────────────────────────────────────────

function Onboarding({ initialProfile, onComplete, onBack, isLocked }) {
  const hasProfile = initialProfile?.goal && Array.isArray(initialProfile?.training)
  const [step, setStep] = useState(hasProfile ? 3 : 1)
  const [goal, setGoal] = useState(initialProfile?.goal || 'cut')
  const [currentWeight, setCurrentWeight] = useState(String(initialProfile?.currentWeight || ''))
  const [targetWeight, setTargetWeight] = useState(String(initialProfile?.targetWeight || ''))
  const [training, setTraining] = useState(initialProfile?.training || [])
  const [daysPerWeek, setDaysPerWeek] = useState(String(initialProfile?.daysPerWeek || ''))
  const [trainingToday, setTrainingToday] = useState(
    initialProfile?.trainingToday !== undefined ? initialProfile.trainingToday : true
  )
  const [ingredients, setIngredients] = useState([])
  const [ingredientInput, setIngredientInput] = useState('')

  function canProceed() {
    if (step === 1) return currentWeight.trim().length > 0
    if (step === 2) return daysPerWeek.trim().length > 0 || training.includes('none')
    if (step === 3) return ingredients.length > 0
    return true
  }

  function addIngredient(raw) {
    const trimmed = raw.trim().replace(/,$/, '').trim()
    if (!trimmed) return
    const type = classifyIngredient(trimmed)
    setIngredients(prev => [...prev, { name: trimmed, type }])
    setIngredientInput('')
  }

  function handleIngredientKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addIngredient(ingredientInput)
    }
  }

  function buildFridgeMessage() {
    return "I want meal ideas. In the fridge I've got: " + ingredients.map(i => i.name).join(', ') + '.'
  }

  function handleCook() {
    if (!canProceed() || isLocked) return
    const remiProfile = {
      goal,
      currentWeight: Number(currentWeight) || undefined,
      targetWeight: targetWeight ? Number(targetWeight) : undefined,
      training,
      daysPerWeek: Number(daysPerWeek) || 0,
      trainingToday,
    }
    onComplete(remiProfile, buildFridgeMessage())
  }

  const pillStyle = (selected) => ({
    padding: '9px 16px', borderRadius: 10,
    border: `1.5px solid ${selected ? '#1D9E75' : '#1a3020'}`,
    backgroundColor: selected ? '#0f3522' : '#0f2318',
    color: selected ? '#5DCAA5' : '#6b8a72',
    fontFamily: 'DM Sans, sans-serif', fontSize: '0.875rem',
    fontWeight: selected ? 500 : 400, cursor: 'pointer', transition: 'all 0.15s',
  })

  const inputStyle = {
    width: '100%', borderRadius: 12, backgroundColor: '#0f2318',
    border: '1px solid #1a3020', color: '#c8e0cc',
    padding: '12px 16px', fontFamily: 'DM Sans, sans-serif', fontSize: 16,
    outline: 'none',
  }

  const labelStyle = {
    fontSize: '0.7rem', color: '#6b8a72', display: 'block',
    marginBottom: 6, letterSpacing: '0.08em', textTransform: 'uppercase',
  }

  function ProgressDots() {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
        {[1, 2, 3].map(s => (
          <div key={s} style={{
            height: 6, width: s === step ? 24 : 8, borderRadius: 10,
            backgroundColor: s <= step ? '#1D9E75' : '#1a3020',
            transition: 'all 0.25s ease',
          }} />
        ))}
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col px-6 py-10" style={{ backgroundColor: '#0A1A12' }}>
      <div className="w-full max-w-sm mx-auto flex flex-col" style={{ minHeight: 'calc(100dvh - 5rem)' }}>

        <div className="flex items-center gap-4 mb-8">
          <button onClick={step > 1 && !hasProfile ? () => setStep(s => s - 1) : onBack}
            style={{ color: '#6b8a72', background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd"/>
            </svg>
          </button>
          {!hasProfile && <ProgressDots />}
        </div>

        <div className="flex-1 space-y-6">

          {step === 1 && (
            <div className="space-y-6">
              <div>
                <h2 style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 500, fontSize: '1.5rem', color: '#F5F2EC', marginBottom: 6 }}>
                  What's the goal, chef?
                </h2>
                <p style={{ fontSize: '0.875rem', color: '#6b8a72' }}>Remi adjusts every dish around this.</p>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {REMI_GOAL_OPTIONS.map(o => (
                  <button key={o.value} onClick={() => setGoal(o.value)} style={pillStyle(goal === o.value)}>
                    {o.label}{o.desc ? ` — ${o.desc}` : ''}{goal === o.value ? ' ✓' : ''}
                  </button>
                ))}
              </div>
              <div className="space-y-4">
                <div>
                  <label style={labelStyle}>Current weight</label>
                  <div className="flex gap-2 items-center">
                    <input type="number" value={currentWeight} onChange={e => setCurrentWeight(e.target.value)} placeholder="84" style={inputStyle} />
                    <span style={{ color: '#6b8a72', fontSize: '0.875rem', flexShrink: 0 }}>kg</span>
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>Target weight</label>
                  <div className="flex gap-2 items-center">
                    <input type="number" value={targetWeight} onChange={e => setTargetWeight(e.target.value)} placeholder="78" style={inputStyle} />
                    <span style={{ color: '#6b8a72', fontSize: '0.875rem', flexShrink: 0 }}>kg</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div>
                <h2 style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 500, fontSize: '1.5rem', color: '#F5F2EC', marginBottom: 6 }}>
                  How do you train?
                </h2>
                <p style={{ fontSize: '0.875rem', color: '#6b8a72' }}>Remi adjusts macros on training vs rest days.</p>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {REMI_TRAINING_OPTIONS.map(o => {
                  const isNone = o.value === 'none'
                  const sel = isNone ? training.includes('none') : training.includes(o.value)
                  return (
                    <button key={o.value} onClick={() => {
                      if (isNone) { setTraining(['none']); return }
                      const filtered = training.filter(t => t !== 'none')
                      setTraining(sel ? filtered.filter(t => t !== o.value) : [...filtered, o.value])
                    }} style={pillStyle(sel)}>
                      {o.label}
                    </button>
                  )
                })}
              </div>
              <div>
                <label style={labelStyle}>Days per week</label>
                <input type="number" min={0} max={7} value={daysPerWeek} onChange={e => setDaysPerWeek(e.target.value)} placeholder="4" style={inputStyle} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderRadius: 14, backgroundColor: '#0f2318', border: '1px solid #1a3020' }}>
                <span style={{ fontSize: '0.9rem', color: '#c8e0cc', fontFamily: 'DM Sans, sans-serif' }}>
                  {trainingToday ? 'Today is a training day' : 'Today is a rest day'}
                </span>
                <button onClick={() => {
                  const next = !trainingToday
                  setTrainingToday(next)
                  localStorage.setItem('remi_training_today', JSON.stringify(next))
                }} style={{ width: 44, height: 24, borderRadius: 12, backgroundColor: trainingToday ? '#1D9E75' : '#1a3020', position: 'relative', flexShrink: 0, border: 'none', cursor: 'pointer', transition: 'background-color 0.2s' }}>
                  <span style={{ position: 'absolute', top: 2, left: trainingToday ? 22 : 2, width: 20, height: 20, borderRadius: '50%', backgroundColor: '#fff', transition: 'left 0.2s', display: 'block' }} />
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <div>
                <h2 style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 500, fontSize: '1.5rem', color: '#F5F2EC', marginBottom: 6 }}>
                  What's in the fridge?
                </h2>
                <p style={{ fontSize: '0.875rem', color: '#6b8a72' }}>Tell Remi what you've got. He'll handle the rest.</p>
              </div>
              <div>
                <input
                  type="text" value={ingredientInput}
                  onChange={e => setIngredientInput(e.target.value)}
                  onKeyDown={handleIngredientKeyDown}
                  placeholder="chicken, rice, broccoli... (Enter to add)"
                  style={inputStyle}
                />
                <p style={{ fontSize: '0.75rem', color: '#4a6b52', marginTop: 6 }}>Press Enter or comma to add each ingredient</p>
              </div>
              {ingredients.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {ingredients.map((ing, i) => {
                    const c = CLASSIFY_COLORS[ing.type]
                    return (
                      <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px 5px 12px', borderRadius: 20, backgroundColor: '#0f2318', border: `1.5px solid ${c.border}`, fontSize: '0.8125rem', color: '#c8e0cc', fontFamily: 'DM Sans, sans-serif' }}>
                        <span>{ing.name}</span>
                        <span style={{ fontSize: '0.6rem', color: c.text, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{ing.type}</span>
                        <button onClick={() => setIngredients(prev => prev.filter((_, j) => j !== i))} style={{ color: '#4a6b52', cursor: 'pointer', background: 'none', border: 'none', padding: 0, lineHeight: 1, fontSize: '1.1rem' }}>×</button>
                      </span>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-8 space-y-3">
          {step < 3 ? (
            <button onClick={() => { if (canProceed()) setStep(s => s + 1) }} disabled={!canProceed()}
              style={{ width: '100%', backgroundColor: canProceed() ? '#1D9E75' : '#0f2318', color: canProceed() ? '#fff' : '#4a6b52', borderRadius: 14, padding: '14px 0', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, fontSize: '0.9375rem', border: canProceed() ? 'none' : '1px solid #1a3020', cursor: canProceed() ? 'pointer' : 'not-allowed' }}>
              Next →
            </button>
          ) : isLocked ? (
            <>
              <button disabled style={{ width: '100%', backgroundColor: '#0f2318', color: '#4a6b52', borderRadius: 14, padding: '14px 0', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, fontSize: '0.9375rem', border: '1px solid #EF9F27', cursor: 'not-allowed' }}>
                🔒 Kitchen's closed for today
              </button>
              <p style={{ textAlign: 'center', fontSize: '0.75rem', color: '#4a6b52' }}>
                <a href="#" style={{ color: '#EF9F27' }}>Go Pro →</a> to keep cooking
              </p>
            </>
          ) : (
            <button onClick={handleCook} disabled={!canProceed()}
              style={{ width: '100%', backgroundColor: canProceed() ? '#1D9E75' : '#0f2318', color: canProceed() ? '#fff' : '#4a6b52', borderRadius: 14, padding: '14px 0', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, fontSize: '0.9375rem', border: canProceed() ? 'none' : '1px solid #1a3020', cursor: canProceed() ? 'pointer' : 'not-allowed' }}>
              Let him cook 🔥
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Profile complete ───────────────────────────────────────────────────────────

function ProfileComplete({ profile, onEnter }) {
  const [heroUrl, setHeroUrl] = useState(null)

  useEffect(() => {
    fetch('/api/unsplash?query=athlete+meal+prep+food')
      .then(r => r.json())
      .then(d => { if (d.url) setHeroUrl(d.url) })
      .catch(() => {})
  }, [])

  return (
    <div className="animate-fade-in min-h-screen bg-sandy flex flex-col relative overflow-hidden">
      <PaperTexture />
      <div className="relative w-full h-64 sm:h-80 shrink-0 overflow-hidden">
        {heroUrl
          ? <img src={heroUrl} alt="" className="w-full h-full object-cover" />
          : <div className="w-full h-full" style={{ backgroundColor: '#C1683A' }} />
        }
        <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, #EDE0C8 100%)' }} />
      </div>
      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-12 relative z-10 -mt-8">
        <div className="w-full max-w-xs sm:max-w-sm text-center space-y-6">
          <h2 className="font-serif text-3xl sm:text-4xl font-bold text-charcoal leading-snug">
            Ready, {profile.name}.
          </h2>
          <p className="text-charcoal-muted leading-relaxed">
            Let's build meals that work as hard as you do.
          </p>
          <button
            onClick={onEnter}
            className="w-full py-4 rounded-xl font-semibold text-base text-white active:opacity-80 transition-opacity"
            style={{ backgroundColor: '#C1683A', boxShadow: '0 2px 8px rgba(193,104,58,0.35)' }}
          >
            Enter the kitchen →
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Pre-cook confirmation modal ───────────────────────────────────────────────

function PreCookModal({ onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center px-5"
      style={{ backgroundColor: 'rgba(10,26,18,0.92)' }}>
      <div className="w-full max-w-sm p-7 space-y-6 animate-fade-in"
        style={{ backgroundColor: '#0f2318', border: '1px solid #1a3020', borderRadius: 20 }}>
        <h2 style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 500, fontSize: '1.375rem', color: '#F5F2EC' }}>
          Ready to cook?
        </h2>
        <p style={{ fontSize: '0.875rem', color: '#6b8a72', lineHeight: 1.6 }}>
          Make sure you've grabbed everything from the fridge — once Remi starts cooking, your generations reset tomorrow.
        </p>
        <div className="space-y-3">
          <button onClick={onConfirm}
            style={{ width: '100%', backgroundColor: '#1D9E75', color: '#fff', borderRadius: 14, padding: '14px 0', fontFamily: 'DM Sans, sans-serif', fontWeight: 500, fontSize: '0.9375rem', border: 'none', cursor: 'pointer' }}>
            Let's cook
          </button>
          <button onClick={onCancel}
            style={{ width: '100%', backgroundColor: 'transparent', color: '#6b8a72', borderRadius: 14, padding: '12px 0', fontFamily: 'DM Sans, sans-serif', fontSize: '0.875rem', border: '1px solid #1a3020', cursor: 'pointer' }}>
            Wait, I missed something
          </button>
        </div>
      </div>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [messages,       setMessages]       = useState(SEED)
  const [input,          setInput]          = useState('')
  const [streaming,      setStreaming]       = useState(false)
  const [streamContent,  setStreamContent]  = useState('')
  const [awaitingDishes, setAwaitingDishes] = useState(false)
  const [dishes,         setDishes]         = useState(null)
  const [dishImages,     setDishImages]     = useState([])
  const [quickReplyType, setQuickReplyType] = useState('proteins')   // 'proteins'|'cuisine'|'time'|null
  const [profile,        setProfile]        = useState(() => loadProfileOrEvict())
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
  const [view,           setView]           = useState(
    () => loadProfileOrEvict() !== null ? 'chat' : 'welcome'
  )
  const [selectedDish,   setSelectedDish]   = useState(null)
  const [viewingDish,    setViewingDish]    = useState(null)
  const [viewingDishImg, setViewingDishImg] = useState(null)
  const [savedBackTo,         setSavedBackTo]         = useState('cards')
  const [missingIngredients,  setMissingIngredients]  = useState([])
  const [shoppingListCopied,  setShoppingListCopied]  = useState(false)
  const [checkedIngredients,  setCheckedIngredients]  = useState(new Set())
  const [error,               setError]               = useState(null)
  const [showCookModal,       setShowCookModal]       = useState(false)
  const [pendingFridgeMsg,    setPendingFridgeMsg]    = useState('')
  const [genCount,            setGenCount]            = useState(() => {
    const key = 'remi_gens_' + new Date().toISOString().slice(0, 10)
    return parseInt(localStorage.getItem(key) || '0', 10)
  })

  const scrollRef      = useRef(null)
  const abortRef       = useRef(null)
  const inputRef       = useRef(null)
  const sessionDataRef = useRef({ proteins: [], cuisine: '', time: '' })

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

  const displayMessages = messages.filter(m => !(m.seed && m.role === 'user'))

  // ── Core message send ──────────────────────────────────────────────────────

  async function submitMessage(text) {
    if (!text.trim() || streaming) return

    const userMsg      = { id: Date.now(), role: 'user', content: text.trim() }
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
      console.log(`[meals] Sending ${nextMessages.length} messages, profile: ${profile?.name ?? 'null'}`)

      const res = await fetch('/api/meals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-POSTHOG-DISTINCT-ID': posthog.get_distinct_id(),
          'X-POSTHOG-SESSION-ID': posthog.get_session_id() ?? '',
        },
        body: JSON.stringify({ messages: nextMessages.map(({ role, content }) => ({ role, content })), profile: mapProfileForApi(profile) }),
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
              console.log('[debug] raw API response:', accumulated)
              const _ingredients = parseMissingIngredients(accumulated)
              console.log('[shopping] [DONE] path — setting missingIngredients:', _ingredients.length, 'item(s)')
              setMissingIngredients(_ingredients)
              setShoppingListCopied(false)
              setCheckedIngredients(new Set())
              saveSession(parsed)
              posthog.capture('dishes_received', { dish_count: parsed.length, proteins: sessionDataRef.current.proteins })
              const _gKey = 'remi_gens_' + new Date().toISOString().slice(0, 10)
              const _newCount = parseInt(localStorage.getItem(_gKey) || '0', 10) + 1
              localStorage.setItem(_gKey, String(_newCount))
              setGenCount(_newCount)
              setView('cards')
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
          console.log('[meals] Partial parse succeeded —', parsed.length, 'dishes recovered')
          setDishes(parsed)
          setDishImages([])
          console.log('[debug] raw API response:', accumulated)
          const _ingredients2 = parseMissingIngredients(accumulated)
          console.log('[shopping] salvage path — setting missingIngredients:', _ingredients2.length, 'item(s)')
          setMissingIngredients(_ingredients2)
          setShoppingListCopied(false)
          setCheckedIngredients(new Set())
          saveSession(parsed)
          const _gKey2 = 'remi_gens_' + new Date().toISOString().slice(0, 10)
          const _newCount2 = parseInt(localStorage.getItem(_gKey2) || '0', 10) + 1
          localStorage.setItem(_gKey2, String(_newCount2))
          setGenCount(_newCount2)
          setView('cards')
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
        content: 'Something went wrong generating your recipes. Try again — if it keeps happening, start a fresh session.',
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
    sessionDataRef.current = { proteins: [], cuisine: '', time: '' }
    setView('onboarding')
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

  function handleSaveRecipe(dish, imgUrl) {
    const entry = { ...dish, _id: `${dish.name}_${Date.now()}`, _savedAt: Date.now(), _imgUrl: imgUrl ?? null }
    setSavedRecipes(prev => {
      const next = [...prev.filter(r => r.name !== dish.name), entry]
      localStorage.setItem('lhc_saved_recipes', JSON.stringify(next))
      return next
    })
    posthog.capture('recipe_saved', { dish_name: dish.name, cuisine: dish.chef?.cuisine })
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
      'Generated by lethimcook4me.vercel.app',
    ].join('\n')
    navigator.clipboard.writeText(lines).then(() => {
      setShoppingListCopied(true)
      posthog.capture('shopping_list_copied', { item_count: unchecked.length })
      setTimeout(() => setShoppingListCopied(false), 2000)
    })
  }

  // ── View: Welcome ────────────────────────────────────────────────────────────
  if (view === 'welcome') {
    return <WelcomeScreen onStart={() => setView('onboarding')} />
  }

  // ── View: Onboarding ─────────────────────────────────────────────────────────
  if (view === 'onboarding') {
    return (
      <>
        <Onboarding
          initialProfile={profile}
          isLocked={genCount >= 3}
          onBack={() => setView(profile ? 'chat' : 'welcome')}
          onComplete={(remiProfile, fridgeMessage) => {
            const saved = { ...remiProfile, completedAt: Date.now(), version: PROFILE_VERSION }
            localStorage.setItem('remi_profile', JSON.stringify(saved))
            setProfile(saved)
            posthog.identify(posthog.get_distinct_id(), {
              name: remiProfile.name,
              goal: remiProfile.goal,
              training: remiProfile.training,
              days_per_week: remiProfile.daysPerWeek,
            })
            posthog.capture('onboarding_completed', { goal: remiProfile.goal, training: remiProfile.training })
            setPendingFridgeMsg(fridgeMessage || '')
            setShowCookModal(true)
          }}
        />
        {showCookModal && (
          <PreCookModal
            onConfirm={() => {
              setShowCookModal(false)
              submitMessage(pendingFridgeMsg)
            }}
            onCancel={() => setShowCookModal(false)}
          />
        )}
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
        />
        <BottomNav activeView="dashboard" onNavigate={v => {
          if (v === 'saved') { setSavedBackTo('dashboard'); setView('saved') }
          else setView(v)
        }} />
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
        }} />
      </>
    )
  }

  // ── View: Detail ─────────────────────────────────────────────────────────────
  if (view === 'detail' && (selectedDish !== null || viewingDish !== null)) {
    const dish   = viewingDish ?? dishes[selectedDish]
    const imgUrl = viewingDish ? viewingDishImg : (dishImages[selectedDish] ?? null)
    const backTo = viewingDish ? savedBackTo : 'cards'
    const detailIngredients = viewingDish ? [] : missingIngredients
    console.log('[shopping] DetailView — missingIngredients:', detailIngredients.length, 'item(s), viewingDish:', !!viewingDish)
    return (
      <DetailView
        dish={dish}
        onBack={() => { setViewingDish(null); setViewingDishImg(null); setView(backTo) }}
        imgUrl={imgUrl}
        isSaved={isRecipeSaved(dish.name)}
        onSave={() => handleSaveRecipe(dish, imgUrl)}
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
        <div className="animate-fade-in flex h-[100dvh]" style={{ backgroundColor: '#0A1A12' }}>
          {/* Main content */}
          <div className="flex-1 min-w-0 overflow-y-auto px-4 py-10 sm:py-14 pb-20 lg:pb-14" style={{ backgroundColor: '#0A1A12' }}>
            <div className="max-w-3xl mx-auto space-y-8 relative">
              {/* Gen counter + locked banner */}
              {genCount >= 3 ? (
                <div className="rounded-2xl px-5 py-4 flex items-center gap-3" style={{ backgroundColor: '#1a1a00', border: '1px solid #EF9F27' }}>
                  <span style={{ fontSize: '1.25rem' }}>🔒</span>
                  <div className="flex-1">
                    <p style={{ color: '#EF9F27', fontWeight: 600, fontSize: '0.875rem' }}>Kitchen's closed for today</p>
                    <p style={{ color: '#6b8a72', fontSize: '0.75rem', marginTop: 2 }}>You've used all 3 free sessions. Come back tomorrow or upgrade.</p>
                  </div>
                  <button style={{ color: '#EF9F27', fontSize: '0.75rem', fontWeight: 700, whiteSpace: 'nowrap' }}>Go Pro →</button>
                </div>
              ) : (
                <p style={{ color: '#6b8a72', fontSize: '0.75rem', textAlign: 'right' }}>{genCount} of 3 sessions used today</p>
              )}
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="font-sans text-3xl sm:text-4xl font-bold" style={{ color: '#c8e0cc' }}>
                    Your meals
                  </h1>
                  <p style={{ color: '#6b8a72', fontSize: '0.875rem', marginTop: 4 }}>
                    Tap a card to open the full recipe.
                  </p>
                </div>
                {/* Desktop nav buttons only */}
                <div className="hidden sm:flex flex-col gap-2 mt-1.5 shrink-0 items-end">
                  <button
                    onClick={() => setView('dashboard')}
                    className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                    style={{ color: '#6b8a72', border: '1px solid #1a3020' }}
                  >
                    Dashboard
                  </button>
                  <div className="flex gap-2">
                    {savedRecipes.length > 0 && (
                      <button
                        onClick={() => { setSavedBackTo('cards'); setView('saved') }}
                        className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1"
                        style={{ color: '#6b8a72', border: '1px solid #1a3020' }}
                      >
                        My Recipes
                        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: '#1D9E75' }}>
                          {savedRecipes.length}
                        </span>
                      </button>
                    )}
                    <button
                      onClick={handleReset}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                      style={{ color: '#6b8a72', border: '1px solid #1a3020' }}
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
                    onImageResolved={url => setDishImages(prev => {
                      const next = [...prev]; next[i] = url; return next
                    })}
                  />
                ))}
              </div>

              {/* ── What You'll Need ── */}
              {missingIngredients.length > 0 && (
                <div className="space-y-3 animate-fade-in">
                  <p
                    className="text-[11px] font-bold uppercase tracking-widest"
                    style={{ color: '#1D9E75' }}
                  >
                    What You'll Need
                  </p>
                  <div
                    className="rounded-2xl p-5 space-y-4"
                    style={{ backgroundColor: '#0f2318', border: '0.5px solid #1a3020' }}
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
                              color: '#c8e0cc',
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
                                border: '2px solid #1D9E75',
                                backgroundColor: checked ? '#1D9E75' : 'transparent',
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
                            backgroundColor: shoppingListCopied ? '#176f52' : allChecked ? '#1a3020' : '#1D9E75',
                            boxShadow: (shoppingListCopied || allChecked) ? 'none' : '0 2px 8px rgba(29,158,117,0.3)',
                            cursor: allChecked ? 'default' : 'pointer',
                          }}
                        >
                          {shoppingListCopied ? '✓ Copied to clipboard!' : allChecked ? '✓ All picked up' : '🛒 Copy Shopping List'}
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
        }} />
      </>
    )
  }

  // ── View: Loading (streaming dishes) ────────────────────────────────────────
  if (awaitingDishes) {
    return (
      <div className="animate-fade-in min-h-screen flex flex-col items-center justify-center px-6 py-14" style={{ backgroundColor: '#0A1A12' }}>
        <ChefLoader profile={profile} />
      </div>
    )
  }

  // ── View: Chat ───────────────────────────────────────────────────────────────
  return (
    <>
      <div className="animate-fade-in flex relative" style={{ position: 'fixed', inset: 0, backgroundColor: '#0A1A12' }}>

        {/* ── Main chat column ── */}
        <div className="flex flex-col flex-1 min-w-0">

          {/* Header */}
          <div className="shrink-0 px-4 py-3.5 backdrop-blur-sm flex items-center justify-between" style={{ backgroundColor: 'rgba(10,26,18,0.92)', borderBottom: '1px solid #1a3020' }}>
            <div className="flex items-center gap-2.5">
              <RemiLogo size={28} />
              <div>
                <h1 className="font-sans font-bold" style={{ fontSize: 18, color: '#c8e0cc', letterSpacing: '0.01em' }}>Remi</h1>
                <p style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 10, letterSpacing: '0.1em', color: '#1D9E75', textTransform: 'uppercase' }}>Personal Chef · Dietician · Coach</p>
              </div>
            </div>
            {/* Desktop nav only — mobile uses BottomNav */}
            <div className="hidden sm:flex items-center gap-2">
              <button
                onClick={() => setView('dashboard')}
                className="text-xs transition-colors flex items-center gap-1 px-2 py-1 rounded-lg"
                style={{ color: '#6b8a72', border: '1px solid #1a3020' }}
              >
                Dashboard
              </button>
              <button
                onClick={() => setView('onboarding')}
                className="text-xs transition-colors flex items-center gap-1 px-2 py-1 rounded-lg"
                style={{ color: '#6b8a72', border: '1px solid #1a3020' }}
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10 8a2 2 0 100-4 2 2 0 000 4zM10 12a6 6 0 00-5.33 3.235A8.966 8.966 0 0010 18a8.966 8.966 0 005.33-2.765A6 6 0 0010 12z"/>
                </svg>
                {profile?.name ?? 'Profile'}
              </button>
            </div>
          </div>

          {/* Mobile insights strip — only shown below lg breakpoint */}
          <div className="lg:hidden">
            <InsightsMobileStrip />
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-3 relative z-10 pb-20 lg:pb-5">
            {displayMessages.map(msg => (
              <ChatBubble key={msg.id} role={msg.role} content={msg.content} userName={profile?.name} />
            ))}
            {streaming && streamContent && (
              <ChatBubble role="assistant" content={streamContent} isStreaming userName={profile?.name} />
            )}
            {streaming && !streamContent && <TypingIndicator />}
            <div className="h-2" />
          </div>

          {/* Error banner */}
          {error && (
            <div className="shrink-0 mx-4 mb-2 rounded-xl border border-terracotta/30 bg-terracotta-pale px-4 py-2.5 text-xs text-terracotta relative z-10">
              {error}
            </div>
          )}

          {/* Quick reply area */}
          {quickReplyType && !streaming && (
            <div className="shrink-0 px-4 pt-3 pb-2 relative z-10" style={{ borderTop: '1px solid #1a3020', backgroundColor: '#0f2318' }}>
              <QuickReplyRow
                type={quickReplyType}
                onSubmit={(text, data) => handleQuickReply(text, data, quickReplyType)}
                onDismiss={() => setQuickReplyType(null)}
                onFocusInput={() => setTimeout(() => inputRef.current?.focus(), 50)}
              />
            </div>
          )}

          {/* Input bar */}
          <div className="shrink-0 px-4 pt-2.5 pb-3 relative z-10" style={{ borderTop: '1px solid #1a3020', backgroundColor: '#0f2318', touchAction: 'manipulation' }}>
            <form onSubmit={handleSubmit} className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
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
                className="flex-1 rounded-2xl px-4 py-3 focus:outline-none disabled:opacity-50 transition leading-snug"
                style={{ fontSize: 16, minHeight: 44, maxHeight: 120, resize: 'none', overflowY: 'auto', backgroundColor: '#132b1a', border: '1px solid #1a3020', color: '#c8e0cc' }}
              />
              {streaming ? (
                <button
                  type="button"
                  onClick={handleStop}
                  style={{ backgroundColor: '#1D9E75', width: 44, height: 44, flexShrink: 0 }}
                  className="flex items-center justify-center rounded-full text-white text-xs font-semibold active:opacity-80 transition-opacity"
                  aria-label="Stop"
                >
                  ■
                </button>
              ) : (
                <button
                  type="submit"
                  style={{
                    backgroundColor: input.trim() ? '#1D9E75' : '#1a3020',
                    width: 44,
                    height: 44,
                    flexShrink: 0,
                    transition: 'background-color 0.15s',
                  }}
                  className="flex items-center justify-center rounded-full text-white active:opacity-80"
                  aria-label="Send"
                >
                  <svg viewBox="0 0 24 24" fill="white" className="w-5 h-5" style={{ marginLeft: 2 }}>
                    <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
                  </svg>
                </button>
              )}
            </form>
          </div>

          {/* Spacer — on mobile, reserves height for the fixed BottomNav so it
              never overlaps the input bar. Height = BottomNav (56px) + iOS safe area. */}
          <div
            className="shrink-0 lg:hidden"
            style={{ height: 'calc(56px + env(safe-area-inset-bottom, 0px))' }}
          />
        </div>

        {/* Desktop insights sidebar */}
        <InsightsDesktopSidebar />
      </div>

      {/* Mobile bottom nav */}
      <BottomNav activeView="chat" onNavigate={v => {
        if (v === 'saved') { setSavedBackTo('chat'); setView('saved') }
        else setView(v)
      }} />
    </>
  )
}
