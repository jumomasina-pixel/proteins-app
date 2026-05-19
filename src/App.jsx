import { useState, useRef, useEffect } from 'react'

// ── Parser ────────────────────────────────────────────────────────────────────

// ── Two small helpers used by parseDishChunk ─────────────────────────────────

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

  console.log('[parseDishChunk] splitIdx:', splitIdx,
    '| chefPart len:', chefPart.length,
    '| dietPart len:', dietPart.length)
  console.log('[parseDishChunk] dietPart preview:', dietPart.slice(0, 300))

  // Dish name — first line containing 🍽️, stripped of emoji and "— Chef Version"
  const nameLine = chunk.split('\n').find(l => l.includes('🍽️')) ?? ''
  const name = nameLine
    .replace(/🍽️\s*/g, '')
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

  // Macros: search the entire dietPart — robust against bullets, indentation, bold
  const calories = grabNum(dietPart, /calories\s*:\s*~?\s*(\d[\d,]*)/i)
  const protein  = grabNum(dietPart, /protein\s*:\s*~?\s*(\d[\d,]*)/i)
  const carbs    = grabNum(dietPart, /carbs?\s*:\s*~?\s*(\d[\d,]*)/i)
  const fat      = grabNum(dietPart, /\bfat\s*:\s*~?\s*(\d[\d,]*)/i)

  const stepsRaw = grab(dietPart,
    /quick\s+cook\s+steps[^:\n]*:\s*([\s\S]+?)(?=\ndietician|$)/i,
  )
  const cookSteps = stepsRaw
    .split('\n')
    .map(l => l.replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean)

  const note = grab(dietPart, /dietician.{0,5}s?\s*note[^:\n]*:\s*([^\n]+)/i)

  const result = {
    name,
    chef: { cuisine, flavour, restaurant, calories: chefCal },
    dietician: { whatChanges, keyTechnique, macros: { calories, protein, carbs, fat }, cookSteps, note },
  }
  console.log('[parseDishChunk] parsed dish:', JSON.stringify(result, null, 2))
  return result
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

