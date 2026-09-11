import { defineConfig } from 'vitest/config'

// Fast band: every seam test must run without network or a real Ren'Py SDK.
// The slow band (real pinned-SDK parse/lint/playtest smoke) lives in
// *.slow.test.ts and runs only via `npm run test:slow` (vitest.slow.config.ts).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.slow.test.ts', 'node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
