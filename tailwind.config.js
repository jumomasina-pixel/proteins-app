/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        sandy: {
          DEFAULT: '#0F0D0B',
          light:   '#1A1612',
          dark:    '#222222',
          border:  '#2A2A2A',
        },
        cream: '#1A1612',
        terracotta: {
          DEFAULT: '#C1683A',
          light:   '#D4845A',
          dark:    '#A0522A',
          pale:    '#1A1612',
        },
        sage: {
          DEFAULT: '#7A9E7E',
          light:   '#96B89A',
          dark:    '#5E8262',
          pale:    '#1A1612',
        },
        charcoal: {
          DEFAULT: '#F0EAE0',
          light:   '#F0EAE0',
          muted:   '#7A6B5A',
        },
        remi: {
          void:      '#0F0D0B',
          grove:     '#C1683A',
          sage:      '#7A9E7E',
          parchment: '#F0EAE0',
          ember:     '#C9A84C',
          stone:     '#2A2A2A',
          surface:   '#1A1612',
          border:    'rgba(240,234,224,0.12)',
        },
      },
      fontFamily: {
        serif: ['"Syne"', 'system-ui', 'sans-serif'],
        sans:  ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card:        '0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.3)',
        'card-hover':'0 10px 32px rgba(0,0,0,0.6), 0 4px 10px rgba(0,0,0,0.4)',
        btn:         '0 2px 8px rgba(0,229,160,0.35)',
      },
      keyframes: {
        fadeIn: {
          '0%':   { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out both',
      },
    },
  },
  plugins: [],
}
