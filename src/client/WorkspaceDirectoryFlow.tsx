import { useEffect, useMemo, useState, type CSSProperties } from 'react'

interface DirPickerProps {
  open: boolean
  busy: boolean
  onPicked: (path: string) => void
  onCancel: () => void
}

interface RwHostSummary {
  alias: string
  host: string
  port: number
  user: string
  authKind: 'key' | 'password'
  keyReady: boolean
  passwordSet: boolean
}

interface LsItem {
  name: string
  type: 'dir' | 'file' | 'symlink'
}

interface HostsResponse { hosts?: RwHostSummary[]; error?: string }
interface LsResponse { path?: string; items?: LsItem[]; error?: string }
interface WorkspaceResponse { ok?: boolean; placeholderDir?: string; workspace?: string; error?: string }
interface LocalPickResponse { ok?: boolean; path?: string; cancelled?: boolean; error?: string }

const border = '1px solid rgba(128,128,128,.28)'
const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border,
  borderRadius: 8,
  padding: '9px 10px',
  background: 'transparent',
  color: 'inherit',
  outline: 'none',
}
const buttonStyle: CSSProperties = {
  border,
  borderRadius: 8,
  padding: '8px 12px',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

function parentOfRemote(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  if (normalized === '' || normalized === '/') return '/'
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

function joinRemote(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent.replace(/\/$/, '')}/${name}`
}

function hostReady(host: RwHostSummary): boolean {
  return host.authKind === 'key' ? host.keyReady : host.passwordSet
}

export function WorkspaceDirectoryFlow({ open, busy, onPicked, onCancel }: DirPickerProps) {
  const [tab, setTab] = useState<'local' | 'remote'>('remote')
  const [hosts, setHosts] = useState<RwHostSummary[]>([])
  const [alias, setAlias] = useState('')
  const [remotePath, setRemotePath] = useState('~/')
  const [workspaceName, setWorkspaceName] = useState('')
  const [items, setItems] = useState<LsItem[]>([])
  const [localPath, setLocalPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const selectedHost = useMemo(() => hosts.find(host => host.alias === alias), [hosts, alias])

  useEffect(() => {
    if (!open) return
    setError('')
    setItems([])
    void (async () => {
      try {
        const data = await json<HostsResponse>(await fetch('/api/dsh-rw/hosts'))
        const next = data.hosts ?? []
        setHosts(next)
        const ready = next.filter(hostReady)
        if (ready.length === 1) {
          setAlias(ready[0]!.alias)
          void loadDir(ready[0]!.alias, '~/')
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [open])

  const loadDir = async (nextAlias = alias, nextPath = remotePath): Promise<void> => {
    if (nextAlias === '' || nextPath.trim() === '') return
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ alias: nextAlias, path: nextPath.trim() })
      const data = await json<LsResponse>(await fetch(`/api/dsh-rw/ls?${params.toString()}`))
      setRemotePath(data.path ?? nextPath.trim())
      setItems((data.items ?? []).filter(item => item.type === 'dir' || item.type === 'symlink'))
    } catch (e) {
      setItems([])
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const chooseRemote = async (): Promise<void> => {
    if (alias === '' || remotePath.trim() === '') return
    setLoading(true)
    setError('')
    try {
      const data = await json<WorkspaceResponse>(await fetch('/api/dsh-rw/workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias, path: remotePath.trim(), name: workspaceName.trim() }),
      }))
      if (!data.placeholderDir) throw new Error(data.error ?? 'remote workspace did not return a placeholder directory')
      onPicked(data.placeholderDir)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const chooseLocalSystem = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const data = await json<LocalPickResponse>(await fetch('/api/dsh-rw/local-pick', { method: 'POST' }))
      if (data.cancelled) return
      if (data.path) {
        setLocalPath(data.path)
        onPicked(data.path)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2147482000, background: 'rgba(0,0,0,.42)', display: 'grid', placeItems: 'center', padding: 18 }}>
      <div style={{ width: 'min(720px, 94vw)', maxHeight: '86vh', overflow: 'auto', borderRadius: 14, border, background: 'var(--dsw-alias-bg-layer-1, #18181b)', color: 'var(--dsw-alias-label-primary, #e4e4e7)', boxShadow: '0 20px 70px rgba(0,0,0,.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 10px', borderBottom: border }}>
          <strong style={{ flex: 1 }}>添加工作区</strong>
          <button type="button" onClick={onCancel} style={{ ...buttonStyle, padding: '4px 9px' }}>×</button>
        </div>

        <div style={{ display: 'flex', gap: 4, padding: '10px 14px 0' }}>
          {(['local', 'remote'] as const).map(key => (
            <button
              key={key}
              type="button"
              onClick={() => { setTab(key); setError('') }}
              style={{
                ...buttonStyle,
                borderColor: 'transparent',
                borderBottom: tab === key ? '2px solid var(--dsw-alias-accent-primary, #4c8dff)' : '2px solid transparent',
                borderRadius: 0,
                fontWeight: tab === key ? 600 : 400,
              }}
            >
              {key === 'local' ? '本机' : '远程 SSH'}
            </button>
          ))}
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {tab === 'local' ? (
            <>
              <div style={{ fontSize: 12, opacity: .68 }}>选择本机目录。系统文件夹选择器只会在你点击下面按钮时打开。</div>
              <input value={localPath} onChange={event => setLocalPath(event.target.value)} placeholder="例如 E:\\project 或 C:\\Users\\..." style={inputStyle} />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                <button type="button" onClick={() => { void chooseLocalSystem() }} disabled={loading || busy} style={buttonStyle}>打开系统文件夹选择器</button>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={onCancel} style={buttonStyle}>取消</button>
                  <button type="button" onClick={() => { if (localPath.trim()) onPicked(localPath.trim()) }} disabled={!localPath.trim() || busy} style={buttonStyle}>选用</button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, opacity: .68 }}>SSH 主机与密码和左侧「SSH」共用同一份配置，不需要再配置第二遍。</div>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, opacity: .72 }}>远程主机</span>
                <select
                  value={alias}
                  onChange={event => {
                    const next = event.target.value
                    setAlias(next)
                    setRemotePath('~/')
                    setItems([])
                    if (next) void loadDir(next, '~/')
                  }}
                  style={inputStyle}
                >
                  <option value="">选择 SSH 主机</option>
                  {hosts.map(host => (
                    <option key={host.alias} value={host.alias} disabled={!hostReady(host)}>
                      {host.alias} ({host.user}@{host.host}){hostReady(host) ? '' : ' · 凭据不可用'}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, opacity: .72 }}>工作区名称（可选）</span>
                <input value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} placeholder="留空使用远程目录名" style={inputStyle} />
              </label>

              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => { void loadDir(alias, parentOfRemote(remotePath)) }} disabled={!alias || loading} style={buttonStyle}>↑</button>
                <input
                  value={remotePath}
                  onChange={event => setRemotePath(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') void loadDir() }}
                  placeholder="远程路径，例如 /apps 或 ~/project"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button type="button" onClick={() => { void loadDir() }} disabled={!alias || loading} style={buttonStyle}>刷新</button>
              </div>

              <div style={{ border, borderRadius: 9, minHeight: 150, maxHeight: 260, overflow: 'auto', padding: 4 }}>
                {loading ? <div style={{ padding: 12, opacity: .65 }}>加载中…</div> : null}
                {!loading && items.length === 0 ? <div style={{ padding: 12, opacity: .55 }}>没有可进入的子目录</div> : null}
                {items.map(item => (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => { void loadDir(alias, joinRemote(remotePath, item.name)) }}
                    style={{ width: '100%', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left', padding: '7px 9px', borderRadius: 6, cursor: 'pointer' }}
                  >
                    📁 {item.name}
                  </button>
                ))}
              </div>

              {selectedHost ? <div style={{ fontSize: 11, opacity: .55 }}>{selectedHost.user}@{selectedHost.host}:{selectedHost.port}</div> : null}

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" onClick={onCancel} style={buttonStyle}>取消</button>
                <button type="button" onClick={() => { void chooseRemote() }} disabled={!alias || !remotePath.trim() || loading || busy} style={{ ...buttonStyle, fontWeight: 600 }}>设为远程工作区</button>
              </div>
            </>
          )}

          {error ? <div style={{ padding: 9, borderRadius: 7, background: 'rgba(220,53,69,.10)', color: '#e06c75', fontSize: 12 }}>{error}</div> : null}
        </div>
      </div>
    </div>
  )
}

interface SlotMeta { name: string; id: string; priority: number }
interface SlotsLike {
  inject(slot: string, factory: () => unknown): unknown
  register(meta: SlotMeta, component: unknown): unknown
}

/** Install the two-tab local/remote workspace chooser into both DSH entry points. */
export function registerWorkspaceDirectoryFlow(ctx: any): void {
  const slots = (typeof ctx?.get === 'function' ? ctx.get('slots') : ctx?.slots) as SlotsLike | undefined
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
  slots.inject('conversation.hero.workspace.directoryFlow', () =>
    slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield slots.register({ name: 'conversation.hero.workspace.directoryFlow', id: 'dsh-ssh-integrated', priority: -200 }, WorkspaceDirectoryFlow)
      yield slots.register({ name: 'sidebar.workspaces.directoryFlow', id: 'dsh-ssh-integrated', priority: -200 }, WorkspaceDirectoryFlow)
    }),
  )
}
