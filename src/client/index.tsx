import { apply as applySshClient } from './embedded-ssh-client.js'
import { LinkedSshHeaderAction } from './LinkedSshHeaderAction.tsx'
import { RemoteFilesTab, remoteWorkspaceAliasFromCwd } from './RemoteFilesTab.tsx'
import { SessionSshTerminalView } from './SessionSshTerminalView.tsx'
import { registerWorkspaceDirectoryFlow } from './WorkspaceDirectoryFlow.tsx'
import { getLinkedSshAlias, useLinkedSshAlias } from './linked-ssh-store.ts'

function linkedAliasPlaceholder(alias: string): string {
  // RemoteFilesTab already derives its fixed SSH host from a dsh-rw placeholder
  // cwd. For a local+Linked-SSH session we feed it an equivalent synthetic cwd
  // only for alias routing; the actual DSH Workspace remains completely local.
  return `C:/.dsh/remote-workspaces/${alias}/__linked__`
}

function RemoteFilesForScope({ scope }: { scope: any }) {
  const sessionId = scope?.sessionId ?? 'global'
  const remoteAlias = remoteWorkspaceAliasFromCwd(scope?.cwd)
  const linkedAlias = useLinkedSshAlias(sessionId)
  const effectiveAlias = remoteAlias ?? linkedAlias

  if (effectiveAlias === null) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 18, textAlign: 'center', opacity: .68, fontSize: 12 }}>
        当前会话没有 SSH 目标。请在会话顶部点击“连接服务器”，或使用“添加工作区 → 远程 SSH”。
      </div>
    )
  }

  return (
    <RemoteFilesTab
      sessionId={sessionId}
      workspaceCwd={remoteAlias !== null ? scope?.cwd : linkedAliasPlaceholder(effectiveAlias)}
    />
  )
}

// better-sidebar may render its pane inside a transformed containing block.
// In CSS, a transformed ancestor becomes the containing block for descendants
// using position: fixed. RemoteFilesTab stores viewport clientX/clientY values,
// so the browser can otherwise apply the pane offset a second time and place
// the menu far away from the pointer. Keep the menu implementation local to
// RemoteFilesTab, but correct its final viewport rect after it mounts.
function installSshFilesContextMenuPositionFix(): () => void {
  let point: { x: number; y: number } | null = null
  let raf = 0
  let timer = 0

  const findMenu = (): HTMLElement | null => {
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('div'))) {
      if (element.style.position !== 'fixed' || element.style.zIndex !== '9999') continue
      const text = element.textContent ?? ''
      if (!text.includes('刷新目录')) continue
      if (!text.includes('重命名') && !text.includes('新建目录')) continue
      return element
    }
    return null
  }

  const normalizeMenu = (menu: HTMLElement): void => {
    for (const button of Array.from(menu.querySelectorAll<HTMLButtonElement>('button'))) {
      const label = (button.textContent ?? '').trim()
      // Left-clicking a file already opens its preview/editor, so repeating the
      // same action in the context menu adds noise without adding capability.
      if (label === '打开 / 预览 / 编辑') {
        button.style.display = 'none'
        continue
      }
      // Rename still edits inline; the implementation detail does not need to
      // be shown to the operator in the menu label.
      if (label === '重命名（原地编辑）') button.textContent = '重命名'
    }
  }

  const correct = (): void => {
    if (point === null) return
    const menu = findMenu()
    if (menu === null) return

    normalizeMenu(menu)
    const rect = menu.getBoundingClientRect()
    const margin = 6
    const wantedX = Math.max(margin, Math.min(point.x, window.innerWidth - rect.width - margin))
    const wantedY = Math.max(margin, Math.min(point.y, window.innerHeight - rect.height - margin))
    const dx = wantedX - rect.left
    const dy = wantedY - rect.top

    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    const currentLeft = Number.parseFloat(menu.style.left || '0') || 0
    const currentTop = Number.parseFloat(menu.style.top || '0') || 0
    menu.style.left = `${currentLeft + dx}px`
    menu.style.top = `${currentTop + dy}px`
  }

  const schedule = (): void => {
    if (raf !== 0) window.cancelAnimationFrame(raf)
    if (timer !== 0) window.clearTimeout(timer)
    raf = window.requestAnimationFrame(() => {
      raf = window.requestAnimationFrame(() => {
        raf = 0
        correct()
      })
    })
    timer = window.setTimeout(() => {
      timer = 0
      correct()
    }, 40)
  }

  const onContextMenu = (event: MouseEvent): void => {
    point = { x: event.clientX, y: event.clientY }
    schedule()
  }

  document.addEventListener('contextmenu', onContextMenu, true)
  return () => {
    document.removeEventListener('contextmenu', onContextMenu, true)
    if (raf !== 0) window.cancelAnimationFrame(raf)
    if (timer !== 0) window.clearTimeout(timer)
  }
}

