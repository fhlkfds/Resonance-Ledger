import { defineConfig } from 'vitest/config';

/**
 * The §19 T-032 scale suite. Seeding a million events and measuring against
 * them takes minutes, so it is deliberately a separate suite that neither
 * `test:unit` nor `test:integration` picks up; CI runs it on its own job.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/performance/**/*.test.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
