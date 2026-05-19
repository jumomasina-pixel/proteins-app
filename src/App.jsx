import { useState, useRef, useEffect } from 'react'

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
  { value: 'lose',     label: 'Lose fat',             emoji: '🔥' },
  { value: 'build',    label: 'Build muscle',          emoji: '💪' },
  { value: 'maintain', label: 'Maintain & eat better', emoji: '🥗' },
]
const FREQ_OPTIONS = [
  { value: 'rarely', label: 'Rarely or never' },
  { value: '1-2x',   label: '1–2x a week'    },
  { value: '3-4x',   label: '3–4x a week'    },
  { value: '5-6x',   label: '5–6x a week'    },
]
const TRAINING_TYPES = ['Weights', 'Cardio', 'Boxing', 'Running', 'Sport', 'None']
const KITCHEN_OPTIONS = [
  { value: 'beginner',    label: 'Beginner'         },
  { value: 'home cook',   label: 'Home cook'        },
  { value: 'confident',   label: 'Pretty confident' },
]

// ── Avatars ───────────────────────────────────────────────────────────────────

function ChefAvatar() {
  return (
    <div
      className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-base select-none"
      style={{ backgroundColor: '#FDF0E8', border: '1.5px solid #D4B896' }}
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
        backgroundColor: '#FFFDF7',
        borderTop: '4px solid #C1683A',
        boxShadow: '0 2px 12px rgba(44,36,22,0.07), 0 1px 3px rgba(44,36,22,0.05)',
      }}
    >
      {/* cuisine badge */}
      <div className="h-5 w-20 rounded-full" style={{ backgroundColor: SHIMMER }} />
      {/* dish name */}
      <div className="space-y-2.5">
        <div className="h-6 w-4/5 rounded-lg" style={{ backgroundColor: SHIMMER }} />
        <div className="h-4 w-3/5 rounded-lg" style={{ backgroundColor: SHIMMER, opacity: 0.7 }} />
      </div>
      {/* calorie number */}
      <div className="h-9 w-20 rounded-lg" style={{ backgroundColor: SHIMMER }} />
      {/* savings badge */}
      <div className="h-5 w-40 rounded-full" style={{ backgroundColor: SHIMMER, opacity: 0.7 }} />
      {/* view recipe link */}
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
              backgroundColor: '#FFFDF7',
              color: '#2C2416',
              borderLeft: '3px solid #C1683A',
              borderRadius: '0 16px 16px 16px',
              boxShadow: '0 1px 6px rgba(44,36,22,0.07)',
            }
        }
      >
        {content}
        {isStreaming && (
          <span className="inline-block w-1.5 h-4 ml-0.5 animate-pulse align-text-bottom rounded-sm" style={{ backgroundColor: '#8B7355', opacity: 0.5 }} />
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
        style={{ backgroundColor: '#FFFDF7', borderLeft: '3px solid #C1683A', borderRadius: '0 16px 16px 16px', boxShadow: '0 1px 6px rgba(44,36,22,0.07)' }}
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
                style={{ backgroundColor: '#FAF3E4', border: '1px solid #D4B896', color: '#5C4A2A' }}
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
                style={{ backgroundColor: '#FAF3E4', border: '1px solid #D4B896', color: '#5C4A2A' }}
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

// Bookmark SVG icons
function BookmarkIcon({ filled }) {
  return filled
    ? <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6.75 2.25A.75.75 0 016 3v18a.75.75 0 001.28.53L12 17.31l4.72 4.22A.75.75 0 0018 21V3a.75.75 0 00-.75-.75H6.75z"/></svg>
    : <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path strokeLinecap="round" strokeLinejoin="round" d="M17.25 3H6.75A.75.75 0 006 3.75v16.5a.75.75 0 001.28.53L12 16.81l4.72 4.22A.75.75 0 0018 20.25V3.75A.75.75 0 0017.25 3z"/></svg>
}

// Reusable cook steps list
function CookStepsList({ steps, accentColor }) {
  return (
    <ol className="space-y-3">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-4 text-sm leading-relaxed rounded-xl px-4 py-3.5"
          style={{ backgroundColor: '#FFFDF7', border: '1px solid #D4B896', color: '#2C2416' }}>
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

function DetailView({ dish, onBack, imgUrl, isSaved, onSave, onRemove }) {
  const [mode,    setMode]   = useState('diet')   // 'diet' | 'chef'
  const [copied,  setCopied] = useState(false)
  const [toast,   setToast]  = useState({ visible: false, message: '' })
  const { chef, dietician } = dish

  function showToast(message) {
    setToast({ visible: true, message })
    setTimeout(() => setToast(t => ({ ...t, visible: false })), 2000)
  }

  function handleCopy() {
    navigator.clipboard.writeText(formatRecipe(dish)).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    })
  }

  function handleBookmark() {
    if (isSaved) { onRemove(); showToast('✕ Removed from My Recipes') }
    else         { onSave();  showToast('✓ Saved to My Recipes')       }
  }

  const isChef = mode === 'chef'
  const chefAccent = '#D4900A'   // amber/gold for indulgent mode

  return (
    <div className="animate-fade-in min-h-screen bg-sandy pb-28 sm:pb-12">
      <PaperTexture />

      {/* Toast */}
      <div className="fixed bottom-28 sm:bottom-20 left-1/2 z-[1000] pointer-events-none transition-all duration-300"
        style={{ transform: `translateX(-50%) translateY(${toast.visible ? 0 : 8}px)`, opacity: toast.visible ? 1 : 0 }}>
        <div className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white shadow-lg"
          style={{ backgroundColor: '#2C2416' }}>
          {toast.message}
        </div>
      </div>

      {/* ── Hero image ── */}
      {imgUrl ? (
        <div className="relative w-full h-72 sm:h-[30rem] overflow-hidden">
          <img src={imgUrl} alt={dish.name} className="w-full h-full object-cover" />
          <div className="absolute inset-0"
            style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.25) 40%, rgba(0,0,0,0.05) 75%, transparent 100%)' }} />
          {/* Top bar: back + bookmark */}
          <div className="absolute top-0 left-0 right-0 px-4 pt-6 max-w-2xl mx-auto flex items-center justify-between">
            <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 hover:text-white transition-colors drop-shadow">
              {BACK_ARROW} Back to dishes
            </button>
            <button onClick={handleBookmark} className="text-white/90 hover:text-white transition-colors drop-shadow">
              <BookmarkIcon filled={isSaved} />
            </button>
          </div>
          {/* Dish name overlaid */}
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
          <div className="px-4 pb-5 max-w-2xl mx-auto w-full flex items-center justify-between">
            <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-medium text-white/80 hover:text-white transition-colors">
              {BACK_ARROW} Back to dishes
            </button>
            <button onClick={handleBookmark} className="text-white/90 hover:text-white transition-colors">
              <BookmarkIcon filled={isSaved} />
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
                ? { backgroundColor: '#FFFDF7', color: '#2C2416', boxShadow: '0 1px 6px rgba(44,36,22,0.14)' }
                : { color: '#8B7355' }
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
                style={{ backgroundColor: '#FFF8E7', borderColor: `${chefAccent}40`, color: '#5C4A2A' }}>
                <span className="font-bold" style={{ color: chefAccent }}>~{chef.calories}</span>
                <span>kcal · full version</span>
              </div>
            )}

            {chef.steps?.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: '#8B7355' }}>
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
                <h3 className="text-xs font-semibold uppercase tracking-widest text-charcoal-muted mb-4">Quick cook steps</h3>
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
      <div className="fixed bottom-0 inset-x-0 p-4 bg-sandy/95 backdrop-blur-sm border-t border-sandy-border sm:static sm:inset-auto sm:p-0 sm:bg-transparent sm:backdrop-blur-none sm:border-0 sm:max-w-2xl sm:mx-auto sm:mt-6 sm:px-4">
        <button onClick={handleCopy}
          className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-sm transition-opacity active:opacity-80"
          style={{ backgroundColor: copied ? '#7A9E7E' : '#C1683A', color: '#FFFFFF' }}>
          {copied ? '✓ Copied!' : 'Copy Recipe 📋'}
        </button>
      </div>
    </div>
  )
}

