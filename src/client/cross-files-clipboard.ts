import { listRemoteDir, readRemoteFile, writeRemoteFile } from './api.ts'

const SSH_ROOT_SELECTOR = '[data-dsh-ssh-files-root="true"]'
const PANEL_HOST_SELECTOR = '[data-dsh-panel-host]'
const ADDON_MENU_ATTR = 'data-dsh-cross-files-clipboard-menu'

interface CrossFilesClipboardOptions {
  sessionId: string
  localCwd: string
  alias: string
}

interface LocalClipboardFile {
  kind: 'local-file'
  sessionId: string
  cwd: string
  path: string
  name: string
}

interface RemoteClipboardFile {
  kind: 'remote-file'
  sessionId: string
  alias: string
  path: string
  name: string
}

type CrossFilesClipboard = LocalClipboardFile | RemoteClipboardFile

let clipboard: CrossFilesClipboard | null = null

function asElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target
  if (target instanceof Node) return target.parentElement
  return null
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = asElement(target)
  if (element === null) return false
  return element.closest('input, textarea, [contenteditable="true"], .cm-editor, .xterm') !== null
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

function localFileRow(target: EventTarget | null, cwd: string): { row: HTMLElement; path: string } | null {
  const element = asElement(target)
  if (element === null || element.closest(SSH_ROOT_SELECTOR) !== null) return null
  const row = element.closest<HTMLElement>('div[role="button"][title]')
  if (row === null || row.closest(PANEL_HOST_SELECTOR) === null) return null
  const path = localPathFromTitle(row.getAttribute('title') ?? '')
  if (path === '' || !localPathWithin(path, cwd)) return null
  return { row, path }
}

function isLocalFilesPanel(panel: HTMLElement, cwd: string): boolean {
  if (panel.querySelector(SSH_ROOT_SELECTOR) !== null) return false

  for (const row of Array.from(panel.querySelectorAll<HTMLElement>('div[role="button"][title]'))) {
    const path = localPathFromTitle(row.getAttribute('title') ?? '')
    if (path !== '' && localPathWithin(path, cwd)) return true
  }

  const rootName = localBaseName(cwd)
  if (rootName === '') return false
  for (const row of Array.from(panel.querySelectorAll<HTMLElement>('div[role="button"]'))) {
    for (const span of Array.from(row.querySelectorAll<HTMLElement>('span'))) {
      if ((span.textContent ?? '').trim() === rootName) return true
    }
  }
  return false
}

function localFilesTarget(target: EventTarget | null, cwd: string): { panel: HTMLElement; target: Element } | null {
  const element = asElement(target)
  if (element === null || element.closest(SSH_ROOT_SELECTOR) !== null) return null
  const panel = element.closest<HTMLElement>(PANEL_HOST_SELECTOR)
  if (panel === null || !isLocalFilesPanel(panel, cwd)) return null
  return { panel, target: element }
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

function remoteDirectoryForTarget(target: EventTarget | null, root: HTMLElement): string {
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

async function readLocalWorkspaceFile(source: LocalClipboardFile): Promise<Blob> {
  const params = new URLSearchParams({
    sessionId: source.sessionId,
    cwd: source.cwd,
    path: source.path,
    download: '1',
  })
  const response = await fetch(`/sidebar/file?${params.toString()}`)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `读取本地文件失败：HTTP ${response.status}`)
  }
  return await response.blob()
}

function dispatchFilesDrop(target: Element, files: File[]): boolean {
  if (typeof DataTransfer !== 'function' || typeof DragEvent !== 'function') {
    throw new Error('当前浏览器不支持 DataTransfer，无法把 SSH 文件粘贴到本地 Files。')
  }
  const transfer = new DataTransfer()
  for (const file of files) transfer.items.add(file)
  for (const type of ['dragenter', 'dragover'] as const) {
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }
  const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
  target.dispatchEvent(drop)
  return drop.defaultPrevented
}

