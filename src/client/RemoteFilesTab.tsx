import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { RemoteDirEntry, SshHostSummary } from './api.ts'
import {
  createRemoteDirectory,
  deleteRemotePath,
  listHosts,
  listRemoteDir,
  readArchiveListing,
  readRemoteFile,
  renameRemotePath,
  writeRemoteFile,
} from './api.ts'
import { CodeEditor, type CodeEditorHandle } from './CodeEditor.tsx'

type LoadedDirs = Record<string, RemoteDirEntry[]>
type Expanded = Record<string, boolean>
type LoadingMap = Record<string, boolean>
type ErrorMap = Record<string, string | undefined>
type SelectionMap = Record<string, SelectedItem>

type PreviewKind = 'none' | 'loading' | 'text' | 'image' | 'pdf' | 'archive' | 'binary' | 'too-large' | 'error'

interface SelectedItem {
  path: string
  parentPath: string
  entry: RemoteDirEntry
}

interface RemoteFilesTabProps {
  sessionId?: string
  workspaceCwd?: string
}

interface ContextMenuState {
  x: number
  y: number
  item: SelectedItem | null
  directory: string
}

const TEXT_PREVIEW_LIMIT = 8 * 1024 * 1024
const MEDIA_PREVIEW_LIMIT = 64 * 1024 * 1024
const RESTORE_LIMIT = 100

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
const ARCHIVE_SUFFIXES = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tgz', '.tbz', '.tbz2', '.txz', '.tar', '.zip', '.7z', '.rar', '.gz', '.bz2', '.xz']

/** dsh-rw placeholder cwd -> SSH alias. Local workspaces return null. */
export function remoteWorkspaceAliasFromCwd(cwd?: string): string | null {
  if (!cwd) return null
  const normalized = cwd.replace(/\\/g, '/')
  const marker = '/.dsh/remote-workspaces/'
  const index = normalized.toLowerCase().indexOf(marker)
  if (index < 0) return null
  const tail = normalized.slice(index + marker.length)
  const alias = tail.split('/')[0]?.trim() ?? ''
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias) ? alias : null
}

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

function isArchive(path: string): boolean {
  const lower = path.toLowerCase()
  return ARCHIVE_SUFFIXES.some(suffix => lower.endsWith(suffix))
}

function imageMime(path: string): string {
  switch (extensionOf(path)) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'ico': return 'image/x-icon'
    case 'avif': return 'image/avif'
    default: return 'application/octet-stream'
  }
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
  return `dsh-ssh-files-sidebar:v4:${sessionId}:${alias}:expanded`
}

function splitStorageKey(sessionId: string): string {
  return `dsh-ssh-files-sidebar:v4:${sessionId}:split`
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

function flattenVisible(rootEntries: RemoteDirEntry[], expanded: Expanded, loaded: LoadedDirs): SelectedItem[] {
  const result: SelectedItem[] = []
  const walk = (entries: RemoteDirEntry[], parent: string): void => {
    for (const entry of entries) {
      const path = joinPath(parent, entry.name)
      result.push({ path, parentPath: parent, entry })
      if (entry.type === 'dir' && expanded[path] && loaded[path]) walk(loaded[path]!, path)
    }
  }
  walk(rootEntries, '/')
  return result
}

function collapseDeleteTargets(items: SelectedItem[]): SelectedItem[] {
  const paths = new Set(items.map(item => item.path))
  return items.filter(item => {
    let parent = item.parentPath
    while (parent !== '/') {
      if (paths.has(parent)) return false
      parent = parentOf(parent)
    }
    return !paths.has('/')
  }).sort((a, b) => b.path.length - a.path.length)
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
  selectedPaths: ReadonlySet<string>
  renamingPath: string | null
  renameDraft: string
  onClick: (event: ReactMouseEvent<HTMLButtonElement>, item: SelectedItem) => void
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, item: SelectedItem) => void
  onRenameDraft: (value: string) => void
  onRenameCommit: (item: SelectedItem) => void
  onRenameCancel: () => void
}

