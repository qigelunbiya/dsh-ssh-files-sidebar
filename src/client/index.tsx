import { apply as applySshClient } from './embedded-ssh-client.js'
import { RemoteFilesTab, remoteWorkspaceAliasFromCwd } from './RemoteFilesTab.tsx'
import { registerWorkspaceDirectoryFlow } from './WorkspaceDirectoryFlow.tsx'

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
  // Original dsh-ssh browser surfaces: left SSH entry + center host/terminal/
  // transfer/tunnel/cluster panel. This shares the host half mounted by our
  // package root and therefore the same ~/.dsh/dsh-ssh.json configuration.
  applySshClient(ctx)

  // Replace the raw native directory picker entry with an explicit Local /
  // Remote SSH chooser. The Remote tab uses dsh-rw's workspace route, mounted
  // by this same package's host half.
  registerWorkspaceDirectoryFlow(ctx)

  ctx.effect(installSshFilesContextMenuPositionFix, 'dsh-ssh-files-sidebar: context menu viewport fix')

  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'dsh-ssh-files-sidebar:files',
    title: 'SSH Files',
    order: 15,
    single: true,
    // Do not offer SSH Files in local workspaces. dsh-rw remote workspaces are
    // represented by ~/.dsh/remote-workspaces/<alias>/<workspace> placeholders.
    available: (_ctx: any, scope: any) => remoteWorkspaceAliasFromCwd(scope?.cwd) !== null,
    component: ({ scope }: any) => (
      <RemoteFilesTab
        sessionId={scope?.sessionId ?? 'global'}
        workspaceCwd={scope?.cwd}
      />
    ),
  }), 'dsh-ssh-files-sidebar: register tab')
}