function showToast(message: string, error = false): void {
  const previous = document.querySelector<HTMLElement>('[data-dsh-cross-files-clipboard-toast="true"]')
  previous?.remove()
  const toast = document.createElement('div')
  toast.dataset.dshCrossFilesClipboardToast = 'true'
  toast.textContent = message
  Object.assign(toast.style, {
    position: 'fixed',
    right: '18px',
    bottom: '18px',
    zIndex: '10050',
    maxWidth: '420px',
    padding: '8px 11px',
    borderRadius: '7px',
    background: error ? 'rgba(180,45,55,.96)' : 'rgba(35,45,62,.96)',
    color: 'white',
    boxShadow: '0 5px 20px rgba(0,0,0,.24)',
    fontSize: '12px',
    lineHeight: '1.4',
    pointerEvents: 'none',
  })
  document.body.appendChild(toast)
  window.setTimeout(() => { if (toast.isConnected) toast.remove() }, error ? 4600 : 2800)
}

function removeAddonMenu(): void {
  document.querySelector<HTMLElement>(`[${ADDON_MENU_ATTR}="true"]`)?.remove()
}

function findNativeMenuRect(x: number, y: number): DOMRect | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"], div'))
  let best: { rect: DOMRect; area: number } | null = null
  for (const element of candidates) {
    const text = element.textContent ?? ''
    const looksLikeFilesMenu =
      text.includes('复制相对路径') || text.includes('复制绝对路径') ||
      text.includes('Copy relative') || text.includes('Copy absolute') ||
      text.includes('刷新目录') || text.includes('Refresh directory')
    if (!looksLikeFilesMenu) continue
    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const rect = element.getBoundingClientRect()
    if (rect.width < 80 || rect.height < 30) continue
    const closeToPoint = x >= rect.left - 20 && x <= rect.right + 20 && y >= rect.top - 20 && y <= rect.bottom + 20
    if (!closeToPoint) continue
    const area = rect.width * rect.height
    if (best === null || area < best.area) best = { rect, area }
  }
  return best?.rect ?? null
}

function actionLabel(kind: 'copy' | 'paste'): string {
  const lang = (document.documentElement.lang || navigator.language || '').toLowerCase()
  if (lang.startsWith('zh')) return kind === 'copy' ? '复制文件' : '粘贴文件'
  return kind === 'copy' ? 'Copy file' : 'Paste file'
}

function showAddonMenu(
  point: { x: number; y: number },
  actions: Array<{ kind: 'copy' | 'paste'; run: () => void | Promise<unknown> }>,
): void {
  removeAddonMenu()
  if (actions.length === 0) return

  const menu = document.createElement('div')
  menu.setAttribute(ADDON_MENU_ATTR, 'true')
  Object.assign(menu.style, {
    position: 'fixed',
    zIndex: '10002',
    width: '154px',
    padding: '5px',
    borderRadius: '8px',
    border: '1px solid rgba(128,128,128,.30)',
    background: 'var(--color-background, Canvas)',
    color: 'inherit',
    boxShadow: '0 8px 28px rgba(0,0,0,.22)',
  })

  for (const action of actions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = actionLabel(action.kind)
    Object.assign(button.style, {
      width: '100%',
      border: '0',
      borderRadius: '4px',
      background: 'transparent',
      color: 'inherit',
      padding: '7px 10px',
      textAlign: 'left',
      cursor: 'pointer',
      fontSize: '12px',
    })
    button.addEventListener('mouseenter', () => { button.style.background = 'rgba(128,128,128,.12)' })
    button.addEventListener('mouseleave', () => { button.style.background = 'transparent' })
    button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation() })
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      removeAddonMenu()
      void action.run()
    })
    menu.appendChild(button)
  }

  document.body.appendChild(menu)
  window.requestAnimationFrame(() => {
    const menuRect = menu.getBoundingClientRect()
    const native = findNativeMenuRect(point.x, point.y)
    const gap = 6
    let left: number
    let top: number
    if (native !== null) {
      left = native.right + gap
      if (left + menuRect.width > window.innerWidth - gap) left = native.left - menuRect.width - gap
      top = native.top
    } else {
      left = point.x + 12
      if (left + menuRect.width > window.innerWidth - gap) left = point.x - menuRect.width - 12
      top = point.y
    }
    left = Math.max(gap, Math.min(left, window.innerWidth - menuRect.width - gap))
    top = Math.max(gap, Math.min(top, window.innerHeight - menuRect.height - gap))
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  })
}

