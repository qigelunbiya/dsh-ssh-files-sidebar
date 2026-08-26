import { useEffect, useMemo, useRef, useState } from 'react'
import type { RemoteDirEntry, SshHostSummary } from './api.ts'
import {
  createRemoteDirectory,
  deleteRemotePath,
  listHosts,
  listRemoteDir,
  readRemoteFile,
  renameRemotePath,
  writeRemoteFile,
} from './api.ts'

type LoadedDirs = Record<string, RemoteDirEntry[]>
type Expanded = Record<string, boolean>
type LoadingMap = Record<string, boolean>
type ErrorMap = Record<string, string | undefined>

type PreviewKind = 'none' | 'loading' | 'text' | 'image' | 'pdf' | 'binary' | 'too-large' | 'error'

interface SelectedItem {
  path: string
  parentPath: string
  entry: RemoteDirEntry
}

interface RemoteFilesTabProps {
  sessionId?: string
}

const TEXT_PREVIEW_LIMIT = 8 * 1024 * 1024
const MEDIA_PREVIEW_LIMIT = 32 * 1024 * 1024
const RESTORE_LIMIT = 80

const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'md', 'markdown', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'pyw', 'pyi', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'properties',
  'xml', 'svg', 'csv', 'tsv', 'sql', 'graphql', 'gql',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'java', 'kt', 'kts', 'go', 'rs', 'php', 'rb',
  'dockerfile', 'makefile', 'gitignore', 'gitattributes', 'env', 'editorconfig',
])

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'])

function sortEntries(entries: RemoteDirEntry[]): RemoteDirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === 'dir') return -1
      if (b.type === 'dir') return 1
    }
    return a.name.localeCompare(b.name)
  })
}

function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent.replace(/\/$/, '')}/${name}`
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? '/' : trimmed.slice(0, index)
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

function extensionOf(path: string): string {
  const name = basename(path).toLowerCase()
  if (name === 'dockerfile' || name === 'makefile' || name.startsWith('.env')) return name.replace(/^\./, '')
  const dot = name.lastIndexOf('.')
  return dot < 0 ? name.replace(/^\./, '') : name.slice(dot + 1)
}

function isHtml(path: string): boolean {
  const ext = extensionOf(path)
  return ext === 'html' || ext === 'htm'
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

function storageKey(sessionId: string, alias: string): string {
  return `dsh-ssh-files-sidebar:v2:${sessionId}:${alias}:expanded`
}

function hostStorageKey(sessionId: string): string {
  return `dsh-ssh-files-sidebar:v2:${sessionId}:host`
}

function readRememberedHost(sessionId: string): string {
  try { return localStorage.getItem(hostStorageKey(sessionId)) ?? '' } catch { return '' }
}

function writeRememberedHost(sessionId: string, alias: string): void {
  try { localStorage.setItem(hostStorageKey(sessionId), alias) } catch { /* storage unavailable */ }
}

function readRememberedExpanded(sessionId: string, alias: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(sessionId, alias))
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((value): value is string => typeof value === 'string' && value.startsWith('/') && value !== '/')
      .slice(0, RESTORE_LIMIT)
  } catch {
    return []
  }
}

function writeRememberedExpanded(sessionId: string, alias: string, expanded: Expanded): void {
  if (alias === '') return
  const paths = Object.entries(expanded)
    .filter(([, open]) => open)
    .map(([path]) => path)
    .slice(0, RESTORE_LIMIT)
  try { localStorage.setItem(storageKey(sessionId, alias), JSON.stringify(paths)) } catch { /* storage unavailable */ }
}

function pathWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root.replace(/\/$/, '')}/`)
}

