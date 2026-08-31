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
 * log-only events (R1-A1, A2) via {@link GatewayEventForwarder}; image blocks
 * are resolved to Codex `localImage` inputs (Q3); images pass through
 * untouched (visual understanding is handled by the hosts' `ocgw-vision` skill).
 *
 * @module dsh-subagent-codex-plus/gateway/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
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
import type { GatewayImageResolver } from './images.ts'
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
  /** Resolves dsh image blocks to Codex `localImage` inputs (Q3). */
  readonly imageResolver?: GatewayImageResolver
}

/**
 * Project one dsh user message onto gateway input blocks. Text blocks pass
 * through; image blocks are resolved asynchronously by the image resolver.
 */
export async function resolveInputs(
  message: UserMessage,
  injected: readonly string[],
  resolver: GatewayImageResolver | undefined,
): Promise<GatewayUserInput[]> {
  const inputs: GatewayUserInput[] = [
    ...injected.map((text): GatewayTextInput => ({ type: 'text', text, text_elements: [] })),
  ]
  for (const block of message.content) {
    if (block.type === 'text') {
      inputs.push({ type: 'text', text: block.text, text_elements: [] })
      continue
    }
    if (block.type === 'image') {
      if (resolver === undefined) {
        throw new Error('gateway: image passthrough not available in this host')
      }
      const resolved = await resolver.resolve(block.attachment)
      inputs.push(resolved.input)
      continue
    }
    throw new Error(`gateway: unsupported content block "${block.type}" in user message`)
  }
  if (inputs.length === 0) {
    throw new Error('gateway: user message carried no text or image content')
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
  /** Prompts waiting for their Codex turn to start (released as durable `user/message`). */
  private readonly pendingUserMessages: UserMessage[] = []
  private readonly idleResolvers = new Set<() => void>()
  private maintenanceSignal: AbortSignal | undefined
  /** Last status reported to the host; guards against duplicate `agent/status`. */
  private reportedStatus: AgentStatus | undefined
  /** Codex → dsh event projection; also owns the dsh turn ordinal. */
  private readonly forwarder: GatewayEventForwarder

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
    this.gateway.on('turn', () => {
      this.reconcileIdle()
      this.emitStatus()
      this.drainQueue()
    })
    this.forwarder = new GatewayEventForwarder(
      this.session,
      {
        ...(this.agentOptions.eventForwarder ?? DEFAULT_EVENT_FORWARDER_OPTIONS),
        onError: (message) => this.report(new Error(message)),
      },
    )
    this.gateway.on('notification', (notification) => this.forwarder.forward(notification))
    // The forwarder listener above runs first, so `turn/start`/`step/start`
    // land before the prompt; the prompt then opens its own turn on the
    // surface instead of piling up in the host inbox queue.
    this.gateway.on('notification', (notification) => {
      if (notification.method === 'turn/started') this.releasePendingPrompt()
    })
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
    if (this.gateway.turnState === 'running') {
      // Queue durably on the dsh inbox while the gateway is busy: the host
      // broadcasts `session/queue` from the inbox splice, so the composer's
      // queue strip shows the prompt immediately (and the host's queue
      // management can edit/delete/steer it). The queued prompt becomes a
      // durable `user/message` when its turn starts via {@link drainQueue}.
      try {
        this.inbox.append('next-turn', message)
      } catch (error: unknown) {
        this.report(error)
      }
      return
    }
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
    // Publish the current status once the host context is available so the
    // dsh client's running indicator reflects a resumed in-flight turn too.
    this.emitStatus()
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
    const injected = this.pendingInject
    this.pendingInject = []
    if (kind === 'steer' && this.gateway.turnState === 'running') {
      // `turn/steer` redirects the ACTIVE turn without a new `turn/started`
      // notification, so a prompt buffered for release on turn start would
      // never flush and the inserted message would never reach the chat.
      // Land it on the surface immediately; it belongs to the running turn.
      try {
        this.session.append('user/message', message, { surfaceOp: 'append' })
      } catch (error: unknown) {
        this.report(error)
      }
    } else {
      // Buffer the prompt until the Codex turn actually starts, mirroring the
      // loop agent's claim→user/message path; the durable record then shows the
      // prompt inside its own turn instead of leaving it in the inbox queue.
      this.pendingUserMessages.push(message)
    }
    void this.resolveAndRoute(kind, message, injected).catch((error: unknown) => {
      // The submission never reached the wire: drop the buffered prompt so it
      // cannot attach to a later, unrelated turn.
      const index = this.pendingUserMessages.indexOf(message)
      if (index >= 0) this.pendingUserMessages.splice(index, 1)
      this.report(error)
    })
  }

  /** Append the next buffered prompt as a durable surface `user/message`. */
  private releasePendingPrompt(): void {
    const message = this.pendingUserMessages.shift()
    if (message === undefined) return
    try {
      this.session.append('user/message', message, { surfaceOp: 'append' })
    } catch (error: unknown) {
      this.report(error)
    }
  }

  /**
   * Submit the next inbox-queued prompt once the gateway is idle. Called from
   * every turn transition, so a chain of queued prompts drains one turn at a
   * time (mirroring the loop agent's claim-on-boundary semantics). The
   * claimed message is held in `pendingUserMessages` until `turn/started`
   * releases it as the durable surface prompt.
   */
  private drainQueue(): void {
    if (this.gateway.turnState !== 'idle') return
    if (this.pendingUserMessages.length > 0) return
    if (this.inbox.nextTurn.length === 0) return
    // `claim('next-turn', …)` returns next-step inputs followed by one
    // next-turn prompt; the gateway drives one prompt per turn.
    const claimed = this.inbox.claim('next-turn', this.forwarder.nextTurnOrdinal())
    const message = claimed[claimed.length - 1]
    if (message === undefined) return
    this.pendingUserMessages.push(message)
    const injected = this.pendingInject
    this.pendingInject = []
    void this.resolveAndRoute('followup', message, injected).catch((error: unknown) => {
      // The submission never reached the wire: drop the in-flight slot and
      // restore the prompt to the front of the durable queue.
      const index = this.pendingUserMessages.indexOf(message)
      if (index >= 0) this.pendingUserMessages.splice(index, 1)
      try {
        this.inbox.prepend('next-turn', message)
      } catch (prependError: unknown) {
        this.report(prependError)
      }
      this.report(error)
    })
  }

  private async resolveAndRoute(
    kind: 'followup' | 'steer',
    message: UserMessage,
    injected: readonly string[],
  ): Promise<void> {
    if (this.gateway.phase !== 'ready') {
      throw new Error(`gateway: agent not attached (phase ${this.gateway.phase})`)
    }
    const inputs = await resolveInputs(
      message,
      injected,
      this.agentOptions.imageResolver,
    )
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

  /**
   * Publish the agent status transition to the host. The dsh host derives
   * each client session's live `running` bit from `agent/status` events
   * (`host/session-status` frames); without them a client that learned the
   * agent was busy (session summary) never flips back to idle, so the chat
   * keeps rendering "thinking" and the stop button stays enabled while
   * `cancel()` has no active turn to interrupt. Emits only on real
   * transitions: the agent invariant rejects repeated no-op status events.
   */
  private emitStatus(): void {
    const status = this.status
    if (this.reportedStatus === status) return
    this.reportedStatus = status
    if (this.ctx === undefined) return
    try {
      agentEvents(this.ctx, this).emit('agent/status', { status })
    } catch (error: unknown) {
      this.report(error)
    }
  }

  private reconcileIdle(): void {
    if (this.status !== 'idle') return
    for (const resolve of this.idleResolvers) resolve()
    this.idleResolvers.clear()
  }
}
