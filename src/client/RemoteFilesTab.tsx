import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { GitStatusSnapshot, RemoteDirEntry, SshHostSummary } from './api.ts'
import {
  createRemoteDirectory,
  deleteRemotePath,
  listHosts,
  listRemoteDir,
  readGitStatus,
  readRemoteFile,
  renameRemotePath,
  writeRemoteFile,
} from './api.ts'
import { CodeEditor, type CodeEditorHandle } from './CodeEditor.tsx'

type LoadedDirs = Record<string, RemoteDirEntry[]>
type Expanded = Record<string, boolean>
type LoadingMap = Record<string, boolean>
type ErrorMap = Record<string, string | undefined>
type GitMarks = Record<string, string>

type PreviewKind = 'none' | 'loading' | 'text' | 'image' | 'pdf' | 'binary' | 'too-large' | 'error'

interface SelectedItem {
  path: string
  parentPath: string
  entry: RemoteDirEntry
}

interface RemoteFilesTabProps {
  sessionId?: string
}

interface ContextMenuState {
  x: number
  y: number
  item: SelectedItem | null
  directory: string
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

function expandedStorageKey(sessionId: string, alias: string): string {
  return `dsh-ssh-files-sidebar:v3:${sessionId}:${alias}:expanded`
}

function hostStorageKey(sessionId: string): string {
  return `dsh-ssh-files-sidebar:v3:${sessionId}:host`
}

function splitStorageKey(sessionId: string): string {
  return `dsh-ssh-files-sidebar:v3:${sessionId}:split`
}

function readRememberedHost(sessionId: string): string {
  try { return localStorage.getItem(hostStorageKey(sessionId)) ?? '' } catch { return '' }
}

function writeRememberedHost(sessionId: string, alias: string): void {
  try { localStorage.setItem(hostStorageKey(sessionId), alias) } catch { /* storage unavailable */ }
}

function readRememberedExpanded(sessionId: string, alias: string): string[] {
  try {
    const raw = localStorage.getItem(expandedStorageKey(sessionId, alias))
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
  try { localStorage.setItem(expandedStorageKey(sessionId, alias), JSON.stringify(paths)) } catch { /* storage unavailable */ }
}

function readSplitPercent(sessionId: string): number {
  try {
    const value = Number(localStorage.getItem(splitStorageKey(sessionId)))
    return Number.isFinite(value) && value >= 20 && value <= 80 ? value : 48
  } catch {
    return 48
  }
}

function writeSplitPercent(sessionId: string, value: number): void {
  try { localStorage.setItem(splitStorageKey(sessionId), String(value)) } catch { /* storage unavailable */ }
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

function statusLabel(status: string): string {
  if (status === '??') return '?'
  if (status.includes('U')) return 'U'
  if (status.includes('R')) return 'R'
  if (status.includes('D')) return 'D'
  if (status.includes('A')) return 'A'
  if (status.includes('M')) return 'M'
  return status.trim().slice(0, 1) || '•'
}

function gitBadge(path: string, isDirectory: boolean, marks: GitMarks): string {
  const exact = marks[path]
  if (exact !== undefined) return statusLabel(exact)
  if (isDirectory && Object.keys(marks).some(candidate => pathWithin(candidate, path))) return '•'
  return ''
}

function gitBadgeColor(label: string): string {
  if (label === 'A' || label === '?') return '#2e8b57'
  if (label === 'D' || label === 'U') return '#d9534f'
  if (label === 'R') return '#7b61a8'
  if (label === 'M' || label === '•') return '#d98c00'
  return 'inherit'
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
  gitMarks: GitMarks
  selectedPath?: string
  onToggle: (path: string) => void
  onSelect: (item: SelectedItem) => void
  onOpenFile: (item: SelectedItem) => void
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, item: SelectedItem) => void
}

function TreeNode(props: TreeNodeProps) {
  const {
    alias, path, depth, entry, expanded, loaded, loading, errors, gitMarks,
    selectedPath, onToggle, onSelect, onOpenFile, onContextMenu,
  } = props
  const fullPath = joinPath(path, entry.name)
  const item: SelectedItem = { path: fullPath, parentPath: path, entry }
  const isDir = entry.type === 'dir'
  const isOpen = isDir && expanded[fullPath] === true
  const children = loaded[fullPath]
  const selected = selectedPath === fullPath
  const badge = gitBadge(fullPath, isDir, gitMarks)

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          onSelect(item)
          if (isDir) onToggle(fullPath)
          else if (entry.type === 'file') onOpenFile(item)
        }}
        onContextMenu={event => onContextMenu(event, item)}
        title={`${fullPath}${entry.mtimeMs > 0 ? `\n${formatTime(entry.mtimeMs)}` : ''}`}
        style={{
          width: '100%',
          border: 0,
          background: selected ? 'rgba(90,130,255,.14)' : 'transparent',
          color: 'inherit',
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) auto auto',
          gap: 7,
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
        {badge !== '' && (
          <span title={`Git: ${badge}`} style={{ color: gitBadgeColor(badge), fontWeight: 700, fontSize: 11 }}>{badge}</span>
        )}
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
              gitMarks={gitMarks}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
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

const menuButtonStyle = {
  width: '100%',
  border: 0,
  borderRadius: 4,
  background: 'transparent',
  color: 'inherit',
  padding: '7px 10px',
  textAlign: 'left',
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

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [treePercent, setTreePercent] = useState(() => readSplitPercent(sessionId))
  const [gitRoot, setGitRoot] = useState<string | null>(null)
  const [gitMarks, setGitMarks] = useState<GitMarks>({})
  const [gitBusy, setGitBusy] = useState(false)

  const objectUrlRef = useRef<string | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const uploadDirectoryRef = useRef('/')
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<CodeEditorHandle | null>(null)

  const selectedHost = useMemo(() => hosts.find(host => host.alias === alias), [hosts, alias])
  const dirty = previewKind === 'text' && draftText !== originalText

  const showNotice = (message: string): void => {
    setNotice(message)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2400)
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
    setTreePercent(readSplitPercent(sessionId))
  }, [sessionId])

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

