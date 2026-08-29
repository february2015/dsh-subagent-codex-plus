/**
 * Profile-named Codex one-shot subagent provider. Every accepted run starts a
 * fresh official package-local Codex wrapper with `app-server --stdio` in the
 * delegating Session's workspace and publishes only after an ephemeral thread exists.
 *
 * @module dsh-subagent-codex-plus
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { readOcgoVisionConfig, VisionBridge } from './gateway/vision.ts'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  CODEX_PERMISSION_MODES,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  codexAppServerArgv,
  codexStartupFailure,
  startCodexRun,
  type CodexPermissionMode,
  type CodexRunSpec,
} from './run.ts'
import { applyGatewayCommands } from './commands.ts'
import { GatewayBindingStore } from './gateway/binding.ts'
import { GatewayManager } from './gateway/manager.ts'

export const name = 'subagent-codex-plus'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'codex-plus'

/** Deployment-owned model, permission, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `codex-plus`). */
  providerName?: string
  /** Native Codex model fixed for this instance; omitted to inherit Codex settings. */
  model?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Native non-interactive permission mode fixed for this Provider instance. */
  permissionMode?: CodexPermissionMode
  /** Grace in milliseconds for app-server process-tree termination. */
  disposeGraceMs?: number
  /** Enable the true-gateway (attach/detach + auto-reattach), default true. */
  gatewayEnabled?: boolean
  /** Gateway binding store file (default `$DSH_HOME/codex-plus-gateway.json`). */
  gatewayBindingFile?: string
  /** Approval policy for gateway turns (default `never`). */
  gatewayApprovalPolicy?: string
  /** Forward Codex intermediate events into the dsh session log (R1-A1), default true. */
  gatewayEventForwarding?: boolean
  /** Append the final Codex reply as a dsh surface event when a turn ends, default false (A2). */
  gatewayAppendFinalMessage?: boolean
  /** Enable the GLM vision bridge for image descriptions (R4), default true. */
  gatewayVisionEnabled?: boolean
  /** Vision bridge endpoint override (default: ocgo provider from ~/.codex/config.toml). */
  gatewayVisionEndpoint?: string
  /** Vision bridge api key override (default: ocgo bearer token from ~/.codex/config.toml). */
  gatewayVisionApiKey?: string
  /** Vision bridge model override (default `glm-5.3-flash`). */
  gatewayVisionModel?: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  env: z.dict(z.string()).default({}),
  permissionMode: z.union([...CODEX_PERMISSION_MODES])
    .default(DEFAULT_CODEX_PERMISSION_MODE),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  gatewayEnabled: z.boolean().default(true),
  gatewayBindingFile: z.string().min(1),
  gatewayApprovalPolicy: z.string().min(1),
  gatewayEventForwarding: z.boolean().default(true),
  gatewayAppendFinalMessage: z.boolean().default(false),
  gatewayVisionEnabled: z.boolean().default(true),
  gatewayVisionEndpoint: z.string().min(1),
  gatewayVisionApiKey: z.string().min(1),
  gatewayVisionModel: z.string().min(1),
})

type ResolvedConfig = Omit<
  Required<Config>,
  | 'model'
  | 'gatewayEnabled'
  | 'gatewayBindingFile'
  | 'gatewayApprovalPolicy'
  | 'gatewayEventForwarding'
  | 'gatewayAppendFinalMessage'
  | 'gatewayVisionEnabled'
  | 'gatewayVisionEndpoint'
  | 'gatewayVisionApiKey'
  | 'gatewayVisionModel'
> & Pick<Config, 'model'>

class CodexProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-codex-plus: no working directory for the child — delegate from a parent session that has one',
      )
    }
    let cwd: string
    try {
      cwd = resolveChildCwd(
        'subagent-codex-plus',
        undefined,
        parentCwd,
      )
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-codex-plus: request was aborted before app-server startup',
        )
      }
      throw codexStartupFailure(error)
    }
    const spec: CodexRunSpec = {
      cwd,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      permissionMode: this.config.permissionMode,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-codex-plus "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startCodexRun(request, spec)
  }
}

/**
 * Register one Profile-named Codex provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, permission mode, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.model === undefined ? {} : { model: config.model },
    env: config.env as Record<string, string>,
    permissionMode: config.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE,
    disposeGraceMs: config.disposeGraceMs as number,
  }
  assertPositiveFinite(
    'subagent-codex-plus',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-codex-plus: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new CodexProvider(
    resolved.providerName,
    ctx,
    resolved,
  ))
  if (config.gatewayEnabled !== false) {
    installGateway(ctx, config)
  }
}

/** Build the vision bridge from explicit config, else the ocgo route in ~/.codex/config.toml. */
function resolveVision(config: Config): VisionBridge | undefined {
  if (config.gatewayVisionEnabled === false) return undefined
  const explicit = config.gatewayVisionEndpoint !== undefined || config.gatewayVisionApiKey !== undefined
  const route = explicit
    ? {
        endpoint: config.gatewayVisionEndpoint,
        apiKey: config.gatewayVisionApiKey,
      }
    : readOcgoVisionConfig(join(homedir(), '.codex', 'config.toml'))
  if (route === undefined || route.endpoint === undefined || route.apiKey === undefined) {
    return undefined
  }
  return new VisionBridge({
    endpoint: route.endpoint,
    apiKey: route.apiKey,
    model: config.gatewayVisionModel ?? 'glm-5.3-flash',
  })
}

/** Wire the true-gateway: binding store, manager, commands, auto-reattach. */
function installGateway(ctx: Context, config: Config): void {
  // The gateway needs the live session/agent registries, which only a full
  // host composition provides; lean compositions (headless one-shots, the
  // official loader fixture) simply skip it.
  if (ctx.get('agents') === undefined || ctx.get('sessions') === undefined) return
  const bindingFile = config.gatewayBindingFile
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'codex-plus-gateway.json')
  const store = new GatewayBindingStore(bindingFile)
  const vision = resolveVision(config)
  const manager = new GatewayManager(ctx, store, {
    argv: codexAppServerArgv(),
    ...config.model === undefined ? {} : { model: config.model },
    ...config.gatewayApprovalPolicy === undefined
      ? {}
      : { approvalPolicy: config.gatewayApprovalPolicy },
    ...config.env === undefined ? {} : { env: config.env },
    eventForwarder: {
      enabled: config.gatewayEventForwarding ?? true,
      appendFinalMessage: config.gatewayAppendFinalMessage ?? false,
    },
    ...vision === undefined ? {} : { vision },
  })
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    applyGatewayCommands((definition) => commands.register(definition), manager)
  }
  manager.installAutoReattach()
}
