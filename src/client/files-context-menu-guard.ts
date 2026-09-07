const SSH_ROOT_SELECTOR = '[data-dsh-ssh-files-root="true"]'
const PANE_SELECTOR = '[data-dsh-pane]'

let installed = false

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

/**
 * better-sidebar's local Files tree owns a hidden multi-file picker inside the
 * tree body. Walk only ancestors BELOW the pane so tab bars / other pane chrome
 * are not mistaken for the file surface just because the pane contains Files.
 */
function isLocalFilesSurface(element: Element): boolean {
  const pane = element.closest<HTMLElement>(PANE_SELECTOR)
  if (pane === null || pane.querySelector(SSH_ROOT_SELECTOR) !== null) return false

  let current: Element | null = element
  while (current !== null && current !== pane) {
    if (current.querySelector('input[type="file"][multiple]') !== null) return true
    current = current.parentElement
  }
  return false
}

/**
 * Suppress the browser's own context menu only on Files / SSH Files surfaces.
 * App-level React context-menu handlers still run because we intentionally do
 * not stop propagation; this only cancels Chrome/Edge's default menu.
 */
export function installFilesContextMenuGuard(): void {
  if (installed) return
  installed = true

  document.addEventListener('contextmenu', (event) => {
    const element = asElement(event.target)
    if (element === null || isEditableTarget(event.target)) return

    if (element.closest(SSH_ROOT_SELECTOR) !== null || isLocalFilesSurface(element)) {
      event.preventDefault()
    }
  }, true)
}