function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`
  return path
}

function remapRecord<T>(record: Record<string, T>, from: string, to: string): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) next[remapPath(key, from, to)] = value
  return next
}

function dropSubtree<T>(record: Record<string, T>, root: string): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!pathWithin(key, root)) next[key] = value
  }
  return next
}

function validName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0')
}

async function blobLooksLikeText(blob: Blob): Promise<boolean> {
  const sample = new Uint8Array(await blob.slice(0, 8192).arrayBuffer())
  if (sample.some(byte => byte === 0)) return false
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(sample)
  const replacements = [...decoded].filter(char => char === '\uFFFD').length
  return replacements <= Math.max(2, decoded.length * 0.01)
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
  loading: LoadingMap
  errors: ErrorMap
  selectedPath?: string
  onToggle: (path: string) => void
  onSelect: (item: SelectedItem) => void
  onOpenFile: (item: SelectedItem) => void
}

function TreeNode(props: TreeNodeProps) {
  const { alias, path, depth, entry, expanded, loaded, loading, errors, selectedPath, onToggle, onSelect, onOpenFile } = props
  const fullPath = joinPath(path, entry.name)
  const item: SelectedItem = { path: fullPath, parentPath: path, entry }
  const isDir = entry.type === 'dir'
  const isOpen = isDir && expanded[fullPath] === true
  const children = loaded[fullPath]
  const selected = selectedPath === fullPath

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          onSelect(item)
          if (isDir) onToggle(fullPath)
          else if (entry.type === 'file') onOpenFile(item)
        }}
        title={`${fullPath}${entry.mtimeMs > 0 ? `\n${formatTime(entry.mtimeMs)}` : ''}`}
        style={{
          width: '100%',
          border: 0,
          background: selected ? 'rgba(90,130,255,.14)' : 'transparent',
          color: 'inherit',
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) auto',
          gap: 8,
          alignItems: 'center',
          padding: `5px 8px 5px ${8 + depth * 14}px`,
          cursor: entry.type === 'other' ? 'default' : 'pointer',
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
          {errors[fullPath] && <div style={{ padding: `3px 8px 3px ${28 + depth * 14}px`, color: '#d9534f', fontSize: 12 }}>{errors[fullPath]}</div>}
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
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const smallButtonStyle = {
  border: '1px solid rgba(128,128,128,.35)',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  padding: '5px 8px',
  cursor: 'pointer',
  fontSize: 12,
} as const

export function RemoteFilesTab({ sessionId = 'global' }: RemoteFilesTabProps) {
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [alias, setAlias] = useState('')
  const [rootEntries, setRootEntries] = useState<RemoteDirEntry[]>([])
  const [expanded, setExpanded] = useState<Expanded>({})
  const [loaded, setLoaded] = useState<LoadedDirs>({})
  const [loading, setLoading] = useState<LoadingMap>({})
  const [errors, setErrors] = useState<ErrorMap>({})
  const [selected, setSelected] = useState<SelectedItem | null>(null)
  const [topError, setTopError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [previewKind, setPreviewKind] = useState<PreviewKind>('none')
  const [previewPath, setPreviewPath] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [originalText, setOriginalText] = useState('')
  const [draftText, setDraftText] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [htmlRendered, setHtmlRendered] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mutating, setMutating] = useState(false)
  const objectUrlRef = useRef<string | null>(null)
  const noticeTimerRef = useRef<number | null>(null)

  const selectedHost = useMemo(() => hosts.find(host => host.alias === alias), [hosts, alias])
  const dirty = previewKind === 'text' && draftText !== originalText

  const showNotice = (message: string): void => {
    setNotice(message)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2200)
  }

  const revokePreviewUrl = (): void => {
    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
    setPreviewUrl('')
  }

  const setBlobPreview = (blob: Blob): void => {
    revokePreviewUrl()
    const url = URL.createObjectURL(blob)
    objectUrlRef.current = url
    setPreviewUrl(url)
  }

  const clearPreview = (): void => {
    revokePreviewUrl()
    setPreviewKind('none')
    setPreviewPath('')
    setPreviewError('')
    setOriginalText('')
    setDraftText('')
    setHtmlRendered(false)
  }

  const confirmDiscard = (): boolean => !dirty || window.confirm('当前文件有未保存修改，确定放弃吗？')

  useEffect(() => () => {
    if (objectUrlRef.current !== null) URL.revokeObjectURL(objectUrlRef.current)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
  }, [])

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const result = await listHosts()
        if (disposed) return
        setHosts(result)
        const remembered = readRememberedHost(sessionId)
        if (remembered !== '' && result.some(host => host.alias === remembered)) setAlias(remembered)
        else if (result.length === 1) setAlias(result[0]?.alias ?? '')
      } catch (error) {
        if (!disposed) setTopError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { disposed = true }
  }, [sessionId])

  const loadRoot = async (nextAlias = alias): Promise<void> => {
    if (nextAlias === '') return
    setBusy(true)
    setTopError(null)
    try {
      const root = sortEntries(await listRemoteDir(nextAlias, '/'))
      const remembered = readRememberedExpanded(sessionId, nextAlias)
      const nextExpanded: Expanded = {}
      const nextLoaded: LoadedDirs = {}
      const nextErrors: ErrorMap = {}
      for (const path of remembered) nextExpanded[path] = true

      await Promise.all(remembered.map(async path => {
        try {
          nextLoaded[path] = sortEntries(await listRemoteDir(nextAlias, path))
        } catch (error) {
          nextErrors[path] = error instanceof Error ? error.message : String(error)
        }
      }))

      setRootEntries(root)
      setExpanded(nextExpanded)
      setLoaded(nextLoaded)
      setErrors(nextErrors)
      setLoading({})
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (alias === '') {
      setRootEntries([])
      return
    }
    writeRememberedHost(sessionId, alias)
    void loadRoot(alias)
  }, [alias, sessionId])

  const refreshDirectory = async (path: string): Promise<void> => {
    if (alias === '') return
    const entries = sortEntries(await listRemoteDir(alias, path))
    if (path === '/') setRootEntries(entries)
    else setLoaded(prev => ({ ...prev, [path]: entries }))
  }

  const toggle = async (path: string): Promise<void> => {
    if (alias === '') return
    const nowOpen = expanded[path] === true
    const nextExpanded = { ...expanded, [path]: !nowOpen }
    setExpanded(nextExpanded)
    writeRememberedExpanded(sessionId, alias, nextExpanded)
    if (nowOpen || loaded[path] !== undefined) return

    setLoading(prev => ({ ...prev, [path]: true }))
    setErrors(prev => ({ ...prev, [path]: undefined }))
    try {
      const entries = sortEntries(await listRemoteDir(alias, path))
      setLoaded(prev => ({ ...prev, [path]: entries }))
    } catch (error) {
      setErrors(prev => ({ ...prev, [path]: error instanceof Error ? error.message : String(error) }))
    } finally {
      setLoading(prev => ({ ...prev, [path]: false }))
    }
  }

  const openFile = async (item: SelectedItem): Promise<void> => {
    if (alias === '' || item.entry.type !== 'file') return
    if (previewPath === item.path && previewKind !== 'none') {
      setSelected(item)
      return
    }
    if (!confirmDiscard()) return

    setSelected(item)
    revokePreviewUrl()
    setPreviewPath(item.path)
    setPreviewKind('loading')
    setPreviewError('')
    setOriginalText('')
    setDraftText('')
    setHtmlRendered(false)

    const ext = extensionOf(item.path)
    const knownText = TEXT_EXTENSIONS.has(ext)
    const knownImage = IMAGE_EXTENSIONS.has(ext)
    const knownPdf = ext === 'pdf'

    if (knownText && item.entry.size > TEXT_PREVIEW_LIMIT) {
      setPreviewKind('too-large')
      return
    }
    if ((knownImage || knownPdf) && item.entry.size > MEDIA_PREVIEW_LIMIT) {
      setPreviewKind('too-large')
      return
    }

    try {
      const blob = await readRemoteFile(alias, item.path)
      if (knownImage) {
        setBlobPreview(blob)
        setPreviewKind('image')
        return
      }
      if (knownPdf) {
        setBlobPreview(blob)
        setPreviewKind('pdf')
        return
      }
      const textLike = knownText || (blob.size <= TEXT_PREVIEW_LIMIT && await blobLooksLikeText(blob))
      if (textLike) {
        const text = await blob.text()
        setOriginalText(text)
        setDraftText(text)
        setPreviewKind('text')
      } else {
        setPreviewKind('binary')
      }
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error))
      setPreviewKind('error')
    }
  }

  const savePreview = async (): Promise<void> => {
    if (alias === '' || previewKind !== 'text' || previewPath === '' || !dirty) return
    setSaving(true)
    try {
      await writeRemoteFile(alias, previewPath, draftText)
      setOriginalText(draftText)
      await refreshDirectory(parentOf(previewPath))
      showNotice('已保存')
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const downloadSelected = async (): Promise<void> => {
    if (alias === '' || selected?.entry.type !== 'file') return
    try {
      const blob = await readRemoteFile(alias, selected.path)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = selected.entry.name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    }
  }

  const createDirectory = async (): Promise<void> => {
    if (alias === '') return
    const parent = selected?.entry.type === 'dir' ? selected.path : selected?.parentPath ?? '/'
    const answer = window.prompt(`在 ${parent} 下新建目录：`, 'new-folder')
    if (answer === null) return
    const name = answer.trim()
    if (!validName(name)) {
      window.alert('目录名不能为空，且不能包含 /。')
      return
    }
    setMutating(true)
    try {
      await createRemoteDirectory(alias, joinPath(parent, name))
      if (parent !== '/') {
        const nextExpanded = { ...expanded, [parent]: true }
        setExpanded(nextExpanded)
        writeRememberedExpanded(sessionId, alias, nextExpanded)
      }
      await refreshDirectory(parent)
      showNotice('目录已创建')
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutating(false)
    }
  }

  const renameSelected = async (): Promise<void> => {
    if (alias === '' || selected === null) return
    const answer = window.prompt('重命名为：', selected.entry.name)
    if (answer === null) return
    const name = answer.trim()
    if (!validName(name)) {
      window.alert('名称不能为空，且不能包含 /。')
      return
    }
    if (name === selected.entry.name) return

    const from = selected.path
    const to = joinPath(selected.parentPath, name)
    setMutating(true)
    try {
      await renameRemotePath(alias, from, to)

      if (selected.entry.type === 'dir') {
        const nextExpanded = remapRecord(expanded, from, to)
        setExpanded(nextExpanded)
        setLoaded(prev => remapRecord(prev, from, to))
        setErrors(prev => remapRecord(prev, from, to))
        setLoading(prev => remapRecord(prev, from, to))
        writeRememberedExpanded(sessionId, alias, nextExpanded)
      }

      setSelected({
        path: to,
        parentPath: selected.parentPath,
        entry: { ...selected.entry, name },
      })
      if (previewPath !== '' && pathWithin(previewPath, from)) setPreviewPath(remapPath(previewPath, from, to))
      await refreshDirectory(selected.parentPath)
      showNotice('已重命名')
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutating(false)
    }
  }

  const deleteSelected = async (): Promise<void> => {
    if (alias === '' || selected === null) return
    const suffix = dirty && pathWithin(previewPath, selected.path) ? '\n该文件还有未保存修改。' : ''
    if (!window.confirm(`永久删除 ${selected.path}？${suffix}`)) return
    setMutating(true)
    try {
      await deleteRemotePath(alias, selected.path, selected.entry.type === 'dir')
      const nextExpanded = dropSubtree(expanded, selected.path)
      setExpanded(nextExpanded)
      setLoaded(prev => dropSubtree(prev, selected.path))
      setErrors(prev => dropSubtree(prev, selected.path))
      setLoading(prev => dropSubtree(prev, selected.path))
      writeRememberedExpanded(sessionId, alias, nextExpanded)
      if (previewPath !== '' && pathWithin(previewPath, selected.path)) clearPreview()
      const parent = selected.parentPath
      setSelected(null)
      await refreshDirectory(parent)
      showNotice('已删除')
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutating(false)
    }
  }

  const handleAliasChange = (nextAlias: string): void => {
    if (nextAlias === alias) return
    if (!confirmDiscard()) return
    clearPreview()
    setSelected(null)
    setAlias(nextAlias)
  }

  const closePreview = (): void => {
    if (!confirmDiscard()) return
    clearPreview()
  }

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', color: 'inherit' }}>
      <div style={{ display: 'flex', gap: 8, padding: 8, borderBottom: '1px solid rgba(128,128,128,.22)' }}>
        <select
          value={alias}
          onChange={event => handleAliasChange(event.target.value)}
          style={{ flex: 1, minWidth: 0, background: 'transparent', color: 'inherit', border: '1px solid rgba(128,128,128,.35)', borderRadius: 6, padding: '5px 7px' }}
          aria-label="SSH 主机"
        >
          <option value="">选择 SSH 主机</option>
          {hosts.map(host => <option key={host.alias} value={host.alias}>{host.alias} ({host.user}@{host.host})</option>)}
        </select>
        <button type="button" onClick={() => { void loadRoot() }} disabled={alias === '' || busy} title="刷新全部" style={smallButtonStyle}>↻</button>
      </div>

      {selectedHost && (
        <div style={{ padding: '6px 10px', fontSize: 11, opacity: 0.65, borderBottom: '1px solid rgba(128,128,128,.14)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedHost.user}@{selectedHost.host}:{selectedHost.port} · /
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,.14)', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => { void createDirectory() }} disabled={alias === '' || mutating} style={smallButtonStyle}>＋目录</button>
        <button type="button" onClick={() => { void renameSelected() }} disabled={selected === null || mutating} style={smallButtonStyle}>重命名</button>
        <button type="button" onClick={() => { void deleteSelected() }} disabled={selected === null || mutating} style={smallButtonStyle}>删除</button>
        <button type="button" onClick={() => { void downloadSelected() }} disabled={selected?.entry.type !== 'file'} style={smallButtonStyle}>下载</button>
      </div>

      {topError && <div style={{ margin: 8, padding: 8, borderRadius: 6, background: 'rgba(220,53,69,.10)', color: '#d9534f', fontSize: 12 }}>{topError}</div>}
      {notice && <div style={{ margin: '6px 8px 0', fontSize: 12, color: '#2e8b57' }}>{notice}</div>}

      <div style={{ flex: previewKind === 'none' ? 1 : 0.95, minHeight: 140, overflow: 'auto', padding: '4px 0 12px' }}>
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
            selectedPath={selected?.path}
            onToggle={path => { void toggle(path) }}
            onSelect={setSelected}
            onOpenFile={item => { void openFile(item) }}
          />
        ))}
      </div>

      {previewKind !== 'none' && (
        <div style={{ flex: 1.05, minHeight: 220, borderTop: '1px solid rgba(128,128,128,.28)', display: 'flex', flexDirection: 'column', background: 'rgba(128,128,128,.025)' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,.18)' }}>
            <strong title={previewPath} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{basename(previewPath)}</strong>
            {dirty && <span style={{ fontSize: 10, color: '#d98c00' }}>未保存</span>}
            {previewKind === 'text' && isHtml(previewPath) && (
              <button type="button" onClick={() => setHtmlRendered(value => !value)} style={smallButtonStyle}>{htmlRendered ? '源码' : '预览'}</button>
            )}
            {previewKind === 'text' && (
              <button type="button" onClick={() => { void savePreview() }} disabled={!dirty || saving} style={smallButtonStyle}>{saving ? '保存中…' : '保存'}</button>
            )}
            <button type="button" onClick={closePreview} style={smallButtonStyle}>×</button>
          </div>

          <div style={{ padding: '4px 8px', fontSize: 10, opacity: 0.58, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={previewPath}>
            {previewPath}
          </div>

          {previewKind === 'loading' && <div style={{ padding: 12, opacity: 0.65, fontSize: 12 }}>正在读取文件…</div>}
          {previewKind === 'error' && <div style={{ padding: 12, color: '#d9534f', fontSize: 12 }}>{previewError}</div>}
          {previewKind === 'too-large' && (
            <div style={{ padding: 12, fontSize: 12 }}>
              文件较大，已停止自动预览以避免浏览器卡顿。可以使用上方“下载”按钮保存到本地。
            </div>
          )}
          {previewKind === 'binary' && (
            <div style={{ padding: 12, fontSize: 12 }}>
              这是二进制或当前不支持直接编辑的文件。可以使用上方“下载”按钮。
            </div>
          )}
          {previewKind === 'text' && htmlRendered && (
            <iframe
              title={`HTML preview ${previewPath}`}
              srcDoc={draftText}
              sandbox=""
              style={{ flex: 1, minHeight: 180, width: '100%', border: 0, background: 'white' }}
            />
          )}
          {previewKind === 'text' && !htmlRendered && (
            <textarea
              value={draftText}
              onChange={event => setDraftText(event.target.value)}
              spellCheck={false}
              style={{
                flex: 1,
                minHeight: 180,
                width: '100%',
                resize: 'none',
                border: 0,
                borderTop: '1px solid rgba(128,128,128,.12)',
                outline: 'none',
                padding: 10,
                boxSizing: 'border-box',
                background: 'transparent',
                color: 'inherit',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 12,
                lineHeight: 1.55,
                tabSize: 2,
              }}
            />
          )}
          {previewKind === 'image' && previewUrl !== '' && (
            <div style={{ flex: 1, minHeight: 180, overflow: 'auto', display: 'grid', placeItems: 'center', padding: 10 }}>
              <img src={previewUrl} alt={basename(previewPath)} style={{ maxWidth: '100%', maxHeight: 520, objectFit: 'contain' }} />
            </div>
          )}
          {previewKind === 'pdf' && previewUrl !== '' && (
            <iframe title={`PDF preview ${previewPath}`} src={previewUrl} style={{ flex: 1, minHeight: 260, width: '100%', border: 0 }} />
          )}
        </div>
      )}

      {selected && (
        <div style={{ padding: '5px 9px', fontSize: 10, opacity: 0.5, borderTop: '1px solid rgba(128,128,128,.14)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${selected.path}\n${formatTime(selected.entry.mtimeMs)}`}>
          {selected.path} · {selected.entry.type === 'dir' ? '目录' : formatBytes(selected.entry.size)}
        </div>
      )}
    </div>
  )
}
