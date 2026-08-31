import { listRemoteDir, readRemoteFile, writeRemoteFile } from './api.ts'

const LOCAL_FILE_MIME = 'application/x-dsh-local-workspace-file'
const SSH_FILE_MIME = 'application/x-dsh-ssh-file'
const SSH_ROOT_SELECTOR = '[data-dsh-ssh-files-root="true"]'
const PANEL_HOST_SELECTOR = '[data-dsh-panel-host]'

interface LocalFilePayload {
  v: 1
  sessionId: string
  cwd: string
  path: string
  name: string
}

interface SshFilePayload {
  v: 1
  sessionId: string
  alias: string
  path: string
  name: string
}

export interface CrossFilesDragDropOptions {
  sessionId: string
  localCwd: string
  alias: string
}

function asElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target
  if (target instanceof Node) return target.parentElement
  return null
}

function localBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at < 0 ? trimmed : trimmed.slice(at + 1)
}

function normalizeLocalPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

function localPathWithin(path: string, cwd: string): boolean {
  const p = normalizeLocalPath(path)
  const root = normalizeLocalPath(cwd)
  return p === root || p.startsWith(`${root}/`)
}

function localPathFromTitle(title: string): string {
  // better-sidebar appends a human-readable broken-symlink hint to the title.
  const marker = ' — '
  const at = title.indexOf(marker)
  return (at < 0 ? title : title.slice(0, at)).trim()
}

function remotePathFromTitle(title: string): string {
  return title.split('\n', 1)[0]?.trim() ?? ''
}

function remoteParent(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  return at <= 0 ? '/' : trimmed.slice(0, at)
}

function remoteBaseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  return at < 0 ? trimmed : trimmed.slice(at + 1)
}

function hasType(dataTransfer: DataTransfer | null, type: string): boolean {
  return dataTransfer !== null && Array.from(dataTransfer.types).includes(type)
}

function parseLocalPayload(dataTransfer: DataTransfer | null): LocalFilePayload | null {
  if (dataTransfer === null) return null
  try {
    const value = JSON.parse(dataTransfer.getData(LOCAL_FILE_MIME)) as Partial<LocalFilePayload>
    if (
      value.v !== 1 ||
      typeof value.sessionId !== 'string' ||
      typeof value.cwd !== 'string' ||
      typeof value.path !== 'string' ||
      typeof value.name !== 'string'
    ) return null
    return value as LocalFilePayload
  } catch {
    return null
  }
}

function parseSshPayload(dataTransfer: DataTransfer | null): SshFilePayload | null {
  if (dataTransfer === null) return null
  try {
    const value = JSON.parse(dataTransfer.getData(SSH_FILE_MIME)) as Partial<SshFilePayload>
    if (
      value.v !== 1 ||
      typeof value.sessionId !== 'string' ||
      typeof value.alias !== 'string' ||
      typeof value.path !== 'string' ||
      typeof value.name !== 'string'
    ) return null
    return value as SshFilePayload
  } catch {
    return null
  }
}

function localFileRow(target: EventTarget | null, cwd: string): { row: HTMLElement; path: string } | null {
  const element = asElement(target)
  if (element === null || element.closest(SSH_ROOT_SELECTOR) !== null) return null
  const row = element.closest<HTMLElement>('div[role="button"][title]')
  if (row === null || row.closest(PANEL_HOST_SELECTOR) === null) return null
  const title = row.getAttribute('title') ?? ''
  const path = localPathFromTitle(title)
  if (path === '' || !localPathWithin(path, cwd)) return null
  return { row, path }
}

function remoteFileButton(target: EventTarget | null): { button: HTMLButtonElement; root: HTMLElement; path: string } | null {
  const element = asElement(target)
  const root = element?.closest<HTMLElement>(SSH_ROOT_SELECTOR) ?? null
  if (root === null) return null
  const button = element?.closest<HTMLButtonElement>('button[title]') ?? null
  if (button === null || !root.contains(button)) return null
  const icon = button.querySelector<HTMLElement>('span[aria-hidden="true"]')?.textContent?.trim() ?? ''
  if (icon !== '📄') return null
  const path = remotePathFromTitle(button.getAttribute('title') ?? '')
  if (!path.startsWith('/')) return null
  return { button, root, path }
}

