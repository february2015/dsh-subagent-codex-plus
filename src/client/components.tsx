/**
 * Official-slot entries for the Codex true-gateway: a session-header action
 * (direct-connect badge), a composer-dock status line, and an input-dock
 * queue strip. Status display lives in the official slots; controls live in
 * the floating window (`ControlPanel`).
 *
 * @module dsh-subagent-codex-plus/client/components
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  runGatewayAction,
  togglePanel,
  useGatewayView,
  usePanelState,
} from './gateway-store.ts'
import type { GatewaySessionView } from '../shared/types.ts'

/** Short stable thread label for badges. */
function shortThread(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 10)}…` : threadId
}

const BADGE_BASE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 24,
  padding: '0 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-stroke-strong, rgba(128,128,128,0.35))',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary, #333)',
  fontSize: 12,
  lineHeight: '24px',
  whiteSpace: 'nowrap' as const,
  cursor: 'pointer',
}

function dotColor(view: GatewaySessionView | null): string {
  if (view?.attached) return view.running ? '#e6a23c' : '#2ea043'
  if (view?.threadId !== undefined) return '#9aa4af'
  return '#9aa4af'
}

function badgeLabel(view: GatewaySessionView | null): string {
  if (view?.attached) {
    return `● Codex · ${shortThread(view.threadId ?? '')}${view.running ? ' · 运行中' : ''}`
  }
  if (view?.threadId !== undefined) {
    return `○ Codex · ${shortThread(view.threadId)}（已保存）`
  }
  return '⚡ 直连 Codex'
}

/** Session-header action: the direct-connect badge (status display). */
export function HeaderAction(props: PropsRuntime<'conversation.session.header.actions'>) {
  const { view } = useGatewayView(props.sessionId)
  const panel = usePanelState()
  return (
    <button
      type="button"
      style={{
        ...BADGE_BASE,
        color: view?.attached
          ? 'var(--dsw-alias-label-primary, #333)'
          : 'var(--dsw-alias-label-tertiary, #888)',
        boxShadow: view?.attached ? 'inset 0 0 0 1px ' + dotColor(view) : undefined,
      }}
      title={view?.threadId !== undefined
        ? `Codex 直连线程 ${view.threadId}${view.attached ? '（点击打开控制窗）' : '（重启后自动恢复，点击打开控制窗）'}`
        : '将本会话直连到 Codex（点击打开控制窗）'}
      onClick={() => togglePanel(!panel.open)}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: dotColor(view),
          display: 'inline-block',
        }}
      />
      {badgeLabel(view)}
    </button>
  )
}

const STATUS_LINE = {
  boxSizing: 'border-box' as const,
  color: 'var(--dsw-alias-label-tertiary, #888)',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  lineHeight: '20px',
  margin: '0 auto',
  maxWidth: 'var(--dsh-chat-content-width, 900px)',
  overflow: 'hidden',
  padding: '0 var(--dsh-composer-side-clearance, 16px)',
  textAlign: 'center' as const,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
  width: '100%',
}

function statusText(view: GatewaySessionView | null): string | null {
  if (view?.attached) {
    const parts = [
      `Codex 直连 · ${shortThread(view.threadId ?? '')}`,
      view.running ? '运行中' : '空闲',
    ]
    if (view.queue.length > 0) parts.push(`队列 ${view.queue.length}`)
    return parts.join(' · ')
  }
  if (view?.threadId !== undefined) {
    return `Codex 直连已保存（线程 ${shortThread(view.threadId)}），重启后自动恢复`
  }
  return null
}

/** Composer-dock status line: only when the session is bound or attached. */
export function DockStatus(props: PropsRuntime<'conversation.composer.dock'>) {
  const { view } = useGatewayView(props.sessionId)
  const text = statusText(view)
  if (text === null) return null
  return (
    <div
      style={STATUS_LINE}
      role="status"
      onClick={() => togglePanel(true)}
      title="点击打开 Codex 网关控制窗"
    >
      {text}
    </div>
  )
}

const QUEUE_STRIP = {
  boxSizing: 'border-box' as const,
  margin: '0 auto',
  maxWidth: 'var(--dsh-chat-content-width, 900px)',
  padding: '4px var(--dsh-composer-side-clearance, 16px)',
  width: '100%',
}

const QUEUE_ROW = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: 'var(--dsw-alias-label-secondary, #555)',
  fontSize: 12,
  lineHeight: '20px',
}

/** Input-dock queue strip: pure status display of the Codex-side queue. */
export function QueueDock(props: PropsRuntime<'conversation.input.dock'>) {
  const { view } = useGatewayView(props.sessionId)
  if (view?.attached !== true || view.queue.length === 0) return null
  return (
    <div style={QUEUE_STRIP} role="status">
      {view.queue.map((item, index) => (
        <div key={item.id} style={QUEUE_ROW}>
          <span
            aria-hidden
            style={{
              flex: '0 0 auto',
              width: 16,
              height: 16,
              borderRadius: 4,
              background: 'var(--dsw-alias-fill-strong, rgba(128,128,128,0.2))',
              color: 'var(--dsw-alias-label-tertiary, #888)',
              fontSize: 10,
              lineHeight: '16px',
              textAlign: 'center',
            }}
          >
            {index + 1}
          </span>
          <span
            style={{
              flex: '1 1 auto',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.text}
          </span>
        </div>
      ))}
      <button
        type="button"
        onClick={() => togglePanel(true)}
        style={{
          display: 'block',
          background: 'none',
          border: 'none',
          padding: 0,
          color: 'var(--dsw-alias-label-tertiary, #888)',
          fontSize: 11,
          lineHeight: '18px',
          cursor: 'pointer',
          textAlign: 'left',
          textDecoration: 'underline',
          textUnderlineOffset: 2,
        }}
        title="打开控制窗查看/改序/取消排队消息"
      >
        排队中：新消息在 Codex 忙时自动入队；点击打开悬浮控制窗取消/改序/插入。
      </button>
    </div>
  )
}

/** Shared action helper used by the control panel. */
export function gatewayError(
  sessionId: string,
  action: (api: import('./api.ts').GatewayApi) => Promise<{ ok: boolean; error?: string }>,
): Promise<string | undefined> {
  return runGatewayAction(sessionId, action)
}