// ── Welcome screen ────────────────────────────────────────────────────────────

const VALUE_PROPS = [
  { emoji: '🍳', text: 'Tell me what proteins you have' },
  { emoji: '👨‍🍳', text: 'Get 3 chef-quality dishes'     },
  { emoji: '✅', text: 'See the lean version of each'  },
]

function WelcomeScreen({ onStart }) {
  const [heroUrl, setHeroUrl] = useState(null)

  useEffect(() => {
    fetch('/api/unsplash?query=healthy+food+preparation+kitchen')
      .then(r => r.json())
      .then(d => { if (d.url) setHeroUrl(d.url) })
      .catch(() => {})
  }, [])

  return (
    <div className="animate-fade-in min-h-screen bg-sandy flex flex-col relative">
      <PaperTexture />

      {/* Scrollable content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 relative z-10">
        <div className="w-full max-w-xs sm:max-w-sm space-y-8 text-center">

          {/* Title */}
          <div className="space-y-2">
            <h1
              className="font-serif font-extrabold text-charcoal leading-none"
              style={{ fontSize: 'clamp(3rem, 12vw, 4.5rem)', letterSpacing: '0.03em' }}
            >
              Let Him Cook
            </h1>
            <p className="text-sm text-charcoal-muted">
              High-protein meals built around what you've got.
            </p>
          </div>

          {/* Hero image strip */}
          <div className="relative w-full h-36 sm:h-44 rounded-2xl overflow-hidden">
            {heroUrl
              ? <img src={heroUrl} alt="" className="w-full h-full object-cover" />
              : <div className="w-full h-full" style={{ backgroundColor: '#C1683A', opacity: 0.15 }} />
            }
            {/* Sandy overlay at 40% */}
            <div className="absolute inset-0 rounded-2xl" style={{ backgroundColor: 'rgba(245,236,215,0.40)' }} />
          </div>

          {/* Value props */}
          <div className="space-y-3 text-left">
            {VALUE_PROPS.map(({ emoji, text }) => (
              <div
                key={text}
                className="flex items-center gap-4 rounded-2xl px-5 py-4 border border-sandy-border shadow-card"
                style={{ backgroundColor: '#FFFDF7' }}
              >
                <span className="text-2xl shrink-0 leading-none">{emoji}</span>
                <span className="text-sm font-medium text-charcoal">{text}</span>
              </div>
            ))}
          </div>

          {/* CTA */}
          <button
            onClick={onStart}
            className="w-full py-4 rounded-xl font-semibold text-base text-white active:opacity-80 transition-opacity"
            style={{ backgroundColor: '#C1683A', boxShadow: '0 2px 8px rgba(193,104,58,0.35)' }}
          >
            Let's Cook →
          </button>
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
            style={{ backgroundColor: 'rgba(255,253,247,0.92)', border: '1px solid #D4B896' }}
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

        {/* Header */}
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

// ── Onboarding ────────────────────────────────────────────────────────────────

const EMPTY_PROFILE = {
  name: '', weight: '', goal: '', goalAmount: '',
  trainingFreq: '', trainingTypes: [], avoidFoods: '', kitchenLevel: '',
}

function Onboarding({ initialProfile, onComplete, onBack }) {
  const [step, setStep]       = useState(1)
  const [profile, setProfile] = useState({ ...EMPTY_PROFILE, ...initialProfile })

  const skipStep4  = profile.goal === 'maintain'
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
    if (step === 3) return profile.goal !== ''
    if (step === 4) return String(profile.goalAmount).trim().length > 0
    if (step === 5) return profile.trainingFreq !== ''
    if (step === 6) return profile.trainingTypes.length > 0
    if (step === 7) return true  // optional
    if (step === 8) return profile.kitchenLevel !== ''
    return true
  }

  const isLast      = stepIndex === totalSteps - 1
  const btnLabel    = isLast ? 'Build my profile →'
                   : (step === 7 && !profile.avoidFoods) ? 'Skip →'
                   : 'Next →'

  const cardStyle = (selected) => ({
    backgroundColor: selected ? '#FDF0E8' : '#FFFDF7',
    borderColor:     selected ? '#C1683A' : '#D4B896',
    color:           '#2C2416',
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
          <h2 className="font-serif text-2xl sm:text-3xl font-bold text-charcoal">What's your goal?</h2>
          <div className="space-y-3">
            {GOAL_OPTIONS.map(o => (
              <button key={o.value} onClick={() => set('goal', o.value)}
                className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl border-2 text-left font-medium transition-all"
                style={cardStyle(profile.goal === o.value)}
              >
                <span className="text-2xl">{o.emoji}</span>{o.label}
              </button>
            ))}
          </div>
        </div>
      )
      case 4: return (
        <div className="space-y-4">
          <h2 className="font-serif text-2xl sm:text-3xl font-bold text-charcoal">
            How much do you want to {profile.goal === 'lose' ? 'lose' : 'gain'}?
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
          <div className="flex flex-wrap gap-2">
            {TRAINING_TYPES.map(type => {
              const sel = profile.trainingTypes.includes(type)
              return (
                <button key={type}
                  onClick={() => {
                    if (type === 'None') { set('trainingTypes', sel ? [] : ['None']); return }
                    const filtered = profile.trainingTypes.filter(t => t !== 'None')
                    set('trainingTypes', sel ? filtered.filter(t => t !== type) : [...filtered, type])
                  }}
                  className="px-4 py-2.5 rounded-full border-2 text-sm font-medium transition-all"
                  style={{ backgroundColor: sel ? '#FDF0E8' : '#FFFDF7', borderColor: sel ? '#C1683A' : '#D4B896', color: sel ? '#C1683A' : '#5C4A2A' }}
                >
                  {type}
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
                  style={{ flex: idx === stepIndex ? 2 : 1, backgroundColor: idx <= stepIndex ? '#C1683A' : '#D4B896' }}
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

      {/* Hero image */}
      <div className="relative w-full h-64 sm:h-80 shrink-0 overflow-hidden">
        {heroUrl
          ? <img src={heroUrl} alt="" className="w-full h-full object-cover" />
          : <div className="w-full h-full" style={{ backgroundColor: '#C1683A' }} />
        }
        <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, #F5ECD7 100%)' }} />
      </div>

      {/* Message */}
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
  const [input,          setInput]           = useState('')
  const [streaming,      setStreaming]       = useState(false)
  const [streamContent,  setStreamContent]  = useState('')
  const [awaitingDishes, setAwaitingDishes] = useState(false)
  const [dishes,         setDishes]         = useState(null)
  const [dishImages,     setDishImages]     = useState([])
  const [profile,        setProfile]        = useState(() => {
    try { const s = localStorage.getItem('lhc_profile'); return s ? JSON.parse(s) : null } catch { return null }
  })
  const [savedRecipes,   setSavedRecipes]   = useState(() => {
    try { const s = localStorage.getItem('lhc_saved_recipes'); return s ? JSON.parse(s) : [] } catch { return [] }
  })
  const [view,           setView]           = useState(    // 'welcome'|'onboarding'|'profile-complete'|'chat'|'cards'|'detail'|'saved'
    () => localStorage.getItem('lhc_profile') ? 'chat' : 'welcome'
  )
  const [selectedDish,   setSelectedDish]   = useState(null)
  const [viewingDish,    setViewingDish]    = useState(null)   // dish opened from saved view
  const [viewingDishImg, setViewingDishImg] = useState(null)
  const [error,          setError]          = useState(null)

  const scrollRef = useRef(null)
  const abortRef  = useRef(null)
  const inputRef  = useRef(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, streamContent])

  const displayMessages = messages.filter(m => !(m.seed && m.role === 'user'))

  async function handleSubmit(e) {
    e.preventDefault()
    if (!input.trim() || streaming) return

    const userMsg     = { id: Date.now(), role: 'user', content: input.trim() }
    const nextMessages = [...messages, userMsg]

    setMessages(nextMessages)
    setInput('')           // clear immediately
    setStreaming(true)
    setStreamContent('')
    setAwaitingDishes(false)
    setError(null)

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

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
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
            // Always attempt parsing — safe for non-recipe turns (returns [])
            const parsed = parseDishes(accumulated)
            if (parsed.length > 0) {
              setDishes(parsed)
              setView('cards')
            } else {
              // Parsing found nothing — treat as a normal conversational reply
              setMessages(prev => [...prev, { id: Date.now(), role: 'assistant', content: accumulated }])
            }
            break outer
          }

          try {
            const { text, error: chunkErr } = JSON.parse(payload)
            if (chunkErr) throw new Error(chunkErr)
            if (text) {
              accumulated += text
              if (!sawDishes) {
                // Detect recipe output by emoji OR by seeing ≥2 "Chef Version" mentions
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

  function handleStop()  { abortRef.current?.abort() }

  function handleReset() {
    setMessages(SEED); setDishes(null); setDishImages([]); setView('chat')
    setSelectedDish(null); setViewingDish(null); setViewingDishImg(null)
    setError(null); setInput('')
    setTimeout(() => inputRef.current?.focus(), 50)
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

  // ── Welcome ─────────────────────────────────────────────────────────────────
  if (view === 'welcome') {
    return <WelcomeScreen onStart={() => setView('onboarding')} />
  }

  // ── Onboarding ───────────────────────────────────────────────────────────────
  if (view === 'onboarding') {
    return (
      <Onboarding
        initialProfile={profile}
        onBack={() => setView(profile ? 'chat' : 'welcome')}
        onComplete={p => {
          const saved = { ...p, completedAt: Date.now() }
          localStorage.setItem('lhc_profile', JSON.stringify(saved))
          setProfile(saved)
          setView(profile ? 'chat' : 'profile-complete')  // skip complete screen on edit
        }}
      />
    )
  }

  // ── Profile complete ─────────────────────────────────────────────────────────
  if (view === 'profile-complete') {
    return <ProfileComplete profile={profile} onEnter={() => setView('chat')} />
  }

  // ── Saved recipes view ───────────────────────────────────────────────────────
  if (view === 'saved') {
    return (
      <SavedRecipesView
        savedRecipes={savedRecipes}
        onClose={() => setView('cards')}
        onRemove={handleRemoveRecipe}
        onOpen={recipe => {
          setViewingDish(recipe)
          setViewingDishImg(recipe._imgUrl ?? null)
          setView('detail')
        }}
      />
    )
  }

  // ── Detail ──────────────────────────────────────────────────────────────────
  if (view === 'detail' && (selectedDish !== null || viewingDish !== null)) {
    const dish   = viewingDish ?? dishes[selectedDish]
    const imgUrl = viewingDish ? viewingDishImg : (dishImages[selectedDish] ?? null)
    const backTo = viewingDish ? 'saved' : 'cards'
    return (
      <DetailView
        dish={dish}
        onBack={() => { setViewingDish(null); setViewingDishImg(null); setView(backTo) }}
        imgUrl={imgUrl}
        isSaved={isRecipeSaved(dish.name)}
        onSave={() => handleSaveRecipe(dish, imgUrl)}
        onRemove={() => handleRemoveRecipe(dish.name)}
      />
    )
  }

  // ── Cards ───────────────────────────────────────────────────────────────────
  if (view === 'cards' && dishes) {
    return (
      <div className="animate-fade-in min-h-screen bg-sandy px-4 py-10 sm:py-14">
        <PaperTexture />
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
            <div className="flex gap-2 mt-1.5 shrink-0">
              {savedRecipes.length > 0 && (
                <button
                  onClick={() => setView('saved')}
                  className="text-xs font-medium text-charcoal-muted hover:text-terracotta border border-sandy-border hover:border-terracotta/40 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1"
                >
                  📖 My Recipes
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
    )
  }

  // ── Skeleton (streaming dishes) ─────────────────────────────────────────────
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

  // ── Chat ────────────────────────────────────────────────────────────────────
  return (
    <div className="animate-fade-in flex flex-col h-[100dvh] bg-sandy relative">
      <PaperTexture />

      {/* Header */}
      <div className="shrink-0 px-4 py-3.5 border-b border-sandy-border bg-sandy-light/80 backdrop-blur-sm flex items-center justify-between">
        <h1 className="font-serif text-xl font-extrabold tracking-wider text-charcoal">Let Him Cook</h1>
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

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-3 relative z-10">
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

      {/* Input bar */}
      <div className="shrink-0 border-t border-sandy-border px-4 pt-2.5 pb-3 bg-sandy-light relative z-10">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-charcoal-muted mb-1.5">Your answer</p>
        <form onSubmit={handleSubmit} className="flex gap-2 items-center">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Type your answer…"
            disabled={streaming}
            className="flex-1 rounded-full bg-cream border border-sandy-border px-5 py-2.5 text-sm text-charcoal placeholder-charcoal-muted/70 focus:outline-none focus:ring-2 focus:ring-terracotta/30 focus:border-terracotta disabled:opacity-50 transition min-h-[44px]"
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
              onClick={handleSubmit}
              style={{ backgroundColor: '#C1683A', width: 44, height: 44, flexShrink: 0 }}
              className="flex items-center justify-center rounded-full text-white active:opacity-80 transition-opacity"
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
  )
}
