import { createRoot, type Root } from 'react-dom/client'
import type { SshApi } from '@linxin666/dsh-ssh/src/client/api.ts'
import type { PanelController } from '@linxin666/dsh-ssh/src/client/panel/controller.ts'
import css from '@linxin666/dsh-ssh/src/client/panel/panel.module.css'
import { EmbeddedSshPanel } from './EmbeddedSshPanel.tsx'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"]'
const ACTIVE_ATTR = 'data-dsh-ssh-active'
const OTHER_ACTIVE_ATTR = 'data-dsh-taskboard-active'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'ssh'

function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/** Upstream mount behavior with our Linked-SSH-aware panel component. */
export function mountEmbeddedSshPanel(controller: PanelController, api: SshApi): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      root?.unmount()
      root = undefined
      container.remove()
      container = undefined
    }
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshSshView = ''
    container.className = css.view
    column.appendChild(container)
    root = createRoot(container)
    root.render(<EmbeddedSshPanel controller={controller} api={api} />)
  }

  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    if (controller.getSnapshot().panelOpen) {
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
    if (target?.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.close()
  }

  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