  const refreshGitStatus = async (item?: SelectedItem | null, directoryOverride?: string): Promise<void> => {
    if (alias === '') return
    const path = directoryOverride ?? item?.path ?? selected?.path ?? '/'
    const isDirectory = directoryOverride !== undefined || item?.entry.type === 'dir' || (item === undefined && selected?.entry.type === 'dir')
    setGitBusy(true)
    try {
      const snapshot: GitStatusSnapshot | null = await readGitStatus(alias, path, isDirectory)
      if (snapshot === null) {
        setGitRoot(null)
        setGitMarks({})
        return
      }
      const marks: GitMarks = {}
      for (const entry of snapshot.entries) marks[entry.path] = entry.status
      setGitRoot(snapshot.root)
      setGitMarks(marks)
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    } finally {
      setGitBusy(false)
    }
  }

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
      setGitRoot(null)
      setGitMarks({})
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

  const selectItem = (item: SelectedItem): void => {
    setSelected(item)
    void refreshGitStatus(item)
  }

  const openFile = async (item: SelectedItem): Promise<void> => {
    if (alias === '' || item.entry.type !== 'file') return
    if (previewPath === item.path && previewKind !== 'none') {
      setSelected(item)
      return
    }
    if (!confirmDiscard()) return

    setSelected(item)
    void refreshGitStatus(item)
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
      await refreshGitStatus(selected)
      showNotice('已保存')
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const downloadItem = async (item: SelectedItem | null = selected): Promise<void> => {
    if (alias === '' || item?.entry.type !== 'file') return
    try {
      const blob = await readRemoteFile(alias, item.path)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = item.entry.name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    }
  }

  const createDirectory = async (parentOverride?: string): Promise<void> => {
    if (alias === '') return
    const parent = parentOverride ?? (selected?.entry.type === 'dir' ? selected.path : selected?.parentPath ?? '/')
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
      await refreshGitStatus(null, parent)
      showNotice('目录已创建')
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutating(false)
    }
  }

