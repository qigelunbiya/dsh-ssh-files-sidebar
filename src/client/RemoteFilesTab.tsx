import { useEffect, useMemo, useState } from 'react'
import type { RemoteDirEntry, SshHostSummary } from './api.ts'
import { listHosts, listRemoteDir } from './api.ts'

type LoadedDirs = Record<string, RemoteDirEntry[]>
type Expanded = Record<string, boolean>

function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent.replace(/\/$/, '')}/${name}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return new Date(ms).toLocaleString()
}

function FolderIcon({ open }: { open: boolean }) {
  return <span aria-hidden="true" style={{ width: 18, display: 'inline-block' }}>{open ? '📂' : '📁'}</span>
}

function FileIcon() {
  return <span aria-hidden="true" style={{ width: 18, display: 'inline-block' }}>📄</span>
}

interface TreeNodeProps {
  alias: string
  path: string
  depth: number
  entry: RemoteDirEntry
  expanded: Expanded
  loaded: LoadedDirs
  loading: Record<string, boolean>
  errors: Record<string, string | undefined>
  onToggle: (path: string) => void
}

function TreeNode(props: TreeNodeProps) {
  const { alias, path, depth, entry, expanded, loaded, loading, errors, onToggle } = props
  const fullPath = joinPath(path, entry.name)
  const isDir = entry.type === 'dir'
  const isOpen = isDir && expanded[fullPath] === true
  const children = loaded[fullPath]
  return (
    <div>
      <button
        type="button"
        onClick={() => { if (isDir) onToggle(fullPath) }}
        title={fullPath}
        style={{
          width: '100%',
          border: 0,
          background: 'transparent',
          color: 'inherit',
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) auto',
          gap: 8,
          alignItems: 'center',
          padding: `5px 8px 5px ${8 + depth * 14}px`,
          cursor: isDir ? 'pointer' : 'default',
          textAlign: 'left',
          fontSize: 13,
        }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isDir ? <FolderIcon open={isOpen} /> : <FileIcon />}
          {entry.name}
        </span>
        <span style={{ opacity: 0.58, fontSize: 11, whiteSpace: 'nowrap' }}>
          {isDir ? '' : formatBytes(entry.size)}
        </span>
      </button>
      {isOpen && (
        <div>
          {loading[fullPath] && <div style={{ paddingLeft: 28 + depth * 14, opacity: 0.65, fontSize: 12 }}>加载中…</div>}
          {errors[fullPath] && <div style={{ paddingLeft: 28 + depth * 14, color: '#d9534f', fontSize: 12 }}>{errors[fullPath]}</div>}
          {children?.map(child => (
            <TreeNode
              key={`${alias}:${fullPath}:${child.name}`}
              alias={alias}
              path={fullPath}
              depth={depth + 1}
              entry={child}
              expanded={expanded}
              loaded={loaded}
              loading={loading}
              errors={errors}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function RemoteFilesTab() {
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [alias, setAlias] = useState('')
  const [rootEntries, setRootEntries] = useState<RemoteDirEntry[]>([])
  const [expanded, setExpanded] = useState<Expanded>({})
  const [loaded, setLoaded] = useState<LoadedDirs>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [topError, setTopError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selected = useMemo(() => hosts.find(host => host.alias === alias), [hosts, alias])

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const result = await listHosts()
        if (disposed) return
        setHosts(result)
        if (result.length === 1) setAlias(result[0]?.alias ?? '')
      } catch (error) {
        if (!disposed) setTopError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { disposed = true }
  }, [])

  const loadRoot = async (nextAlias = alias) => {
    if (nextAlias === '') return
    setBusy(true)
    setTopError(null)
    try {
      const entries = await listRemoteDir(nextAlias, '/')
      entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)
      setRootEntries(entries)
      setExpanded({})
      setLoaded({})
      setErrors({})
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (alias !== '') void loadRoot(alias)
  }, [alias])

  const toggle = async (path: string) => {
    if (alias === '') return
    const nowOpen = expanded[path] === true
    if (nowOpen) {
      setExpanded(prev => ({ ...prev, [path]: false }))
      return
    }
    setExpanded(prev => ({ ...prev, [path]: true }))
    if (loaded[path] !== undefined) return
    setLoading(prev => ({ ...prev, [path]: true }))
    setErrors(prev => ({ ...prev, [path]: undefined }))
    try {
      const entries = await listRemoteDir(alias, path)
      entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)
      setLoaded(prev => ({ ...prev, [path]: entries }))
    } catch (error) {
      setErrors(prev => ({ ...prev, [path]: error instanceof Error ? error.message : String(error) }))
    } finally {
      setLoading(prev => ({ ...prev, [path]: false }))
    }
  }

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', color: 'inherit' }}>
      <div style={{ display: 'flex', gap: 8, padding: 8, borderBottom: '1px solid rgba(128,128,128,.22)' }}>
        <select
          value={alias}
          onChange={event => setAlias(event.target.value)}
          style={{ flex: 1, minWidth: 0, background: 'transparent', color: 'inherit', border: '1px solid rgba(128,128,128,.35)', borderRadius: 6, padding: '5px 7px' }}
          aria-label="SSH 主机"
        >
          <option value="">选择 SSH 主机</option>
          {hosts.map(host => <option key={host.alias} value={host.alias}>{host.alias} ({host.user}@{host.host})</option>)}
        </select>
        <button
          type="button"
          onClick={() => { void loadRoot() }}
          disabled={alias === '' || busy}
          title="刷新"
          style={{ border: '1px solid rgba(128,128,128,.35)', borderRadius: 6, background: 'transparent', color: 'inherit', padding: '5px 9px', cursor: 'pointer' }}
        >↻</button>
      </div>
      {selected && (
        <div style={{ padding: '6px 10px', fontSize: 11, opacity: 0.65, borderBottom: '1px solid rgba(128,128,128,.14)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected.user}@{selected.host}:{selected.port} · /
        </div>
      )}
      {topError && <div style={{ margin: 8, padding: 8, borderRadius: 6, background: 'rgba(220,53,69,.10)', color: '#d9534f', fontSize: 12 }}>{topError}</div>}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 0 12px' }}>
        {alias === '' && <div style={{ padding: 12, opacity: 0.62, fontSize: 12 }}>请先在 @linxin666/dsh-ssh 中配置主机，然后在这里选择。</div>}
        {alias !== '' && busy && rootEntries.length === 0 && <div style={{ padding: 12, opacity: 0.62, fontSize: 12 }}>正在读取 / …</div>}
        {rootEntries.map(entry => (
          <TreeNode
            key={`${alias}:/:${entry.name}`}
            alias={alias}
            path="/"
            depth={0}
            entry={entry}
            expanded={expanded}
            loaded={loaded}
            loading={loading}
            errors={errors}
            onToggle={toggle}
          />
        ))}
      </div>
      {selected && <div style={{ padding: '5px 9px', fontSize: 10, opacity: 0.48, borderTop: '1px solid rgba(128,128,128,.14)' }}>文件时间按服务器返回值读取；点击目录按需展开。</div>}
    </div>
  )
}
