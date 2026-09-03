import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#0d1117',
        panel: '#161b22',
        ink: '#f0f4f8',
        muted: '#9da7b3',
        accent: '#d6ff69',
      },
    },
  },
  plugins: [],
} satisfies Config;
