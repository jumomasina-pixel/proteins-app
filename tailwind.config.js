/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        sandy: {
          DEFAULT: '#EDE0C8',
          light:   '#F5ECD7',
          dark:    '#D4C4A0',
          border:  '#C8B090',
        },
        cream: '#FAF6EE',
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
          DEFAULT: '#1A1108',
          light:   '#4A3728',
          muted:   '#7A6548',
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
        'fade-in': 'fadeIn 0.2s ease-out both',
      },
    },
  },
  plugins: [],
}
