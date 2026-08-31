/** Parent adapter that fails if the composition-only probe starts a turn. */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'

class CompositionOnlyAdapter extends LlmAdapter {
  async * stream(_options) {
    throw new Error('dsh-subagent-codex-plus loader composition must not invoke a model')
  }
}

export const name = 'codex-plus-loader-composition-fixture'
export const inject = ['llm']

/**
 * Register a parent adapter solely so the host composition is complete.
 * @param ctx - Loader context supplying the LLM seam.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter(['mock'], new CompositionOnlyAdapter())
}
