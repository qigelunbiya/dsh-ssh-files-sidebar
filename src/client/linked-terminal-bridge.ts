export interface LinkedTerminalRequest {
  alias: string
  autoConnect: boolean
  nonce: number
}

type Listener = (request: LinkedTerminalRequest) => void
type PanelOpener = (request: LinkedTerminalRequest) => void

let latest: LinkedTerminalRequest | null = null
let nonce = 0
let panelOpener: PanelOpener | null = null
const listeners = new Set<Listener>()

/**
 * Durable in-bundle command bridge from the session header into the embedded
 * SSH panel. The request itself is retained for the React panel, while a panel
 * opener is registered as soon as the SSH client is applied so clicking the
 * header can synchronously open the center-column SSH surface even if the
 * panel React tree is between mounts.
 */
export function requestLinkedTerminal(alias: string, autoConnect = true): void {
  const trimmed = alias.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed)) return
  latest = { alias: trimmed, autoConnect, nonce: ++nonce }
  panelOpener?.(latest)
  for (const listener of [...listeners]) listener(latest)
}

/**
 * Bind the long-lived SSH panel controller to this command bridge. This is
 * deliberately separate from the React subscription below: opening the panel
 * must not depend on whether EmbeddedSshPanel has mounted its useEffect yet.
 */
export function bindLinkedTerminalPanelOpener(opener: PanelOpener): () => void {
  panelOpener = opener
  if (latest !== null) opener(latest)
  return () => {
    if (panelOpener === opener) panelOpener = null
  }
}

export function subscribeLinkedTerminal(listener: Listener): () => void {
  listeners.add(listener)
  if (latest !== null) {
    const snapshot = latest
    queueMicrotask(() => {
      if (listeners.has(listener)) listener(snapshot)
    })
  }
  return () => { listeners.delete(listener) }
}
