import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type IDisposable } from '@xterm/xterm'
import { listHosts, type SshHostSummary } from './api.ts'
import {
  SshApi,
  XTERM_CSS,
  type TerminalConnectionBridge,
} from './ssh-panel-bridge.js'
import { useLinkedSshAlias } from './linked-ssh-store.ts'

interface SessionSshTerminalViewProps {
  sessionId: string
}

type TerminalStatus =
  | { kind: 'idle' }
  | { kind: 'connecting'; alias: string }
  | { kind: 'connected'; alias: string }
  | { kind: 'exited'; alias: string; detail?: string }
  | { kind: 'error'; alias?: string; detail: string }

let xtermCssInjected = false

function ensureXtermCss(): void {
  if (xtermCssInjected || typeof document === 'undefined') return
  xtermCssInjected = true
  if (document.querySelector('style[data-dsh-ssh-xterm]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshSshXterm = ''
  style.textContent = XTERM_CSS
  document.head.appendChild(style)
}

/**
 * Session-scoped SSH terminal for the conversation view ring.
 *
 * The target is intentionally NOT selectable here. It always follows the
 * session's Linked SSH binding, which is changed only by the header control.
 * This keeps Agent context, SSH Files and the terminal on one authoritative
 * remote host instead of allowing each surface to drift to a different host.
 */
export function SessionSshTerminalView({ sessionId }: SessionSshTerminalViewProps) {
  const linkedAlias = useLinkedSshAlias(sessionId)
  const [host, setHost] = useState<SshHostSummary | null>(null)
  const [status, setStatus] = useState<TerminalStatus>({ kind: 'idle' })

  const apiRef = useRef<SshApi | null>(null)
  if (apiRef.current === null) apiRef.current = new SshApi()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const connectionRef = useRef<TerminalConnectionBridge | null>(null)
  const inputSubscriptionRef = useRef<IDisposable | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const generationRef = useRef(0)

  const teardown = (): void => {
    generationRef.current += 1
    const connection = connectionRef.current
    connectionRef.current = null
    if (connection !== null) {
      connection.onReady = undefined
      connection.onOutput = undefined
      connection.onExit = undefined
      connection.close()
    }
    inputSubscriptionRef.current?.dispose()
    inputSubscriptionRef.current = null
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
    const container = containerRef.current
    if (container !== null) container.replaceChildren()
  }

  const fitTerminal = (): void => {
    const term = termRef.current
    const fit = fitRef.current
    if (term === null || fit === null) return
    try {
      fit.fit()
      connectionRef.current?.resize(term.cols, term.rows)
    } catch {
      // The view may be transitioning in/out of the active tab. A later
      // ResizeObserver/requestAnimationFrame pass will fit it once visible.
    }
  }

  const connectTo = (alias: string): void => {
    const container = containerRef.current
    if (container === null) return

    teardown()
    const generation = generationRef.current
    setStatus({ kind: 'connecting', alias })

    try {
      const term = new Terminal({
        convertEol: false,
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Menlo, Consolas, "Liberation Mono", monospace',
        theme: {
          background: '#0b0e14',
          foreground: '#d8dee9',
          cursor: '#a3b8d0',
        },
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)

      termRef.current = term
      fitRef.current = fit

      window.requestAnimationFrame(() => {
        if (generation !== generationRef.current) return
        try { fit.fit() } catch { /* view may still be settling */ }
        const connection = apiRef.current!.openTerminal(alias, term.cols, term.rows)
        if (generation !== generationRef.current) {
          connection.close()
          return
        }
        connectionRef.current = connection
        inputSubscriptionRef.current = term.onData(data => { connection.send(data) })
        connection.onReady = () => {
          if (generation === generationRef.current) setStatus({ kind: 'connected', alias })
        }
        connection.onOutput = data => {
          if (generation === generationRef.current) term.write(data)
        }
        connection.onExit = (_code, error) => {
          if (generation !== generationRef.current) return
          inputSubscriptionRef.current?.dispose()
          inputSubscriptionRef.current = null
          connectionRef.current = null
          term.options.disableStdin = true
          setStatus({ kind: 'exited', alias, ...(error === undefined ? {} : { detail: error }) })
        }
        fitTerminal()
      })

      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => { fitTerminal() })
        observer.observe(container)
        resizeObserverRef.current = observer
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setStatus({ kind: 'error', alias, detail })
    }
  }

  useEffect(() => {
    ensureXtermCss()
    return () => { teardown() }
  }, [])

  useEffect(() => {
    let disposed = false
    setHost(null)
    if (linkedAlias === null) return () => { disposed = true }
    void listHosts().then(
      hosts => {
        if (!disposed) setHost(hosts.find(item => item.alias === linkedAlias) ?? null)
      },
      () => {
        if (!disposed) setHost(null)
      },
    )
    return () => { disposed = true }
  }, [linkedAlias])

  // The Linked SSH selector in the session header is the single source of
  // truth. When it changes while this view is open, disconnect the old shell
  // and connect the newly selected server automatically.
  useEffect(() => {
    teardown()
    if (linkedAlias === null) {
      setStatus({ kind: 'idle' })
      return
    }
    const frame = window.requestAnimationFrame(() => { connectTo(linkedAlias) })
    return () => { window.cancelAnimationFrame(frame) }
  }, [linkedAlias, sessionId])

  const active = status.kind === 'connecting' || status.kind === 'connected'
  const targetLabel = linkedAlias === null
    ? '未连接服务器'
    : host === null
      ? linkedAlias
      : `${linkedAlias} (${host.user}@${host.host}:${host.port})`

  return (
    <div style={{
      boxSizing: 'border-box',
      width: '100%',
      minHeight: '62vh',
      height: '100%',
      padding: '12px 14px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      overflow: 'hidden',
    }}>
      <div style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>SSH 终端</div>
          <div style={{ marginTop: 3, fontSize: 12, opacity: .66, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            当前服务器：{targetLabel}
          </div>
        </div>

        {linkedAlias !== null ? (
          <>
            <button
              type="button"
              disabled={active}
              onClick={() => { connectTo(linkedAlias) }}
              style={{
                border: '1px solid rgba(128,128,128,.35)',
                borderRadius: 6,
                background: 'transparent',
                color: 'inherit',
                padding: '5px 10px',
                cursor: active ? 'default' : 'pointer',
                opacity: active ? .5 : 1,
              }}
            >
              连接
            </button>
            <button
              type="button"
              disabled={!active}
              onClick={() => {
                teardown()
                setStatus({ kind: 'idle' })
              }}
              style={{
                border: '1px solid rgba(128,128,128,.35)',
                borderRadius: 6,
                background: 'transparent',
                color: 'inherit',
                padding: '5px 10px',
                cursor: active ? 'pointer' : 'default',
                opacity: active ? 1 : .5,
              }}
            >
              断开
            </button>
          </>
        ) : null}
      </div>

      {linkedAlias === null ? (
        <div style={{
          flex: 1,
          minHeight: 320,
          border: '1px dashed rgba(128,128,128,.35)',
          borderRadius: 8,
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          textAlign: 'center',
          opacity: .68,
          fontSize: 13,
        }}>
          当前会话还没有连接 SSH 服务器。请在页面顶部“标准模式”右侧的“连接服务器”中选择服务器。
        </div>
      ) : (
        <>
          {status.kind === 'connecting' ? (
            <div style={{ flex: 'none', padding: '7px 9px', borderRadius: 6, background: 'rgba(79,129,255,.10)', fontSize: 12 }}>
              正在连接 {status.alias}…
            </div>
          ) : null}
          {status.kind === 'connected' ? (
            <div style={{ flex: 'none', padding: '7px 9px', borderRadius: 6, background: 'rgba(46,160,67,.10)', fontSize: 12 }}>
              已连接 {status.alias}
            </div>
          ) : null}
          {status.kind === 'exited' ? (
            <div style={{ flex: 'none', padding: '7px 9px', borderRadius: 6, background: 'rgba(128,128,128,.10)', fontSize: 12 }}>
              {status.alias} 的终端已断开{status.detail ? `：${status.detail}` : ''}
            </div>
          ) : null}
          {status.kind === 'error' ? (
            <div style={{ flex: 'none', padding: '7px 9px', borderRadius: 6, background: 'rgba(220,70,70,.10)', color: '#d9534f', fontSize: 12 }}>
              SSH 终端错误：{status.detail}
            </div>
          ) : null}

          <div style={{
            flex: 1,
            minHeight: 360,
            borderRadius: 8,
            overflow: 'hidden',
            background: '#0b0e14',
            position: 'relative',
          }}>
            <div ref={containerRef} style={{ position: 'absolute', inset: 0, padding: 6 }} />
            {status.kind === 'idle' ? (
              <div style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                color: '#8b949e',
                pointerEvents: 'none',
                fontSize: 13,
              }}>
                当前终端已断开。服务器切换请使用页面顶部的 SSH 连接按钮。
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}