  const renameItem = async (item: SelectedItem | null = selected): Promise<void> => {
    if (alias === '' || item === null) return
    const answer = window.prompt('重命名为：', item.entry.name)
    if (answer === null) return
    const name = answer.trim()
    if (!validName(name)) {
      window.alert('名称不能为空，且不能包含 /。')
      return
    }
    if (name === item.entry.name) return

    const from = item.path
    const to = joinPath(item.parentPath, name)
    setMutating(true)
    try {
      await renameRemotePath(alias, from, to)

      if (item.entry.type === 'dir') {
        const nextExpanded = remapRecord(expanded, from, to)
        setExpanded(nextExpanded)
        setLoaded(prev => remapRecord(prev, from, to))
        setErrors(prev => remapRecord(prev, from, to))
        setLoading(prev => remapRecord(prev, from, to))
        writeRememberedExpanded(sessionId, alias, nextExpanded)
      }

      const nextItem: SelectedItem = {
        path: to,
        parentPath: item.parentPath,
        entry: { ...item.entry, name },
      }
      setSelected(nextItem)
      if (previewPath !== '' && pathWithin(previewPath, from)) setPreviewPath(remapPath(previewPath, from, to))
      await refreshDirectory(item.parentPath)
      await refreshGitStatus(nextItem)
      showNotice('已重命名')
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutating(false)
    }
  }

  const deleteItem = async (item: SelectedItem | null = selected): Promise<void> => {
    if (alias === '' || item === null) return
    const suffix = dirty && pathWithin(previewPath, item.path) ? '\n该文件还有未保存修改。' : ''
    if (!window.confirm(`永久删除 ${item.path}？${suffix}`)) return
    setMutating(true)
    try {
      await deleteRemotePath(alias, item.path, item.entry.type === 'dir')
      const nextExpanded = dropSubtree(expanded, item.path)
      setExpanded(nextExpanded)
      setLoaded(prev => dropSubtree(prev, item.path))
      setErrors(prev => dropSubtree(prev, item.path))
      setLoading(prev => dropSubtree(prev, item.path))
      writeRememberedExpanded(sessionId, alias, nextExpanded)
      if (previewPath !== '' && pathWithin(previewPath, item.path)) clearPreview()
      const parent = item.parentPath
      setSelected(null)
      await refreshDirectory(parent)
      await refreshGitStatus(null, parent)
      showNotice('已删除')
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutating(false)
    }
  }

  const chooseUpload = (directory: string): void => {
    if (alias === '') return
    uploadDirectoryRef.current = directory
    if (fileInputRef.current !== null) {
      fileInputRef.current.value = ''
      fileInputRef.current.click()
    }
  }

