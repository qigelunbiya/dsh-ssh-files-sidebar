import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal, type IDisposable } from '@xterm/xterm'
import { listHosts, type SshHostSummary } from './api.ts'
import { SshApi, XTERM_CSS, type TerminalConnectionBridge } from './ssh-panel-bridge.js'
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

interface ContextMenuState { x: number; y: number }
interface SearchResultState { index: number; count: number }

const DEFAULT_FONT_SIZE = 13
const MIN_FONT_SIZE = 9
const MAX_FONT_SIZE = 26
const FONT_STORAGE_KEY = 'dsh-ssh-files-sidebar:ssh-terminal-font-size:v1'

const SEARCH_DECORATIONS = {
  matchBackground: '#394150',
  matchBorder: '#657087',
  matchOverviewRuler: '#7f8da8',
  activeMatchBackground: '#a66f16',
  activeMatchBorder: '#f0b44c',
  activeMatchColorOverviewRuler: '#f0b44c',
} as const

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

function readFontSize(): number {
  if (typeof window === 'undefined') return DEFAULT_FONT_SIZE
  try {
    const value = Number(window.localStorage.getItem(FONT_STORAGE_KEY))
    return Number.isFinite(value) && value >= MIN_FONT_SIZE && value <= MAX_FONT_SIZE
      ? Math.round(value)
      : DEFAULT_FONT_SIZE
  } catch {
    return DEFAULT_FONT_SIZE
  }
}

function writeFontSize(value: number): void {
  try { window.localStorage.setItem(FONT_STORAGE_KEY, String(value)) } catch { /* storage unavailable */ }
}

function clampContextMenuPoint(x: number, y: number): ContextMenuState {
  const width = 238
  const height = 330
  const margin = 8
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
  }
}

function legacyCopy(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  textarea.remove()
  return ok
}

/**
 * Session-scoped SSH terminal. The host is intentionally not selectable here:
 * the session header Linked SSH binding is the single source of truth shared by
 * Agent context, SSH Files and this terminal.
 */
