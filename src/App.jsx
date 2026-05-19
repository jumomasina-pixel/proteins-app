import { useState, useRef, useEffect, useMemo } from 'react'

// ── Storage versioning ────────────────────────────────────────────────────────
// Bump this number whenever the stored data shape changes in a breaking way.
// Any existing storage that doesn't carry a matching version will be wiped and
// the user will restart from the welcome screen as a new user.

const PROFILE_VERSION = 4

const LS_KEYS = ['lhc_profile', 'lhc_saved_recipes', 'lhc_sessions', 'lhc_streak', 'lhc_stats']

function loadProfileOrEvict() {
  try {
    const raw = localStorage.getItem('lhc_profile')
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

// ── Seed conversation ─────────────────────────────────────────────────────────

const SEED = [
  { id: 'seed-u', role: 'user',      content: 'I want meal ideas', seed: true },
  { id: 'seed-a', role: 'assistant', content: 'What proteins do you have on hand right now?', seed: true },
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

// ── Onboarding option constants ───────────────────────────────────────────────

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
        backgroundColor: '#FAF6EE',
        borderTop: '1px solid #C8B090',
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
            style={{ color: active ? '#C1683A' : '#7A6548' }}
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
    <div
      className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-base select-none"
      style={{ backgroundColor: '#FDF0E8', border: '1.5px solid #C8B090' }}
      aria-hidden
    >
      🧑‍🍳
    </div>
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
              backgroundColor: '#FAF6EE',
              color: '#1A1108',
              borderLeft: '3px solid #C1683A',
              borderRadius: '0 16px 16px 16px',
              boxShadow: '0 1px 6px rgba(26,17,8,0.07)',
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
        style={{ backgroundColor: '#FAF6EE', borderLeft: '3px solid #C1683A', borderRadius: '0 16px 16px 16px', boxShadow: '0 1px 6px rgba(26,17,8,0.07)' }}
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
    backgroundColor: sel ? '#FDF0E8' : '#FAF6EE',
    borderColor:     sel ? '#C1683A' : '#C8B090',
    color:           sel ? '#C1683A' : '#4A3728',
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
    function toggle(val) {
      setSelected(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])
    }
    function handleSubmit() {
      if (selected.length === 0) return
      const list = selected.length === 1
        ? selected[0]
        : selected.slice(0, -1).join(', ') + ' and ' + selected[selected.length - 1]
      onSubmit(`I've got ${list}`, selected)
    }
    return (
      <div className="space-y-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-charcoal-muted">Select your proteins</p>
        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
          {PROTEIN_CARDS.map(card => (
            <button
              key={card.value}
              onClick={() => toggle(card.value)}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-full border text-sm font-medium transition-all"
              style={chipStyle(selected.includes(card.value))}
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
              Use {selected.length > 1 ? `these ${selected.length} proteins` : 'this protein'} →
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
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-full border text-sm font-medium transition-all active:scale-95"
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
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-full border text-sm font-medium transition-all active:scale-95"
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
  const savings = calorieSavings(dish)
  return (
    <button
      onClick={onClick}
      className="w-full rounded-2xl bg-cream shadow-card overflow-hidden text-left transition-all duration-200 hover:-translate-y-1.5 hover:shadow-card-hover group"
    >
      <CardImageHeader dishName={dish.name} cuisine={dish.chef.cuisine} onImageResolved={onImageResolved} />

      <div className="px-5 pb-5 pt-4 space-y-3">
        {/* Calorie count */}
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-bold tabular-nums" style={{ color: '#C1683A' }}>
            {dish.dietician.macros.calories}
          </span>
          <span className="text-sm text-charcoal-muted">kcal</span>
        </div>

        {/* Cook time + difficulty badges */}
        {(dish.dietician.cookTime !== '—' || dish.dietician.difficulty) && (
          <div className="flex gap-2 flex-wrap">
            {dish.dietician.cookTime !== '—' && (
              <span
                className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full"
                style={{ backgroundColor: '#FAF3E4', border: '1px solid #C8B090', color: '#4A3728' }}
              >
                <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                {dish.dietician.cookTime} mins
              </span>
            )}
            {dish.dietician.difficulty && (
              <span
                className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full"
                style={{ backgroundColor: '#FAF3E4', border: '1px solid #C8B090', color: '#4A3728' }}
              >
                <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2c0 0-6 6-6 12a6 6 0 0012 0c0-6-6-12-6-12zm0 16a2 2 0 110-4 2 2 0 010 4z"/>
                </svg>
                {dish.dietician.difficulty}
              </span>
            )}
          </div>
        )}

        {/* Calorie savings badge */}
        {savings && (
          <div className="inline-flex items-center gap-1.5 text-xs font-medium text-sage-dark bg-sage-pale rounded-full px-3 py-1 border border-sage/25">
            💪 Save ~{savings} kcal vs restaurant
          </div>
        )}

        <div className="pt-1 text-sm font-medium text-terracotta flex items-center gap-1.5 group-hover:gap-3 transition-all duration-200">
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

function DetailView({ dish, onBack, imgUrl, isSaved, onSave, onRemove, onNavigateDashboard }) {
  const [mode,   setMode]   = useState('diet')
  const [copied, setCopied] = useState(false)
  const [toast,  setToast]  = useState({ visible: false, message: '', action: null })
  const { chef, dietician } = dish

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

const WELCOME_VALUE_PROPS = [
  { icon: '⚡', text: 'Built around what you actually have'        },
  { icon: '🎯', text: 'Personalised to your body and your goals'   },
  { icon: '🍽️', text: 'Chef quality. Dietician approved.'          },
]

// Keyframe styles injected once for welcome-screen animations
const WELCOME_STYLES = `
  @keyframes ctaPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(193,104,58,0); }
    50%       { box-shadow: 0 0 0 10px rgba(193,104,58,0.18); }
  }
  .cta-pulse { animation: ctaPulse 2.4s ease-in-out 0.8s 3; }
  @keyframes taglineFadeIn {
    from { opacity: 0; transform: translateY(14px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .tagline-enter { animation: taglineFadeIn 0.4s ease-out both; }
  @keyframes propFadeIn {
    from { opacity: 0; transform: translateX(-8px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  .prop-enter-0 { animation: propFadeIn 0.35s ease-out 0.05s both; }
  .prop-enter-1 { animation: propFadeIn 0.35s ease-out 0.15s both; }
  .prop-enter-2 { animation: propFadeIn 0.35s ease-out 0.25s both; }
`

function WelcomeScreen({ onStart }) {
  const [heroUrl,    setHeroUrl]    = useState(null)
  const [imgLoaded,  setImgLoaded]  = useState(false)
  const [showBelow,  setShowBelow]  = useState(false)

  useEffect(() => {
    fetch('/api/unsplash?query=meal+prep+athlete+kitchen+dark+moody')
      .then(r => r.json())
      .then(d => { if (d.url) setHeroUrl(d.url) })
      .catch(() => {})
  }, [])

  // Reveal content below the hero once image is loaded (or after 1.2s fallback)
  useEffect(() => {
    const t = setTimeout(() => setShowBelow(true), 1200)
    return () => clearTimeout(t)
  }, [])

  function handleImgLoad() {
    setImgLoaded(true)
    setShowBelow(true)
  }

  return (
    <div className="min-h-screen flex flex-col relative overflow-x-hidden" style={{ backgroundColor: '#1A1108' }}>
      <style>{WELCOME_STYLES}</style>
      <PaperTexture />

      {/* ── Hero image — full bleed, no rounded corners ── */}
      <div
        className="relative w-full shrink-0 overflow-hidden"
        style={{ height: 'clamp(45vh, 50vw, 55vh)' }}
      >
        {/* Warm dark placeholder */}
        <div
          className="absolute inset-0"
          style={{ backgroundColor: '#2A1A0E' }}
        />

        {heroUrl && (
          <img
            src={heroUrl}
            alt=""
            onLoad={handleImgLoad}
            className="absolute inset-0 w-full h-full object-cover transition-opacity duration-700"
            style={{ opacity: imgLoaded ? 1 : 0 }}
          />
        )}

        {/* Gradient — warm sandy fade at bottom */}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(to bottom, rgba(26,17,8,0.25) 0%, rgba(26,17,8,0.05) 30%, rgba(26,17,8,0.7) 75%, #1A1108 100%)',
          }}
        />

        {/* Wordmark sits at the top of the hero */}
        <div className="absolute top-0 left-0 right-0 px-6 pt-10 sm:pt-14 text-center">
          <h1
            className="font-serif font-extrabold leading-none text-white"
            style={{
              fontSize: 'clamp(2.6rem, 9vw, 4rem)',
              letterSpacing: '0.03em',
              textShadow: '0 2px 20px rgba(0,0,0,0.55)',
            }}
          >
            Let Him Cook
          </h1>
          <p
            className="mt-2 font-sans text-white/55 tracking-[0.22em]"
            style={{ fontSize: '0.6rem', fontWeight: 600, textTransform: 'uppercase' }}
          >
            Personal Chef · Dietician · Coach
          </p>
        </div>
      </div>

      {/* ── Content below hero ── */}
      <div
        className="flex-1 flex flex-col px-6 pb-10 pt-8 sm:pb-14"
        style={{
          backgroundColor: '#1A1108',
          opacity: showBelow ? 1 : 0,
          transition: 'opacity 0.35s ease-out',
        }}
      >
        <div className="w-full max-w-sm mx-auto flex flex-col gap-8">

          {/* ── Tagline block ── */}
          <div className={`text-center space-y-3 ${showBelow ? 'tagline-enter' : ''}`}>
            <h2
              className="font-serif font-bold text-white leading-tight"
              style={{ fontSize: 'clamp(1.5rem, 5.5vw, 2rem)' }}
            >
              Eat like a chef.<br />
              Train like an athlete.<br />
              Live like both.
            </h2>
            <p className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.50)' }}>
              Your proteins. Your goals. Three dishes — lean or indulgent — in seconds.
            </p>
          </div>

          {/* ── Value props ── */}
          <div className="space-y-3">
            {WELCOME_VALUE_PROPS.map(({ icon, text }, i) => (
              <div
                key={text}
                className={`flex items-center gap-4 prop-enter-${i}`}
              >
                <span
                  className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-base"
                  style={{ backgroundColor: 'rgba(193,104,58,0.15)', border: '1px solid rgba(193,104,58,0.3)' }}
                >
                  {icon}
                </span>
                <span
                  className="text-sm font-medium leading-snug"
                  style={{ color: 'rgba(255,255,255,0.80)' }}
                >
                  {text}
                </span>
              </div>
            ))}
          </div>

          {/* ── Social proof ── */}
          <p
            className="text-center italic"
            style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.32)', lineHeight: 1.6 }}
          >
            — Trusted by athletes, home cooks, and everyone in between
          </p>

          {/* ── CTA ── */}
          <div className="space-y-3">
            <button
              onClick={onStart}
              className="cta-pulse w-full py-4 rounded-xl font-bold text-base text-white transition-opacity active:opacity-80"
              style={{
                backgroundColor: '#C1683A',
                fontSize: '1rem',
                letterSpacing: '0.01em',
              }}
            >
              Build My Profile →
            </button>
            <p
              className="text-center"
              style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.30)', letterSpacing: '0.04em' }}
            >
              Free · No account needed · Takes 2 minutes
            </p>
          </div>

        </div>
      </div>
    </div>
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

// ── Onboarding ────────────────────────────────────────────────────────────────

const EMPTY_PROFILE = {
  name: '', weight: '', goals: [], goalAmount: '',
  trainingFreq: '', trainingTypes: [], avoidFoods: '', kitchenLevel: '',
}

function Onboarding({ initialProfile, onComplete, onBack }) {
  const [step, setStep]       = useState(1)
  const [profile, setProfile] = useState({ ...EMPTY_PROFILE, ...initialProfile })

  // Only show step 4 (how much to lose) when fat-loss is one of the selected goals
  const skipStep4  = !(profile.goals ?? []).includes('lose')
  const stepList   = skipStep4 ? [1,2,3,5,6,7,8] : [1,2,3,4,5,6,7,8]
  const stepIndex  = stepList.indexOf(step)
  const totalSteps = stepList.length
  const displayNum = stepIndex + 1

  function set(field, value) { setProfile(p => ({ ...p, [field]: value })) }

  function goNext() {
    const ni = stepIndex + 1
    if (ni >= stepList.length) { onComplete(profile); return }
    setStep(stepList[ni])
  }
  function goBack() {
    const pi = stepIndex - 1
    if (pi < 0) { onBack?.(); return }
    setStep(stepList[pi])
  }

  function canProceed() {
    if (step === 1) return profile.name.trim().length > 0
    if (step === 2) return String(profile.weight).trim().length > 0
    if (step === 3) return (profile.goals ?? []).length > 0
    if (step === 4) return String(profile.goalAmount).trim().length > 0
    if (step === 5) return profile.trainingFreq !== ''
    if (step === 6) return profile.trainingTypes.length > 0
    if (step === 7) return true
    if (step === 8) return profile.kitchenLevel !== ''
    return true
  }

  const isLast   = stepIndex === totalSteps - 1
  const btnLabel = isLast ? 'Build my profile →'
                 : (step === 7 && !profile.avoidFoods) ? 'Skip →'
                 : 'Next →'

  const cardStyle = (selected) => ({
    backgroundColor: selected ? '#FDF0E8' : '#FAF6EE',
    borderColor:     selected ? '#C1683A' : '#C8B090',
    color:           '#1A1108',
  })

  function renderStep() {
    switch (step) {
      case 1: return (
        <div className="space-y-4">
          <h2 className="font-serif text-2xl sm:text-3xl font-bold text-charcoal">What's your name?</h2>
          <input autoFocus type="text" value={profile.name}
            onChange={e => set('name', e.target.value)}
            onKeyDown={e => e.key === 'Enter' && canProceed() && goNext()}
            placeholder="First name"
            className="w-full rounded-xl bg-cream border border-sandy-border px-5 py-3.5 text-charcoal text-base focus:outline-none focus:border-terracotta transition"
          />
        </div>
      )
      case 2: return (
        <div className="space-y-4">
          <h2 className="font-serif text-2xl sm:text-3xl font-bold text-charcoal">What's your current weight?</h2>
          <div className="flex items-center gap-3">
            <input autoFocus type="number" value={profile.weight}
              onChange={e => set('weight', e.target.value)}
              onKeyDown={e => e.key === 'Enter' && canProceed() && goNext()}
              placeholder="85"
              className="flex-1 rounded-xl bg-cream border border-sandy-border px-5 py-3.5 text-charcoal text-base focus:outline-none focus:border-terracotta transition"
            />
            <span className="font-medium text-charcoal-muted">kg</span>
          </div>
        </div>
      )
      case 3: return (
        <div className="space-y-4">
          <h2 className="font-serif text-2xl sm:text-3xl font-bold text-charcoal">What are your goals?</h2>
          <p className="text-sm text-charcoal-muted">Select all that apply</p>
          <div className="space-y-2.5">
            {GOAL_OPTIONS.map(o => {
              const sel = (profile.goals ?? []).includes(o.value)
              return (
                <button
                  key={o.value}
                  onClick={() => {
                    const current = profile.goals ?? []
                    set('goals', sel ? current.filter(v => v !== o.value) : [...current, o.value])
                  }}
                  className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl border-2 text-left font-medium transition-all"
                  style={cardStyle(sel)}
                >
                  <span className="text-2xl leading-none shrink-0">{o.emoji}</span>
                  <span>{o.label}</span>
                  {sel && (
                    <span className="ml-auto shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-white text-xs"
                      style={{ backgroundColor: '#C1683A' }}>✓</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )
      case 4: return (
        <div className="space-y-4">
          <h2 className="font-serif text-2xl sm:text-3xl font-bold text-charcoal">
            How much fat do you want to lose?
          </h2>
          <div className="flex items-center gap-3">
            <input autoFocus type="number" value={profile.goalAmount}
              onChange={e => set('goalAmount', e.target.value)}
              onKeyDown={e => e.key === 'Enter' && canProceed() && goNext()}
              placeholder="10"
              className="flex-1 rounded-xl bg-cream border border-sandy-border px-5 py-3.5 text-charcoal text-base focus:outline-none focus:border-terracotta transition"
            />
            <span className="font-medium text-charcoal-muted">kg</span>
          </div>
        </div>
      )
      case 5: return (
        <div className="space-y-4">
          <h2 className="font-serif text-2xl sm:text-3xl font-bold text-charcoal">How often do you train?</h2>
          <div className="space-y-3">
            {FREQ_OPTIONS.map(o => (
              <button key={o.value} onClick={() => set('trainingFreq', o.value)}
                className="w-full px-5 py-4 rounded-2xl border-2 text-left font-medium transition-all"
                style={cardStyle(profile.trainingFreq === o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )
      case 6: return (
        <div className="space-y-4">
          <h2 className="font-serif text-2xl sm:text-3xl font-bold text-charcoal">What type of training?</h2>
          <p className="text-sm text-charcoal-muted">Select all that apply</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {TRAINING_TYPES.map(({ value, label, emoji }) => {
              const sel = profile.trainingTypes.includes(value)
              return (
                <button key={value}
                  onClick={() => {
                    if (value === 'None') { set('trainingTypes', sel ? [] : ['None']); return }
                    const filtered = profile.trainingTypes.filter(t => t !== 'None')
                    set('trainingTypes', sel ? filtered.filter(t => t !== value) : [...filtered, value])
                  }}
                  className="flex items-center gap-2 px-3 py-3 rounded-xl border-2 text-sm font-medium transition-all text-left"
                  style={{ backgroundColor: sel ? '#FDF0E8' : '#FAF6EE', borderColor: sel ? '#C1683A' : '#C8B090', color: sel ? '#C1683A' : '#4A3728' }}
                >
                  <span className="text-lg leading-none shrink-0">{emoji}</span>
                  <span className="leading-snug">{label}</span>
                </button>
              )
            })}
          </div>
        </div>
      )
      case 7: return (
        <div className="space-y-4">
          <h2 className="font-serif text-2xl sm:text-3xl font-bold text-charcoal">Any foods you avoid?</h2>
          <p className="text-sm text-charcoal-muted">Optional — leave blank to skip</p>
          <textarea autoFocus rows={3} value={profile.avoidFoods}
            onChange={e => set('avoidFoods', e.target.value)}
            placeholder="e.g. dairy, gluten, shellfish…"
            className="w-full rounded-xl bg-cream border border-sandy-border px-5 py-3.5 text-charcoal text-sm focus:outline-none focus:border-terracotta transition resize-none"
          />
        </div>
      )
      case 8: return (
        <div className="space-y-4">
          <h2 className="font-serif text-2xl sm:text-3xl font-bold text-charcoal">How comfortable are you in the kitchen?</h2>
          <div className="space-y-3">
            {KITCHEN_OPTIONS.map(o => (
              <button key={o.value} onClick={() => set('kitchenLevel', o.value)}
                className="w-full px-5 py-4 rounded-2xl border-2 text-left font-medium transition-all"
                style={cardStyle(profile.kitchenLevel === o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )
      default: return null
    }
  }

  return (
    <div className="animate-fade-in min-h-screen bg-sandy flex flex-col px-6 py-8 relative">
      <PaperTexture />
      <div className="relative z-10 w-full max-w-sm mx-auto flex flex-col" style={{ minHeight: 'calc(100dvh - 4rem)' }}>

        {/* Progress header */}
        <div className="flex items-center gap-4 mb-10">
          <button onClick={goBack} className="text-charcoal-muted hover:text-charcoal transition-colors p-1">
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd"/>
            </svg>
          </button>
          <div className="flex-1 flex items-center gap-3">
            <div className="flex gap-1.5 flex-1">
              {stepList.map((s, idx) => (
                <div key={s} className="h-1.5 rounded-full transition-all duration-300"
                  style={{ flex: idx === stepIndex ? 2 : 1, backgroundColor: idx <= stepIndex ? '#C1683A' : '#C8B090' }}
                />
              ))}
            </div>
            <span className="text-xs text-charcoal-muted shrink-0 tabular-nums">{displayNum} / {totalSteps}</span>
          </div>
        </div>

        {/* Step */}
        <div className="flex-1">{renderStep()}</div>

        {/* Next */}
        <div className="mt-8">
          <button onClick={goNext} disabled={!canProceed()}
            className="w-full py-4 rounded-xl font-semibold text-base text-white transition-opacity"
            style={{ backgroundColor: '#C1683A', opacity: canProceed() ? 1 : 0.4, boxShadow: canProceed() ? '0 2px 8px rgba(193,104,58,0.35)' : 'none' }}
          >
            {btnLabel}
          </button>
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
  const [savedBackTo,    setSavedBackTo]    = useState('cards')
  const [error,          setError]          = useState(null)

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

    try {
      const res = await fetch('/api/meals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: nextMessages.map(({ role, content }) => ({ role, content })), profile }),
        signal: abortRef.current.signal,
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || `Server error ${res.status}`)
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
            const parsed = parseDishes(accumulated)
            if (parsed.length > 0) {
              setDishes(parsed)
              setDishImages([])
              saveSession(parsed)
              setView('cards')
            } else {
              setMessages(prev => [...prev, { id: Date.now(), role: 'assistant', content: accumulated }])
              const nextType = detectQuickReplyType(accumulated)
              setQuickReplyType(nextType)
            }
            break outer
          }

          try {
            const { text: chunk, error: chunkErr } = JSON.parse(payload)
            if (chunkErr) throw new Error(chunkErr)
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
          } catch { /* skip malformed SSE chunk */ }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message)
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
    setMessages(SEED)
    setDishes(null)
    setDishImages([])
    setView('chat')
    setSelectedDish(null)
    setViewingDish(null)
    setViewingDishImg(null)
    setError(null)
    setInput('')
    setQuickReplyType('proteins')
    sessionDataRef.current = { proteins: [], cuisine: '', time: '' }
    setTimeout(() => inputRef.current?.focus(), 50)
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
  }

  function handleRemoveRecipe(nameOrId) {
    setSavedRecipes(prev => {
      const next = prev.filter(r => r._id !== nameOrId && r.name !== nameOrId)
      localStorage.setItem('lhc_saved_recipes', JSON.stringify(next))
      return next
    })
  }

  function isRecipeSaved(dishName) {
    return savedRecipes.some(r => r.name === dishName)
  }

  // ── View: Welcome ────────────────────────────────────────────────────────────
  if (view === 'welcome') {
    return <WelcomeScreen onStart={() => setView('onboarding')} />
  }

  // ── View: Onboarding ─────────────────────────────────────────────────────────
  if (view === 'onboarding') {
    return (
      <Onboarding
        initialProfile={profile}
        onBack={() => setView(profile ? 'chat' : 'welcome')}
        onComplete={p => {
          const saved = { ...p, completedAt: Date.now(), version: PROFILE_VERSION }
          localStorage.setItem('lhc_profile', JSON.stringify(saved))
          setProfile(saved)
          setView(profile ? 'chat' : 'profile-complete')
        }}
      />
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
    return (
      <DetailView
        dish={dish}
        onBack={() => { setViewingDish(null); setViewingDishImg(null); setView(backTo) }}
        imgUrl={imgUrl}
        isSaved={isRecipeSaved(dish.name)}
        onSave={() => handleSaveRecipe(dish, imgUrl)}
        onRemove={() => handleRemoveRecipe(dish.name)}
        onNavigateDashboard={() => setView('dashboard')}
      />
    )
  }

  // ── View: Cards ──────────────────────────────────────────────────────────────
  if (view === 'cards' && dishes) {
    return (
      <>
        <div className="animate-fade-in flex h-[100dvh] bg-sandy">
          <PaperTexture />
          {/* Main content */}
          <div className="flex-1 min-w-0 overflow-y-auto px-4 py-10 sm:py-14 pb-20 lg:pb-14">
            <div className="max-w-3xl mx-auto space-y-8 relative">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="font-serif text-4xl sm:text-5xl font-extrabold tracking-wider text-charcoal">
                    Let Him Cook
                  </h1>
                  <p className="text-charcoal-muted text-sm mt-1.5">
                    Tap a card to open the full recipe.
                  </p>
                </div>
                {/* Desktop nav buttons only */}
                <div className="hidden sm:flex flex-col gap-2 mt-1.5 shrink-0 items-end">
                  <button
                    onClick={() => setView('dashboard')}
                    className="text-xs font-medium text-charcoal-muted hover:text-terracotta border border-sandy-border hover:border-terracotta/40 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    Dashboard
                  </button>
                  <div className="flex gap-2">
                    {savedRecipes.length > 0 && (
                      <button
                        onClick={() => { setSavedBackTo('cards'); setView('saved') }}
                        className="text-xs font-medium text-charcoal-muted hover:text-terracotta border border-sandy-border hover:border-terracotta/40 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1"
                      >
                        My Recipes
                        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: '#C1683A' }}>
                          {savedRecipes.length}
                        </span>
                      </button>
                    )}
                    <button
                      onClick={handleReset}
                      className="text-xs font-medium text-charcoal-muted hover:text-terracotta border border-sandy-border hover:border-terracotta/40 px-3 py-1.5 rounded-lg transition-colors"
                    >
                      Start over
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                {dishes.map((dish, i) => (
                  <DishCard
                    key={i}
                    dish={dish}
                    onClick={() => { setSelectedDish(i); setView('detail') }}
                    onImageResolved={url => setDishImages(prev => {
                      const next = [...prev]; next[i] = url; return next
                    })}
                  />
                ))}
              </div>
            </div>
          </div>
          {/* Desktop insights sidebar */}
          <InsightsSidebar />
        </div>
        <BottomNav activeView="cards" onNavigate={v => {
          if (v === 'saved') { setSavedBackTo('cards'); setView('saved') }
          else if (v === 'chat') handleReset()
          else setView(v)
        }} />
      </>
    )
  }

  // ── View: Skeleton (streaming dishes) ───────────────────────────────────────
  if (awaitingDishes) {
    return (
      <div className="animate-fade-in min-h-screen bg-sandy px-4 py-10 sm:py-14">
        <PaperTexture />
        <div className="max-w-3xl mx-auto space-y-8 relative">
          <div>
            <h1 className="font-serif text-4xl sm:text-5xl font-extrabold tracking-wider text-charcoal">
              Let Him Cook
            </h1>
            <p className="text-charcoal-muted text-sm mt-1.5">
              Building 3 high-protein recipes just for you…
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {[0, 1, 2].map(i => <SkeletonCard key={i} />)}
          </div>
        </div>
      </div>
    )
  }

  // ── View: Chat ───────────────────────────────────────────────────────────────
  return (
    <>
      <div className="animate-fade-in flex h-[100dvh] bg-sandy relative">
        <PaperTexture />

        {/* ── Main chat column ── */}
        <div className="flex flex-col flex-1 min-w-0">

          {/* Header */}
          <div className="shrink-0 px-4 py-3.5 border-b border-sandy-border bg-sandy-light/80 backdrop-blur-sm flex items-center justify-between">
            <h1 className="font-serif text-xl font-extrabold tracking-wider text-charcoal">Let Him Cook</h1>
            {/* Desktop nav only — mobile uses BottomNav */}
            <div className="hidden sm:flex items-center gap-2">
              <button
                onClick={() => setView('dashboard')}
                className="text-xs text-charcoal-muted hover:text-terracotta transition-colors flex items-center gap-1 px-2 py-1 rounded-lg border border-transparent hover:border-sandy-border"
              >
                Dashboard
              </button>
              <button
                onClick={() => setView('onboarding')}
                className="text-xs text-charcoal-muted hover:text-terracotta transition-colors flex items-center gap-1"
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
            <div className="shrink-0 border-t border-sandy-border px-4 pt-3 pb-2 bg-sandy-light relative z-10">
              <QuickReplyRow
                type={quickReplyType}
                onSubmit={(text, data) => handleQuickReply(text, data, quickReplyType)}
                onDismiss={() => setQuickReplyType(null)}
                onFocusInput={() => setTimeout(() => inputRef.current?.focus(), 50)}
              />
            </div>
          )}

          {/* Input bar */}
          <div className="shrink-0 border-t border-sandy-border px-4 pt-2.5 pb-3 bg-sandy-light relative z-10">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-charcoal-muted mb-1.5">Your answer</p>
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
                placeholder="Type here or tap an option above..."
                rows={1}
                disabled={streaming}
                className="flex-1 rounded-2xl bg-cream border border-sandy-border px-4 py-3 text-charcoal placeholder-charcoal-muted/70 focus:outline-none focus:ring-2 focus:ring-terracotta/30 focus:border-terracotta disabled:opacity-50 transition leading-snug"
                style={{ fontSize: 16, minHeight: 44, maxHeight: 120, resize: 'none', overflowY: 'auto' }}
              />
              {streaming ? (
                <button
                  type="button"
                  onClick={handleStop}
                  style={{ backgroundColor: '#C1683A', width: 44, height: 44, flexShrink: 0 }}
                  className="flex items-center justify-center rounded-full text-white text-xs font-semibold active:opacity-80 transition-opacity"
                  aria-label="Stop"
                >
                  ■
                </button>
              ) : (
                <button
                  type="submit"
                  style={{
                    backgroundColor: input.trim() ? '#C1683A' : '#C8B090',
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
