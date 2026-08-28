import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

interface RwState {
  alias: string | null
  workspace: string | null
}

interface RwPlaceholderMeta {
  plugin: 'dsh-rw'
  alias: string
  host: string
  port: number
  user: string
  remotePath: string
}

/**
 * dsh-rw 0.4.x persists one process-global Session in ~/.dsh/dsh-rw-session.json.
 * That state is appropriate for its original single-remote-workspace workflow,
 * but it is not authoritative in Harness where many conversations can be open
 * at once (local, remote, and local+Linked-SSH).
 *
 * We still give dsh-rw a tiny Session-shaped object because its picker/status
 * routes expect one while creating a placeholder. The state deliberately lives
 * only in this process and is NEVER restored from disk. Native remote-tool
 * routing does not depend on this state: dsh-rw's shim already treats the
 * calling agent cwd + .dsh-rw-meta.json as authoritative.
 */
export class EphemeralRwSession {
  private state: RwState = { alias: null, workspace: null }

  get alias(): string | null {
    return this.state.alias
  }

  get workspace(): string | null {
    return this.state.workspace
  }

  set(patch: Partial<RwState>): void {
    this.state = { ...this.state, ...patch }
  }
}

const META_FILE = '.dsh-rw-meta.json'
const DEFAULT_PLACEHOLDER_BASE = join(homedir(), '.dsh', 'remote-workspaces')

function normalizeCase(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function insideOrEqual(path: string, root: string): boolean {
  const p = normalizeCase(resolve(path))
  const r = normalizeCase(resolve(root))
  return p === r || p.startsWith(`${r}${sep}`)
}

function readMeta(dir: string): RwPlaceholderMeta | null {
  try {
    const data = JSON.parse(readFileSync(join(dir, META_FILE), 'utf8')) as Record<string, unknown>
    if (
      data.plugin !== 'dsh-rw' ||
      typeof data.alias !== 'string' || data.alias === '' ||
      typeof data.host !== 'string' || data.host === '' ||
      typeof data.port !== 'number' || !Number.isFinite(data.port) ||
      typeof data.user !== 'string' || data.user === '' ||
      typeof data.remotePath !== 'string' || data.remotePath === ''
    ) return null
    return {
      plugin: 'dsh-rw',
      alias: data.alias,
      host: data.host,
      port: data.port,
      user: data.user,
      remotePath: data.remotePath,
    }
  } catch {
    return null
  }
}

/**
 * Resolve the CURRENT conversation cwd to its remote-workspace metadata.
 * No global dsh-rw session is consulted. We walk upward only inside the known
 * placeholder base, so a normal local project can never be mistaken for SSH.
 */
export function remoteWorkspaceFromCwd(cwd: unknown, baseDir = DEFAULT_PLACEHOLDER_BASE): RwPlaceholderMeta | null {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null

  const baseLex = resolve(baseDir)
  const candidates = [resolve(cwd)]
  try {
    const real = realpathSync(cwd)
    if (!candidates.some(item => normalizeCase(item) === normalizeCase(real))) candidates.push(real)
  } catch {
    // Lexical containment is sufficient when cwd temporarily cannot be realpathed.
  }

  for (const start of candidates) {
    if (!insideOrEqual(start, baseLex)) continue
    let current = start
    while (insideOrEqual(current, baseLex)) {
      const meta = readMeta(current)
      if (meta !== null) return meta
      if (normalizeCase(current) === normalizeCase(baseLex)) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return null
}

function cwdFromAgentLike(value: any): string | undefined {
  const cwd = value?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

function remotePrompt(meta: RwPlaceholderMeta): string {
  return [
    '## Remote workspace (session-safe)',
    `This conversation is remote-backed: ${meta.user}@${meta.host}:${meta.port} (alias: ${meta.alias}), workspace ${meta.remotePath}.`,
    'The conversation cwd is a dsh-rw placeholder; the remote filesystem is the source of truth.',
    'Use the normal Read/Write/Edit/Glob/Grep/Bash tools exactly as you would in a local workspace; dsh-rw shim routing maps those native file/shell calls for this cwd to this remote workspace. Do not use the Windows-local Pwsh tool for remote-shell work.',
    'Legacy rw_* tools are intentionally hidden/blocked by dsh-ssh-files-sidebar because dsh-rw 0.4.x stores their target in one process-global session and can therefore drift across conversations. Do not call rw_* tools.',
  ].join('\n')
}

function blockedRwResult(cwd: string | undefined, meta: RwPlaceholderMeta | null): any {
  const message = meta === null
    ? `rw_* is disabled in this local workspace${cwd ? ` (${cwd})` : ''}. Use the normal local Read/Write/Edit/Glob/Grep/Bash/Pwsh tools. If you intentionally need another server from a local workspace, use the session-bound linked_ssh_* tools after selecting it in the header.`
    : `rw_* is disabled because its upstream target is process-global and unsafe across conversations. This session is already a remote workspace on ${meta.alias}:${meta.remotePath}; use the normal native Read/Write/Edit/Glob/Grep/Bash tools, which are routed to that remote workspace by cwd.`
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message },
  }
}

/**
 * Make dsh-rw safe in a multi-session Harness process without forking its SSH
 * shim implementation:
 *
 * 1. Prompt assembly is rewritten from the ACTUAL conversation cwd. A local
 *    conversation receives no stale dsh-rw section at all; a remote placeholder
 *    receives an accurate per-session section.
 * 2. rw_* schemas are hidden from every model. Those legacy tools read the
 *    process-global dsh-rw Session and are the source of cross-session drift.
 * 3. If an old conversation/tool trace still attempts an rw_* call, execution
 *    is blocked before the upstream tool can touch the wrong host.
 *
 * The upstream native shim remains enabled. Its own activeTarget() already uses
 * exec.agent.session.header.cwd and placeholder metadata as the authoritative
 * slow path, so native tools keep working in Remote Workspaces while real local
 * paths pass through untouched.
 */
export function installRemoteWorkspaceSessionSafety(ctx: any): void {
  ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly: any, context: any, next: () => Promise<any>) => {
    const resolved = await next()
    const cwd = cwdFromAgentLike(context)
    const meta = remoteWorkspaceFromCwd(cwd)

    const sections = Array.isArray(resolved?.sections)
      ? resolved.sections.flatMap((section: any) => {
          if (section?.name !== 'dsh-rw') return [section]
          return meta === null ? [] : [{ ...section, text: remotePrompt(meta) }]
        })
      : resolved?.sections

    const tools = Array.isArray(resolved?.tools)
      ? resolved.tools.filter((tool: any) => typeof tool?.name !== 'string' || !tool.name.startsWith('rw_'))
      : resolved?.tools

    return { ...resolved, sections, tools }
  }), 'dsh-ssh-files-sidebar: session-safe dsh-rw prompt/tools')

  // Register before/alongside the dsh-rw shim. Returning a result without
  // calling next() prevents the legacy global-session tool from executing.
  ctx.effect(() => ctx.on('tools/execute', async (exec: any, next: () => Promise<any>) => {
    if (typeof exec?.name !== 'string' || !exec.name.startsWith('rw_')) return await next()
    const cwd = cwdFromAgentLike(exec)
    return blockedRwResult(cwd, remoteWorkspaceFromCwd(cwd))
  }), 'dsh-ssh-files-sidebar: block legacy global rw tools')
}
