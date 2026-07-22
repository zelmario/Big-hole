import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    benchmark: {
      include: ['tests/**/*.bench.ts'],
    },
    // Decoding a real fixture and diffing a full sample matrix is not a fast unit test.
    testTimeout: 120_000,
  },
});
