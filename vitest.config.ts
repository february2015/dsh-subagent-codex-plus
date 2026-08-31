import { defineConfig } from 'vitest/config'

/**
 * Offline test suite only. `tests/real-*` need a live Codex binary (`real-product.spec.ts`)
 * or a real DEEPSEEK_API_KEY (`real-deepseek.e2e.ts`) and are excluded on purpose;
 * run them by hand when a real endpoint is available.
 */
export default defineConfig({
  test: {
    // The loader-composition e2e intentionally crosses process boundaries
    // (spawns a real tsx driver, boots a dsh Loader tree, disposes its fiber).
    // detectAsyncLeaks (default on in vitest 4) flags those cross-process
    // handles as leaks and its fake-stack error crashes the default reporter.
    detectAsyncLeaks: false,
    include: [
      'tests/gateway-agent.spec.ts',
      'tests/loader-composition.e2e.ts',
      'tests/subagent-codex.spec.ts',
      'tests/tool-tracker.spec.ts',
    ],
  },
})