/**
 * Cross-pane file clipboard for the visible local Files and SSH Files panes.
 *
 * This deliberately does NOT try to mutate better-sidebar's React context-menu
 * DOM. That menu is portaled outside the panel and its internal structure is not
 * a stable extension API. Instead we keep a tiny adjacent transfer menu whose
 * actions use the same proven transfer paths as drag/drop. This makes copy/paste
 * work for file rows, directory rows, file-parent targets and blank/root areas.
 */
export function installCrossFilesClipboard(options: CrossFilesClipboardOptions): () => void {
  const { sessionId, localCwd, alias } = options
  let lastLocalTarget: Element | null = null
  let lastRemoteTarget: Element | null = null

  const copyLocal = (target: EventTarget | null): boolean => {
    const file = localFileRow(target, localCwd)
    if (file === null) return false
    clipboard = {
      kind: 'local-file',
      sessionId,
      cwd: localCwd,
      path: file.path,
      name: localBaseName(file.path),
    }
    showToast(`已复制 ${clipboard.name}，可到 SSH Files 目标目录右键粘贴或按 Ctrl+V`)
    return true
  }

  const copyRemote = (target: EventTarget | null): boolean => {
    const file = remoteFileButton(target)
    if (file === null || file.root.dataset.sessionId !== sessionId || file.root.dataset.sshAlias !== alias) return false
    clipboard = {
      kind: 'remote-file',
      sessionId,
      alias,
      path: file.path,
      name: remoteBaseName(file.path),
    }
    showToast(`已复制 ${clipboard.name}，可到 Files 目标目录右键粘贴或按 Ctrl+V`)
    return true
  }

  const pasteToRemote = async (target: EventTarget | null): Promise<boolean> => {
    if (clipboard === null) return false
    if (clipboard.sessionId !== sessionId) {
      showToast('剪贴板来自另一个会话，请在当前会话重新复制文件。', true)
      return true
    }
    const root = remoteRootForTarget(target, sessionId, alias)
    if (root === null) return false
    const directory = remoteDirectoryForTarget(target, root)
    try {
      const sourceName = clipboard.name
      const destination = directory === '/' ? `/${sourceName}` : `${directory}/${sourceName}`
      if (clipboard.kind === 'remote-file' && clipboard.alias === alias && clipboard.path === destination) {
        showToast('源文件和目标文件相同，不需要粘贴。')
        return true
      }
      showToast(`正在粘贴 ${sourceName} → ${alias}:${directory}`)
      const existing = await listRemoteDir(alias, directory)
      if (existing.some((entry: { name: string }) => entry.name === sourceName)) {
        if (!window.confirm(`${destination} 已存在，是否覆盖？`)) {
          showToast('已取消粘贴')
          return true
        }
      }
      const blob = clipboard.kind === 'local-file'
        ? await readLocalWorkspaceFile(clipboard)
        : await readRemoteFile(clipboard.alias, clipboard.path)
      await writeRemoteFile(alias, destination, blob)
      root.querySelector<HTMLButtonElement>('button[title="刷新全部"]')?.click()
      showToast(`已粘贴到 ${alias}:${directory}`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true)
    }
    return true
  }

  const pasteToLocal = async (target: EventTarget | null): Promise<boolean> => {
    if (clipboard === null) return false
    if (clipboard.sessionId !== sessionId) {
      showToast('剪贴板来自另一个会话，请在当前会话重新复制文件。', true)
      return true
    }
    const local = localFilesTarget(target, localCwd)
    if (local === null) return false
    try {
      showToast(`正在粘贴 ${clipboard.name} → Files`)
      const blob = clipboard.kind === 'remote-file'
        ? await readRemoteFile(clipboard.alias, clipboard.path)
        : await readLocalWorkspaceFile(clipboard)
      const file = new File([blob], clipboard.name, {
        type: blob.type || 'application/octet-stream',
        lastModified: Date.now(),
      })
      const accepted = dispatchFilesDrop(local.target, [file])
      if (!accepted) throw new Error('请在 Files 的工作区根、目录行、文件行或文件树空白区域上粘贴。')
      showToast(`已粘贴 ${clipboard.name} 到 Files`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true)
    }
    return true
  }

  const rememberTarget = (target: EventTarget | null): void => {
    const local = localFilesTarget(target, localCwd)
    if (local !== null) {
      lastLocalTarget = local.target
      return
    }
    const remoteRoot = remoteRootForTarget(target, sessionId, alias)
    if (remoteRoot !== null) lastRemoteTarget = asElement(target)
  }

  const onContextMenu = (event: MouseEvent): void => {
    removeAddonMenu()
    rememberTarget(event.target)

    const local = localFilesTarget(event.target, localCwd)
    if (local !== null) {
      const copyable = localFileRow(event.target, localCwd) !== null
      const actions: Array<{ kind: 'copy' | 'paste'; run: () => void | Promise<unknown> }> = []
      if (copyable) actions.push({ kind: 'copy', run: () => { copyLocal(event.target) } })
      if (clipboard !== null) actions.push({ kind: 'paste', run: () => pasteToLocal(event.target) })
      if (actions.length > 0) {
        const point = { x: event.clientX, y: event.clientY }
        window.setTimeout(() => { showAddonMenu(point, actions) }, 0)
      }
      return
    }

    const root = remoteRootForTarget(event.target, sessionId, alias)
    if (root !== null) {
      const copyable = remoteFileButton(event.target) !== null
      const actions: Array<{ kind: 'copy' | 'paste'; run: () => void | Promise<unknown> }> = []
      if (copyable) actions.push({ kind: 'copy', run: () => { copyRemote(event.target) } })
      if (clipboard !== null) actions.push({ kind: 'paste', run: () => pasteToRemote(event.target) })
      if (actions.length > 0) {
        const point = { x: event.clientX, y: event.clientY }
        window.setTimeout(() => { showAddonMenu(point, actions) }, 0)
      }
    }
  }

  const onPointerDown = (event: PointerEvent): void => {
    const addon = asElement(event.target)?.closest(`[${ADDON_MENU_ATTR}="true"]`)
    if (addon === null) removeAddonMenu()
    rememberTarget(event.target)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isEditableTarget(event.target)) return
    const mod = event.ctrlKey || event.metaKey
    if (!mod) return
    const key = event.key.toLowerCase()

    if (key === 'c') {
      if (copyLocal(event.target) || copyRemote(event.target) || copyLocal(lastLocalTarget) || copyRemote(lastRemoteTarget)) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }

    if (key !== 'v' || clipboard === null) return
    const localNow = localFilesTarget(event.target, localCwd)
    if (localNow !== null) {
      event.preventDefault()
      event.stopPropagation()
      lastLocalTarget = localNow.target
      void pasteToLocal(localNow.target)
      return
    }
    const remoteNow = remoteRootForTarget(event.target, sessionId, alias)
    if (remoteNow !== null) {
      event.preventDefault()
      event.stopPropagation()
      lastRemoteTarget = asElement(event.target)
      void pasteToRemote(event.target)
      return
    }
    if (lastLocalTarget !== null) {
      event.preventDefault()
      event.stopPropagation()
      void pasteToLocal(lastLocalTarget)
      return
    }
    if (lastRemoteTarget !== null) {
      event.preventDefault()
      event.stopPropagation()
      void pasteToRemote(lastRemoteTarget)
    }
  }

  document.addEventListener('contextmenu', onContextMenu, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('keydown', onKeyDown, true)

  return () => {
    removeAddonMenu()
    document.removeEventListener('contextmenu', onContextMenu, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('keydown', onKeyDown, true)
  }
}
