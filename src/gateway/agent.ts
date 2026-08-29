/**
 * dsh `Agent` contract implemented as a thin forwarder to a durable
 * `CodexGateway`. The dsh host constructs the gateway (attach flow) and
 * supplies the live session/inbox/context association at registration.
 *
 * Semantics follow the verified app-server behavior:
 * - followup -> `turn/start` when idle, `thread/queue/add` when busy;
 * - steer -> `turn/steer` (or a fresh turn when idle);
 * - inject -> buffered and merged as leading text into the next submission;
 * - cancel -> best-effort `turn/interrupt` (thread/process stay alive).
 *
 * Intermediate Codex output is projected into the dsh session log as
 * log-only events (R1-A1, A2) via {@link GatewayEventForwarder}.
 *
 * @module dsh-subagent-codex-plus/gateway/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  Inbox,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import type {
  AgentCancelCause,
  Session,
  SessionId,
  UserMessage,
} from '@deepseek-ai/dsh-session'
import { CodexGateway } from './gateway.ts'
import {
  DEFAULT_EVENT_FORWARDER_OPTIONS,
  GatewayEventForwarder,
  type GatewayEventForwarderOptions,
} from './events.ts'
import type { GatewayTextInput, GatewayUserInput } from './wire.ts'

/** Live dsh association supplied by the host when the agent is registered. */
export interface GatewayAgentHost {
  readonly id: SessionId
  readonly session: Session
  readonly inbox: Inbox
  /** Agent-scoped context; bound by the attach wiring after construction. */
  readonly ctx: Context | undefined
  readonly options: AgentOptions
}

export interface GatewayAgentOptions {
  /** Codex → dsh session event forwarding policy (R1-A1/A2). */
  readonly eventForwarder?: GatewayEventForwarderOptions
}

/**
 * Project one dsh user message onto gateway input blocks. Text blocks pass
 * through; image/attachment blocks are deferred to the image-passthrough
 * step (Q3/R4) and fail loudly until then.
 */
export function gatewayInputs(message: UserMessage): GatewayUserInput[] {
  const inputs: GatewayUserInput[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      inputs.push({ type: 'text', text: block.text, text_elements: [] })
      continue
    }
    throw new Error('gateway: image/attachment passthrough not wired yet (Q3/R4 step)')
  }
  if (inputs.length === 0) {
    throw new Error('gateway: user message carried no text content')
  }
  return inputs
}

/** Forwarder agent driving one Codex thread for one dsh session. */
export class GatewayAgent implements Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly inbox: Inbox
  ctx: Context

  private pendingInject: string[] = []
  private readonly idleResolvers = new Set<() => void>()
  private maintenanceSignal: AbortSignal | undefined

  constructor(
    private readonly host: GatewayAgentHost,
    private readonly gateway: CodexGateway,
    private readonly agentOptions: GatewayAgentOptions = {},
  ) {
    this.id = host.id
    this.options = host.options
    this.session = host.session
    this.inbox = host.inbox
    this.ctx = host.ctx ?? (undefined as unknown as Context)
    void this.inbox
    this.gateway.on('turn', () => this.reconcileIdle())
    const forwarder = new GatewayEventForwarder(
      this.session,
      {
        ...(this.agentOptions.eventForwarder ?? DEFAULT_EVENT_FORWARDER_OPTIONS),
        onError: (message) => this.report(new Error(message)),
      },
    )
    this.gateway.on('notification', (notification) => forwarder.forward(notification))
  }

  get status(): AgentStatus {
    return this.gateway.turnState === 'running' ? 'running' : 'idle'
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (wakeup) {
      this.followup(message)
    } else {
      this.inject(message)
    }
  }

  followup(message: UserMessage): void {
    this.dispatch('followup', message)
  }

  steer(message: UserMessage): void {
    this.dispatch('steer', message)
  }

  inject(message: UserMessage): void {
    for (const block of message.content) {
      if (block.type === 'text') this.pendingInject.push(block.text)
    }
  }

  /** Bind the agent-scoped context after construction (attach wiring). */
  bindCtx(ctx: Context): void {
    this.ctx = ctx
  }

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    this.gateway.cancel()
    this.maintenanceSignal?.dispatchEvent(new Event('abort'))
    if (options?.keepInbox !== true) {
      this.pendingInject = []
    }
  }

  whenIdle(): Promise<void> {
    if (this.status === 'idle') return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.idleResolvers.add(resolve)
    })
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.maintenanceSignal !== undefined) {
      return Promise.reject(new Error('gateway: maintenance task already running'))
    }
    const controller = new AbortController()
    this.maintenanceSignal = controller.signal
    const done = task(controller.signal)
    done.finally(() => {
      this.maintenanceSignal = undefined
    })
    return done
  }

  private dispatch(kind: 'followup' | 'steer', message: UserMessage): void {
    let inputs: GatewayUserInput[]
    try {
      const injected = this.pendingInject
      this.pendingInject = []
      const blocks = gatewayInputs(message)
      inputs = injected.length === 0
        ? blocks
        : [
            ...injected.map((text): GatewayTextInput => ({ type: 'text', text, text_elements: [] })),
            ...blocks,
          ]
    } catch (error: unknown) {
      this.report(error)
      return
    }
    // Mirror the loop agent's durable inbox recording so the dsh UI and log
    // show the user's prompt even though no dsh model processes it.
    try {
      this.inbox.append(kind === 'steer' ? 'next-step' : 'next-turn', message)
    } catch (error: unknown) {
      this.report(error)
      return
    }
    void this.route(kind, inputs).catch((error: unknown) => this.report(error))
  }

  private async route(kind: 'followup' | 'steer', inputs: GatewayUserInput[]): Promise<void> {
    if (this.gateway.phase !== 'ready') {
      throw new Error(`gateway: agent not attached (phase ${this.gateway.phase})`)
    }
    if (kind === 'steer') {
      await this.gateway.steer(inputs)
    } else {
      await this.gateway.submit(inputs)
    }
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    ;(this.ctx as Context | undefined)?.logger?.warn?.(`[gateway] ${message}`)
  }

  private reconcileIdle(): void {
    if (this.status !== 'idle') return
    for (const resolve of this.idleResolvers) resolve()
    this.idleResolvers.clear()
  }
}
