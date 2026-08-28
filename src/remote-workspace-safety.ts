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
const LOCAL_GENERAL_TOOL_NAMES = ['read', 'write', 'edit', 'str_replace_editor', 'glob', 'grep', 'pwsh', 'bash'] as const
const REMOTE_SHIM_TOOL_NAMES = ['read', 'write', 'edit', 'str_replace_editor', 'glob', 'grep', 'bash'] as const

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

function toolNamesFromSchemas(schemas: unknown): string[] {
  if (!Array.isArray(schemas)) return []
  return schemas
    .map((tool: any) => typeof tool?.name === 'string' ? tool.name : null)
    .filter((name: string | null): name is string => name !== null)
}

function exactNames(visibleNames: readonly string[], candidates: readonly string[]): string[] {
  const visible = new Set(visibleNames)
  return candidates.filter(name => visible.has(name))
}

function quotedNames(names: readonly string[]): string {
  return names.map(name => `\`${name}\``).join(', ')
}

function localPrompt(cwd: string | undefined, visibleNames: readonly string[]): string {
  const localGeneral = exactNames(visibleNames, LOCAL_GENERAL_TOOL_NAMES)
  const guidance = localGeneral.length > 0
    ? `General local file/shell tools actually advertised to this agent include: ${quotedNames(localGeneral)}. Use only names that are present in the current tool list.`
    : 'This agent preset currently advertises no general local file/shell tool from `read`, `write`, `edit`, `str_replace_editor`, `glob`, `grep`, `pwsh`, or `bash`. Do not invent one; use another tool that is actually advertised, or explain the limitation.'
  return [
    '## Local workspace (session-safe)',
    `This conversation is local-backed${cwd ? ` at ${cwd}` : ''}. It is NOT a dsh-rw Remote Workspace.`,
    'Ignore any earlier rw_* calls, remote-workspace status, or remote cwd claims in conversation history; they do not apply to this conversation cwd.',
    guidance,
    'Tool names are case-sensitive. Call exact lowercase names such as `read`, `glob`, or `pwsh` only when those exact names are advertised. Never invent TitleCase aliases such as `Read`, `Glob`, `Pwsh`, or `Bash`.',
    'Legacy `rw_*` tools are intentionally unavailable because their upstream target is process-global. If this local conversation intentionally links an SSH server, use the session-bound `linked_ssh_*` tools for that remote work while keeping ordinary local tools local.',
  ].join('\n')
}

function remotePrompt(meta: RwPlaceholderMeta, visibleNames: readonly string[]): string {
  const shimTools = exactNames(visibleNames, REMOTE_SHIM_TOOL_NAMES)
  const guidance = shimTools.length > 0
    ? `Native tools actually advertised and eligible for dsh-rw cwd routing include: ${quotedNames(shimTools)}.`
    : 'No native dsh-rw-shimmable file/shell tool is currently advertised by this agent preset; do not invent one.'
  return [
    '## Remote workspace (session-safe)',
    `This conversation is remote-backed: ${meta.user}@${meta.host}:${meta.port} (alias: ${meta.alias}), workspace ${meta.remotePath}.`,
    'The conversation cwd is a dsh-rw placeholder; the remote filesystem is the source of truth.',
    guidance,
    'Use only exact tool names present in the current tool list. Tool names are case-sensitive and lowercase; never call invented aliases such as `Read`, `Glob`, `Pwsh`, or `Bash`.',
    'The Windows-local `pwsh` tool is not a remote-shell route. For remote shell work use an advertised `bash` route when present, or an explicit SSH/Linked-SSH command tool appropriate to the current target.',
    'Legacy `rw_*` tools are intentionally hidden/blocked because dsh-rw 0.4.x stores their target in one process-global session and can drift across conversations. Do not call `rw_*` tools.',
  ].join('\n')
}

