import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

const DAYS = [
  { key: 'mon', label: 'MON' },
  { key: 'tue', label: 'TUE' },
  { key: 'wed', label: 'WED' },
  { key: 'thu', label: 'THU' },
  { key: 'fri', label: 'FRI' },
  { key: 'sat', label: 'SAT' },
  { key: 'sun', label: 'SUN' },
]

const SLOTS = ['breakfast', 'lunch', 'dinner']

const TEMPLATES = [
  {
    id: 'performance',
    title: 'Performance',
    desc: 'High protein. Built to train hard.',
  },
  {
    id: 'cut',
    title: 'Cut',
    desc: 'Calorie controlled. Nothing wasted.',
  },
  {
    id: 'maintenance',
    title: 'Maintenance',
    desc: 'Steady. Consistent. Sustainable.',
  },
]

function getMondayOf(date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function formatWeekRange(monday) {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const start = new Date(monday + 'T00:00:00')
  const end = new Date(monday + 'T00:00:00')
  end.setDate(end.getDate() + 6)
  return `${start.getDate()} ${MONTHS[start.getMonth()]} – ${end.getDate()} ${MONTHS[end.getMonth()]}`
}

function initEmptyPlan() {
  return Object.fromEntries(
    DAYS.map(d => [d.key, { breakfast: null, lunch: null, dinner: null, training: true }])
  )
}

function recipeToSlot(r) {
  return {
    id:     r._id || r.id || null,
    title:  r.name || 'Untitled',
    image:  r._imgUrl || null,
    macros: {
      kcal:    parseInt(r.dietician?.macros?.calories) || 0,
      protein: parseInt(r.dietician?.macros?.protein)  || 0,
      carbs:   parseInt(r.dietician?.macros?.carbs)    || 0,
      fat:     parseInt(r.dietician?.macros?.fat)      || 0,
    },
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SlotCard({ slot, label, onClick, onRemove }) {
  if (!slot) {
    return (
      <button
        onClick={onClick}
        style={{
          width: '100%',
          minHeight: 72,
          backgroundColor: '#1A1A1A',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888' }}>{label}</span>
      </button>
    )
  }

  return (
    <div style={{ borderRadius: 8, overflow: 'hidden', backgroundColor: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', position: 'relative' }}>
      {slot.image ? (
        <div style={{ position: 'relative', aspectRatio: '16/9', overflow: 'hidden' }}>
          <img
            src={slot.image}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', borderRadius: '8px 8px 0 0' }}
          />
        </div>
      ) : (
        <div style={{ aspectRatio: '16/9', backgroundColor: '#111111', borderRadius: '8px 8px 0 0' }} />
      )}
      <button
        onClick={onRemove}
        aria-label="Remove"
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          width: 22,
          height: 22,
          borderRadius: '50%',
          backgroundColor: 'rgba(13,13,13,0.75)',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#888888',
          fontSize: 14,
          lineHeight: 1,
          padding: 0,
        }}
      >
        ×
      </button>
      <div style={{ padding: '6px 8px 8px' }}>
        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 500, color: '#F0F0F0', margin: '0 0 3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {slot.title}
        </p>
        <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: '#00E5A0', margin: 0 }}>
          {slot.macros.kcal} kcal
        </p>
      </div>
    </div>
  )
}

function DayRow({ dayDef, dayPlan, onSlotClick, onSlotRemove, onTrainingToggle }) {
  const training = dayPlan?.training ?? true
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr 1fr 1fr', gap: 8, alignItems: 'start', marginBottom: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, paddingTop: 24 }}>
        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          {dayDef.label}
        </span>
        <button
          onClick={() => onTrainingToggle(dayDef.key)}
          style={{
            height: 22,
            borderRadius: 11,
            padding: '0 8px',
            border: training ? 'none' : '1px solid rgba(255,255,255,0.2)',
            backgroundColor: training ? '#00E5A0' : 'transparent',
            color: training ? '#0D0D0D' : '#888888',
            fontFamily: 'Inter, sans-serif',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.06em',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {training ? 'TRAIN' : 'REST'}
        </button>
      </div>
      {SLOTS.map(slot => (
        <SlotCard
          key={slot}
          slot={dayPlan?.[slot] || null}
          label={slot.charAt(0).toUpperCase() + slot.slice(1)}
          onClick={() => onSlotClick(dayDef.key, slot)}
          onRemove={() => onSlotRemove(dayDef.key, slot)}
        />
      ))}
    </div>
  )
}

function TemplatePicker({ onSelect, onScratch }) {
  return (
    <div style={{ maxWidth: 560, margin: '0 auto', paddingTop: 20 }}>
      <p style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 18, color: '#F0F0F0', margin: '0 0 6px', textAlign: 'center' }}>
        Choose a starting point
      </p>
      <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', margin: '0 0 24px', textAlign: 'center' }}>
        Pick a template or start blank.
      </p>
      <div
        className="__mp-template-grid"
        style={{ display: 'flex', flexDirection: 'row', gap: 10 }}
      >
        {TEMPLATES.map(t => (
          <div
            key={t.id}
            style={{
              flex: 1,
              backgroundColor: '#1A1A1A',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              borderRight: '1px solid rgba(255,255,255,0.08)',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              borderLeft: '4px solid #00E5A0',
              borderRadius: 8,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <span style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 15, color: '#F0F0F0', display: 'block' }}>
              {t.title}
            </span>
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', lineHeight: 1.5, display: 'block', flex: 1 }}>
              {t.desc}
            </span>
            <button
              onClick={() => onSelect(t.id)}
              style={{
                width: '100%',
                height: 44,
                borderRadius: 8,
                border: 'none',
                backgroundColor: '#00E5A0',
                color: '#0D0D0D',
                fontFamily: 'Inter, sans-serif',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
                marginTop: 4,
              }}
            >
              Use Template
            </button>
          </div>
        ))}
      </div>
      <div style={{ textAlign: 'center', marginTop: 20 }}>
        <button
          onClick={onScratch}
          style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888', cursor: 'pointer', padding: '4px 0' }}
        >
          Start from scratch
        </button>
      </div>
    </div>
  )
}

const MP_CSS = `
@keyframes __mpSlideUp {
  from { transform: translateY(100%) }
  to   { transform: translateY(0) }
}
.__mp-sheet { animation: __mpSlideUp 300ms ease-out both }
@media (max-width: 600px) {
  .__mp-template-grid { flex-direction: column !important }
}
`

function DishPickerSheet({ dishes, search, onSearch, filterChip, onFilter, onSelect, onClose }) {
  const CHIPS = [
    { id: 'all',         label: 'All' },
    { id: 'performance', label: 'Performance' },
    { id: 'cheatday',    label: 'Cheat Day' },
  ]

  return (
    <>
      <style>{MP_CSS}</style>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(13,13,13,0.85)', zIndex: 1000 }}
      />
      <div
        className="__mp-sheet"
        onClick={e => e.stopPropagation()}
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          maxHeight: '80vh',
          backgroundColor: '#1A1A1A',
          borderRadius: '12px 12px 0 0',
          zIndex: 1001,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Sheet header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px 12px', flexShrink: 0 }}>
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 500, color: '#888888', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Choose a Dish
          </span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888888', padding: 4, lineHeight: 1, fontSize: 20 }}
          >
            ×
          </button>
        </div>

        {/* Search */}
        <div style={{ padding: '0 16px 10px', flexShrink: 0 }}>
          <input
            type="text"
            value={search}
            onChange={e => onSearch(e.target.value)}
            placeholder="Search saved dishes…"
            autoComplete="off"
            style={{
              width: '100%',
              height: 48,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.08)',
              backgroundColor: '#0D0D0D',
              color: '#F0F0F0',
              fontFamily: 'Inter, sans-serif',
              fontSize: 16,
              padding: '0 14px',
              boxSizing: 'border-box',
              outline: 'none',
            }}
          />
        </div>

        {/* Filter chips */}
        <div style={{ display: 'flex', gap: 8, padding: '0 16px 12px', flexShrink: 0 }}>
          {CHIPS.map(chip => {
            const active = filterChip === chip.id
            return (
              <button
                key={chip.id}
                onClick={() => onFilter(chip.id)}
                style={{
                  height: 30,
                  padding: '0 12px',
                  borderRadius: 15,
                  border: active ? '1px solid #00E5A0' : '1px solid rgba(255,255,255,0.12)',
                  backgroundColor: active ? 'rgba(0,229,160,0.1)' : 'transparent',
                  color: active ? '#00E5A0' : '#888888',
                  fontFamily: 'Inter, sans-serif',
                  fontSize: 12,
                  fontWeight: active ? 600 : 400,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {chip.label}
              </button>
            )
          })}
        </div>

        {/* Dish list */}
        <div style={{ overflowY: 'auto', flex: 1, paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}>
          {dishes.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', margin: 0 }}>
                Nothing saved yet. Cook something worth keeping.
              </p>
            </div>
          ) : (
            dishes.map((r, i) => {
              const kcal = parseInt(r.dietician?.macros?.calories) || null
              return (
                <button
                  key={r._id || i}
                  onClick={() => onSelect(recipeToSlot(r))}
                  style={{
                    width: '100%',
                    height: 56,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '0 16px',
                    backgroundColor: 'transparent',
                    border: 'none',
                    borderBottom: i < dishes.length - 1 ? '0.5px solid rgba(255,255,255,0.06)' : 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  {r._imgUrl ? (
                    <img
                      src={r._imgUrl}
                      alt=""
                      style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }}
                    />
                  ) : (
                    <div style={{ width: 40, height: 40, borderRadius: 6, backgroundColor: '#111111', flexShrink: 0 }} />
                  )}
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 500, color: '#F0F0F0', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.name}
                  </span>
                  {kcal !== null && (
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: '#00E5A0', flexShrink: 0 }}>
                      {kcal} kcal
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>
    </>
  )
}

function BottomBar({ avgKcal, avgProtein, repeatConfirm, onRepeat, onConfirmRepeat, onCancelRepeat }) {
  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: '#0D0D0D',
      borderTop: '1px solid rgba(255,255,255,0.08)',
      padding: '12px 16px',
      paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      zIndex: 100,
    }}>
      <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, margin: 0, lineHeight: 1.6 }}>
        <span style={{ color: '#00E5A0' }}>~{avgKcal} kcal</span>
        <span style={{ color: '#888888' }}> avg/day · </span>
        <span style={{ color: '#888888' }}>{avgProtein}g protein avg</span>
      </p>
      {repeatConfirm ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#888888' }}>Copy plan to next week?</span>
          <button
            onClick={onConfirmRepeat}
            style={{ height: 32, padding: '0 12px', borderRadius: 6, border: 'none', backgroundColor: '#00E5A0', color: '#0D0D0D', fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            Confirm
          </button>
          <button
            onClick={onCancelRepeat}
            style={{ height: 32, padding: '0 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.12)', backgroundColor: 'transparent', color: '#888888', fontFamily: 'Inter, sans-serif', fontSize: 12, cursor: 'pointer' }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={onRepeat}
          style={{
            height: 44,
            padding: '0 16px',
            borderRadius: 8,
            border: '1px solid #00E5A0',
            backgroundColor: '#1A1A1A',
            color: '#00E5A0',
            fontFamily: 'Inter, sans-serif',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Repeat Week
        </button>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MealPlanner({ user, authToken, savedRecipes, onClose }) {
  const [weekStart,     setWeekStart]     = useState(() => getMondayOf(new Date()))
  const [plan,          setPlan]          = useState(null)
  const [hasGrid,       setHasGrid]       = useState(false)
  const [loading,       setLoading]       = useState(true)
  const [picker,        setPicker]        = useState(null)
  const [search,        setSearch]        = useState('')
  const [filterChip,    setFilterChip]    = useState('all')
  const [repeatConfirm, setRepeatConfirm] = useState(false)
  const saveTimerRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setHasGrid(false)
      setPlan(null)
      if (!authToken) { setLoading(false); return }
      try {
        const r = await fetch(`/api/meal-plans?week_start=${weekStart}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        })
        if (!r.ok || cancelled) { setLoading(false); return }
        const data = await r.json()
        if (!cancelled && data.plan) {
          setPlan(data.plan)
          setHasGrid(true)
        }
      } catch {}
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [weekStart, authToken])

  const debouncedSave = useCallback((newPlan, ws) => {
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      if (!authToken) return
      try {
        await fetch('/api/meal-plans', {
          method:  'POST',
          headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ week_start: ws, plan: newPlan }),
        })
      } catch {}
    }, 800)
  }, [authToken])

  function updatePlan(updater) {
    setPlan(prev => {
      const next = updater(prev || initEmptyPlan())
      debouncedSave(next, weekStart)
      return next
    })
  }

  function handleSlotSet(day, slot, dish) {
    updatePlan(p => ({ ...p, [day]: { ...(p[day] || { training: true }), [slot]: dish } }))
    setPicker(null)
    setSearch('')
    setFilterChip('all')
  }

  function handleSlotRemove(day, slot) {
    updatePlan(p => ({ ...p, [day]: { ...(p[day] || { training: true }), [slot]: null } }))
  }

  function handleTrainingToggle(day) {
    updatePlan(p => ({ ...p, [day]: { ...(p[day] || {}), training: !(p[day]?.training ?? true) } }))
  }

  function handleTemplateSelect() {
    const empty = initEmptyPlan()
    setPlan(empty)
    setHasGrid(true)
    debouncedSave(empty, weekStart)
  }

  async function handleRepeatWeek() {
    if (!authToken || !plan) return
    const nextMonday = addDays(weekStart, 7)
    try {
      await fetch('/api/meal-plans', {
        method:  'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ week_start: nextMonday, plan }),
      })
    } catch {}
    setRepeatConfirm(false)
  }

  const macros = useMemo(() => {
    if (!plan) return null
    let totalKcal = 0, totalProtein = 0, filled = 0
    Object.values(plan).forEach(day => {
      SLOTS.forEach(slot => {
        const dish = day[slot]
        if (dish) {
          totalKcal   += dish.macros?.kcal    || 0
          totalProtein += dish.macros?.protein || 0
          filled++
        }
      })
    })
    if (filled === 0) return null
    return { avgKcal: Math.round(totalKcal / 7), avgProtein: Math.round(totalProtein / 7) }
  }, [plan])

  const filteredDishes = useMemo(() => {
    if (!savedRecipes?.length) return []
    return savedRecipes.filter(r => {
      const name    = (r.name || '').toLowerCase()
      const kcal    = parseInt(r.dietician?.macros?.calories) || 0
      const protein = parseInt(r.dietician?.macros?.protein)  || 0
      if (search && !name.includes(search.toLowerCase())) return false
      if (filterChip === 'performance' && protein < 30) return false
      if (filterChip === 'cheatday'    && kcal    < 600) return false
      return true
    })
  }, [savedRecipes, search, filterChip])

  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: '#0D0D0D', zIndex: 900, display: 'flex', flexDirection: 'column' }}>

      {/* ── Header ── */}
      <div style={{
        flexShrink: 0,
        backgroundColor: '#0D0D0D',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        padding: '12px 16px',
        display: 'grid',
        gridTemplateColumns: '44px 1fr 44px',
        alignItems: 'center',
      }}>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', color: '#888888' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 17, color: '#F0F0F0', margin: '0 0 2px', letterSpacing: '0.06em' }}>
            MEAL PLANNER
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <button
              onClick={() => setWeekStart(prev => addDays(prev, -7))}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888888', padding: 2, display: 'flex', lineHeight: 1 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#888888' }}>
              {formatWeekRange(weekStart)}
            </span>
            <button
              onClick={() => setWeekStart(prev => addDays(prev, 7))}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888888', padding: 2, display: 'flex', lineHeight: 1 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          </div>
        </div>
        <div />
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 12px', paddingBottom: macros ? 80 : 24 }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#888888' }}>Loading…</span>
          </div>
        ) : !hasGrid ? (
          <TemplatePicker onSelect={handleTemplateSelect} onScratch={handleTemplateSelect} />
        ) : (
          <div>
            {/* Column headers */}
            <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr 1fr 1fr', gap: 8, marginBottom: 6 }}>
              <div />
              {SLOTS.map(s => (
                <span key={s} style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#888888', letterSpacing: '0.10em', textTransform: 'uppercase', textAlign: 'center' }}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </span>
              ))}
            </div>
            {DAYS.map(d => (
              <DayRow
                key={d.key}
                dayDef={d}
                dayPlan={plan?.[d.key]}
                onSlotClick={(day, slot) => setPicker({ day, slot })}
                onSlotRemove={handleSlotRemove}
                onTrainingToggle={handleTrainingToggle}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Bottom bar ── */}
      {macros && (
        <BottomBar
          avgKcal={macros.avgKcal}
          avgProtein={macros.avgProtein}
          repeatConfirm={repeatConfirm}
          onRepeat={() => setRepeatConfirm(true)}
          onConfirmRepeat={handleRepeatWeek}
          onCancelRepeat={() => setRepeatConfirm(false)}
        />
      )}

      {/* ── Dish picker ── */}
      {picker && (
        <DishPickerSheet
          dishes={filteredDishes}
          search={search}
          onSearch={setSearch}
          filterChip={filterChip}
          onFilter={setFilterChip}
          onSelect={dish => handleSlotSet(picker.day, picker.slot, dish)}
          onClose={() => { setPicker(null); setSearch(''); setFilterChip('all') }}
        />
      )}
    </div>
  )
}
