/**
 * Floating control window for the Codex true-gateway, seated in the
 * official `shell.overlay` layer (root-scoped, click-through unless the
 * entry opts into pointer events). Controls live here per the user's
 * decision: attach/detach (gateway switch), queue cancel/reorder, steer
 * insertion, and turn interruption. The window tracks the currently
 * selected session through the framework `useSessions` feed.
 *
 * @module dsh-subagent-codex-plus/client/control-panel
 */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  movePanel,
  runGatewayAction,
  togglePanel,
  useGatewayView,
  usePanelState,
} from './gateway-store.ts'
import type { GatewaySessionView } from '../shared/types.ts'

const PANEL_WIDTH = 320

const PANEL_STYLE = {
  position: 'fixed',
  zIndex: 9999,
  width: PANEL_WIDTH,
  boxSizing: 'border-box' as const,
  pointerEvents: 'auto' as const,
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-stroke-strong, rgba(128,128,128,0.4))',
  background: 'var(--dsw-alias-surface-raised, #ffffff)',
  color: 'var(--dsw-alias-label-primary, #222)',
  boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
  fontFamily: 'var(--dsh-font-sans, -apple-system, "PingFang SC", sans-serif)',
  fontSize: 13,
  overflow: 'hidden',
} as const

const SECTION = {
  padding: '10px 12px',
  borderTop: '1px solid var(--dsw-alias-stroke-subtle, rgba(128,128,128,0.15))',
}

const SECTION_TITLE = {
  color: 'var(--dsw-alias-label-secondary, #555)',
  fontSize: 11,
  fontWeight: 600,
  marginBottom: 6,
}

const BUTTON = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  height: 26,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-stroke-strong, rgba(128,128,128,0.4))',
  background: 'var(--dsw-alias-fill-weak, rgba(128,128,128,0.08))',
  color: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}

const PRIMARY_BUTTON = {
  ...BUTTON,
  borderColor: 'var(--dsw-alias-accent, #3b82f6)',
  background: 'var(--dsw-alias-accent, #3b82f6)',
  color: '#fff',
}

const DANGER_BUTTON = {
  ...BUTTON,
  borderColor: 'var(--dsw-alias-danger, #d64545)',
  color: 'var(--dsw-alias-danger, #d64545)',
}

const INPUT = {
  boxSizing: 'border-box' as const,
  width: '100%',
  height: 26,
  padding: '0 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-stroke-strong, rgba(128,128,128,0.4))',
  background: 'var(--dsw-alias-surface-raised, #fff)',
  color: 'inherit',
  fontSize: 12,
}

function shortThread(threadId: string): string {
  return threadId.length > 16 ? `${threadId.slice(0, 14)}…` : threadId
}

function statusBadge(view: GatewaySessionView | null): string {
  if (view?.attached) return view.running ? '运行中' : '空闲'
  return '未直连'
}

