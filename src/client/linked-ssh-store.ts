import { useEffect, useSyncExternalStore } from 'react'
import { getLinkedSshBinding, saveLinkedSshBinding } from './api.ts'

const STORAGE_PREFIX = 'dsh-ssh-files-sidebar:linked-ssh:v1:'
const EVENT_NAME = 'dsh-ssh-files-sidebar:linked-ssh-changed'
const hydrated = new Set<string>()
const hydrating = new Map<string, Promise<void>>()
const workspaceAliases = new Map<string, string>()

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`
}

function normalizeAlias(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const alias = value.trim()
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias) ? alias : null
}

function publish(sessionId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { sessionId } }))
}

/** Read the explicit Linked SSH browser cache for one DSH session. */
export function getLinkedSshAlias(sessionId?: string): string | null {
  if (!sessionId || typeof window === 'undefined') return null
  try {
    return normalizeAlias(window.localStorage.getItem(storageKey(sessionId)))
  } catch {
    return null
  }
}

/**
 * Record the SSH alias implied by a dsh-rw Remote Workspace.
 * This state is intentionally page-local: the Workspace itself remains the
 * persistent source of truth, while consumers such as SSH Terminal and @ refs
 * get one unified effective target without polluting the explicit Linked SSH
 * binding stored for local workspaces.
 */
export function setWorkspaceSshAlias(sessionId: string, alias: string | null): void {
  if (!sessionId || typeof window === 'undefined') return
  const normalized = alias === null ? null : normalizeAlias(alias)
  if (alias !== null && normalized === null) return
  const current = workspaceAliases.get(sessionId) ?? null
  if (current === normalized) return
  if (normalized === null) workspaceAliases.delete(sessionId)
  else workspaceAliases.set(sessionId, normalized)
  publish(sessionId)
}

/** Workspace SSH wins; otherwise fall back to the explicit Linked SSH binding. */
export function getEffectiveSshAlias(sessionId?: string): string | null {
  if (!sessionId) return null
  return workspaceAliases.get(sessionId) ?? getLinkedSshAlias(sessionId)
}

function publishLocal(sessionId: string, alias: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (alias === null) window.localStorage.removeItem(storageKey(sessionId))
    else window.localStorage.setItem(storageKey(sessionId), alias)
  } catch {
    // Hardened browser contexts may reject storage; the same-page event still
    // lets mounted consumers re-read whatever storage state is available.
  }
  publish(sessionId)
}

/**
 * Load the host-side binding once per page. Existing 0.5.0 browser-only state
 * is migrated forward automatically when the host has no binding yet.
 */
export function hydrateLinkedSshAlias(sessionId: string): Promise<void> {
  if (!sessionId || typeof window === 'undefined' || hydrated.has(sessionId)) return Promise.resolve()
  const active = hydrating.get(sessionId)
  if (active !== undefined) return active

  const task = (async () => {
    const cached = getLinkedSshAlias(sessionId)
    try {
      const binding = await getLinkedSshBinding(sessionId)
      if (binding !== null) {
        publishLocal(sessionId, binding.alias)
      } else if (cached !== null) {
        // 0.5.0 stored Linked SSH only in localStorage. Preserve the user's
        // working setup by promoting that cache to the new host-side store.
        const migrated = await saveLinkedSshBinding(sessionId, cached)
        publishLocal(sessionId, migrated?.alias ?? cached)
      } else {
        publishLocal(sessionId, null)
      }
      hydrated.add(sessionId)
    } catch (error) {
      // Keep the browser cache usable even if the host route temporarily fails.
      console.warn('[dsh-ssh-files-sidebar] Linked SSH hydrate failed:', error)
    } finally {
      hydrating.delete(sessionId)
    }
  })()
  hydrating.set(sessionId, task)
  return task
}

/**
 * Link or unlink one DSH session from an existing dsh-ssh host alias.
 * The host store is written first so the Agent context and the UI cannot claim
 * different targets after a successful interaction.
 */
export async function setLinkedSshAlias(sessionId: string, alias: string | null): Promise<void> {
  if (!sessionId || typeof window === 'undefined') return
  const normalized = alias === null ? null : normalizeAlias(alias)
  if (alias !== null && normalized === null) throw new Error('invalid SSH alias')
  const binding = await saveLinkedSshBinding(sessionId, normalized)
  publishLocal(sessionId, binding?.alias ?? null)
  hydrated.add(sessionId)
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

function useAliasSnapshot(sessionId: string, effective: boolean): string | null {
  useEffect(() => {
    void hydrateLinkedSshAlias(sessionId)
  }, [sessionId])

  return useSyncExternalStore(
    listener => subscribe(sessionId, listener),
    () => effective ? getEffectiveSshAlias(sessionId) : getLinkedSshAlias(sessionId),
    () => null,
  )
}

/** Explicit user-selected Linked SSH only, used by the header selector itself. */
export function useExplicitLinkedSshAlias(sessionId: string): string | null {
  return useAliasSnapshot(sessionId, false)
}

/**
 * Reactive effective SSH target used by SSH Files / SSH Terminal.
 * A Remote Workspace alias takes priority over an explicit local-workspace link.
 */
export function useLinkedSshAlias(sessionId: string): string | null {
  return useAliasSnapshot(sessionId, true)
}
