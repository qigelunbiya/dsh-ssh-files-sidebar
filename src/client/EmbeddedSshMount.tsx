import { createRoot, type Root } from 'react-dom/client'
import { panelCss as css, type PanelController, type SshApi } from './ssh-panel-bridge.js'
import { EmbeddedSshErrorBoundary } from './EmbeddedSshErrorBoundary.tsx'
import { EmbeddedSshPanel } from './EmbeddedSshPanel.tsx'

const PRIMARY_CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"]'
const FALLBACK_CENTER_COLUMN_SELECTOR = '[class*="centerCol"]'
const ACTIVE_ATTR = 'data-dsh-ssh-active'
const OTHER_ACTIVE_ATTR = 'data-dsh-taskboard-active'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'ssh'

function conversationColumn(): HTMLElement | undefined {
  const pane = document.querySelector<HTMLElement>(PRIMARY_CONVERSATION_COLUMN_SELECTOR)
  if (pane !== null) {
    // Current Harness can nest [data-pane="conversation"] inside centerCol.
    // The dsh-ssh stylesheet hides every direct centerCol child except
    // [data-dsh-ssh-view] while SSH is active. Mounting our view *inside* the
    // nested pane therefore caused centerCol to hide the pane itself, leaving
    // a completely white center area. Put the SSH view beside the pane as a
    // direct center-column child whenever that outer container exists.
    const outerCenter = pane.closest<HTMLElement>(FALLBACK_CENTER_COLUMN_SELECTOR)
    if (outerCenter !== null) return outerCenter
    return pane
  }
  return document.querySelector<HTMLElement>(FALLBACK_CENTER_COLUMN_SELECTOR) ?? undefined
}

/** Upstream mount behavior with our Linked-SSH-aware panel component. */
export function mountEmbeddedSshPanel(controller: PanelController, api: SshApi): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let retryFrame = 0

  const ensure = (): boolean => {
    if (container !== undefined) {
      if (container.isConnected) return true
      root?.unmount()
      root = undefined
      container.remove()
      container = undefined
    }

    const column = conversationColumn()
    if (column === undefined) return false

    container = document.createElement('div')
    container.dataset.dshSshView = ''
    container.className = css.view ?? ''
    column.appendChild(container)
    root = createRoot(container)
    root.render(
      <EmbeddedSshErrorBoundary controller={controller}>
        <EmbeddedSshPanel controller={controller} api={api} />
      </EmbeddedSshErrorBoundary>,
    )
    return true
  }

  const scheduleEnsure = (): void => {
    if (retryFrame !== 0) return
    retryFrame = window.requestAnimationFrame(() => {
      retryFrame = 0
      if (!controller.getSnapshot().panelOpen) return
      if (ensure()) applyActive()
      else scheduleEnsure()
    })
  }

  const waitObserver = new MutationObserver(() => {
    if (container !== undefined && !container.isConnected) ensure()
    else if (container === undefined) ensure()
  })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  function applyActive(): void {
    if (controller.getSnapshot().panelOpen) {
      // Never hide the conversation until the SSH view is actually mounted.
      if (!ensure()) {
        document.documentElement.removeAttribute(ACTIVE_ATTR)
        scheduleEnsure()
        return
      }
      document.documentElement.removeAttribute(OTHER_ACTIVE_ATTR)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }

  const onOtherActivate = (event: Event): void => {
    if ((event as CustomEvent).detail === 'taskboard' && controller.getSnapshot().panelOpen) controller.close()
  }

  const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.getSnapshot().panelOpen) return
    const target = event.target as HTMLElement | null
    if (target !== null && target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.close()
  }

  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = controller.subscribe(applyActive)
  ensure()
  applyActive()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    if (retryFrame !== 0) window.cancelAnimationFrame(retryFrame)
    retryFrame = 0
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
