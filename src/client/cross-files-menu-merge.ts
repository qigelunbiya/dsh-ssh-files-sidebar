const ADDON_MENU_SELECTOR = '[data-dsh-cross-files-clipboard-menu="true"]'
const MERGED_ACTION_ATTR = 'data-dsh-cross-files-merged-action'

let installed = false

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
}

function rectDistance(a: DOMRect, b: DOMRect): number {
  const dx = a.right < b.left ? b.left - a.right : b.right < a.left ? a.left - b.right : 0
  const dy = a.bottom < b.top ? b.top - a.bottom : b.bottom < a.top ? a.top - b.bottom : 0
  return Math.hypot(dx, dy)
}

function looksLikeLocalFilesMenu(element: HTMLElement): boolean {
  const text = element.textContent ?? ''
  return (
    text.includes('复制相对路径') || text.includes('复制绝对路径') ||
    text.includes('复制相对地址') || text.includes('复制绝对地址') ||
    text.includes('Copy relative path') || text.includes('Copy absolute path') ||
    text.includes('上传到此处') || text.includes('Upload here')
  )
}

function looksLikeSshFilesMenu(element: HTMLElement): boolean {
  const text = element.textContent ?? ''
  return (
    text.includes('刷新目录') || text.includes('Refresh directory') ||
    (text.includes('重命名') && text.includes('删除')) ||
    (text.includes('Rename') && text.includes('Delete'))
  )
}

function findNativeMenu(addon: HTMLElement): { menu: HTMLElement; side: 'local' | 'ssh' } | null {
  const addonRect = addon.getBoundingClientRect()
  const candidates: Array<{ menu: HTMLElement; side: 'local' | 'ssh'; distance: number; area: number }> = []

  for (const menu of Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'))) {
    if (!isVisible(menu) || !looksLikeLocalFilesMenu(menu)) continue
    const rect = menu.getBoundingClientRect()
    candidates.push({ menu, side: 'local', distance: rectDistance(addonRect, rect), area: rect.width * rect.height })
  }

  for (const menu of Array.from(document.querySelectorAll<HTMLElement>('div'))) {
    if (menu === addon || !isVisible(menu)) continue
    if (menu.style.position !== 'fixed' || menu.style.zIndex !== '9999') continue
    if (!looksLikeSshFilesMenu(menu)) continue
    const rect = menu.getBoundingClientRect()
    candidates.push({ menu, side: 'ssh', distance: rectDistance(addonRect, rect), area: rect.width * rect.height })
  }

  candidates.sort((a, b) => a.distance - b.distance || a.area - b.area)
  const best = candidates[0]
  return best === undefined ? null : { menu: best.menu, side: best.side }
}

function buttonText(button: HTMLButtonElement): string {
  return (button.textContent ?? '').trim()
}

function findInsertionAnchor(menu: HTMLElement, side: 'local' | 'ssh'): HTMLButtonElement | null {
  const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button'))
    .filter(button => button.getAttribute(MERGED_ACTION_ATTR) !== 'true')

  if (side === 'local') {
    return buttons.find(button => {
      const text = buttonText(button)
      return (
        text.includes('复制相对路径') || text.includes('复制绝对路径') ||
        text.includes('复制相对地址') || text.includes('复制绝对地址') ||
        text.includes('Copy relative path') || text.includes('Copy absolute path')
      )
    }) ?? null
  }

  return buttons.find(button => {
    const text = buttonText(button)
    return text === '刷新目录' || text === 'Refresh directory'
  }) ?? null
}

function findTemplateButton(menu: HTMLElement): HTMLButtonElement | null {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).find(button => {
    if (button.getAttribute(MERGED_ACTION_ATTR) === 'true' || !isVisible(button)) return false
    const text = buttonText(button)
    return text !== '删除' && text !== 'Delete'
  }) ?? null
}

function applyNativeAppearance(button: HTMLButtonElement, template: HTMLButtonElement | null): void {
  if (template === null) return
  const label = button.textContent ?? ''
  button.className = template.className
  button.style.cssText = template.style.cssText
  const role = template.getAttribute('role')
  const tabIndex = template.getAttribute('tabindex')
  if (role !== null) button.setAttribute('role', role)
  if (tabIndex !== null) button.setAttribute('tabindex', tabIndex)
  button.removeAttribute('disabled')
  button.removeAttribute('aria-disabled')
  button.removeAttribute('aria-haspopup')
  button.removeAttribute('aria-expanded')
  button.textContent = label

  const normalBackground = button.style.background
  button.addEventListener('mouseenter', () => {
    if (button.style.background === normalBackground || button.style.background === '') {
      button.style.background = 'rgba(128,128,128,.12)'
    }
  })
  button.addEventListener('mouseleave', () => {
    button.style.background = normalBackground
  })
}

function mergeAddonIntoNativeMenu(addon: HTMLElement): boolean {
  if (!addon.isConnected) return true
  const resolved = findNativeMenu(addon)
  if (resolved === null) return false

  const { menu, side } = resolved
  const actionButtons = Array.from(addon.querySelectorAll<HTMLButtonElement>('button'))
  if (actionButtons.length === 0) {
    addon.remove()
    return true
  }

  const template = findTemplateButton(menu)
  const anchor = findInsertionAnchor(menu, side)
  const container = anchor?.parentElement ?? template?.parentElement ?? menu

  for (const button of actionButtons) {
    button.setAttribute(MERGED_ACTION_ATTR, 'true')
    applyNativeAppearance(button, template)
    if (anchor !== null && anchor.parentElement === container) container.insertBefore(button, anchor)
    else container.appendChild(button)
  }

  addon.remove()
  return true
}

function scheduleMerge(addon: HTMLElement): void {
  const tryMerge = (): boolean => mergeAddonIntoNativeMenu(addon)
  window.requestAnimationFrame(() => {
    if (tryMerge()) return
    window.setTimeout(() => {
      if (tryMerge()) return
      window.setTimeout(() => { tryMerge() }, 60)
    }, 20)
  })
}

/**
 * v0.8.13 menu presentation bridge.
 *
 * The cross-files clipboard intentionally owns only transfer semantics and
 * therefore creates a tiny transient action menu. Here we move those already
 * wired action buttons into whichever native context menu triggered them:
 * better-sidebar's Files menu or RemoteFilesTab's SSH Files menu. The button
 * closures stay intact, while the UI remains a single native-looking column.
 */
export function installCrossFilesMenuMerge(): void {
  if (installed) return
  installed = true

  const mergeExisting = (): void => {
    for (const addon of Array.from(document.querySelectorAll<HTMLElement>(ADDON_MENU_SELECTOR))) {
      scheduleMerge(addon)
    }
  }

  mergeExisting()
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue
        if (node.matches(ADDON_MENU_SELECTOR)) scheduleMerge(node)
        for (const addon of Array.from(node.querySelectorAll<HTMLElement>(ADDON_MENU_SELECTOR))) scheduleMerge(addon)
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
}
