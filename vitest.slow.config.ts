import { defineConfig } from 'vitest/config'

// Slow integration band: real pinned Ren'Py SDK provisioning + lint/parse +
// launch smoke. Skippable by CI, mandatory before release (spec Testing
// Decisions). Run explicitly: `npm run test:slow`.
export default defineConfig({
  test: {
    include: ['src/**/*.slow.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
})