function currentVisibleToolNames(ctx: any, agent: any): string[] {
  try {
    if (typeof ctx?.tools?.schemas !== 'function') return []
    return toolNamesFromSchemas(ctx.tools.schemas(agent))
  } catch {
    return []
  }
}

function blockedRwResult(cwd: string | undefined, meta: RwPlaceholderMeta | null, visibleNames: readonly string[]): any {
  const candidates = exactNames(visibleNames, meta === null ? LOCAL_GENERAL_TOOL_NAMES : REMOTE_SHIM_TOOL_NAMES)
  const replacement = candidates.length > 0
    ? `Available exact replacement tool names include ${quotedNames(candidates)}.`
    : 'No general replacement file/shell tool is currently advertised by this agent preset; do not invent one. Use another advertised tool or explain the limitation.'
  const message = meta === null
    ? `Legacy rw_* call blocked in local workspace${cwd ? ` (${cwd})` : ''}. ${replacement} Tool names are case-sensitive; do not call Read/Glob/Pwsh/Bash unless those exact names really exist. Use linked_ssh_* only for an explicitly linked remote server.`
    : `Legacy rw_* call blocked because its upstream target is process-global and unsafe across conversations. This conversation is already a Remote Workspace on ${meta.alias}:${meta.remotePath}. ${replacement} Use the exact advertised lowercase native/SSH tool instead.`
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
 * 1. Prompt assembly is rewritten from the ACTUAL conversation cwd. Every
 *    conversation gets an explicit LOCAL or REMOTE fact that supersedes stale
 *    tool history from another workspace.
 * 2. rw_* schemas are hidden from every model. Those legacy tools read the
 *    process-global dsh-rw Session and are the source of cross-session drift.
 * 3. If an old conversation/tool trace still attempts an rw_* call, execution
 *    is blocked before the upstream tool can touch the wrong host and the error
 *    names only tools that are actually visible to that Agent.
 *
 * The upstream native shim remains enabled. Its own activeTarget() already uses
 * exec.agent.session.header.cwd and placeholder metadata as the authoritative
 * path, so native tools keep working in Remote Workspaces while real local
 * paths pass through untouched.
 */
export function installRemoteWorkspaceSessionSafety(ctx: any): void {
  ctx.effect(() => ctx.on('system-prompt/assemble', async (_assembly: any, context: any, next: () => Promise<any>) => {
    const resolved = await next()
    const cwd = cwdFromAgentLike(context)
    const meta = remoteWorkspaceFromCwd(cwd)
    const tools = Array.isArray(resolved?.tools)
      ? resolved.tools.filter((tool: any) => typeof tool?.name !== 'string' || !tool.name.startsWith('rw_'))
      : resolved?.tools
    const visibleNames = toolNamesFromSchemas(tools)
    const replacementText = meta === null ? localPrompt(cwd, visibleNames) : remotePrompt(meta, visibleNames)

    let replaced = false
    const sections = Array.isArray(resolved?.sections)
      ? resolved.sections.map((section: any) => {
          if (section?.name !== 'dsh-rw') return section
          replaced = true
          return { ...section, text: replacementText }
        })
      : resolved?.sections

    if (Array.isArray(sections) && !replaced) sections.push({ name: 'dsh-rw', text: replacementText })
    return { ...resolved, sections, tools }
  }), 'dsh-ssh-files-sidebar: session-safe dsh-rw prompt/tools')

  // Register before/alongside the dsh-rw shim. Returning a result without
  // calling next() prevents the legacy global-session tool from executing.
  ctx.effect(() => ctx.on('tools/execute', async (exec: any, next: () => Promise<any>) => {
    if (typeof exec?.name !== 'string' || !exec.name.startsWith('rw_')) return await next()
    const cwd = cwdFromAgentLike(exec)
    const meta = remoteWorkspaceFromCwd(cwd)
    return blockedRwResult(cwd, meta, currentVisibleToolNames(ctx, exec?.agent))
  }), 'dsh-ssh-files-sidebar: block legacy global rw tools')
}
