import { listRemoteDir, readRemoteFile, writeRemoteFile } from './api.ts'

const SSH_ROOT_SELECTOR = '[data-dsh-ssh-files-root="true"]'
const PANEL_HOST_SELECTOR = '[data-dsh-panel-host]'
const ACTION_ATTR = 'data-dsh-cross-files-action'
const TOAST_ATTR = 'data-dsh-cross-files-clipboard-toast'

interface LocalFilePayload {
  kind: 'local'
  sessionId: string
  cwd: string
  path: string
  name: string
}

interface SshFilePayload {
  kind: 'ssh'
  sessionId: string
  alias: string
  path: string
  name: string
}

type CrossFilesClipboardPayload = LocalFilePayload | SshFilePayload

export interface CrossFilesClipboardOptions {
  sessionId: string
  localCwd: string
  alias: string
}

interface PendingContext {
  side: 'local' | 'ssh'
  target: Element
  anchor: HTMLElement
  copyPayload: CrossFilesClipboardPayload | null
  remoteDirectory?: string
  x: number
  y: number
}

interface Installation {
  refs: number
  dispose: () => void
}

let clipboard: CrossFilesClipboardPayload | null = null
const installations = new Map<string, Installation>()

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

function remoteRootForTarget(target: EventTarget | null, options: CrossFilesClipboardOptions): HTMLElement | null {
  const root = asElement(target)?.closest<HTMLElement>(SSH_ROOT_SELECTOR) ?? null
  if (root === null) return null
  if (root.dataset.sessionId !== options.sessionId || root.dataset.sshAlias !== options.alias) return null
  return root
}

function remoteFileButton(target: EventTarget | null, options: CrossFilesClipboardOptions): { button: HTMLButtonElement; root: HTMLElement; path: string } | null {
  const root = remoteRootForTarget(target, options)
  if (root === null) return null
  const element = asElement(target)
  const button = element?.closest<HTMLButtonElement>('button[title]') ?? null
  if (button === null || !root.contains(button)) return null
  const icon = button.querySelector<HTMLElement>('span[aria-hidden="true"]')?.textContent?.trim() ?? ''
  if (icon !== '📄') return null
  const path = remotePathFromTitle(button.getAttribute('title') ?? '')
  if (!path.startsWith('/')) return null
  return { button, root, path }
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
    throw new Error(text || `读取工作区文件失败：HTTP ${response.status}`)
  }
  return await response.blob()
}

