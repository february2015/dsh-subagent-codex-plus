import { describe, expect, it } from 'vitest'
import { ActiveToolTracker } from '../src/gateway/tool-tracker.ts'

describe('ActiveToolTracker long-tool heartbeat', () => {
  it('records a functionCall item/started as the active tool', () => {
    const tracker = new ActiveToolTracker()
    tracker.onItemStarted({ item: { type: 'functionCall', name: 'shell_command', arguments: '{}' } }, 1_700_000_000_000)
    expect(tracker.current).toEqual({ name: 'shell_command', startedAt: 1_700_000_000_000 })
  })

  it('reads dynamicToolCall tool objects and clears on item/completed', () => {
    const tracker = new ActiveToolTracker()
    tracker.onItemStarted({ item: { type: 'dynamicToolCall', tool: { type: 'function', name: 'apply_patch' } } }, 42)
    expect(tracker.current?.name).toBe('apply_patch')
    tracker.onItemCompleted({ item: { type: 'dynamicToolCall', id: 'call-1' } })
    expect(tracker.current).toBeUndefined()
  })

  it('ignores non-tool items and completions', () => {
    const tracker = new ActiveToolTracker()
    tracker.onItemStarted({ item: { type: 'reasoning' } })
    tracker.onItemStarted({ item: { type: 'userMessage' } })
    tracker.onItemStarted({})
    expect(tracker.current).toBeUndefined()
    tracker.onItemCompleted({ item: { type: 'agentMessage' } })
    expect(tracker.current).toBeUndefined()
  })

  it('keeps the first tool while parallel tools run and clears on the last completion', () => {
    const tracker = new ActiveToolTracker()
    tracker.onItemStarted({ item: { type: 'functionCall', name: 'shell_command' } }, 100)
    tracker.onItemStarted({ item: { type: 'functionCall', name: 'apply_patch' } }, 200)
    // Still running until BOTH complete; the heartbeat keeps the original start.
    expect(tracker.current).toEqual({ name: 'shell_command', startedAt: 100 })
    tracker.onItemCompleted({ item: { type: 'functionCall', id: 'a' } })
    expect(tracker.current).toEqual({ name: 'shell_command', startedAt: 100 })
    tracker.onItemCompleted({ item: { type: 'functionCall', id: 'b' } })
    expect(tracker.current).toBeUndefined()
  })

  it('absorbs a completion whose start was missed (reconnect) without a stale tool', () => {
    const tracker = new ActiveToolTracker()
    tracker.onItemCompleted({ item: { type: 'functionCall', id: 'x' } })
    expect(tracker.current).toBeUndefined()
    // A later real tool start still shows.
    tracker.onItemStarted({ item: { type: 'functionCall', name: 'shell_command' } }, 500)
    expect(tracker.current?.name).toBe('shell_command')
  })

  it('resets on turn boundaries', () => {
    const tracker = new ActiveToolTracker()
    tracker.onItemStarted({ item: { type: 'functionCall', name: 'shell_command' } })
    expect(tracker.current).toBeDefined()
    tracker.reset()
    expect(tracker.current).toBeUndefined()
  })
})