function TreeNode(props: TreeNodeProps) {
  const {
    alias, path, depth, entry, expanded, loaded, loading, errors, selectedPaths,
    renamingPath, renameDraft, onClick, onContextMenu, onRenameDraft, onRenameCommit, onRenameCancel,
  } = props
  const fullPath = joinPath(path, entry.name)
  const item: SelectedItem = { path: fullPath, parentPath: path, entry }
  const isDir = entry.type === 'dir'
  const isOpen = isDir && expanded[fullPath] === true
  const children = loaded[fullPath]
  const selected = selectedPaths.has(fullPath)
  const renaming = renamingPath === fullPath

  return (
    <div>
      <button
        type="button"
        onClick={event => { if (!renaming) onClick(event, item) }}
        onContextMenu={event => { if (!renaming) onContextMenu(event, item) }}
        title={`${fullPath}${entry.mtimeMs > 0 ? `\n${formatTime(entry.mtimeMs)}` : ''}`}
        style={{
          width: '100%',
          border: 0,
          background: selected ? 'rgba(90,130,255,.16)' : 'transparent',
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
        <span style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 2 }}>
          {isDir ? <FolderIcon open={isOpen} /> : <FileIcon />}
          {renaming ? (
            <input
              autoFocus
              value={renameDraft}
              onChange={event => onRenameDraft(event.target.value)}
              onFocus={event => event.currentTarget.select()}
              onClick={event => event.stopPropagation()}
              onMouseDown={event => event.stopPropagation()}
              onBlur={() => onRenameCommit(item)}
              onKeyDown={event => {
                event.stopPropagation()
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') {
                  event.preventDefault()
                  onRenameCancel()
                }
              }}
              style={{ minWidth: 0, flex: 1, border: '1px solid #6f8cff', borderRadius: 4, background: 'transparent', color: 'inherit', font: 'inherit', padding: '1px 4px', outline: 'none' }}
            />
          ) : (
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
          )}
        </span>
        <span style={{ opacity: 0.58, fontSize: 11, whiteSpace: 'nowrap' }}>{isDir ? '' : formatBytes(entry.size)}</span>
      </button>
      {isOpen && (
        <div>
          {loading[fullPath] && <div style={{ paddingLeft: 28 + depth * 14, opacity: 0.65, fontSize: 12 }}>加载中…</div>}
          {errors[fullPath] && <div style={{ padding: `3px 8px 3px ${28 + depth * 14}px`, color: '#d9534f', fontSize: 12 }}>{errors[fullPath]}</div>}
          {children?.map(child => (
            <TreeNode
              key={`${alias}:${fullPath}:${child.name}`}
              {...props}
              path={fullPath}
              depth={depth + 1}
              entry={child}
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

export function RemoteFilesTab({ sessionId = 'global', workspaceCwd }: RemoteFilesTabProps) {
  const boundAlias = useMemo(() => remoteWorkspaceAliasFromCwd(workspaceCwd), [workspaceCwd])
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [alias, setAlias] = useState('')
  const [rootEntries, setRootEntries] = useState<RemoteDirEntry[]>([])
  const [expanded, setExpanded] = useState<Expanded>({})
  const [loaded, setLoaded] = useState<LoadedDirs>({})
  const [loading, setLoading] = useState<LoadingMap>({})
  const [errors, setErrors] = useState<ErrorMap>({})
  const [selection, setSelection] = useState<SelectionMap>({})
  const [primaryPath, setPrimaryPath] = useState<string | null>(null)
  const [topError, setTopError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [previewKind, setPreviewKind] = useState<PreviewKind>('none')
  const [previewPath, setPreviewPath] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [originalText, setOriginalText] = useState('')
  const [draftText, setDraftText] = useState('')
  const [archiveText, setArchiveText] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [htmlRendered, setHtmlRendered] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mutating, setMutating] = useState(false)

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [treePercent, setTreePercent] = useState(() => readSplitPercent(sessionId))
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const objectUrlRef = useRef<string | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const uploadDirectoryRef = useRef('/')
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<CodeEditorHandle | null>(null)
  const anchorPathRef = useRef<string | null>(null)
  const renameCommitRef = useRef(false)

  const selectedHost = useMemo(() => hosts.find(host => host.alias === alias), [hosts, alias])
  const selectedPaths = useMemo(() => new Set(Object.keys(selection)), [selection])
  const selectedItems = useMemo(() => Object.values(selection), [selection])
  const primary = primaryPath ? selection[primaryPath] ?? null : null
  const visibleItems = useMemo(() => flattenVisible(rootEntries, expanded, loaded), [rootEntries, expanded, loaded])
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

  const setBlobPreview = (blob: Blob, mime?: string): void => {
    revokePreviewUrl()
    const typed = mime && blob.type !== mime ? blob.slice(0, blob.size, mime) : blob
    const url = URL.createObjectURL(typed)
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
    setArchiveText('')
    setHtmlRendered(false)
  }

  const confirmDiscard = (): boolean => !dirty || window.confirm('当前文件有未保存修改，确定放弃吗？')

  useEffect(() => () => {
    if (objectUrlRef.current !== null) URL.revokeObjectURL(objectUrlRef.current)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
  }, [])

  useEffect(() => {
    setTreePercent(readSplitPercent(sessionId))
    setSelection({})
    setPrimaryPath(null)
    anchorPathRef.current = null
    clearPreview()
  }, [sessionId, workspaceCwd])

  useEffect(() => {
    if (boundAlias === null) {
      setAlias('')
      setHosts([])
      setRootEntries([])
      return
    }
    let disposed = false
    void (async () => {
      try {
        const result = await listHosts()
        if (disposed) return
        setHosts(result)
        if (!result.some(host => host.alias === boundAlias)) {
          setAlias('')
          setTopError(`当前远程工作区绑定到 ${boundAlias}，但 SSH 主机配置中找不到这个别名。请在左侧 SSH 中补回该主机。`)
          return
        }
        setTopError(null)
        setAlias(boundAlias)
      } catch (error) {
        if (!disposed) setTopError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { disposed = true }
  }, [boundAlias])

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
    if (alias !== '') void loadRoot(alias)
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
    if (previewPath === item.path && previewKind !== 'none') return
    if (!confirmDiscard()) return

    revokePreviewUrl()
    setPreviewPath(item.path)
    setPreviewKind('loading')
    setPreviewError('')
    setOriginalText('')
    setDraftText('')
    setArchiveText('')
    setHtmlRendered(false)

    const ext = extensionOf(item.path)
    const knownText = TEXT_EXTENSIONS.has(ext)
    const knownImage = IMAGE_EXTENSIONS.has(ext)
    const knownPdf = ext === 'pdf'
    const knownArchive = isArchive(item.path)

    if (knownText && item.entry.size > TEXT_PREVIEW_LIMIT) {
      setPreviewKind('too-large')
      return
    }
    if ((knownImage || knownPdf) && item.entry.size > MEDIA_PREVIEW_LIMIT) {
      setPreviewKind('too-large')
      return
    }

    try {
      if (knownArchive) {
        setArchiveText(await readArchiveListing(alias, item.path))
        setPreviewKind('archive')
        return
      }

      const blob = await readRemoteFile(alias, item.path)
      if (knownImage) {
        setBlobPreview(blob, imageMime(item.path))
        setPreviewKind('image')
        return
      }
      if (knownPdf) {
        setBlobPreview(blob, 'application/pdf')
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

  const handleNodeClick = (event: ReactMouseEvent<HTMLButtonElement>, item: SelectedItem): void => {
    const ctrl = event.ctrlKey || event.metaKey
    const shift = event.shiftKey

    if (shift && anchorPathRef.current !== null) {
      const start = visibleItems.findIndex(candidate => candidate.path === anchorPathRef.current)
      const end = visibleItems.findIndex(candidate => candidate.path === item.path)
      if (start >= 0 && end >= 0) {
        const [from, to] = start <= end ? [start, end] : [end, start]
        const next: SelectionMap = ctrl ? { ...selection } : {}
        for (const candidate of visibleItems.slice(from, to + 1)) next[candidate.path] = candidate
        setSelection(next)
        setPrimaryPath(item.path)
        return
      }
    }

    if (ctrl) {
      const next = { ...selection }
      if (next[item.path]) delete next[item.path]
      else next[item.path] = item
      setSelection(next)
      setPrimaryPath(next[item.path] ? item.path : Object.keys(next).at(-1) ?? null)
      anchorPathRef.current = item.path
      return
    }

    setSelection({ [item.path]: item })
    setPrimaryPath(item.path)
    anchorPathRef.current = item.path
    if (item.entry.type === 'dir') void toggle(item.path)
    else if (item.entry.type === 'file') void openFile(item)
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

  const downloadOne = async (item: SelectedItem): Promise<void> => {
    if (alias === '' || item.entry.type !== 'file') return
    const blob = await readRemoteFile(alias, item.path)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = item.entry.name
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const downloadSelection = async (items = selectedItems): Promise<void> => {
    const files = items.filter(item => item.entry.type === 'file')
    if (files.length === 0) return
    try {
      for (const item of files) await downloadOne(item)
      if (files.length > 1) showNotice(`已触发 ${files.length} 个文件下载`)
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    }
  }

  const createDirectory = async (parentOverride?: string): Promise<void> => {
    if (alias === '') return
    const parent = parentOverride ?? (primary?.entry.type === 'dir' ? primary.path : primary?.parentPath ?? '/')
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

  const beginRename = (item: SelectedItem | null = primary): void => {
    if (item === null || selectedItems.length > 1) return
    setSelection({ [item.path]: item })
    setPrimaryPath(item.path)
    setRenameDraft(item.entry.name)
    setRenamingPath(item.path)
  }

  const cancelRename = (): void => {
    renameCommitRef.current = true
    setRenamingPath(null)
    setRenameDraft('')
    queueMicrotask(() => { renameCommitRef.current = false })
  }

  const commitRename = async (item: SelectedItem): Promise<void> => {
    if (renamingPath !== item.path || renameCommitRef.current) return
    renameCommitRef.current = true
    const name = renameDraft.trim()
    setRenamingPath(null)
    setRenameDraft('')
    try {
      if (!validName(name)) {
        window.alert('名称不能为空，且不能包含 /。')
        return
      }
      if (name === item.entry.name) return
      if (alias === '') return

      const from = item.path
      const to = joinPath(item.parentPath, name)
      setMutating(true)
      await renameRemotePath(alias, from, to)

      let nextExpanded = expanded
      if (item.entry.type === 'dir') {
        nextExpanded = remapRecord(expanded, from, to)
        setExpanded(nextExpanded)
        setLoaded(prev => remapRecord(prev, from, to))
        setErrors(prev => remapRecord(prev, from, to))
        setLoading(prev => remapRecord(prev, from, to))
        writeRememberedExpanded(sessionId, alias, nextExpanded)
      }

      const nextItem: SelectedItem = { path: to, parentPath: item.parentPath, entry: { ...item.entry, name } }
      setSelection({ [to]: nextItem })
      setPrimaryPath(to)
      anchorPathRef.current = to
      if (previewPath !== '' && pathWithin(previewPath, from)) setPreviewPath(remapPath(previewPath, from, to))
      await refreshDirectory(item.parentPath)
      showNotice('已重命名')
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutating(false)
      queueMicrotask(() => { renameCommitRef.current = false })
    }
  }

  const deleteSelection = async (items = selectedItems): Promise<void> => {
    if (alias === '' || items.length === 0) return
    const targets = collapseDeleteTargets(items)
    const label = targets.length === 1 ? targets[0]!.path : `${targets.length} 个项目`
    const affectsDirty = dirty && targets.some(item => pathWithin(previewPath, item.path))
    if (!window.confirm(`永久删除 ${label}？${affectsDirty ? '\n其中包含尚未保存的编辑内容。' : ''}`)) return

    setMutating(true)
    try {
      for (const item of targets) await deleteRemotePath(alias, item.path, item.entry.type === 'dir')
      let nextExpanded = expanded
      for (const item of targets) nextExpanded = dropSubtree(nextExpanded, item.path)
      setExpanded(nextExpanded)
      writeRememberedExpanded(sessionId, alias, nextExpanded)
      if (targets.some(item => previewPath !== '' && pathWithin(previewPath, item.path))) clearPreview()
      setSelection({})
      setPrimaryPath(null)
      anchorPathRef.current = null
      await loadRoot(alias)
      showNotice(targets.length === 1 ? '已删除' : `已删除 ${targets.length} 个项目`)
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
      showNotice(uploaded > 0 ? `已上传 ${uploaded} 个文件` : '没有上传文件')
    } catch (error) {
      setTopError(error instanceof Error ? error.message : String(error))
    } finally {
      setMutating(false)
    }
  }

  const closePreview = (): void => {
    if (!confirmDiscard()) return
    clearPreview()
  }

  const openContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, item: SelectedItem): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!selection[item.path]) {
      setSelection({ [item.path]: item })
      anchorPathRef.current = item.path
    }
    setPrimaryPath(item.path)
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 210),
      y: Math.min(event.clientY, window.innerHeight - 280),
      item,
      directory: item.entry.type === 'dir' ? item.path : item.parentPath,
    })
  }

  const openRootContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    event.preventDefault()
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 210),
      y: Math.min(event.clientY, window.innerHeight - 220),
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

  const handleTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      const next: SelectionMap = {}
      for (const item of visibleItems) next[item.path] = item
      setSelection(next)
      if (visibleItems.length) setPrimaryPath(visibleItems.at(-1)!.path)
      return
    }
    if (event.key === 'F2' && selectedItems.length === 1) {
      event.preventDefault()
      beginRename(selectedItems[0]!)
      return
    }
    if (event.key === 'Delete' && selectedItems.length > 0) {
      event.preventDefault()
      void deleteSelection()
    }
  }

  if (boundAlias === null) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 18, textAlign: 'center', opacity: .68, fontSize: 12 }}>
        SSH Files 只在远程 SSH 工作区中可用。请通过“添加工作区 → 远程 SSH”进入服务器目录。
      </div>
    )
  }

  const menuSelection = contextMenu?.item && selection[contextMenu.item.path]
    ? selectedItems
    : contextMenu?.item ? [contextMenu.item] : []
  const menuFileCount = menuSelection.filter(item => item.entry.type === 'file').length

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', color: 'inherit', position: 'relative' }}>
      <input ref={fileInputRef} type="file" multiple hidden onChange={event => { void uploadFiles(event.currentTarget.files) }} />

      <div style={{ display: 'flex', gap: 8, padding: 8, borderBottom: '1px solid rgba(128,128,128,.22)', alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 0, border: '1px solid rgba(128,128,128,.35)', borderRadius: 6, padding: '5px 8px', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedHost ? `${selectedHost.alias} (${selectedHost.user}@${selectedHost.host})` : boundAlias}
        </div>
        <button type="button" onClick={() => { void loadRoot() }} disabled={alias === '' || busy} title="刷新全部" style={smallButtonStyle}>↻</button>
      </div>

      {selectedHost && (
        <div style={{ padding: '6px 10px', fontSize: 11, opacity: 0.65, borderBottom: '1px solid rgba(128,128,128,.14)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedHost.user}@{selectedHost.host}:{selectedHost.port} · /
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,.14)', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => { void createDirectory() }} disabled={alias === '' || mutating} style={smallButtonStyle}>＋目录</button>
        <button type="button" onClick={() => chooseUpload(primary?.entry.type === 'dir' ? primary.path : primary?.parentPath ?? '/')} disabled={alias === '' || mutating} style={smallButtonStyle}>上传</button>
        <button type="button" onClick={() => beginRename()} disabled={selectedItems.length !== 1 || mutating} style={smallButtonStyle}>重命名</button>
        <button type="button" onClick={() => { void deleteSelection() }} disabled={selectedItems.length === 0 || mutating} style={smallButtonStyle}>删除{selectedItems.length > 1 ? `(${selectedItems.length})` : ''}</button>
        <button type="button" onClick={() => { void downloadSelection() }} disabled={!selectedItems.some(item => item.entry.type === 'file')} style={smallButtonStyle}>下载{selectedItems.filter(item => item.entry.type === 'file').length > 1 ? `(${selectedItems.filter(item => item.entry.type === 'file').length})` : ''}</button>
      </div>

      {topError && <div style={{ margin: 8, padding: 8, borderRadius: 6, background: 'rgba(220,53,69,.10)', color: '#d9534f', fontSize: 12 }}>{topError}</div>}
      {notice && <div style={{ margin: '6px 8px 0', fontSize: 12, color: '#2e8b57' }}>{notice}</div>}

      <div ref={splitContainerRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div
          tabIndex={0}
          onKeyDown={handleTreeKeyDown}
          onContextMenu={openRootContextMenu}
          style={{
            height: previewKind === 'none' ? '100%' : `${treePercent}%`,
            flex: previewKind === 'none' ? '1 1 auto' : '0 0 auto',
            minHeight: 100,
            overflow: 'auto',
            padding: '4px 0 12px',
            outline: 'none',
          }}
        >
          {alias === '' && !topError && <div style={{ padding: 12, opacity: 0.62, fontSize: 12 }}>正在读取当前远程工作区的 SSH 主机配置…</div>}
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
              selectedPaths={selectedPaths}
              renamingPath={renamingPath}
              renameDraft={renameDraft}
              onClick={handleNodeClick}
              onContextMenu={openContextMenu}
              onRenameDraft={setRenameDraft}
              onRenameCommit={item => { void commitRename(item) }}
              onRenameCancel={cancelRename}
            />
          ))}
        </div>

        {previewKind !== 'none' && (
          <div onPointerDown={startResize} title="拖拽调整文件树 / 编辑器高度" style={{ height: 7, flex: '0 0 7px', cursor: 'row-resize', touchAction: 'none', borderTop: '1px solid rgba(128,128,128,.20)', borderBottom: '1px solid rgba(128,128,128,.20)', background: 'rgba(128,128,128,.07)' }} />
        )}

        {previewKind !== 'none' && (
          <div style={{ flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column', background: 'rgba(128,128,128,.025)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,.18)' }}>
              <strong title={previewPath} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{basename(previewPath)}</strong>
              {dirty && <span style={{ fontSize: 10, color: '#d98c00' }}>未保存</span>}
              {previewKind === 'text' && !htmlRendered && <button type="button" onClick={() => editorRef.current?.openSearch()} style={smallButtonStyle}>搜索</button>}
              {previewKind === 'text' && isHtml(previewPath) && <button type="button" onClick={() => setHtmlRendered(value => !value)} style={smallButtonStyle}>{htmlRendered ? '源码' : '预览'}</button>}
              {previewKind === 'text' && <button type="button" onClick={() => { void savePreview() }} disabled={!dirty || saving} style={smallButtonStyle}>{saving ? '保存中…' : '保存'}</button>}
              <button type="button" onClick={closePreview} style={smallButtonStyle}>×</button>
            </div>

            <div style={{ padding: '4px 8px', fontSize: 10, opacity: 0.58, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={previewPath}>{previewPath}</div>

            {previewKind === 'loading' && <div style={{ padding: 12, opacity: 0.65, fontSize: 12 }}>正在读取文件…</div>}
            {previewKind === 'error' && <div style={{ padding: 12, color: '#d9534f', fontSize: 12 }}>{previewError}</div>}
            {previewKind === 'too-large' && <div style={{ padding: 12, fontSize: 12 }}>文件较大，已停止自动预览以避免浏览器卡顿。可以使用“下载”保存到本地。</div>}
            {previewKind === 'binary' && <div style={{ padding: 12, fontSize: 12 }}>这是当前不支持直接预览的二进制文件。可以使用“下载”。</div>}
            {previewKind === 'archive' && (
              <pre style={{ flex: 1, minHeight: 0, overflow: 'auto', margin: 0, padding: 10, borderTop: '1px solid rgba(128,128,128,.12)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{archiveText}</pre>
            )}
            {previewKind === 'text' && htmlRendered && <iframe title={`HTML preview ${previewPath}`} srcDoc={draftText} sandbox="" style={{ flex: 1, minHeight: 120, width: '100%', border: 0, background: 'white' }} />}
            {previewKind === 'text' && !htmlRendered && (
              <div style={{ flex: 1, minHeight: 0, borderTop: '1px solid rgba(128,128,128,.12)' }}>
                <CodeEditor ref={editorRef} path={previewPath} value={draftText} onChange={setDraftText} onSave={savePreview} />
              </div>
            )}
            {previewKind === 'image' && previewUrl !== '' && (
              <div style={{ flex: 1, minHeight: 120, overflow: 'auto', display: 'grid', placeItems: 'center', padding: 10 }}>
                <img src={previewUrl} alt={basename(previewPath)} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              </div>
            )}
            {previewKind === 'pdf' && previewUrl !== '' && <iframe title={`PDF preview ${previewPath}`} src={previewUrl} style={{ flex: 1, minHeight: 180, width: '100%', border: 0 }} />}
          </div>
        )}
      </div>

      <div style={{ padding: '5px 9px', fontSize: 10, opacity: 0.52, borderTop: '1px solid rgba(128,128,128,.14)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {selectedItems.length > 1
          ? `${selectedItems.length} 项已选择 · Ctrl 点击增减选择 · Shift 点击范围选择`
          : primary ? `${primary.path} · ${primary.entry.type === 'dir' ? '目录' : formatBytes(primary.entry.size)}` : 'Ctrl/Shift 可多选；F2 重命名；Delete 删除'}
      </div>

      {contextMenu !== null && (
        <>
          <div onMouseDown={() => setContextMenu(null)} onContextMenu={event => { event.preventDefault(); setContextMenu(null) }} style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />
          <div onMouseDown={event => event.stopPropagation()} style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 9999, width: 196, padding: 5, borderRadius: 8, border: '1px solid rgba(128,128,128,.30)', background: 'var(--color-background, Canvas)', color: 'inherit', boxShadow: '0 8px 28px rgba(0,0,0,.22)' }}>
            {contextMenu.item?.entry.type === 'file' && menuSelection.length === 1 && <button type="button" style={menuButtonStyle} onClick={() => runContextAction(() => openFile(contextMenu.item!))}>打开 / 预览 / 编辑</button>}
            {menuFileCount > 0 && <button type="button" style={menuButtonStyle} onClick={() => runContextAction(() => downloadSelection(menuSelection))}>下载{menuFileCount > 1 ? `选中文件 (${menuFileCount})` : ''}</button>}
            <button type="button" style={menuButtonStyle} onClick={() => runContextAction(() => refreshDirectory(contextMenu.directory))}>刷新目录</button>
            {(contextMenu.item === null || contextMenu.item.entry.type === 'dir') && <button type="button" style={menuButtonStyle} onClick={() => runContextAction(() => chooseUpload(contextMenu.directory))}>上传文件到这里</button>}
            {(contextMenu.item === null || contextMenu.item.entry.type === 'dir') && <button type="button" style={menuButtonStyle} onClick={() => runContextAction(() => createDirectory(contextMenu.directory))}>新建目录</button>}
            {menuSelection.length === 1 && contextMenu.item !== null && <button type="button" style={menuButtonStyle} onClick={() => runContextAction(() => beginRename(contextMenu.item))}>重命名（原地编辑）</button>}
            {menuSelection.length > 0 && <button type="button" style={{ ...menuButtonStyle, color: '#d9534f' }} onClick={() => runContextAction(() => deleteSelection(menuSelection))}>删除{menuSelection.length > 1 ? `选中项目 (${menuSelection.length})` : ''}</button>}
          </div>
        </>
      )}
    </div>
  )
}
