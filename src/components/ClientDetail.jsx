import { useState, useEffect } from 'react'

const LABEL_STYLE = {
  fontFamily: 'Inter, sans-serif',
  fontSize: 10,
  fontWeight: 500,
  color: '#888888',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  margin: 0,
}
const VALUE_STYLE = {
  fontFamily: 'Inter, sans-serif',
  fontSize: 14,
  fontWeight: 500,
  color: '#F0F0F0',
  margin: '4px 0 0',
}
const MONO_VALUE_STYLE = {
  ...VALUE_STYLE,
  fontFamily: 'JetBrains Mono, monospace',
}

export default function ClientDetail({ selectedClient: c, onClose, authToken }) {
  const [savedRecipes, setSavedRecipes] = useState([])
  const [clientProfile, setClientProfile] = useState(null)
  const [recipesLoading, setRecipesLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    if (!authToken || !c?.id) { setRecipesLoading(false); return }
    fetch(`/api/coach-client?clientId=${c.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then(r => r.ok ? r.json() : {})
      .then(data => {
        if (data && !Array.isArray(data)) {
          setSavedRecipes(Array.isArray(data.savedRecipes) ? data.savedRecipes : [])
          setClientProfile(data.clientProfile || null)
        } else {
          setSavedRecipes(Array.isArray(data) ? data : [])
        }
      })
      .catch(() => setSavedRecipes([]))
      .finally(() => setRecipesLoading(false))
  }, [c?.id, authToken])

  const isActive = (() => {
    if (!c) return false
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
    if (c.created_at && new Date(c.created_at).getTime() > thirtyDaysAgo) return true
    return savedRecipes.length > 0
  })()

  const firstName = (c?.name || '').split(' ')[0] || c?.name || '—'

  const stats = [
    { label: 'Weight',    value: clientProfile?.weight            ? `${clientProfile.weight}kg`       : '—', mono: true  },
    { label: 'Target',    value: clientProfile?.targetWeight      ? `${clientProfile.targetWeight}kg`  : '—', mono: true  },
    { label: 'Trains',    value: clientProfile?.trainingFrequency || '—',                                     mono: false },
    { label: 'Allergies', value: clientProfile?.foodsToAvoid      || 'None',                                  mono: false },
  ]

  const displayed = showAll ? savedRecipes : savedRecipes.slice(0, 10)

  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#0D0D0D', paddingBottom: 40 }}>
      {/* Sticky header */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        backgroundColor: '#0D0D0D',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        minHeight: 64,
      }}>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            minWidth: 44, minHeight: 44, flexShrink: 0,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <h1 style={{
            fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 22,
            color: '#F0F0F0', margin: 0, lineHeight: 1, flexShrink: 0,
          }}>
            {firstName}
          </h1>
          {(c?.sport || c?.goal) && (
            <span style={{
              backgroundColor: '#1A1A1A',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 20,
              padding: '4px 10px',
              fontFamily: 'Inter, sans-serif',
              fontWeight: 500,
              fontSize: 13,
              color: '#888888',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 160,
            }}>
              {[c?.sport, c?.goal].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>

        {/* Status pill */}
        <span style={{
          flexShrink: 0,
          backgroundColor: isActive ? '#00E5A0' : '#1A1A1A',
          color: isActive ? '#0D0D0D' : '#888888',
          fontFamily: 'Inter, sans-serif',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          padding: '4px 10px',
          borderRadius: 20,
          border: isActive ? 'none' : '1px solid rgba(255,255,255,0.08)',
        }}>
          {isActive ? 'ACTIVE' : 'INACTIVE'}
        </span>
      </div>

      <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Profile stat card */}
        <div style={{
          backgroundColor: '#1A1A1A',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8,
          padding: 16,
        }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 12,
          }}>
            {stats.map(({ label, value, mono }) => (
              <div key={label}>
                <p style={LABEL_STYLE}>{label}</p>
                <p style={mono ? MONO_VALUE_STYLE : VALUE_STYLE}>{value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Remi's Note card */}
        <div style={{
          backgroundColor: '#1A1A1A',
          border: '1px solid rgba(255,255,255,0.08)',
          borderLeft: '4px solid #00E5A0',
          borderRadius: 8,
          padding: 16,
        }}>
          <p style={{ ...LABEL_STYLE, margin: '0 0 10px' }}>Remi's Note</p>
          {c?.remiNote ? (
            <p style={{
              fontFamily: 'Inter, sans-serif', fontSize: 14,
              color: '#F0F0F0', margin: 0, lineHeight: 1.6,
            }}>
              {c.remiNote}
            </p>
          ) : (
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', margin: 0 }}>
              No notes yet.
            </p>
          )}
        </div>

        {/* Saved recipes */}
        <div>
          <p style={{ ...LABEL_STYLE, margin: '0 0 12px' }}>Saved Dishes</p>
          {recipesLoading && (
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', margin: 0 }}>
              Loading...
            </p>
          )}
          {!recipesLoading && savedRecipes.length === 0 && (
            <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#888888', margin: 0 }}>
              Nothing saved yet.
            </p>
          )}
          {!recipesLoading && savedRecipes.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {displayed.map(row => {
                const d = row.recipe_data || {}
                const name = d.name || d.dish || d.title || 'Untitled'
                const kcalRaw = d.dietician?.macros?.calories
                  || d.chef?.macros?.calories
                  || d.macros?.calories
                  || ''
                const kcal = parseInt(kcalRaw)
                return (
                  <div
                    key={row.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 12px',
                      backgroundColor: '#1A1A1A',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 8,
                    }}
                  >
                    <span style={{
                      fontFamily: 'Inter, sans-serif', fontSize: 14,
                      fontWeight: 500, color: '#F0F0F0',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {name}
                    </span>
                    {kcal > 0 && (
                      <span style={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 13,
                        color: '#00E5A0', flexShrink: 0, marginLeft: 12,
                      }}>
                        {kcal} kcal
                      </span>
                    )}
                  </div>
                )
              })}
              {savedRecipes.length > 10 && !showAll && (
                <button
                  onClick={() => setShowAll(true)}
                  style={{
                    background: 'none', border: 'none',
                    fontFamily: 'Inter, sans-serif', fontSize: 14,
                    color: '#00E5A0', cursor: 'pointer',
                    textAlign: 'left', padding: '8px 0', alignSelf: 'flex-start',
                  }}
                >
                  View all {savedRecipes.length} dishes
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
