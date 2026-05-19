/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        sandy: {
          DEFAULT: '#F5ECD7',
          light:   '#FAF3E4',
          dark:    '#E0CFA8',
          border:  '#D4B896',
        },
        cream: '#FFFDF7',
        terracotta: {
          DEFAULT: '#C1683A',
          light:   '#D4845A',
          dark:    '#A8522A',
          pale:    '#FDF0E8',
        },
        sage: {
          DEFAULT: '#7A9E7E',
          light:   '#A8C5AC',
          dark:    '#4E7A53',
          pale:    '#EEF5EF',
        },
        charcoal: {
          DEFAULT: '#2C2416',
          light:   '#5C4A2A',
          muted:   '#8B7355',
        },
      },
      fontFamily: {
        serif: ['"Playfair Display"', 'Georgia', 'serif'],
        sans:  ['"DM Sans"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card:       '0 2px 12px rgba(44,36,22,0.07), 0 1px 3px rgba(44,36,22,0.05)',
        'card-hover':'0 10px 32px rgba(44,36,22,0.14), 0 4px 10px rgba(44,36,22,0.08)',
        btn:        '0 2px 8px rgba(193,104,58,0.35)',
      },
      keyframes: {
        fadeIn: {
          '0%':   { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.35s ease-out both',
      },
    },
  },
  plugins: [],
}