function remoteRootForTarget(target: EventTarget | null, sessionId: string, alias: string): HTMLElement | null {
  const root = asElement(target)?.closest<HTMLElement>(SSH_ROOT_SELECTOR) ?? null
  if (root === null) return null
  if (root.dataset.sessionId !== sessionId || root.dataset.sshAlias !== alias) return null
  return root
}

function remoteDirectoryForDrop(target: EventTarget | null, root: HTMLElement): string {
  const element = asElement(target)
  const button = element?.closest<HTMLButtonElement>('button[title]') ?? null
  if (button === null || !root.contains(button)) return '/'
  const icon = button.querySelector<HTMLElement>('span[aria-hidden="true"]')?.textContent?.trim() ?? ''
  const path = remotePathFromTitle(button.getAttribute('title') ?? '')
  if (!path.startsWith('/')) return '/'
  if (icon === '📁' || icon === '📂') return path
  if (icon === '📄') return remoteParent(path)
  return '/'
}

function isLocalFilesPanel(panel: HTMLElement, cwd: string): boolean {
  if (panel.querySelector(SSH_ROOT_SELECTOR) !== null) return false

  for (const row of Array.from(panel.querySelectorAll<HTMLElement>('div[role="button"][title]'))) {
    const path = localPathFromTitle(row.getAttribute('title') ?? '')
    if (path !== '' && localPathWithin(path, cwd)) return true
  }

  // Empty workspaces have no titled file rows. The built-in root row still
  // exposes the cwd basename as its own span, which is enough to distinguish
  // the Files tree from other better-sidebar tabs during our private drag.
  const rootName = localBaseName(cwd)
  if (rootName === '') return false
  for (const row of Array.from(panel.querySelectorAll<HTMLElement>('div[role="button"]'))) {
    for (const span of Array.from(row.querySelectorAll<HTMLElement>('span'))) {
      if ((span.textContent ?? '').trim() === rootName) return true
    }
  }
  return false
}

function localFilesPanelForTarget(target: EventTarget | null, cwd: string): HTMLElement | null {
  const panel = asElement(target)?.closest<HTMLElement>(PANEL_HOST_SELECTOR) ?? null
  return panel !== null && isLocalFilesPanel(panel, cwd) ? panel : null
}

async function readLocalWorkspaceFile(payload: LocalFilePayload): Promise<Blob> {
  const params = new URLSearchParams({
    sessionId: payload.sessionId,
    cwd: payload.cwd,
    path: payload.path,
    download: '1',
  })
  const response = await fetch(`/sidebar/file?${params.toString()}`)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `读取本地文件失败：HTTP ${response.status}`)
  }
  return await response.blob()
}

function setDropHighlight(element: HTMLElement | null, active: boolean): void {
  if (element === null) return
  if (active) {
    element.dataset.dshCrossFilesDrop = 'true'
    element.style.outline = '2px solid rgba(76, 120, 255, .65)'
    element.style.outlineOffset = '-2px'
  } else if (element.dataset.dshCrossFilesDrop === 'true') {
    delete element.dataset.dshCrossFilesDrop
    element.style.outline = ''
    element.style.outlineOffset = ''
  }
}

