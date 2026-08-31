import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Inbox, type AgentStatus } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { GatewayAgent, type GatewayAgentHost } from '../src/gateway/agent.ts'
import type { CodexGateway } from '../src/gateway/gateway.ts'
import type { GatewayUserInput } from '../src/gateway/wire.ts'

/** Minimal gateway double: captures listeners and exposes a settable turnState. */
function fakeGateway(initial: 'idle' | 'running' = 'idle'): CodexGateway {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const submitted: GatewayUserInput[][] = []
  let turnState: 'idle' | 'running' = initial
  return {
    phase: 'ready',
    get turnState() {
      return turnState
    },
    set turnState(next: 'idle' | 'running') {
      turnState = next
    },
    on(name: string, listener: (...args: unknown[]) => void): void {
      const list = handlers.get(name) ?? []
      list.push(listener)
      handlers.set(name, list)
    },
    emit(name: string, ...args: unknown[]): void {
      for (const listener of handlers.get(name) ?? []) listener(...args)
    },
    submit(inputs: readonly GatewayUserInput[]): Promise<{ kind: 'turn'; id: string }> {
      submitted.push([...inputs])
      return Promise.resolve({ kind: 'turn', id: 'turn-test' })
    },
    steer(inputs: readonly GatewayUserInput[]): Promise<string | undefined> {
      submitted.push([...inputs])
      return Promise.resolve('turn-test')
    },
    submitted,
  } as unknown as CodexGateway
}

/** Session double: the event forwarder reads `events` and appends records. */
function fakeSession(): NonNullable<GatewayAgentHost['session']> {
  return {
    header: { seedLength: 0 },
    events: [] as unknown[],
    append(type: string, data: unknown): unknown {
      const event = { type, data, seq: (this.events as unknown[]).length + 1, time: Date.now() }
      ;(this.events as unknown[]).push(event)
      return event
    },
  } as unknown as NonNullable<GatewayAgentHost['session']>
}

/** Cordis-ish double that records `agent/status` dispatches. */
function recordingCtx(statuses: AgentStatus[]): Context {
  return {
    logger: { warn: () => {} },
    events: {
      dispatch(kind: string, args: unknown[]): unknown[] {
        if (kind === 'emit' && args[1] === 'agent/status') {
          statuses.push((args[2] as { status: AgentStatus }).status)
        }
        return []
      },
    },
  } as unknown as Context
}

describe('GatewayAgent agent/status emission', () => {
  it('emits current status on bind and only real transitions afterwards', () => {
    const gateway = fakeGateway('idle')
    const session = fakeSession()
    const inbox = new Inbox(session, {
      inserted: () => {},
      discarded: () => {},
      claimed: () => {},
    })
    const statuses: AgentStatus[] = []
    const agent = new GatewayAgent({
      id: 'session-status-test',
      session,
      inbox,
      ctx: undefined,
      options: { provider: 'codex-plus' },
    } as GatewayAgentHost, gateway)
    agent.bindCtx(recordingCtx(statuses))

    // Attach while idle: current status published once.
    expect(statuses).toEqual(['idle'])

    gateway.turnState = 'running'
    gateway.emit('turn')
    expect(statuses).toEqual(['idle', 'running'])

    // A repeated turn notification with no state change must not re-emit
    // (the agent invariant treats repeated same-status as a no-op violation).
    gateway.emit('turn')
    expect(statuses).toEqual(['idle', 'running'])

    gateway.turnState = 'idle'
    gateway.emit('turn')
    expect(statuses).toEqual(['idle', 'running', 'idle'])
  })

  it('publishes a resumed in-flight turn as running on bind', () => {
    const gateway = fakeGateway('running')
    const session = fakeSession()
    const inbox = new Inbox(session, {
      inserted: () => {},
      discarded: () => {},
      claimed: () => {},
    })
    const statuses: AgentStatus[] = []
    const agent = new GatewayAgent({
      id: 'session-status-resume',
      session,
      inbox,
      ctx: undefined,
      options: { provider: 'codex-plus' },
    } as GatewayAgentHost, gateway)
    agent.bindCtx(recordingCtx(statuses))

    expect(statuses).toEqual(['running'])
  })
})

it('queues a busy followup on the inbox and drains it into its own turn', async () => {
  const gateway = fakeGateway('running')
  const session = fakeSession()
  const inbox = new Inbox(session, {
    inserted: () => {},
    discarded: () => {},
    claimed: () => {},
  })
  const statuses: AgentStatus[] = []
  const agent = new GatewayAgent({
    id: 'session-busy-queue',
    session,
    inbox,
    ctx: undefined,
    options: { provider: 'codex-plus' },
  } as GatewayAgentHost, gateway)
  agent.bindCtx(recordingCtx(statuses))

  const message = createUserMessage({
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  })
  agent.followup(message)

  // Busy: the prompt lands durably on the inbox (host queue strip sees it),
  // and is NOT submitted to the gateway yet.
  expect(inbox.nextTurn).toHaveLength(1)
  expect(gateway.submitted).toHaveLength(0)

  // The active turn completes: the queued prompt drains into a new turn.
  gateway.turnState = 'idle'
  gateway.emit('turn')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(inbox.nextTurn).toHaveLength(0)
  expect(gateway.submitted).toHaveLength(1)
  expect(gateway.submitted[0]?.[0]).toMatchObject({ type: 'text', text: 'hello' })

  // Its turn starts: the claimed prompt is released as the durable surface
  // user/message that opens the new turn.
  gateway.turnState = 'running'
  gateway.emit('notification', { method: 'turn/started', params: {} })
  const userMessages = (session as unknown as { events: Array<{ type: string; data: unknown }> }).events
    .filter((event) => event.type === 'user/message')
  expect(userMessages).toHaveLength(1)
  expect((userMessages[0]?.data as { content: Array<{ type: string; text: string }> }).content[0]?.text).toBe('hello')
})

