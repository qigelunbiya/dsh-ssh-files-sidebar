export interface LinkedTerminalRequest {
  alias: string
  autoConnect: boolean
  nonce: number
}

type Listener = (request: LinkedTerminalRequest) => void

let latest: LinkedTerminalRequest | null = null
let nonce = 0
const listeners = new Set<Listener>()

/**
 * Durable in-bundle command bridge from the session header into the embedded
 * SSH panel. Unlike a one-shot DOM CustomEvent, the latest request is retained
 * until the panel React tree has subscribed, so clicks made while the panel is
 * remounting cannot be lost.
 */
export function requestLinkedTerminal(alias: string, autoConnect = true): void {
  const trimmed = alias.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed)) return
  latest = { alias: trimmed, autoConnect, nonce: ++nonce }
  for (const listener of [...listeners]) listener(latest)
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