function dispatchFilesDrop(target: Element, files: File[]): boolean {
  if (typeof DataTransfer !== 'function' || typeof DragEvent !== 'function') {
    throw new Error('当前浏览器不支持 DataTransfer，无法把 SSH 文件粘贴到 Files。')
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

function showToast(anchor: HTMLElement, message: string, error = false): void {
  let toast = document.querySelector<HTMLElement>(`[${TOAST_ATTR}="true"]`)
  if (toast === null) {
    toast = document.createElement('div')
    toast.setAttribute(TOAST_ATTR, 'true')
    Object.assign(toast.style, {
      position: 'fixed',
      zIndex: '10030',
      maxWidth: '320px',
      padding: '7px 10px',
      borderRadius: '7px',
      fontSize: '12px',
      lineHeight: '1.35',
      boxShadow: '0 4px 18px rgba(0,0,0,.18)',
      pointerEvents: 'none',
    })
    document.body.appendChild(toast)
  }

  const rect = anchor.getBoundingClientRect()
  const width = Math.min(320, Math.max(180, rect.width - 20))
  const left = Math.max(8, Math.min(rect.right - width - 10, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(rect.bottom - 46, window.innerHeight - 54))
  toast.style.width = `${width}px`
  toast.style.left = `${left}px`
  toast.style.top = `${top}px`
  toast.style.background = error ? 'rgba(180,45,55,.94)' : 'rgba(35,45,62,.94)'
  toast.style.color = 'white'
  toast.textContent = message

  window.setTimeout(() => {
    if (toast?.isConnected && toast.textContent === message) toast.remove()
  }, error ? 4200 : 2400)
}

function setClipboard(payload: CrossFilesClipboardPayload, anchor: HTMLElement): void {
  clipboard = payload
  showToast(
    anchor,
    payload.kind === 'local'
      ? `已复制 ${payload.name}，可到 SSH Files 右键粘贴`
      : `已复制 ${payload.name}，可到 Files 右键粘贴`,
  )
}

function localClipboardFor(options: CrossFilesClipboardOptions): LocalFilePayload | null {
  if (clipboard?.kind !== 'local') return null
  if (clipboard.sessionId !== options.sessionId) return null
  if (normalizeLocalPath(clipboard.cwd) !== normalizeLocalPath(options.localCwd)) return null
  if (!localPathWithin(clipboard.path, options.localCwd)) return null
  return clipboard
}

function sshClipboardFor(options: CrossFilesClipboardOptions): SshFilePayload | null {
  if (clipboard?.kind !== 'ssh') return null
  if (clipboard.sessionId !== options.sessionId || clipboard.alias !== options.alias) return null
  if (!clipboard.path.startsWith('/')) return null
  return clipboard
}

async function pasteLocalToRemote(
  options: CrossFilesClipboardOptions,
  directory: string,
  anchor: HTMLElement,
): Promise<void> {
  const payload = localClipboardFor(options)
  if (payload === null) return
  try {
    showToast(anchor, `正在粘贴 ${payload.name} → ${options.alias}:${directory}`)
    const existing = await listRemoteDir(options.alias, directory)
    if (existing.some(entry => entry.name === payload.name)) {
      const destination = directory === '/' ? `/${payload.name}` : `${directory}/${payload.name}`
      if (!window.confirm(`${destination} 已存在，是否覆盖？`)) {
        showToast(anchor, '已取消粘贴')
        return
      }
    }
    const blob = await readLocalWorkspaceFile(payload)
    const destination = directory === '/' ? `/${payload.name}` : `${directory}/${payload.name}`
    await writeRemoteFile(options.alias, destination, blob)
    showToast(anchor, `已粘贴到 ${options.alias}:${directory}`)
    anchor.querySelector<HTMLButtonElement>('button[title="刷新全部"]')?.click()
  } catch (error) {
    showToast(anchor, error instanceof Error ? error.message : String(error), true)
  }
}

async function pasteRemoteToLocal(
  options: CrossFilesClipboardOptions,
  target: Element,
  anchor: HTMLElement,
): Promise<void> {
  const payload = sshClipboardFor(options)
  if (payload === null) return
  try {
    showToast(anchor, `正在粘贴 ${payload.name} → Files`)
    const blob = await readRemoteFile(options.alias, payload.path)
    const file = new File([blob], payload.name, {
      type: blob.type || 'application/octet-stream',
      lastModified: Date.now(),
    })
    const accepted = dispatchFilesDrop(target, [file])
    if (!accepted) throw new Error('请在 Files 的工作区根目录、目录行或文件行上执行粘贴。')
    showToast(anchor, `已提交 ${payload.name} 到 Files`)
  } catch (error) {
    showToast(anchor, error instanceof Error ? error.message : String(error), true)
  }
}

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
}

function pointDistance(rect: DOMRect, x: number, y: number): number {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
  return Math.hypot(dx, dy)
}

function fixedRemoteMenu(): HTMLElement | null {
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('div'))) {
    if (element.style.position !== 'fixed' || element.style.zIndex !== '9999') continue
    if (!isVisible(element)) continue
    const text = element.textContent ?? ''
    if (text.includes('刷新目录') && (text.includes('重命名') || text.includes('新建目录'))) return element
  }
  return null
}

function localMenuNearPoint(x: number, y: number): HTMLElement | null {
  const roleMenus = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'))
    .filter(isVisible)
    .sort((a, b) => pointDistance(a.getBoundingClientRect(), x, y) - pointDistance(b.getBoundingClientRect(), x, y))
  if (roleMenus[0] !== undefined && pointDistance(roleMenus[0].getBoundingClientRect(), x, y) < 160) return roleMenus[0]

  const px = Math.max(1, Math.min(window.innerWidth - 2, x + 5))
  const py = Math.max(1, Math.min(window.innerHeight - 2, y + 5))
  for (const start of document.elementsFromPoint(px, py)) {
    let current: Element | null = start
    while (current instanceof HTMLElement && current !== document.body) {
      const rect = current.getBoundingClientRect()
      const buttons = current.querySelectorAll('button')
      if (buttons.length >= 2 && rect.width >= 100 && rect.width <= 460 && rect.height <= 760 && isVisible(current)) {
        return current
      }
      current = current.parentElement
    }
  }
  return null
}

