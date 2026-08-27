import { useEffect, useRef, useState } from 'react'
import { Terminal, type IDisposable } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SshApi, TerminalConnection } from '@linxin666/dsh-ssh/src/client/api.ts'
import type { SshHostSummary } from '@linxin666/dsh-ssh/src/protocol.ts'
import { XTERM_CSS } from '@linxin666/dsh-ssh/src/client/panel/xterm.css.ts'
import { errorMessage, tt } from '@linxin666/dsh-ssh/src/client/panel/helpers.ts'
import css from '@linxin666/dsh-ssh/src/client/panel/panel.module.css'

interface LinkedTerminalTabProps {
  api: SshApi
  presetAlias?: string
  requestId?: number
  autoConnect?: boolean
}

type TerminalStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; alias: string }
  | { kind: 'exited'; alias: string; detail?: string }
  | { kind: 'error'; detail: string }

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
 * TerminalTab-compatible view with one addition: a Linked SSH header action can
 * open the SSH panel and immediately connect the session's bound alias.
 */
export function LinkedTerminalTab({ api, presetAlias, requestId, autoConnect = false }: LinkedTerminalTabProps) {
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [alias, setAlias] = useState(presetAlias ?? '')
  const [status, setStatus] = useState<TerminalStatus>({ kind: 'idle' })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const connRef = useRef<TerminalConnection | null>(null)
  const dataSubRef = useRef<IDisposable | null>(null)
  const lastAutoRequestRef = useRef<number | undefined>(undefined)

  useEffect(() => { ensureXtermCss() }, [])

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const list = await api.listHosts()
        if (!disposed) setHosts(list)
      } catch (cause) {
        if (!disposed) setStatus({ kind: 'error', detail: errorMessage(cause) })
      }
    })()
    return () => { disposed = true }
  }, [api])

  useEffect(() => {
    if (presetAlias !== undefined) setAlias(presetAlias)
  }, [presetAlias, requestId])

  const teardown = (): void => {
    const connection = connRef.current
    connRef.current = null
    if (connection !== null) {
      connection.onReady = undefined
      connection.onOutput = undefined
      connection.onExit = undefined
      connection.close()
    }
    dataSubRef.current?.dispose()
    dataSubRef.current = null
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
  }

  useEffect(() => () => { teardown() }, [])

  useEffect(() => {
    const onResize = (): void => {
      const term = termRef.current
      const fit = fitRef.current
      if (term === null || fit === null) return
      fit.fit()
      connRef.current?.resize(term.cols, term.rows)
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])

  const connect = (explicitAlias?: string): void => {
    const target = explicitAlias ?? alias
    const container = containerRef.current
    if (target === '' || container === null) return
    if (status.kind === 'connecting' || status.kind === 'connected') {
      const current = status.kind === 'connected' ? status.alias : undefined
      if (current === target) return
      teardown()
    } else {
      teardown()
    }

    setAlias(target)
    setStatus({ kind: 'connecting' })
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Consolas, "Liberation Mono", monospace',
      theme: { background: '#0b0e14', foreground: '#d8dee9', cursor: '#a3b8d0' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    const connection = api.openTerminal(target, term.cols, term.rows)
    termRef.current = term
    fitRef.current = fit
    connRef.current = connection
    let settled = false
    dataSubRef.current = term.onData(data => { connection.send(data) })
    connection.onReady = () => { setStatus({ kind: 'connected', alias: target }) }
    connection.onOutput = data => { term.write(data) }
    connection.onExit = (code, error) => {
      if (settled) return
      settled = true
      dataSubRef.current?.dispose()
      dataSubRef.current = null
      term.options.disableStdin = true
      connRef.current = null
      setStatus({ kind: 'exited', alias: target, ...(error === undefined ? {} : { detail: error }) })
    }
  }

  // A new requestId means the header explicitly asked for this terminal. Run
  // after commit so containerRef is ready; presetAlias is passed directly to
  // avoid waiting for React's alias state update.
  useEffect(() => {
    if (!autoConnect || presetAlias === undefined || requestId === undefined) return
    if (lastAutoRequestRef.current === requestId) return
    lastAutoRequestRef.current = requestId
    const frame = window.requestAnimationFrame(() => { connect(presetAlias) })
    return () => window.cancelAnimationFrame(frame)
    // status is intentionally not a dependency: requestId is the command edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect, presetAlias, requestId])

  const disconnect = (): void => {
    teardown()
    setStatus({ kind: 'idle' })
  }

  const active = status.kind === 'connecting' || status.kind === 'connected'

  return (
    <div className={css.termBody}>
      <div className={css.controls}>
        <select className={css.input} value={alias} onChange={event => { setAlias(event.target.value) }}>
          <option value="">{tt('terminal.selectHost')}</option>
          {hosts.map(host => <option key={host.alias} value={host.alias}>{host.alias} ({host.host})</option>)}
        </select>
        <button type="button" className={css.primaryButton} disabled={alias === '' || active} onClick={() => connect()}>{tt('terminal.connect')}</button>
        <button type="button" className={css.ghostButton} disabled={!active} onClick={disconnect}>{tt('terminal.disconnect')}</button>
      </div>
      {status.kind === 'connecting' && <div className={css.banner} data-kind="info">{tt('terminal.connecting')}</div>}
      {status.kind === 'connected' && <div className={css.banner} data-kind="ok">{tt('terminal.ready', { alias: status.alias })}</div>}
      {status.kind === 'exited' && (
        <div className={css.banner} data-kind="info">{tt('terminal.exited', { alias: status.alias })}{status.detail !== undefined ? ' (' + status.detail + ')' : ''}</div>
      )}
      {status.kind === 'error' && <div className={css.banner} data-kind="error">{tt('terminal.error', { error: status.detail })}</div>}
      <div className={css.termWrap}>
        <div ref={containerRef} className={css.termContainer} />
        {status.kind === 'idle' && (
          <div className={css.termPlaceholder}>{hosts.length === 0 ? tt('hosts.empty') : tt('terminal.placeholder')}</div>
        )}
      </div>
    </div>
  )
}
