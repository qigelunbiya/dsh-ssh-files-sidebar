import { remoteWorkspaceFromCwd } from './remote-workspace-safety.ts'

interface BindingStoreLike {
  get(sessionId: string): { alias: string } | undefined
}

/** Return the current DSH agent/session id from prompt or tool contexts. */
export function sessionIdFromAgentLike(value: any): string | undefined {
  const id = value?.agent?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** Return the actual conversation cwd from prompt or tool contexts. */
export function cwdFromAgentLike(value: any): string | undefined {
  const cwd = value?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Resolve the one SSH alias that the current conversation is allowed to use.
 *
 * The client UI gives a Remote Workspace precedence over an additive Linked SSH
 * binding (RemoteFilesForScope uses remoteAlias ?? linkedAlias). The host-side
 * Agent routing must use exactly the same precedence, otherwise the UI can show
 * 131 while a model-facing tool silently operates on a stale 122 binding.
 */
export function effectiveSessionSshAlias(store: BindingStoreLike, value: any): string | null {
  const cwd = cwdFromAgentLike(value)
  const remote = remoteWorkspaceFromCwd(cwd)
  if (remote !== null) return remote.alias

  const sessionId = sessionIdFromAgentLike(value)
  if (sessionId === undefined) return null
  return store.get(sessionId)?.alias ?? null
}

export function requireEffectiveSessionSshAlias(store: BindingStoreLike, value: any): string {
  const alias = effectiveSessionSshAlias(store, value)
  if (alias === null) {
    throw new Error('当前会话没有 SSH 目标。请先在会话顶部选择服务器，或进入一个 Remote Workspace。')
  }
  return alias
}
