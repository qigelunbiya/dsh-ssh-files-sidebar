import { useSyncExternalStore } from 'react'

const STORAGE_PREFIX = 'dsh-ssh-files-sidebar:linked-ssh:v1:'
const EVENT_NAME = 'dsh-ssh-files-sidebar:linked-ssh-changed'

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`
}

function normalizeAlias(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const alias = value.trim()
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias) ? alias : null
}

/** Read the SSH host linked to one DSH session. */
export function getLinkedSshAlias(sessionId?: string): string | null {
  if (!sessionId || typeof window === 'undefined') return null
  try {
    return normalizeAlias(window.localStorage.getItem(storageKey(sessionId)))
  } catch {
    return null
  }
}

/** Link or unlink one DSH session from an existing dsh-ssh host alias. */
export function setLinkedSshAlias(sessionId: string, alias: string | null): void {
  if (!sessionId || typeof window === 'undefined') return
  const normalized = alias === null ? null : normalizeAlias(alias)
  try {
    if (normalized === null) window.localStorage.removeItem(storageKey(sessionId))
    else window.localStorage.setItem(storageKey(sessionId), normalized)
  } catch {
    // Storage can be unavailable in hardened browser contexts. The custom event
    // still lets the current page converge to the attempted state if possible.
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { sessionId } }))
}

function subscribe(sessionId: string, listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}

  const onCustom = (event: Event): void => {
    const detail = (event as CustomEvent<{ sessionId?: string }>).detail
    if (detail?.sessionId === sessionId) listener()
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key === storageKey(sessionId)) listener()
  }

  window.addEventListener(EVENT_NAME, onCustom)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(EVENT_NAME, onCustom)
    window.removeEventListener('storage', onStorage)
  }
}

/** Reactive session binding used by the header action and SSH Files tab. */
export function useLinkedSshAlias(sessionId: string): string | null {
  return useSyncExternalStore(
    listener => subscribe(sessionId, listener),
    () => getLinkedSshAlias(sessionId),
    () => null,
  )
}
