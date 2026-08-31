import { defineConfig } from 'vitest/config'

/**
 * Hand-run e2e suite: real Codex binary / real API credentials.
 * These tests spawn the real `@openai/codex` app-server (and optionally need
 * a real DEEPSEEK_API_KEY), so they are excluded from the default offline
 * suite on purpose. Run them explicitly when a live endpoint is available:
 *
 *   npx vitest run --config vitest.e2e.config.ts
 */
export default defineConfig({
  test: {
    detectAsyncLeaks: false,
    include: [
      'tests/gateway-events.e2e.ts',
      'tests/real-product.spec.ts',
      'tests/real-deepseek.e2e.ts',
    ],
  },
})