export function SessionSshTerminalView({ sessionId }: SessionSshTerminalViewProps) {
  const linkedAlias = useLinkedSshAlias(sessionId)
  const [host, setHost] = useState<SshHostSummary | null>(null)
  const [status, setStatus] = useState<TerminalStatus>({ kind: 'idle' })
  const [fontSize, setFontSizeState] = useState(readFontSize)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [hasSelection, setHasSelection] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  const [searchResult, setSearchResult] = useState<SearchResultState>({ index: -1, count: 0 })
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  const apiRef = useRef<SshApi | null>(null)
  if (apiRef.current === null) apiRef.current = new SshApi()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const connectionRef = useRef<TerminalConnectionBridge | null>(null)
  const inputSubscriptionRef = useRef<IDisposable | null>(null)
  const selectionSubscriptionRef = useRef<IDisposable | null>(null)
  const searchResultSubscriptionRef = useRef<IDisposable | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const generationRef = useRef(0)
  const fontSizeRef = useRef(fontSize)
  const searchOpenRef = useRef(searchOpen)
  const searchQueryRef = useRef(searchQuery)
  const searchCaseSensitiveRef = useRef(searchCaseSensitive)
  const messageTimerRef = useRef<number | null>(null)

  fontSizeRef.current = fontSize
  searchOpenRef.current = searchOpen
  searchQueryRef.current = searchQuery
  searchCaseSensitiveRef.current = searchCaseSensitive

  const flash = (message: string): void => {
    setActionMessage(message)
    if (messageTimerRef.current !== null) window.clearTimeout(messageTimerRef.current)
    messageTimerRef.current = window.setTimeout(() => {
      messageTimerRef.current = null
      setActionMessage(null)
    }, 2200)
  }

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
    selectionSubscriptionRef.current?.dispose()
    selectionSubscriptionRef.current = null
    searchResultSubscriptionRef.current?.dispose()
    searchResultSubscriptionRef.current = null
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
    searchAddonRef.current = null
    setHasSelection(false)
    setSearchResult({ index: -1, count: 0 })
    containerRef.current?.replaceChildren()
  }

  const fitTerminal = (): void => {
    const term = termRef.current
    const fit = fitRef.current
    if (term === null || fit === null) return
    try {
      fit.fit()
      connectionRef.current?.resize(term.cols, term.rows)
    } catch {
      // The view may still be transitioning. ResizeObserver will try again.
    }
  }

  const applyFontSize = (next: number): void => {
    const size = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(next)))
    fontSizeRef.current = size
    setFontSizeState(size)
    writeFontSize(size)
    if (termRef.current !== null) termRef.current.options.fontSize = size
    window.requestAnimationFrame(fitTerminal)
  }

  const copySelection = async (): Promise<void> => {
    const term = termRef.current
    if (term === null || !term.hasSelection()) {
      flash('当前没有选中的终端文本')
      return
    }
    const text = term.getSelection()
    try {
      if (navigator.clipboard?.writeText !== undefined) await navigator.clipboard.writeText(text)
      else if (!legacyCopy(text)) throw new Error('clipboard unavailable')
      flash('已复制到剪贴板')
    } catch {
      if (legacyCopy(text)) flash('已复制到剪贴板')
      else flash('浏览器禁止写入剪贴板')
    }
    term.focus()
  }

  const pasteText = (text: string): void => {
    const term = termRef.current
    if (term === null || text === '') return
    // xterm handles bracketed-paste mode before forwarding through onData.
    term.paste(text)
    term.focus()
  }

  const pasteFromClipboard = async (): Promise<void> => {
    try {
      if (navigator.clipboard?.readText === undefined) throw new Error('clipboard unavailable')
      const text = await navigator.clipboard.readText()
      pasteText(text)
      if (text !== '') flash('已粘贴')
    } catch {
      flash('浏览器未允许读取剪贴板，可用 Ctrl+V / Ctrl+Shift+V 再试')
      termRef.current?.focus()
    }
  }

  const openSearch = (): void => {
    setContextMenu(null)
    searchOpenRef.current = true
    setSearchOpen(true)
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
  }

  const closeSearch = (): void => {
    searchOpenRef.current = false
    setSearchOpen(false)
    searchAddonRef.current?.clearDecorations()
    setSearchResult({ index: -1, count: 0 })
    termRef.current?.focus()
  }

  const searchNext = (query = searchQueryRef.current, incremental = false): void => {
    if (query === '') {
      searchAddonRef.current?.clearDecorations()
      setSearchResult({ index: -1, count: 0 })
      return
    }
    searchAddonRef.current?.findNext(query, {
      incremental,
      caseSensitive: searchCaseSensitiveRef.current,
      decorations: SEARCH_DECORATIONS,
    })
  }

  const searchPrevious = (query = searchQueryRef.current): void => {
    if (query === '') return
    searchAddonRef.current?.findPrevious(query, {
      caseSensitive: searchCaseSensitiveRef.current,
      decorations: SEARCH_DECORATIONS,
    })
  }

  const clearScreen = (): void => {
    termRef.current?.clear()
    termRef.current?.focus()
    setContextMenu(null)
  }

  const selectAll = (): void => {
    termRef.current?.selectAll()
    termRef.current?.focus()
    setContextMenu(null)
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
        fontSize: fontSizeRef.current,
        fontFamily: 'Menlo, Consolas, "Liberation Mono", monospace',
        scrollback: 10000,
        rightClickSelectsWord: false,
        theme: {
          background: '#0b0e14',
          foreground: '#d8dee9',
          cursor: '#a3b8d0',
          selectionBackground: '#35557a',
        },
      })
      const fit = new FitAddon()
      const search = new SearchAddon()
      term.loadAddon(fit)
      term.loadAddon(search)
      term.open(container)

      termRef.current = term
      fitRef.current = fit
      searchAddonRef.current = search
      selectionSubscriptionRef.current = term.onSelectionChange(() => {
        setHasSelection(term.hasSelection())
      })
      searchResultSubscriptionRef.current = search.onDidChangeResults(result => {
        setSearchResult({ index: result.resultIndex, count: result.resultCount })
      })

      // xterm 6 registers the key handler for the lifetime of Terminal and
      // returns void; disposing Terminal in teardown removes it as well.
      term.attachCustomKeyEventHandler(event => {
        if (event.type !== 'keydown') return true
        const mod = event.ctrlKey || event.metaKey
        const key = event.key.toLowerCase()

        // Ctrl+C stays SIGINT when there is no selection. With a selection it
        // behaves like a modern integrated terminal and copies instead.
        if (mod && key === 'c' && (event.shiftKey || term.hasSelection())) {
          void copySelection()
          return false
        }
        if ((mod && key === 'v') || (event.shiftKey && event.key === 'Insert')) {
          void pasteFromClipboard()
          return false
        }
        if (mod && event.key === 'Insert') {
          void copySelection()
          return false
        }
        if (mod && key === 'f') {
          openSearch()
          return false
        }
        if (mod && event.shiftKey && key === 'a') {
          selectAll()
          return false
        }
        if (mod && (event.key === '=' || event.key === '+')) {
          applyFontSize(fontSizeRef.current + 1)
          return false
        }
        if (mod && event.key === '-') {
          applyFontSize(fontSizeRef.current - 1)
          return false
        }
        if (mod && event.key === '0') {
          applyFontSize(DEFAULT_FONT_SIZE)
          return false
        }
        if (searchOpenRef.current && event.key === 'F3') {
          if (event.shiftKey) searchPrevious()
          else searchNext()
          return false
        }
        if (searchOpenRef.current && event.key === 'Escape') {
          closeSearch()
          return false
        }
        // Ctrl+L passes through to readline/shell, preserving native clear.
        return true
      })

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
          if (generation === generationRef.current) {
            setStatus({ kind: 'connected', alias })
            term.focus()
          }
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
        const observer = new ResizeObserver(fitTerminal)
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
    return () => {
      teardown()
      if (messageTimerRef.current !== null) window.clearTimeout(messageTimerRef.current)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    setHost(null)
    if (linkedAlias === null) return () => { disposed = true }
    void listHosts().then(
      hosts => { if (!disposed) setHost(hosts.find(item => item.alias === linkedAlias) ?? null) },
      () => { if (!disposed) setHost(null) },
    )
    return () => { disposed = true }
  }, [linkedAlias])

  useEffect(() => {
    if (contextMenu === null) return
    const close = (): void => { setContextMenu(null) }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  // Changing the header Linked SSH target tears down the old PTY and follows
  // the new target automatically, keeping Terminal and SSH Files synchronized.
  useEffect(() => {
    teardown()
    if (linkedAlias === null) {
      setStatus({ kind: 'idle' })
      return
    }
    const frame = window.requestAnimationFrame(() => { connectTo(linkedAlias) })
    return () => { window.cancelAnimationFrame(frame) }
  }, [linkedAlias, sessionId])

  useEffect(() => {
    if (!searchOpen) return
    if (searchQuery === '') {
      searchAddonRef.current?.clearDecorations()
      setSearchResult({ index: -1, count: 0 })
      return
    }
    searchNext(searchQuery, true)
  }, [searchQuery, searchCaseSensitive])

  const active = status.kind === 'connecting' || status.kind === 'connected'
  const targetLabel = linkedAlias === null
    ? '未连接服务器'
    : host === null
      ? linkedAlias
      : `${linkedAlias} (${host.user}@${host.host}:${host.port})`

  const menuButton = (disabled = false) => ({
    width: '100%', border: 0, borderRadius: 5, background: 'transparent',
    color: disabled ? 'rgba(128,128,128,.55)' : 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18,
    padding: '7px 9px', cursor: disabled ? 'default' : 'pointer', fontSize: 12,
    textAlign: 'left' as const,
  })

  return (
    <div style={{
      boxSizing: 'border-box', width: '100%', minHeight: '62vh', height: '100%',
      padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden',
    }}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>SSH 终端</div>
          <div style={{ marginTop: 3, fontSize: 12, opacity: .66, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            当前服务器：{targetLabel} · 字体 {fontSize}px
          </div>
        </div>
        {linkedAlias !== null ? (
          <>
            <button type="button" disabled={active} onClick={() => { connectTo(linkedAlias) }} style={{
              border: '1px solid rgba(128,128,128,.35)', borderRadius: 6, background: 'transparent',
              color: 'inherit', padding: '5px 10px', cursor: active ? 'default' : 'pointer', opacity: active ? .5 : 1,
            }}>连接</button>
            <button type="button" disabled={!active} onClick={() => { teardown(); setStatus({ kind: 'idle' }) }} style={{
              border: '1px solid rgba(128,128,128,.35)', borderRadius: 6, background: 'transparent',
              color: 'inherit', padding: '5px 10px', cursor: active ? 'pointer' : 'default', opacity: active ? 1 : .5,
            }}>断开</button>
          </>
        ) : null}
      </div>

      {linkedAlias === null ? (
        <div style={{
          flex: 1, minHeight: 320, border: '1px dashed rgba(128,128,128,.35)', borderRadius: 8,
          display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center', opacity: .68, fontSize: 13,
        }}>
          当前会话还没有连接 SSH 服务器。请在页面顶部“标准模式”右侧的“连接服务器”中选择服务器。
        </div>
      ) : (
        <>
          {status.kind === 'connecting' ? <StatusBanner background="rgba(79,129,255,.10)">正在连接 {status.alias}…</StatusBanner> : null}
          {status.kind === 'connected' ? <StatusBanner background="rgba(46,160,67,.10)">已连接 {status.alias}</StatusBanner> : null}
          {status.kind === 'exited' ? <StatusBanner background="rgba(128,128,128,.10)">{status.alias} 的终端已断开{status.detail ? `：${status.detail}` : ''}</StatusBanner> : null}
          {status.kind === 'error' ? <StatusBanner background="rgba(220,70,70,.10)" color="#d9534f">SSH 终端错误：{status.detail}</StatusBanner> : null}

          <div
            onContextMenu={event => {
              event.preventDefault()
              event.stopPropagation()
              setContextMenu(clampContextMenuPoint(event.clientX, event.clientY))
            }}
            onPaste={event => {
              const text = event.clipboardData.getData('text/plain')
              if (text === '') return
              event.preventDefault()
              pasteText(text)
            }}
            style={{
              flex: 1, minHeight: 360, borderRadius: 8, overflow: 'hidden',
              background: '#0b0e14', position: 'relative',
            }}
          >
            <div ref={containerRef} style={{ position: 'absolute', inset: 0, padding: 6 }} />

            {searchOpen ? (
              <div onPointerDown={event => { event.stopPropagation() }} style={{
                position: 'absolute', top: 10, right: 14, zIndex: 8, display: 'flex', alignItems: 'center', gap: 4,
                padding: 5, border: '1px solid rgba(255,255,255,.18)', borderRadius: 7,
                background: '#171b22', boxShadow: '0 8px 24px rgba(0,0,0,.35)',
              }}>
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={event => { searchQueryRef.current = event.target.value; setSearchQuery(event.target.value) }}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      if (event.shiftKey) searchPrevious()
                      else searchNext()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      closeSearch()
                    }
                  }}
                  placeholder="搜索终端输出"
                  style={{ width: 190, border: '1px solid rgba(255,255,255,.16)', borderRadius: 5, outline: 'none', background: '#0f1319', color: '#e6edf3', padding: '5px 7px', fontSize: 12 }}
                />
                <span style={{ minWidth: 42, textAlign: 'center', color: '#aab3c0', fontSize: 11 }}>
                  {searchResult.count > 0 && searchResult.index >= 0 ? `${searchResult.index + 1}/${searchResult.count}` : searchQuery === '' ? '' : '0/0'}
                </span>
                <button type="button" title="区分大小写" onClick={() => {
                  searchCaseSensitiveRef.current = !searchCaseSensitive
                  setSearchCaseSensitive(!searchCaseSensitive)
                }} style={{ border: 0, borderRadius: 4, background: searchCaseSensitive ? '#315b8a' : 'transparent', color: '#e6edf3', padding: '4px 6px', cursor: 'pointer', fontSize: 11 }}>Aa</button>
                <button type="button" title="上一个 (Shift+Enter / Shift+F3)" onClick={searchPrevious} style={searchButtonStyle}>↑</button>
                <button type="button" title="下一个 (Enter / F3)" onClick={() => { searchNext() }} style={searchButtonStyle}>↓</button>
                <button type="button" title="关闭 (Esc)" onClick={closeSearch} style={searchButtonStyle}>×</button>
              </div>
            ) : null}

            {actionMessage !== null ? (
              <div style={{
                position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 9,
                border: '1px solid rgba(255,255,255,.14)', borderRadius: 6, background: 'rgba(24,28,35,.94)',
                color: '#d8dee9', padding: '6px 10px', fontSize: 12, pointerEvents: 'none',
              }}>{actionMessage}</div>
            ) : null}

            {status.kind === 'idle' ? (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#8b949e', pointerEvents: 'none', fontSize: 13 }}>
                当前终端已断开。服务器切换请使用页面顶部的 SSH 连接按钮。
              </div>
            ) : null}
          </div>

          {contextMenu !== null ? (
            <div
              onPointerDown={event => { event.stopPropagation() }}
              onContextMenu={event => { event.preventDefault() }}
              style={{
                position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 10020, width: 230, padding: 5,
                border: '1px solid rgba(128,128,128,.32)', borderRadius: 7,
                background: 'var(--color-background, #fff)', color: 'var(--color-foreground, #1f2328)',
                boxShadow: '0 10px 28px rgba(0,0,0,.22)',
              }}
            >
              <button type="button" disabled={!hasSelection} onClick={() => { setContextMenu(null); void copySelection() }} style={menuButton(!hasSelection)}>
                <span>复制</span><span style={{ opacity: .55 }}>Ctrl+Shift+C</span>
              </button>
              <button type="button" onClick={() => { setContextMenu(null); void pasteFromClipboard() }} style={menuButton()}>
                <span>粘贴</span><span style={{ opacity: .55 }}>Ctrl+Shift+V</span>
              </button>
              <button type="button" onClick={selectAll} style={menuButton()}>
                <span>全选</span><span style={{ opacity: .55 }}>Ctrl+Shift+A</span>
              </button>
              <MenuDivider />
              <button type="button" onClick={openSearch} style={menuButton()}>
                <span>搜索</span><span style={{ opacity: .55 }}>Ctrl+F</span>
              </button>
              <button type="button" onClick={clearScreen} style={menuButton()}>
                <span>清屏</span><span style={{ opacity: .55 }}>Ctrl+L</span>
              </button>
              <MenuDivider />
              <button type="button" disabled={fontSize >= MAX_FONT_SIZE} onClick={() => { setContextMenu(null); applyFontSize(fontSizeRef.current + 1) }} style={menuButton(fontSize >= MAX_FONT_SIZE)}>
                <span>放大字体</span><span style={{ opacity: .55 }}>Ctrl++</span>
              </button>
              <button type="button" disabled={fontSize <= MIN_FONT_SIZE} onClick={() => { setContextMenu(null); applyFontSize(fontSizeRef.current - 1) }} style={menuButton(fontSize <= MIN_FONT_SIZE)}>
                <span>缩小字体</span><span style={{ opacity: .55 }}>Ctrl+-</span>
              </button>
              <button type="button" onClick={() => { setContextMenu(null); applyFontSize(DEFAULT_FONT_SIZE) }} style={menuButton()}>
                <span>恢复默认字体</span><span style={{ opacity: .55 }}>Ctrl+0</span>
              </button>
              <div style={{ padding: '5px 9px 3px', opacity: .5, fontSize: 11 }}>
                当前字体：{fontSize}px · Ctrl+C 有选区时复制，否则发送中断信号
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

function StatusBanner({ children, background, color = 'inherit' }: { children: React.ReactNode; background: string; color?: string }) {
  return <div style={{ flex: 'none', padding: '7px 9px', borderRadius: 6, background, color, fontSize: 12 }}>{children}</div>
}

function MenuDivider() {
  return <div style={{ height: 1, margin: '4px 3px', background: 'rgba(128,128,128,.22)' }} />
}

const searchButtonStyle = {
  border: 0,
  background: 'transparent',
  color: '#e6edf3',
  cursor: 'pointer',
  padding: '3px 5px',
} as const