/** Floating gateway control window (shell.overlay entry). */
export function ControlPanel(props: PropsRuntime<'shell.overlay'>) {
  const panel = usePanelState()
  const sessionId: string | undefined = props.useSessions((state) => state.current)
  const { view, loading, error: pollError } = useGatewayView(sessionId)
  const [attachThread, setAttachThread] = useState('')
  const [steerText, setSteerText] = useState('')
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { dx: event.clientX - panel.x, dy: event.clientY - panel.y }
    ;(event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId)
  }, [panel.x, panel.y])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current === null) return
    movePanel(
      Math.max(0, Math.min(window.innerWidth - PANEL_WIDTH, event.clientX - drag.current.dx)),
      Math.max(0, event.clientY - drag.current.dy),
    )
  }, [])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null
    ;(event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId)
  }, [])

  const run = useCallback(async (
    action: (api: import('./api.ts').GatewayApi) => Promise<{ ok: boolean; error?: string }>,
  ): Promise<boolean> => {
    if (sessionId === undefined) return false
    const error = await runGatewayAction(sessionId, action)
    setActionError(error)
    return error === undefined
  }, [sessionId])

  if (!panel.open) return null

  const queue = view?.attached === true ? view.queue : []

  const reorder = async (index: number, direction: -1 | 1): Promise<void> => {
    const target = index + direction
    if (target < 0 || target >= queue.length) return
    const ids = queue.map((item) => item.id)
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    await run((api) => api.queueReorder(sessionId!, ids))
  }

  return (
    <div
      role="dialog"
      aria-label="Codex 直连网关控制"
      style={{ ...PANEL_STYLE, left: panel.x, top: panel.y }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          cursor: 'grab',
          userSelect: 'none',
          borderBottom: '1px solid var(--dsw-alias-stroke-subtle, rgba(128,128,128,0.15))',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="拖动移动窗口"
      >
        <span aria-hidden style={{ fontSize: 14 }}>🔗</span>
        <span style={{ fontWeight: 600 }}>Codex 直连网关</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="关闭"
          style={{ ...BUTTON, height: 22, padding: '0 8px' }}
          onClick={() => togglePanel(false)}
        >
          ✕
        </button>
      </div>

      {sessionId === undefined ? (
        <div style={SECTION}>当前没有选中会话。</div>
      ) : (
        <>
          <div style={SECTION}>
            <div style={SECTION_TITLE}>网关开关</div>
            {view?.attached === true ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--dsw-alias-label-secondary, #555)' }}>
                  已直连线程 <code style={{ fontSize: 11 }}>{shortThread(view.threadId ?? '')}</code>
                </span>
                <button
                  type="button"
                  style={DANGER_BUTTON}
                  onClick={() => { void run((api) => api.detach(sessionId)) }}
                >
                  断开直连
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  style={INPUT}
                  placeholder="恢复已有线程 id（留空 = 新建）"
                  value={attachThread}
                  onChange={(event) => setAttachThread(event.currentTarget.value)}
                />
                <button
                  type="button"
                  style={PRIMARY_BUTTON}
                  onClick={() => {
                    void run((api) => api.attach(sessionId, attachThread.trim() === '' ? undefined : attachThread.trim()))
                  }}
                >
                  {view?.threadId !== undefined ? '重新直连（已保存线程）' : '直连 Codex'}
                </button>
                {view?.threadId !== undefined && (
                  <div style={{ color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 11 }}>
                    已保存线程 <code>{shortThread(view.threadId)}</code>，重启后自动恢复
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={SECTION}>
            <div style={SECTION_TITLE}>状态</div>
            <div style={{ color: 'var(--dsw-alias-label-secondary, #555)', fontSize: 12, lineHeight: '20px' }}>
              会话 <code style={{ fontSize: 11 }}>{shortThread(sessionId)}</code>
              {loading && ' · 载入中'}
            </div>
            <div style={{ color: 'var(--dsw-alias-label-secondary, #555)', fontSize: 12, lineHeight: '20px' }}>
              状态：{statusBadge(view)} · 队列 {queue.length}
            </div>
            {view?.attached === true && view.running && (
              <button
                type="button"
                style={DANGER_BUTTON}
                onClick={() => { void run((api) => api.cancel(sessionId)) }}
              >
                中断当前
              </button>
            )}
          </div>

          {queue.length > 0 && (
            <div style={SECTION}>
              <div style={SECTION_TITLE}>排队列表</div>
              {queue.map((item, index) => (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
                  <span
                    style={{
                      flex: '1 1 auto',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: 12,
                    }}
                    title={item.text}
                  >
                    {index + 1}. {item.text}
                  </span>
                  <button
                    type="button"
                    style={{ ...BUTTON, height: 20, padding: '0 6px' }}
                    aria-label="上移"
                    disabled={index === 0}
                    onClick={() => { void reorder(index, -1) }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    style={{ ...BUTTON, height: 20, padding: '0 6px' }}
                    aria-label="下移"
                    disabled={index === queue.length - 1}
                    onClick={() => { void reorder(index, 1) }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    style={{ ...DANGER_BUTTON, height: 20, padding: '0 6px' }}
                    aria-label="取消该条"
                    onClick={() => { void run((api) => api.queueDelete(sessionId, item.id)) }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={SECTION}>
            <div style={SECTION_TITLE}>直接插入（steer）</div>
            <textarea
              rows={3}
              style={{ ...INPUT, height: 'auto', padding: '6px 8px', resize: 'vertical', lineHeight: '18px' }}
              placeholder="插入一条消息，直接改变当前 Codex 回合的方向（不等队列）"
              value={steerText}
              onChange={(event) => setSteerText(event.currentTarget.value)}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button
                type="button"
                style={PRIMARY_BUTTON}
                disabled={steerText.trim() === '' || view?.attached !== true}
                onClick={() => {
                  const text = steerText.trim()
                  if (text === '') return
                  void run((api) => api.steer(sessionId, text)).then((ok) => {
                    if (ok) setSteerText('')
                  })
                }}
              >
                插入
              </button>
            </div>
          </div>

          {(actionError ?? pollError) !== undefined && (
            <div style={{ ...SECTION, color: 'var(--dsw-alias-danger, #d64545)', fontSize: 11 }}>
              {actionError ?? pollError}
            </div>
          )}
        </>
      )}
    </div>
  )
}