function showRemoteToast(root: HTMLElement, message: string, error = false): void {
  let toast = root.querySelector<HTMLElement>('[data-dsh-cross-files-toast="true"]')
  if (toast === null) {
    toast = document.createElement('div')
    toast.dataset.dshCrossFilesToast = 'true'
    Object.assign(toast.style, {
      position: 'absolute',
      right: '10px',
      bottom: '10px',
      zIndex: '10020',
      maxWidth: '78%',
      padding: '7px 10px',
      borderRadius: '7px',
      fontSize: '12px',
      lineHeight: '1.35',
      boxShadow: '0 4px 18px rgba(0,0,0,.18)',
      pointerEvents: 'none',
    })
    root.appendChild(toast)
  }
  toast.textContent = message
  toast.style.background = error ? 'rgba(180,45,55,.94)' : 'rgba(35,45,62,.94)'
  toast.style.color = 'white'
  window.setTimeout(() => {
    if (toast?.isConnected && toast.textContent === message) toast.remove()
  }, error ? 4200 : 2400)
}

function dispatchFilesDrop(target: Element, files: File[]): boolean {
  if (typeof DataTransfer !== 'function' || typeof DragEvent !== 'function') {
    throw new Error('当前浏览器不支持 DataTransfer，无法把 SSH 文件拖入本地 Files。')
  }
  const transfer = new DataTransfer()
  for (const file of files) transfer.items.add(file)

  for (const type of ['dragenter', 'dragover'] as const) {
    target.dispatchEvent(new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }))
  }
  const drop = new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    dataTransfer: transfer,
  })
  target.dispatchEvent(drop)
  return drop.defaultPrevented
}

/**
 * Bridge better-sidebar's local Files tree and this plugin's SSH Files tree.
 *
 * We deliberately reuse better-sidebar's OWN upload drop pipeline for the
 * SSH -> local direction: after fetching the remote bytes, a synthetic Files
 * drop is dispatched at the exact DOM target the user released over. That
 * preserves its built-in "folder row = that folder / file row = parent / blank
 * body = workspace root" semantics without reaching into private React state.
 *
 * The reverse direction keeps the local file as a path-only drag token until
 * drop, then streams the bytes through better-sidebar's existing raw file route
 * and dsh-ssh's existing SFTP upload route. Browser drag payloads therefore
 * never contain credentials and large files are not prefetched just because a
 * row was hovered.
 */
