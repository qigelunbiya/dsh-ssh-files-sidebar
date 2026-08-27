import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { listHosts, type SshHostSummary } from './api.ts'
import { remoteWorkspaceAliasFromCwd } from './RemoteFilesTab.tsx'
import { setLinkedSshAlias, useLinkedSshAlias } from './linked-ssh-store.ts'

interface HeaderActionProps {
  sessionId: string
  useSessions: <T>(selector: (state: any) => T) => T
}

const buttonStyle: CSSProperties = {
  border: '1px solid rgba(128,128,128,.28)',
  borderRadius: 7,
  background: 'transparent',
  color: 'inherit',
  padding: '4px 8px',
  cursor: 'pointer',
  fontSize: 12,
  whiteSpace: 'nowrap',
}

export function LinkedSshHeaderAction(props: HeaderActionProps) {
  const { sessionId, useSessions } = props
  const cwd = useSessions(state => state.byId?.[sessionId]?.cwd as string | undefined)
  const remoteWorkspaceAlias = useMemo(() => remoteWorkspaceAliasFromCwd(cwd), [cwd])
  const linkedAlias = useLinkedSshAlias(sessionId)
  const effectiveAlias = remoteWorkspaceAlias ?? linkedAlias

  const [open, setOpen] = useState(false)
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  useEffect(() => {
    if (!open) return
    let disposed = false
    setLoading(true)
    setError('')
    void listHosts().then(
      result => {
        if (disposed) return
        setHosts(result)
        setLoading(false)
      },
      reason => {
        if (disposed) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      },
    )
    return () => { disposed = true }
  }, [open])

  const currentHost = hosts.find(host => host.alias === effectiveAlias)

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        title={remoteWorkspaceAlias
          ? `远程工作区：${remoteWorkspaceAlias}`
          : linkedAlias
            ? `当前会话已连接 SSH：${linkedAlias}`
            : '给当前本地会话连接一台 SSH 服务器'}
        style={{
          ...buttonStyle,
          borderColor: effectiveAlias ? 'rgba(78,139,255,.48)' : 'rgba(128,128,128,.28)',
          background: effectiveAlias ? 'rgba(78,139,255,.09)' : 'transparent',
        }}
      >
        🔗 {effectiveAlias ?? '连接服务器'}
      </button>

      {open ? (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 7px)',
            left: 0,
            zIndex: 2147482500,
            width: 290,
            maxWidth: 'min(90vw, 290px)',
            border: '1px solid rgba(128,128,128,.28)',
            borderRadius: 10,
            background: 'var(--dsw-alias-bg-layer-1, #18181b)',
            color: 'var(--dsw-alias-label-primary, #e4e4e7)',
            boxShadow: '0 14px 45px rgba(0,0,0,.30)',
            padding: 8,
          }}
        >
          <div style={{ padding: '5px 7px 8px', fontSize: 12, opacity: .68 }}>
            {remoteWorkspaceAlias
              ? '这是远程 SSH 工作区，服务器由工作区本身决定。'
              : '当前 Workspace 保持在本机；这里只绑定服务器，普通 Read / Write / Bash 仍然操作本机。'}
          </div>

          {effectiveAlias ? (
            <div style={{ margin: '0 4px 7px', padding: '8px 9px', borderRadius: 7, background: 'rgba(78,139,255,.08)', fontSize: 12 }}>
              <div style={{ fontWeight: 600 }}>{effectiveAlias}</div>
              {currentHost ? <div style={{ marginTop: 3, opacity: .68 }}>{currentHost.user}@{currentHost.host}:{currentHost.port}</div> : null}
            </div>
          ) : null}

          {loading ? <div style={{ padding: 9, fontSize: 12, opacity: .65 }}>正在读取 SSH 主机…</div> : null}
          {error ? <div style={{ padding: 9, color: '#e06c75', fontSize: 12 }}>{error}</div> : null}

          {!loading && !remoteWorkspaceAlias ? (
            <div style={{ maxHeight: 230, overflow: 'auto' }}>
              {hosts.length === 0 && !error ? <div style={{ padding: 9, fontSize: 12, opacity: .55 }}>还没有 SSH 主机，请先在左侧「SSH」中添加。</div> : null}
              {hosts.map(host => {
                const selected = linkedAlias === host.alias
                return (
                  <button
                    key={host.alias}
                    type="button"
                    onClick={() => {
                      setLinkedSshAlias(sessionId, host.alias)
                      setOpen(false)
                    }}
                    style={{
                      width: '100%',
                      border: 0,
                      borderRadius: 6,
                      background: selected ? 'rgba(78,139,255,.13)' : 'transparent',
                      color: 'inherit',
                      textAlign: 'left',
                      padding: '7px 9px',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: selected ? 600 : 400 }}>{selected ? '✓ ' : ''}{host.alias}</div>
                    <div style={{ marginTop: 2, fontSize: 11, opacity: .58 }}>{host.user}@{host.host}:{host.port}</div>
                  </button>
                )
              })}
            </div>
          ) : null}

          {!remoteWorkspaceAlias && linkedAlias ? (
            <div style={{ borderTop: '1px solid rgba(128,128,128,.20)', marginTop: 6, paddingTop: 6 }}>
              <button
                type="button"
                onClick={() => {
                  setLinkedSshAlias(sessionId, null)
                  setOpen(false)
                }}
                style={{ ...buttonStyle, width: '100%', borderColor: 'transparent', textAlign: 'left' }}
              >
                断开服务器连接
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