function ChatBubble({ role, content, isStreaming }) {
  const isUser = role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className="max-w-[82%] sm:max-w-[68%] px-5 py-3 text-sm leading-relaxed whitespace-pre-wrap rounded-2xl shadow-sm"
        style={isUser
          ? { backgroundColor: '#C1683A', color: '#FFFFFF', borderBottomRightRadius: 4 }
          : { backgroundColor: '#FFFDF7', color: '#2C2416', border: '1px solid #D4B896', borderBottomLeftRadius: 4 }
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
    <div className="flex justify-start">
      <div className="flex items-center gap-1.5 px-4 py-3.5 rounded-2xl rounded-tl-sm bg-cream border border-sandy-border shadow-sm">
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

function DishCard({ dish, onClick }) {
  const savings = calorieSavings(dish)
  return (
    <button
      onClick={onClick}
      className="w-full rounded-2xl bg-cream shadow-card border-t-4 border-terracotta p-5 sm:p-6 text-left transition-all duration-200 hover:-translate-y-1.5 hover:shadow-card-hover group"
    >
      <div className="space-y-3">
        {dish.chef.cuisine && (
          <span className="inline-block text-xs px-2.5 py-1 rounded-full bg-sage-pale text-sage-dark border border-sage/30 font-medium">
            {dish.chef.cuisine}
          </span>
        )}
        <h3 className="font-serif text-xl font-bold text-charcoal leading-snug">
          {dish.name}
        </h3>
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-bold text-terracotta tabular-nums">
            {dish.dietician.macros.calories}
          </span>
          <span className="text-sm text-charcoal-muted">kcal</span>
        </div>
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

function DetailView({ dish, onBack }) {
  const [copied, setCopied] = useState(false)
  const { chef, dietician } = dish

  function handleCopy() {
    navigator.clipboard.writeText(formatRecipe(dish)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="animate-fade-in min-h-screen bg-sandy pb-28 sm:pb-12 px-4 py-8">
      <PaperTexture />
      <div className="max-w-2xl mx-auto space-y-8 relative">

        {/* Back */}
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm font-medium text-charcoal-muted hover:text-terracotta transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
          </svg>
          Back to dishes
        </button>

        <h1 className="font-serif text-3xl sm:text-4xl font-bold text-charcoal leading-tight">
          {dish.name}
        </h1>

        {/* ── Chef Version ── */}
        <section className="space-y-4 pl-5 border-l-4 border-terracotta">
          <h2 className="font-serif text-lg font-bold text-charcoal">🍽️ Chef Version</h2>

          {(chef.cuisine || chef.flavour) && (
            <div className="flex flex-wrap gap-2">
              {chef.cuisine && (
                <span className="text-xs px-3 py-1 rounded-full bg-terracotta-pale text-terracotta border border-terracotta/25">
                  {chef.cuisine}
                </span>
              )}
              {chef.flavour && (
                <span className="text-xs px-3 py-1 rounded-full bg-terracotta-pale text-terracotta border border-terracotta/25">
                  {chef.flavour}
                </span>
              )}
            </div>
          )}

          {chef.restaurant && (
            <p className="text-sm text-charcoal leading-relaxed">{chef.restaurant}</p>
          )}

          {chef.calories && (
            <div className="inline-flex items-center gap-1.5 text-xs text-charcoal-muted bg-sandy-light border border-sandy-border px-3 py-1.5 rounded-full">
              <span className="text-terracotta font-bold">~{chef.calories}</span>
              <span>kcal · restaurant version</span>
            </div>
          )}
        </section>

        <div className="border-t border-sandy-border" />

        {/* ── Dietician Version ── */}
        <section className="space-y-6 pl-5 border-l-4 border-sage">
          <h2 className="font-serif text-lg font-bold text-charcoal">✅ Dietician Version</h2>

          <MacroRow macros={dietician.macros} />

          {dietician.whatChanges.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-charcoal-muted mb-3">
                What changes
              </h3>
              <ul className="space-y-2">
                {dietician.whatChanges.map((item, i) => (
                  <li key={i} className="flex gap-2.5 text-sm text-charcoal leading-snug">
                    <span className="text-sage font-bold shrink-0 mt-px">✓</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {dietician.keyTechnique && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-charcoal-muted mb-2">
                Key technique
              </h3>
              <p className="text-sm text-charcoal leading-relaxed">{dietician.keyTechnique}</p>
            </div>
          )}

          {dietician.cookSteps.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-charcoal-muted mb-4">
                Quick cook steps
              </h3>
              <ol className="space-y-3">
                {dietician.cookSteps.map((step, i) => (
                  <li key={i} className="flex gap-4 text-sm leading-snug rounded-xl px-4 py-3.5" style={{ backgroundColor: '#FFFDF7', border: '1px solid #D4B896', color: '#2C2416' }}>
                    <span className="shrink-0 w-6 h-6 rounded-full text-xs flex items-center justify-center font-bold mt-px" style={{ backgroundColor: '#C1683A', color: '#FFFFFF' }}>
                      {i + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {dietician.note && (
            <div className="rounded-xl bg-sage-pale border border-sage/25 px-5 py-4">
              <p className="text-sm text-sage-dark leading-relaxed">{dietician.note}</p>
            </div>
          )}
        </section>
      </div>

      {/* ── Copy Recipe button — fixed on mobile, inline on sm+ ── */}
      <div className="fixed bottom-0 inset-x-0 p-4 bg-sandy/95 backdrop-blur-sm border-t border-sandy-border sm:static sm:inset-auto sm:p-0 sm:bg-transparent sm:backdrop-blur-none sm:border-0 sm:max-w-2xl sm:mx-auto sm:mt-4">
        <button
          onClick={handleCopy}
          className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-sm transition-opacity active:opacity-80"
          style={{ backgroundColor: copied ? '#7A9E7E' : '#C1683A', color: '#FFFFFF' }}
        >
          {copied ? '✓ Copied!' : 'Copy Recipe 📋'}
        </button>
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
  const [view,           setView]           = useState('chat')  // 'chat' | 'cards' | 'detail'
  const [selectedDish,   setSelectedDish]   = useState(null)
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
        body: JSON.stringify({ messages: nextMessages.map(({ role, content }) => ({ role, content })) }),
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
    setMessages(SEED); setDishes(null); setView('chat')
    setSelectedDish(null); setError(null); setInput('')
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  // ── Detail ──────────────────────────────────────────────────────────────────
  if (view === 'detail' && selectedDish !== null) {
    return <DetailView dish={dishes[selectedDish]} onBack={() => setView('cards')} />
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
            <button
              onClick={handleReset}
              className="shrink-0 text-xs font-medium text-charcoal-muted hover:text-terracotta border border-sandy-border hover:border-terracotta/40 px-3 py-1.5 rounded-lg transition-colors mt-1.5"
            >
              Start over
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {dishes.map((dish, i) => (
              <DishCard
                key={i}
                dish={dish}
                onClick={() => { setSelectedDish(i); setView('detail') }}
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
      <div className="shrink-0 px-4 py-4 border-b border-sandy-border bg-sandy-light/80 backdrop-blur-sm text-center">
        <h1 className="font-serif text-2xl font-extrabold tracking-wider text-charcoal">Let Him Cook</h1>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-3 relative z-10">
        {displayMessages.map(msg => (
          <ChatBubble key={msg.id} role={msg.role} content={msg.content} />
        ))}
        {streaming && streamContent && (
          <ChatBubble role="assistant" content={streamContent} isStreaming />
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
      <div className="shrink-0 border-t border-sandy-border px-4 py-3 bg-sandy-light relative z-10">
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