/**
 * Keep the session terminal's familiar shortcuts local to the terminal.
 *
 * xterm's custom key handler decides whether a key is forwarded to the PTY,
 * but returning false does not reliably cancel Chrome's page-level defaults.
 * Listen at window capture (the earliest DOM phase available to page code) and
 * cancel browser defaults before the event reaches xterm. Propagation remains
 * intact so SessionSshTerminalView can still perform its own search/font action.
 *
 * Clipboard paste is the opposite case: Ctrl+V must stay a native browser paste
 * event. When clipboard-read permission is granted, the terminal's explicit
 * navigator.clipboard.readText() path and the browser paste event can both fire,
 * producing duplicate text. Stop only the keydown propagation here (without
 * preventDefault) so the browser performs exactly one native paste event.
 */
function installSessionTerminalBrowserShortcutCompatibility(): () => void {
  const findXterm = (target: EventTarget | null): Element | null => {
    return target instanceof Element ? target.closest('.xterm') : null
  }

  const isSessionTerminalTarget = (eventTarget: EventTarget | null): boolean => {
    // Some Chromium/xterm combinations report the helper textarea as the event
    // target, while others can surface document/body during IME/focus changes.
    // Fall back to activeElement so the guard still recognizes the focused PTY.
    const xterm = findXterm(eventTarget) ?? findXterm(document.activeElement)
    if (xterm === null) return false

    // The original full SSH management panel is mounted under this marker.
    // Leave its keyboard behavior untouched; this compatibility layer is only
    // for the conversation-level Linked SSH terminal.
    return xterm.closest('[data-dsh-ssh-view]') === null
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isSessionTerminalTarget(event.target)) return

    const mod = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()

    // Let the browser/xterm native paste event be the one and only paste path.
    // Do not call preventDefault: that would suppress the actual paste event.
    if ((mod && key === 'v') || (event.shiftKey && event.key === 'Insert')) {
      event.stopPropagation()
      return
    }

    if (!mod) return

    const isTerminalFind = key === 'f' || event.code === 'KeyF'
    const terminalOwnedBrowserShortcut =
      isTerminalFind ||
      key === '0' ||
      key === '-' ||
      key === '=' ||
      key === '+' ||
      (event.shiftKey && (key === 'c' || key === 'a'))

    if (terminalOwnedBrowserShortcut) {
      // Explicitly cancel Chromium's built-in Find/Zoom actions. Using window
      // capture plus returnValue=false is intentionally redundant here: it
      // covers Chrome variants where document-level prevention arrived too late.
      event.preventDefault()
      event.returnValue = false
    }
  }

  window.addEventListener('keydown', onKeyDown, true)
  return () => { window.removeEventListener('keydown', onKeyDown, true) }
}

// We compose the original dsh-ssh browser UI inside this one client plugin.
// Because we call its apply() directly, our wrapper must declare every Cordis
// service that the embedded client may access. In particular dsh-ssh's current
// client reads settingsScope; without listing it here Cordis intentionally
// throws "cannot get property settingsScope without inject".
export const inject = [
  'betterSidebar',
  'slots',
  'locale',
  'connection',
  'remote',
  'settingsScope',
]

export function apply(ctx: any): void {
  // Original dsh-ssh browser surfaces remain available from the left SSH entry
  // for host management, transfer, tunnels and ad-hoc administration. The
  // session-bound terminal below is intentionally a different surface: it can
  // never select a host independently from Linked SSH.
  applySshClient(ctx)

  // Replace the raw native directory picker entry with an explicit Local /
  // Remote SSH chooser. The Remote tab uses dsh-rw's workspace route, mounted
  // by this same package's host half.
  registerWorkspaceDirectoryFlow(ctx)

  ctx.effect(installSshFilesContextMenuPositionFix, 'dsh-ssh-files-sidebar: context menu viewport fix')
  ctx.effect(installSessionTerminalBrowserShortcutCompatibility, 'dsh-ssh-files-sidebar: session terminal browser shortcut compatibility')

  // Linked SSH is session-scoped and additive: a local Workspace stays local,
  // while the session can independently point at one configured SSH host.
  // This selector is the single source of truth for Agent context, SSH Files
  // and the session SSH terminal.
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'linked-ssh',
    order: 5,
    label: 'SSH',
  }, LinkedSshHeaderAction))

  // Native conversation tab beside “对话 / 轨迹”. It is deliberately bound to
  // the current session's Linked SSH alias and exposes no host selector of its
  // own, preventing terminal/SSH-Files/Agent target drift.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'ssh-terminal',
    order: 20,
    label: 'SSH终端',
  }, SessionSshTerminalView))

  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'dsh-ssh-files-sidebar:files',
    title: 'SSH Files',
    order: 15,
    single: true,
    // SSH Files is available either for a native Remote Workspace or when the
    // current local session has an explicit Linked SSH target.
    available: (_ctx: any, scope: any) => {
      const remoteAlias = remoteWorkspaceAliasFromCwd(scope?.cwd)
      if (remoteAlias !== null) return true
      return getLinkedSshAlias(scope?.sessionId) !== null
    },
    component: ({ scope }: any) => <RemoteFilesForScope scope={scope} />,
  }), 'dsh-ssh-files-sidebar: register tab')
}
