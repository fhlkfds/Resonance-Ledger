import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Risk-based per specification section 19: the gate covers the modules
      // where a defect is silent and expensive, not a global percentage.
      // Modules that need a database are gated in the integration config.
      include: [
        'src/lib/crypto/**',
        'src/lib/spotify/normalize.ts',
        'src/lib/stats/dates.ts',
        'src/lib/auth/consent.ts',
        'src/lib/auth/csrf.ts',
        'src/lib/auth/oauth-state.ts',
        'src/lib/auth/spotify-oauth.ts',
      ],
      thresholds: {
        branches: 90,
        functions: 90,
        statements: 90,
        lines: 90,
      },
    },
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
