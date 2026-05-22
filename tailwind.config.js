/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        sandy: {
          DEFAULT: '#0A1A12',
          light:   '#0f2318',
          dark:    '#132b1a',
          border:  '#1a3020',
        },
        cream: '#0f2318',
        terracotta: {
          DEFAULT: '#1D9E75',
          light:   '#5DCAA5',
          dark:    '#176f52',
          pale:    '#0f2318',
        },
        sage: {
          DEFAULT: '#5DCAA5',
          light:   '#a0d9c5',
          dark:    '#1D9E75',
          pale:    '#0f2318',
        },
        charcoal: {
          DEFAULT: '#c8e0cc',
          light:   '#c8e0cc',
          muted:   '#6b8a72',
        },
        remi: {
          void:      '#0A1A12',
          grove:     '#1D9E75',
          sage:      '#5DCAA5',
          parchment: '#F5F2EC',
          ember:     '#EF9F27',
          stone:     '#2C2C2A',
          surface:   '#0f2318',
          border:    '#1a3020',
        },
      },
      fontFamily: {
        serif: ['"Playfair Display"', 'Georgia', 'serif'],
        sans:  ['"DM Sans"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card:        '0 2px 12px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.2)',
        'card-hover':'0 10px 32px rgba(0,0,0,0.5), 0 4px 10px rgba(0,0,0,0.3)',
        btn:         '0 2px 8px rgba(29,158,117,0.35)',
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