  const uploadFiles = async (files: FileList | null): Promise<void> => {
    if (alias === '' || files === null || files.length === 0) return
    const directory = uploadDirectoryRef.current
    setMutating(true)
    setTopError(null)
    try {
      const existingEntries = await listRemoteDir(alias, directory)
      const existing = new Set(existingEntries.map(entry => entry.name))
      let uploaded = 0
      for (const file of Array.from(files)) {
        if (!validName(file.name)) continue
        if (existing.has(file.name) && !window.confirm(`${joinPath(directory, file.name)} 已存在，是否覆盖？`)) continue
        setNotice(`正在上传 ${file.name}…`)
        await writeRemoteFile(alias, joinPath(directory, file.name), file)
        uploaded += 1
      }
      await refreshDirectory(directory)
      await refreshGitStatus(null, directory)
      showNotice(uploaded > 0 ? `已上传 ${uploaded} 个文件` : '没有上传文件')
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
    setGitRoot(null)
    setGitMarks({})
    setAlias(nextAlias)
  }

  const closePreview = (): void => {
    if (!confirmDiscard()) return
    clearPreview()
  }

  const openContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, item: SelectedItem): void => {
    event.preventDefault()
    event.stopPropagation()
    setSelected(item)
    void refreshGitStatus(item)
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 250),
      item,
      directory: item.entry.type === 'dir' ? item.path : item.parentPath,
    })
  }

  const openRootContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    event.preventDefault()
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 210),
      item: null,
      directory: '/',
    })
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const container = splitContainerRef.current
    if (container === null) return
    const rect = container.getBoundingClientRect()
    let last = treePercent
    const move = (moveEvent: PointerEvent): void => {
      const raw = ((moveEvent.clientY - rect.top) / rect.height) * 100
      last = Math.max(20, Math.min(80, raw))
      setTreePercent(last)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      writeSplitPercent(sessionId, last)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const runContextAction = (action: () => void | Promise<void>): void => {
    setContextMenu(null)
    void action()
  }

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', color: 'inherit', position: 'relative' }}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={event => { void uploadFiles(event.currentTarget.files) }}
      />

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
          {gitRoot !== null && <span title={gitRoot}> · Git: {gitRoot}</span>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,.14)', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => { void createDirectory() }} disabled={alias === '' || mutating} style={smallButtonStyle}>＋目录</button>
        <button type="button" onClick={() => chooseUpload(selected?.entry.type === 'dir' ? selected.path : selected?.parentPath ?? '/')} disabled={alias === '' || mutating} style={smallButtonStyle}>上传</button>
        <button type="button" onClick={() => { void renameItem() }} disabled={selected === null || mutating} style={smallButtonStyle}>重命名</button>
        <button type="button" onClick={() => { void deleteItem() }} disabled={selected === null || mutating} style={smallButtonStyle}>删除</button>
        <button type="button" onClick={() => { void downloadItem() }} disabled={selected?.entry.type !== 'file'} style={smallButtonStyle}>下载</button>
        <button type="button" onClick={() => { void refreshGitStatus() }} disabled={alias === '' || gitBusy} style={smallButtonStyle}>{gitBusy ? 'Git…' : 'Git'}</button>
      </div>

      {topError && <div style={{ margin: 8, padding: 8, borderRadius: 6, background: 'rgba(220,53,69,.10)', color: '#d9534f', fontSize: 12 }}>{topError}</div>}
      {notice && <div style={{ margin: '6px 8px 0', fontSize: 12, color: '#2e8b57' }}>{notice}</div>}

      <div ref={splitContainerRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div
          onContextMenu={openRootContextMenu}
          style={{
            height: previewKind === 'none' ? '100%' : `${treePercent}%`,
            flex: previewKind === 'none' ? '1 1 auto' : '0 0 auto',
            minHeight: 100,
            overflow: 'auto',
            padding: '4px 0 12px',
          }}
        >
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
              gitMarks={gitMarks}
              selectedPath={selected?.path}
              onToggle={path => { void toggle(path) }}
              onSelect={selectItem}
              onOpenFile={item => { void openFile(item) }}
              onContextMenu={openContextMenu}
            />
          ))}
        </div>

        {previewKind !== 'none' && (
          <div
            onPointerDown={startResize}
            title="拖拽调整文件树 / 编辑器高度"
            style={{
              height: 7,
              flex: '0 0 7px',
              cursor: 'row-resize',
              touchAction: 'none',
              borderTop: '1px solid rgba(128,128,128,.20)',
              borderBottom: '1px solid rgba(128,128,128,.20)',
              background: 'rgba(128,128,128,.07)',
            }}
          />
        )}

        {previewKind !== 'none' && (
          <div style={{ flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column', background: 'rgba(128,128,128,.025)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,.18)' }}>
              <strong title={previewPath} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{basename(previewPath)}</strong>
              {dirty && <span style={{ fontSize: 10, color: '#d98c00' }}>未保存</span>}
              {previewKind === 'text' && !htmlRendered && (
                <button type="button" onClick={() => editorRef.current?.openSearch()} style={smallButtonStyle}>搜索</button>
              )}
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
                文件较大，已停止自动预览以避免浏览器卡顿。可以使用“下载”保存到本地。
              </div>
            )}
            {previewKind === 'binary' && (
              <div style={{ padding: 12, fontSize: 12 }}>
                这是二进制或当前不支持直接编辑的文件。可以使用“下载”。
              </div>
            )}
            {previewKind === 'text' && htmlRendered && (
              <iframe
                title={`HTML preview ${previewPath}`}
                srcDoc={draftText}
                sandbox=""
                style={{ flex: 1, minHeight: 120, width: '100%', border: 0, background: 'white' }}
              />
            )}
            {previewKind === 'text' && !htmlRendered && (
              <div style={{ flex: 1, minHeight: 0, borderTop: '1px solid rgba(128,128,128,.12)' }}>
                <CodeEditor
                  ref={editorRef}
                  path={previewPath}
                  value={draftText}
                  onChange={setDraftText}
                  onSave={savePreview}
                />
              </div>
            )}
            {previewKind === 'image' && previewUrl !== '' && (
              <div style={{ flex: 1, minHeight: 120, overflow: 'auto', display: 'grid', placeItems: 'center', padding: 10 }}>
                <img src={previewUrl} alt={basename(previewPath)} style={{ maxWidth: '100%', maxHeight: 520, objectFit: 'contain' }} />
              </div>
            )}
            {previewKind === 'pdf' && previewUrl !== '' && (
              <iframe title={`PDF preview ${previewPath}`} src={previewUrl} style={{ flex: 1, minHeight: 180, width: '100%', border: 0 }} />
            )}
          </div>
        )}
      </div>

      {selected && (
        <div style={{ padding: '5px 9px', fontSize: 10, opacity: 0.5, borderTop: '1px solid rgba(128,128,128,.14)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${selected.path}\n${formatTime(selected.entry.mtimeMs)}`}>
          {selected.path} · {selected.entry.type === 'dir' ? '目录' : formatBytes(selected.entry.size)}
        </div>
      )}

      {contextMenu !== null && (
        <>
          <div
            onMouseDown={() => setContextMenu(null)}
            onContextMenu={event => { event.preventDefault(); setContextMenu(null) }}
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
          />
          <div
            onMouseDown={event => event.stopPropagation()}
            style={{
              position: 'fixed',
              left: contextMenu.x,
              top: contextMenu.y,
              zIndex: 9999,
              width: 178,
              padding: 5,
              borderRadius: 8,
              border: '1px solid rgba(128,128,128,.30)',
              background: 'var(--color-background, Canvas)',
              color: 'inherit',
              boxShadow: '0 8px 28px rgba(0,0,0,.22)',
            }}
          >
            {contextMenu.item?.entry.type === 'file' && (
              <button type="button" style={menuButtonStyle} onClick={() => runContextAction(() => openFile(contextMenu.item!))}>打开 / 编辑</button>
            )}
            {contextMenu.item?.entry.type === 'file' && (
              <button type="button" style={menuButtonStyle} onClick={() => runContextAction(() => downloadItem(contextMenu.item))}>下载</button>
            )}
            <button type="button" style={menuButtonStyle} onClick={() => runContextAction(() => refreshDirectory(contextMenu.directory))}>刷新目录</button>
            {(contextMenu.item === null || contextMenu.item.entry.type === 'dir') && (
              <button type="button" style={menuButtonStyle} onClick={() => runContextAction(() => chooseUpload(contextMenu.directory))}>上传文件到这里</button>
            )}
            {(contextMenu.item === null || contextMenu.item.entry.type === 'dir') && (
              <button type="button" style={menuButtonStyle} onClick={() => runContextAction(() => createDirectory(contextMenu.directory))}>新建目录</button>
            )}
            <button type="button" style={menuButtonStyle} onClick={() => runContextAction(() => refreshGitStatus(contextMenu.item, contextMenu.directory))}>刷新 Git 状态</button>
            {contextMenu.item !== null && (
              <button type="button" style={menuButtonStyle} onClick={() => runContextAction(() => renameItem(contextMenu.item))}>重命名</button>
            )}
            {contextMenu.item !== null && (
              <button type="button" style={{ ...menuButtonStyle, color: '#d9534f' }} onClick={() => runContextAction(() => deleteItem(contextMenu.item))}>删除</button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
