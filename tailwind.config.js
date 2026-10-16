/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Superfícies escuras da navegação ("central de operação")
        ink: {
          950: '#0c101b',
          900: '#111627',
          800: '#1a2138',
          700: '#242d4a',
        },
        // Acento principal da marca Contatta
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        },
        // Um acento por marketplace
        shopee: '#ee4d2d',
        meli: '#ffe600',
        amazon: '#ff9900',
        tiktok: '#25f4ee',
      },
      fontFamily: {
        sans: ['Inter Variable', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Archivo Variable', 'Inter Variable', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