function findContextMenu(context: PendingContext): HTMLElement | null {
  return context.side === 'ssh' ? fixedRemoteMenu() : localMenuNearPoint(context.x, context.y)
}

function closeContextMenu(menu: HTMLElement): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  const siblings = menu.parentElement?.children ?? []
  for (const sibling of Array.from(siblings)) {
    if (!(sibling instanceof HTMLElement) || sibling === menu) continue
    if (sibling.style.position === 'fixed' && sibling.style.zIndex === '9998') {
      sibling.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      return
    }
  }
}

function injectAction(
  menu: HTMLElement,
  id: 'copy' | 'paste',
  label: string,
  action: () => void,
): void {
  if (menu.querySelector(`[${ACTION_ATTR}="${id}"]`) !== null) return
  const template = Array.from(menu.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => window.getComputedStyle(button).display !== 'none')
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute(ACTION_ATTR, id)
  button.textContent = label
  if (template !== undefined) {
    button.className = template.className
    button.style.cssText = template.style.cssText
    button.style.display = ''
    button.style.color = ''
  } else {
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
  }
  button.addEventListener('mousedown', event => { event.stopPropagation() })
  button.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    closeContextMenu(menu)
    action()
  })
  const firstButton = menu.querySelector('button')
  if (firstButton !== null) menu.insertBefore(button, firstButton)
  else menu.appendChild(button)
}

function augmentContextMenu(context: PendingContext, options: CrossFilesClipboardOptions): boolean {
  const menu = findContextMenu(context)
  if (menu === null) return false

  if (context.copyPayload !== null) {
    injectAction(menu, 'copy', '复制文件', () => { setClipboard(context.copyPayload!, context.anchor) })
  }

  if (context.side === 'ssh' && localClipboardFor(options) !== null) {
    const directory = context.remoteDirectory ?? '/'
    injectAction(menu, 'paste', '粘贴文件', () => { void pasteLocalToRemote(options, directory, context.anchor) })
  }
  if (context.side === 'local' && sshClipboardFor(options) !== null) {
    injectAction(menu, 'paste', '粘贴文件', () => { void pasteRemoteToLocal(options, context.target, context.anchor) })
  }
  return true
}

function editableTarget(target: EventTarget | null): boolean {
  const element = asElement(target)
  return element?.closest('input, textarea, select, [contenteditable="true"], .cm-editor, .xterm') !== null
}

