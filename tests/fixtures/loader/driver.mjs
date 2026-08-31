#!/usr/bin/env node
/** Inspect the public dsh-subagent-codex-plus provider composition without invoking the product. */

import { boot, loadOverlayPatches, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const configPath = process.argv[2]
const bundlePatchPath = process.argv[3]
if (configPath === undefined || bundlePatchPath === undefined) {
  throw new Error('dsh-subagent-codex-plus loader composition driver requires config and Bundle patch paths')
}

let starts = 0
const ctx = await boot(
  'dsh-subagent-codex-plus-loader-composition',
  resolveConfigPath(configPath, undefined),
  loadOverlayPatches('dsh-subagent-codex-plus-loader-composition', bundlePatchPath),
  (hostCtx) => {
    hostCtx.on('subagent/start', () => {
      starts += 1
    })
  },
)

try {
  const providerNames = ['codex-plus', 'codex-primary', 'codex-secondary']
  const toolNames = ['subagent_codex', 'subagent_codex_primary', 'subagent_codex_secondary']
  const providers = providerNames.map((providerName) => {
    const provider = ctx.subagents.getProvider(providerName)
    if (provider === undefined) {
      throw new Error(`${providerName} provider was not registered`)
    }
    return {
      name: provider.name,
      capabilities: provider.capabilities,
      inheritsParentContext: provider.inheritsParentContext,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const tools = toolNames.map((toolName) => {
    const tool = ctx.tools.schemas().find(schema => schema.name === toolName)
    if (tool === undefined) throw new Error(`${toolName} tool was not registered`)
    const properties = tool.parameters.properties
    if (
      typeof properties !== 'object'
      || properties === null
      || Array.isArray(properties)
    ) {
      throw new Error(`${toolName} has invalid parameter properties`)
    }
    return {
      name: tool.name,
      parameterNames: Object.keys(properties).sort(),
      required: tool.parameters.required,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const jobTools = ctx.tools.schemas()
    .map(schema => schema.name)
    .filter(name => name === 'job_kill' || name === 'job_list' || name === 'job_output')
    .sort()

  process.stdout.write(`${JSON.stringify({
    providers: ctx.subagents.list().sort(),
    providerDetails: providers,
    tools,
    jobTools,
    starts,
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
