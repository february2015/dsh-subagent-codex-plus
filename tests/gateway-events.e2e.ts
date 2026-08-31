import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexGateway } from '../src/gateway/gateway.ts'
import { GatewayEventForwarder } from '../src/gateway/events.ts'
import type { CodexGatewayNotification } from '../src/gateway/wire.ts'
import { startResponsesFixture } from './responses-fixture.ts'

const codexPackageJson = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const codexPackage = JSON.parse(readFileSync(codexPackageJson, 'utf8')) as {
  version: string
  bin: { codex: string }
}
const codexEntry = resolve(dirname(codexPackageJson), codexPackage.bin.codex)

const roots: string[] = []
const gateways: CodexGateway[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface RecordedEvent {
  readonly type: string
  readonly data: unknown
}

function fakeSession(events: RecordedEvent[]): { append(type: string, data: unknown): unknown; events: unknown[] } {
  return {
    events: events as unknown[],
    append(type: string, data: unknown): unknown {
      const event = { type, data, seq: events.length + 1, time: Date.now() }
      events.push(event as RecordedEvent)
      return event
    },
  } as unknown as { append(type: string, data: unknown): unknown; events: unknown[] }
}

describe('gateway event forwarder with a real codex app-server', () => {
  it('forwards a real shell tool call as tool/call (commandExecution wire shape)', async () => {
    const nonce = `PROBE_${randomUUID()}`
    const fixture = await startResponsesFixture([
      {
        kind: 'functionCall',
        name: 'shell_command',
        arguments: { command: `echo ${nonce}` },
      },
      { kind: 'complete', text: `Shell output: ${nonce}` },
    ])
    const root = mkdtempSync(join(tmpdir(), 'dsh-gateway-e2e-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const codexHome = join(root, 'codex-home')
    mkdirSync(workspace)
    mkdirSync(codexHome)
    writeFileSync(join(codexHome, 'config.toml'), [
      'model = "fixture-model"',
      'model_provider = "fixture-e2e"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'disable_response_storage = true',
      'check_for_update_on_startup = false',
      '',
      '[model_providers.fixture-e2e]',
      'name = "Fixture E2E provider"',
      `base_url = "${fixture.baseUrl}"`,
      'env_key = "FIXTURE_API_KEY"',
      'wire_api = "responses"',
      'requires_openai_auth = false',
      '',
      '[analytics]',
      'enabled = false',
      '',
    ].join('\n'))
    const env = {
      FIXTURE_API_KEY: 'fixture-key',
      CODEX_HOME: codexHome,
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'xdg-config'),
      PATH: root,
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '127.0.0.1,localhost',
    }

    const gateway = new CodexGateway({
      cwd: workspace,
      argv: [process.execPath, codexEntry, 'app-server', '--stdio'],
      env,
      onStderr: (line) => { process.stderr.write(`[codex-app-server] ${line}\n`) },
    })
    gateways.push(gateway)
    const threadId = await gateway.start()
    expect(threadId.length).toBeGreaterThan(0)

    const recorded: RecordedEvent[] = []
    const forwarder = new GatewayEventForwarder(fakeSession(recorded) as never)
    const notifications: CodexGatewayNotification[] = []
    gateway.on('notification', (notification) => {
      notifications.push(notification)
      forwarder.forward(notification)
    })

    const completed = new Promise<void>((resolveTurn) => {
      const onTurn = (state: 'idle' | 'running'): void => {
        if (state === 'idle') {
          gateway.off('turn', onTurn)
          resolveTurn()
        }
      }
      gateway.on('turn', onTurn)
    })
    const outcome = await gateway.submit([
      { type: 'text', text: `Run the shell command \`echo ${nonce}\` and reply with its exact output.`, text_elements: [] },
    ])
    expect(outcome.kind).toBe('turn')
    await completed

    const toolCalls = recorded.filter(event => event.type === 'tool/call')
    expect(toolCalls.length).toBeGreaterThan(0)
    const toolCall = toolCalls[0]?.data as { name: string; arguments: string; turn: number; step: number }
    expect(toolCall.name).toBe('shell_command')
    expect(toolCall.arguments).toContain(nonce)

    const turns = recorded.filter(event => event.type === 'turn/start')
    const turnEnds = recorded.filter(event => event.type === 'turn/end')
    expect(turns).toHaveLength(1)
    expect(turnEnds).toHaveLength(1)
    const turnStart = turns[0]?.data as { turn: number }
    const turnEnd = turnEnds[0]?.data as { turn: number }
    expect(turnStart.turn).toBe(turnEnd.turn)
    expect(turnStart.turn).toBeGreaterThan(0)

    // The durable reply settles BEFORE turn/end so the chat fold renders a
    // normal completed bubble instead of a synthetic interrupted node.
    const assistant = recorded.filter(event => event.type === 'assistant/message')
    expect(assistant).toHaveLength(1)
    const assistantSeq = recorded.indexOf(assistant[0]!)
    const turnEndSeq = recorded.indexOf(turnEnds[0]!)
    expect(assistantSeq).toBeLessThan(turnEndSeq)

    const toolSeq = recorded.indexOf(toolCalls[0]!)
    expect(toolSeq).toBeGreaterThan(recorded.indexOf(turns[0]!))
    expect(toolSeq).toBeLessThan(turnEndSeq)

    // The reasoning/text deltas were streamed as log-only assistant/chunk.
    const chunks = recorded.filter(event => event.type === 'assistant/chunk')
    expect(chunks.length).toBeGreaterThan(0)
    await fixture.close()
  }, 120_000)
})