export function installCrossFilesDragAndDrop(options: CrossFilesDragDropOptions): () => void {
  const { sessionId, localCwd, alias } = options
  let highlightedRemote: HTMLElement | null = null
  let highlightedLocal: HTMLElement | null = null

  const clearHighlights = (): void => {
    setDropHighlight(highlightedRemote, false)
    setDropHighlight(highlightedLocal, false)
    highlightedRemote = null
    highlightedLocal = null
  }

  const onPointerDown = (event: PointerEvent): void => {
    const local = localFileRow(event.target, localCwd)
    if (local !== null) {
      local.row.draggable = true
      local.row.dataset.dshLocalFilePath = local.path
      return
    }
    const remote = remoteFileButton(event.target)
    if (remote !== null && remote.root.dataset.sessionId === sessionId && remote.root.dataset.sshAlias === alias) {
      remote.button.draggable = true
      remote.button.dataset.dshSshFilePath = remote.path
    }
  }

  const onDragStart = (event: DragEvent): void => {
    if (event.dataTransfer === null) return

    const local = localFileRow(event.target, localCwd)
    if (local !== null) {
      const payload: LocalFilePayload = {
        v: 1,
        sessionId,
        cwd: localCwd,
        path: local.path,
        name: localBaseName(local.path),
      }
      event.dataTransfer.setData(LOCAL_FILE_MIME, JSON.stringify(payload))
      event.dataTransfer.effectAllowed = 'copy'
      return
    }

    const remote = remoteFileButton(event.target)
    if (remote === null || remote.root.dataset.sessionId !== sessionId || remote.root.dataset.sshAlias !== alias) return
    const payload: SshFilePayload = {
      v: 1,
      sessionId,
      alias,
      path: remote.path,
      name: remoteBaseName(remote.path),
    }
    event.dataTransfer.setData(SSH_FILE_MIME, JSON.stringify(payload))
    event.dataTransfer.effectAllowed = 'copy'
  }

  const onDragOver = (event: DragEvent): void => {
    if (hasType(event.dataTransfer, LOCAL_FILE_MIME)) {
      const root = remoteRootForTarget(event.target, sessionId, alias)
      if (root === null) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
      if (highlightedRemote !== root) {
        setDropHighlight(highlightedRemote, false)
        highlightedRemote = root
        setDropHighlight(root, true)
      }
      return
    }

    if (hasType(event.dataTransfer, SSH_FILE_MIME)) {
      const panel = localFilesPanelForTarget(event.target, localCwd)
      if (panel === null) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
      if (highlightedLocal !== panel) {
        setDropHighlight(highlightedLocal, false)
        highlightedLocal = panel
        setDropHighlight(panel, true)
      }
    }
  }

  const onDrop = (event: DragEvent): void => {
    if (hasType(event.dataTransfer, LOCAL_FILE_MIME)) {
      const root = remoteRootForTarget(event.target, sessionId, alias)
      if (root === null) return
      const payload = parseLocalPayload(event.dataTransfer)
      if (
        payload === null ||
        payload.sessionId !== sessionId ||
        normalizeLocalPath(payload.cwd) !== normalizeLocalPath(localCwd) ||
        !localPathWithin(payload.path, localCwd)
      ) return

      event.preventDefault()
      event.stopPropagation()
      const directory = remoteDirectoryForDrop(event.target, root)
      clearHighlights()

      void (async () => {
        try {
          showRemoteToast(root, `正在传输 ${payload.name} → ${alias}:${directory}`)
          const existing = await listRemoteDir(alias, directory)
          if (existing.some(entry => entry.name === payload.name)) {
            const overwrite = window.confirm(`${directory === '/' ? '' : directory}/${payload.name} 已存在，是否覆盖？`)
            if (!overwrite) {
              showRemoteToast(root, '已取消传输')
              return
            }
          }
          const blob = await readLocalWorkspaceFile(payload)
          await writeRemoteFile(alias, directory === '/' ? `/${payload.name}` : `${directory}/${payload.name}`, blob)
          showRemoteToast(root, `已传输到 ${alias}:${directory}`)
          root.querySelector<HTMLButtonElement>('button[title="刷新全部"]')?.click()
        } catch (error) {
          showRemoteToast(root, error instanceof Error ? error.message : String(error), true)
        }
      })()
      return
    }

    if (hasType(event.dataTransfer, SSH_FILE_MIME)) {
      const panel = localFilesPanelForTarget(event.target, localCwd)
      const target = asElement(event.target)
      if (panel === null || target === null) return
      const payload = parseSshPayload(event.dataTransfer)
      if (payload === null || payload.sessionId !== sessionId || payload.alias !== alias || !payload.path.startsWith('/')) return

      event.preventDefault()
      event.stopPropagation()
      clearHighlights()

      void (async () => {
        try {
          const blob = await readRemoteFile(alias, payload.path)
          const file = new File([blob], payload.name, {
            type: blob.type || 'application/octet-stream',
            lastModified: Date.now(),
          })
          const accepted = dispatchFilesDrop(target, [file])
          if (!accepted) {
            throw new Error('请把文件拖到 Files 的文件树区域、目录行或文件行上。')
          }
        } catch (error) {
          window.alert(error instanceof Error ? error.message : String(error))
        }
      })()
    }
  }

  const onDragEnd = (): void => { clearHighlights() }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('dragstart', onDragStart, true)
  document.addEventListener('dragover', onDragOver, true)
  document.addEventListener('drop', onDrop, true)
  document.addEventListener('dragend', onDragEnd, true)

  return () => {
    clearHighlights()
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('dragstart', onDragStart, true)
    document.removeEventListener('dragover', onDragOver, true)
    document.removeEventListener('drop', onDrop, true)
    document.removeEventListener('dragend', onDragEnd, true)
  }
}