describe('mid-turn steer step split', () => {
  interface Event {
    type: string
    data: Record<string, unknown>
  }

  it('closes the running step, lands the inserted prompt, and opens the next step', async () => {
    const gateway = fakeGateway('running')
    const session = fakeSession()
    const inbox = new Inbox(session, {
      inserted: () => {},
      discarded: () => {},
      claimed: () => {},
    })
    const agent = new GatewayAgent({
      id: 'session-steer-split',
      session,
      inbox,
      ctx: undefined,
      options: { provider: 'codex-plus' },
    } as GatewayAgentHost, gateway)

    const events = () => (session as unknown as { events: Event[] }).events

    // A turn starts and streams pre-steer reasoning on step 1.
    gateway.emit('notification', { method: 'turn/started', params: { turn: { id: 'turn-1' } } })
    gateway.emit('notification', {
      method: 'item/reasoning/textDelta',
      params: { itemId: 'reason-1', contentIndex: 0, delta: 'before' },
    })

    // The user inserts a prompt while the turn is running.
    const inserted = createUserMessage({
      content: [{ type: 'text', text: '插入的指令' }],
      source: { kind: 'user' },
    })
    agent.steer(inserted)

    // Post-steer output streams.
    gateway.emit('notification', {
      method: 'item/reasoning/textDelta',
      params: { itemId: 'reason-2', contentIndex: 0, delta: 'after' },
    })
    gateway.emit('notification', {
      method: 'item/agentMessage/delta',
      params: { contentIndex: 0, delta: 'answer' },
    })
    gateway.emit('notification', { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })

    const log = events()
    const stepEnds = log.filter(event => event.type === 'step/end').map(event => event.data)
    const stepStarts = log.filter(event => event.type === 'step/start').map(event => event.data)
    const userMessages = log.filter(event => event.type === 'user/message').map(event => event.data)
    const chunks = log.filter(event => event.type === 'assistant/chunk').map(event => event.data)
    const finalMessage = log.find(event => event.type === 'assistant/message')?.data as Record<string, unknown>

    // Step 1 closes at the steer, the inserted prompt lands, step 2 opens,
    // and step 2 closes when the turn completes — in that order.
    expect(stepEnds).toEqual([{ turn: 1, step: 1 }, { turn: 1, step: 2 }])
    expect(stepStarts).toEqual([{ turn: 1, step: 1 }, { turn: 1, step: 2 }])
    expect(userMessages).toHaveLength(1)
    expect((userMessages[0]?.content as Array<{ type: string; text: string }>)[0]?.text).toBe('插入的指令')
    const stepEndSeq = log.indexOf(log.find(event => event.type === 'step/end')!)
    const userSeq = log.indexOf(log.find(event => event.type === 'user/message')!)
    const step2Seq = log.indexOf(log.find(event => event.type === 'step/start' && event.data.step === 2)!)
    expect(stepEndSeq).toBeLessThan(userSeq)
    expect(userSeq).toBeLessThan(step2Seq)

    // Pre-steer chunks stay on step 1; post-steer chunks land on step 2 so
    // the fold renders them AFTER the inserted prompt.
    expect(chunks.filter(chunk => chunk.step === 1)).toHaveLength(1)
    expect(chunks.filter(chunk => chunk.step === 2)).toHaveLength(2)

    // The durable reply settles step 2 (the step that streamed content).
    expect(finalMessage.turn).toBe(1)
    expect(finalMessage.step).toBe(2)
    const message = finalMessage.message as { content: Array<{ type: string; text: string }> }
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toBe('answer')
  })

  it('settles the last content step when a steer races turn completion', async () => {
    const gateway = fakeGateway('running')
    const session = fakeSession()
    const inbox = new Inbox(session, {
      inserted: () => {},
      discarded: () => {},
      claimed: () => {},
    })
    const agent = new GatewayAgent({
      id: 'session-steer-race',
      session,
      inbox,
      ctx: undefined,
      options: { provider: 'codex-plus' },
    } as GatewayAgentHost, gateway)

    const events = () => (session as unknown as { events: Event[] }).events

    gateway.emit('notification', { method: 'turn/started', params: { turn: { id: 'turn-1' } } })
    gateway.emit('notification', {
      method: 'item/reasoning/textDelta',
      params: { itemId: 'reason-1', contentIndex: 0, delta: 'real reply' },
    })
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: '太迟的插入' }],
      source: { kind: 'user' },
    }))
    // The turn completed before the steer produced any new output.
    gateway.emit('notification', { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })

    const log = events()
    const finalMessage = log.find(event => event.type === 'assistant/message')?.data as Record<string, unknown>
    expect(finalMessage.step).toBe(1)
    const message = finalMessage.message as { content: Array<{ type: string; text: string }> }
    const text = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
    expect(text).toBe('real reply')
  })
})