function install(options: CrossFilesClipboardOptions): () => void {
  let raf1 = 0
  let raf2 = 0
  const timers = new Set<number>()

  const clearScheduled = (): void => {
    if (raf1 !== 0) window.cancelAnimationFrame(raf1)
    if (raf2 !== 0) window.cancelAnimationFrame(raf2)
    raf1 = 0
    raf2 = 0
    for (const timer of timers) window.clearTimeout(timer)
    timers.clear()
  }

  const scheduleAugment = (context: PendingContext): void => {
    clearScheduled()
    const attempt = (): void => { augmentContextMenu(context, options) }
    raf1 = window.requestAnimationFrame(() => {
      raf1 = 0
      raf2 = window.requestAnimationFrame(() => {
        raf2 = 0
        attempt()
      })
    })
    for (const delay of [45, 110]) {
      const timer = window.setTimeout(() => {
        timers.delete(timer)
        attempt()
      }, delay)
      timers.add(timer)
    }
  }

  const onContextMenu = (event: MouseEvent): void => {
    const remoteRoot = remoteRootForTarget(event.target, options)
    if (remoteRoot !== null) {
      const remoteFile = remoteFileButton(event.target, options)
      scheduleAugment({
        side: 'ssh',
        target: asElement(event.target) ?? remoteRoot,
        anchor: remoteRoot,
        copyPayload: remoteFile === null ? null : {
          kind: 'ssh',
          sessionId: options.sessionId,
          alias: options.alias,
          path: remoteFile.path,
          name: remoteBaseName(remoteFile.path),
        },
        remoteDirectory: remoteDirectoryForTarget(event.target, remoteRoot),
        x: event.clientX,
        y: event.clientY,
      })
      return
    }

    const localPanel = localFilesPanelForTarget(event.target, options.localCwd)
    if (localPanel === null) return
    const localFile = localFileRow(event.target, options.localCwd)
    scheduleAugment({
      side: 'local',
      target: asElement(event.target) ?? localPanel,
      anchor: localPanel,
      copyPayload: localFile === null ? null : {
        kind: 'local',
        sessionId: options.sessionId,
        cwd: options.localCwd,
        path: localFile.path,
        name: localBaseName(localFile.path),
      },
      x: event.clientX,
      y: event.clientY,
    })
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || editableTarget(event.target)) return
    const key = event.key.toLowerCase()
    if (key !== 'c' && key !== 'v') return
    const target = asElement(event.target) ?? asElement(document.activeElement)
    if (target === null) return

    const remoteRoot = remoteRootForTarget(target, options)
    if (remoteRoot !== null) {
      if (key === 'c') {
        const remoteFile = remoteFileButton(target, options)
        if (remoteFile === null) return
        event.preventDefault()
        event.stopPropagation()
        setClipboard({
          kind: 'ssh',
          sessionId: options.sessionId,
          alias: options.alias,
          path: remoteFile.path,
          name: remoteBaseName(remoteFile.path),
        }, remoteRoot)
        return
      }
      if (localClipboardFor(options) === null) return
      event.preventDefault()
      event.stopPropagation()
      void pasteLocalToRemote(options, remoteDirectoryForTarget(target, remoteRoot), remoteRoot)
      return
    }

    const localPanel = localFilesPanelForTarget(target, options.localCwd)
    if (localPanel === null) return
    if (key === 'c') {
      const localFile = localFileRow(target, options.localCwd)
      if (localFile === null) return
      event.preventDefault()
      event.stopPropagation()
      setClipboard({
        kind: 'local',
        sessionId: options.sessionId,
        cwd: options.localCwd,
        path: localFile.path,
        name: localBaseName(localFile.path),
      }, localPanel)
      return
    }
    if (sshClipboardFor(options) === null) return
    event.preventDefault()
    event.stopPropagation()
    void pasteRemoteToLocal(options, target, localPanel)
  }

  document.addEventListener('contextmenu', onContextMenu, true)
  document.addEventListener('keydown', onKeyDown, true)
  return () => {
    clearScheduled()
    document.removeEventListener('contextmenu', onContextMenu, true)
    document.removeEventListener('keydown', onKeyDown, true)
  }
}

/**
 * Add an internal file clipboard between better-sidebar Files and SSH Files.
 *
 * This intentionally transfers file bytes only when Paste is invoked. Copy is
 * just a session-bound path token, so large files are not read into browser
 * memory merely because the user right-clicked Copy. The actual transfer reuses
 * the same local raw-file route, SFTP writer, and better-sidebar upload/drop
 * pipeline as cross-pane drag/drop, including overwrite confirmation and target
 * semantics (directory row = inside it, file row = its parent, root = root).
 */
export function installCrossFilesClipboard(options: CrossFilesClipboardOptions): () => void {
  const key = `${options.sessionId}\n${normalizeLocalPath(options.localCwd)}\n${options.alias}`
  const existing = installations.get(key)
  if (existing !== undefined) {
    existing.refs += 1
    return () => {
      existing.refs -= 1
      if (existing.refs <= 0) {
        existing.dispose()
        installations.delete(key)
      }
    }
  }

  const created: Installation = { refs: 1, dispose: install(options) }
  installations.set(key, created)
  return () => {
    created.refs -= 1
    if (created.refs <= 0) {
      created.dispose()
      installations.delete(key)
    }
  }
}
