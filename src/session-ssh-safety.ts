import type { LinkedSshBindingStore } from './linked-ssh.ts'
import { effectiveSessionSshAlias } from './session-ssh-target.ts'

/** Raw multi-host tools registered by @linxin666/dsh-ssh 0.3.x. */
const RAW_SSH_TOOL_NAMES = [
  'ssh_list',
  'ssh_exec',
  'ssh_upload',
  'ssh_download',
  'ssh_tunnel',
  'ssh_cluster',
] as const

function isRawSshToolName(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith('ssh_') && !name.startsWith('linked_ssh_')
}

function lockPrompt(alias: string | null): string {
  if (alias === null) {
    return [
      '## SSH session lock',
      'This conversation currently has NO SSH target.',
      'The generic multi-host ssh_* surface is unavailable. Do not enumerate configured SSH hosts and do not guess a server.',
      'If remote work is required, the user must first select a server in the conversation header or enter a Remote Workspace.',
    ].join('\n')
  }

  return [
    '## SSH session lock',
    `This conversation is LOCKED to SSH alias "${alias}". That is the ONE AND ONLY remote server this Agent may inspect or modify in this conversation.`,
    'Other configured SSH hosts are outside this conversation even if their aliases/IPs appear in old chat history, configuration, or previous tool results.',
    'Never enumerate configured SSH hosts. Never call ssh_list. Never choose or probe another alias.',
    `For remote work use only the advertised session-bound linked_ssh_* tools; they inject "${alias}" automatically and expose no alias selector to the model.`,
    `When the user says “服务器”, “远程”, processes, services, logs, files, deployment, ports, or commands without naming a host, it means ONLY "${alias}" in this conversation.`,
    'If the user wants another server, they must switch the conversation header/Remote Workspace first; do not switch servers on their behalf inside a tool call.',
  ].join('\n')
}

/**
 * Enforce one remote target per conversation using ToolRuntime's native
 * security/visibility primitives rather than relying on prompt-assembly edits.
 *
 * @linxin666/dsh-ssh must stay enabled because its routes, terminal, SFTP and
 * host store power the UI. While enabled it also registers generic multi-host
 * model tools (ssh_list/ssh_exec/...). Those tools conflict with this plugin's
 * session-bound contract, so every Agent receives a scoped tools.restrict()
 * deny-mask for the raw SSH names.
 *
 * The restriction is authoritative for BOTH model presentation and dispatch.
 * A global monotonic tools.guard() is the second boundary: stale history or a
 * hand-crafted call cannot execute any raw ssh_* body even if presentation is
 * bypassed. linked_ssh_* no longer delegates through ToolRuntime raw tools; it
 * talks to SshEngine directly, so denying every raw call is safe.
 */
export function installSessionSshTargetSafety(ctx: any, store: LinkedSshBindingStore): void {
  const restrictions = new Map<any, () => void>()

  const protectAgent = (agent: any): void => {
    if (agent === null || typeof agent !== 'object' || restrictions.has(agent)) return

    // tools.restrict() rejects unknown names, so materialize only raw tools that
    // are actually registered in this runtime. The embedded dsh-ssh 0.3.4
    // contributes all six, while this keeps the fence forward/back compatible.
    const deny = RAW_SSH_TOOL_NAMES.filter(name => ctx.tools.get(name) !== undefined)
    if (deny.length === 0) return

    const dispose = agent.ctx.tools.restrict({ deny })
    restrictions.set(agent, dispose)
  }

  // The plugin may be loaded/reloaded after one or more sessions already exist.
  // Protect those immediately instead of waiting for the next agent lifecycle.
  ctx.effect(() => {
    const agents = typeof ctx?.agents?.list === 'function' ? ctx.agents.list() : []
    for (const agent of agents) protectAgent(agent)
    return () => {
      for (const dispose of restrictions.values()) {
        try { dispose() } catch { /* scope may already be disposed */ }
      }
      restrictions.clear()
    }
  }, 'dsh-ssh-files-sidebar: restrict existing agents from raw SSH tools')

  // Every future conversation gets the same scoped restriction before its first
  // normal turn. Agent.ctx is the official scope for ToolRuntime restrictions.
  ctx.effect(() => ctx.on('agent/created', ({ agent }: any) => {
    protectAgent(agent)
  }), 'dsh-ssh-files-sidebar: restrict new agents from raw SSH tools')

  ctx.effect(() => ctx.on('agent/disposed', ({ agent }: any) => {
    // Agent scope teardown owns the restriction contribution. Just forget the
    // disposer so plugin cleanup never tries to touch a dead scope.
    restrictions.delete(agent)
  }), 'dsh-ssh-files-sidebar: forget disposed SSH restrictions')

  // Monotonic dispatch guard: unlike an around-listener this cannot be undone
  // by listener ordering. Raw multi-host SSH execution is simply not a valid
  // capability while this integrated plugin owns session routing.
  ctx.effect(() => ctx.tools.guard((exec: any) => {
    if (!isRawSshToolName(exec?.name)) return undefined
    const alias = effectiveSessionSshAlias(store, exec)
    if (alias === null) {
      return `Raw ${String(exec?.name)} is disabled: this conversation has no SSH target. Select a server in the header first.`
    }
    return `Raw ${String(exec?.name)} is disabled: this conversation is locked to SSH "${alias}". Use the corresponding linked_ssh_* capability; host enumeration and alias switching are forbidden.`
  }), 'dsh-ssh-files-sidebar: hard-deny raw multi-host SSH dispatch')

  // Prompt text is now explanatory only. Enforcement lives in restrict()+guard,
  // so a model cannot escape the boundary by ignoring prose.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-ssh-session-lock',
    order: 150,
    text: (context: any) => lockPrompt(effectiveSessionSshAlias(store, context)),
  }), 'dsh-ssh-files-sidebar: one SSH target per session prompt')
}
