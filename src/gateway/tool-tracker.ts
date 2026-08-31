/**
 * Active tool-call tracking for the long-tool heartbeat. The Codex
 * app-server emits `item/started`/`item/completed` for every item; tool
 * items (`functionCall`/`dynamicToolCall`) bracket one tool execution. The
 * gateway keeps the currently-executing tool so the UI can show "正在执行
 * shell_command · 已运行 X 分 Y 秒" while a long local command runs —
 * without that heartbeat a multi-minute tool execution looks like a hang.
 *
 * @module dsh-subagent-codex-plus/gateway/tool-tracker
 */

/** A Codex tool call currently executing inside the active turn. */
export interface ActiveTool {
  /** Tool name as reported by Codex (e.g. `shell_command`). */
  readonly name: string
  /** Epoch ms when the tool call started; clients derive the elapsed time. */
  readonly startedAt: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isToolType(type: unknown): boolean {
  return type === 'commandExecution' || type === 'functionCall' || type === 'dynamicToolCall'
}

function toolNameOf(item: Record<string, unknown>): string {
  if (item.type === 'commandExecution') return 'shell_command'
  const tool = item.tool
  if (typeof tool === 'string' && tool.length > 0) return tool
  const nested = asRecord(tool)
  if (nested !== undefined && typeof nested.name === 'string' && nested.name.length > 0) {
    return nested.name
  }
  const name = item.name
  return typeof name === 'string' && name.length > 0 ? name : 'tool'
}

/** Map one `item/started` notification onto an active-tool record, if tool. */
function startedTool(params: Record<string, unknown>, now: number): ActiveTool | undefined {
  const item = asRecord(params.item)
  if (item === undefined || !isToolType(item.type)) return undefined
  return { name: toolNameOf(item), startedAt: now }
}

/** Whether one `item/completed` notification closes a tool execution. */
function completedTool(params: Record<string, unknown>): boolean {
  const item = asRecord(params.item)
  return item !== undefined && isToolType(item.type)
}

/**
 * Tracks the currently-executing Codex tool call. Parallel tool starts stack
 * on a counter so the first completion does not clear a still-running tool;
 * the counter also absorbs a completion whose start was missed (e.g. after a
 * mid-turn reconnect) without going negative.
 */
export class ActiveToolTracker {
  private count = 0
  private active: ActiveTool | undefined

  /** The tool call currently executing, if any. */
  get current(): ActiveTool | undefined {
    return this.active
  }

  /** Feed an `item/started` notification. */
  onItemStarted(params: Record<string, unknown>, now = Date.now()): void {
    const started = startedTool(params, now)
    if (started === undefined) return
    this.count += 1
    if (this.active === undefined) this.active = started
  }

  /** Feed an `item/completed` notification. */
  onItemCompleted(params: Record<string, unknown>): void {
    if (!completedTool(params)) return
    this.count = Math.max(0, this.count - 1)
    if (this.count === 0) this.active = undefined
  }

  /** Clear on turn boundaries so a stale tool never sticks. */
  reset(): void {
    this.count = 0
    this.active = undefined
  }
}
