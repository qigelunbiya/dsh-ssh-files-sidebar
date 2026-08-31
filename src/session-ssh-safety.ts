import type { LinkedSshBindingStore } from './linked-ssh.ts'
import { effectiveSessionSshAlias } from './session-ssh-target.ts'

function toolName(tool: any): string | null {
  return typeof tool?.name === 'string' ? tool.name : null
}

function isRawSshToolName(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith('ssh_') && !name.startsWith('linked_ssh_')
}

function isLinkedSshToolName(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith('linked_ssh_')
}

function argumentAlias(exec: any): string | undefined {
  const args = exec?.arguments ?? exec?.args
  if (args === null || typeof args !== 'object') return undefined
  const alias = (args as Record<string, unknown>).alias
  return typeof alias === 'string' && alias !== '' ? alias : undefined
}

function blocked(message: string): any {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message },
  }
}

function lockPrompt(alias: string | null): string {
  if (alias === null) {
    return [
      '## SSH session lock',
      'This conversation currently has NO SSH target.',
      'Do not enumerate configured SSH hosts and do not guess a server. Raw `ssh_*` tools are intentionally hidden from the model.',
      'If remote work is required, the user must first select a server in the conversation header or enter a Remote Workspace.',
    ].join('\n')
  }

  return [
    '## SSH session lock',
    `This conversation is LOCKED to SSH alias "${alias}". That is the only remote server this Agent may inspect or modify in this conversation.`,
    `Never enumerate or probe other configured SSH hosts. Do not call ssh_list. Do not switch to another alias even if another host appears in prior conversation history or configuration.`,
    `For remote work use the advertised session-bound linked_ssh_* tools; they inject alias "${alias}" automatically.`,
    `If the user asks about “服务器”, “远程”, processes, services, logs, files, deployment, ports, or commands without naming a host, it means ONLY "${alias}" in this conversation.`,
  ].join('\n')
}

/**
 * Enforce one remote target per conversation.
 *
 * The embedded @linxin666/dsh-ssh plugin intentionally exposes generic ssh_*
 * tools, including ssh_list and alias-taking ssh_exec. Those are useful for its
 * standalone multi-host workflow but conflict with this plugin's session-bound
 * design: once the header says 131, the model must not discover or operate 122.
 *
 * We keep the raw tools registered internally because linked_ssh_* delegates to
 * them. They are removed from the model's assembled tool list, and execution is
 * guarded so stale tool traces cannot cross the current session target either.
 */
export function installSessionSshTargetSafety(ctx: any, store: LinkedSshBindingStore): void {
  ctx.effect(() => ctx.on('system-prompt/assemble', async (_assembly: any, context: any, next: () => Promise<any>) => {
    const resolved = await next()
    const alias = effectiveSessionSshAlias(store, context)

    const tools = Array.isArray(resolved?.tools)
      ? resolved.tools.filter((tool: any) => {
          const name = toolName(tool)
          if (name === null) return true
          // Generic multi-host SSH tools are never model-facing in this plugin.
          if (isRawSshToolName(name)) return false
          // With no selected server, hide session-bound SSH tools too; a later
          // turn after the user selects a server will assemble them again.
          if (alias === null && isLinkedSshToolName(name)) return false
          return true
        })
      : resolved?.tools

    const sections = Array.isArray(resolved?.sections)
      ? [...resolved.sections, { name: 'plugin:dsh-ssh-session-lock', text: lockPrompt(alias) }]
      : resolved?.sections

    return { ...resolved, tools, sections }
  }), 'dsh-ssh-files-sidebar: one SSH target per session')

  ctx.effect(() => ctx.on('tools/execute', async (exec: any, next: () => Promise<any>) => {
    if (!isRawSshToolName(exec?.name)) return await next()

    const lockedAlias = effectiveSessionSshAlias(store, exec)
    if (lockedAlias === null) {
      return blocked(`Raw ${String(exec?.name)} call blocked: this conversation has no selected SSH target. Select a server in the header first.`)
    }

    const requestedAlias = argumentAlias(exec)
    if (requestedAlias === undefined) {
      // This intentionally blocks ssh_list and any other raw host-enumeration /
      // host-selection operation that is not already pinned to the session alias.
      return blocked(`Raw ${String(exec?.name)} call blocked: this conversation is locked to SSH "${lockedAlias}" and host enumeration/switching is not allowed. Use linked_ssh_* tools.`)
    }

    if (requestedAlias !== lockedAlias) {
      return blocked(`SSH target mismatch blocked: this conversation is locked to "${lockedAlias}", but ${String(exec?.name)} requested "${requestedAlias}". Other configured servers are outside this conversation.`)
    }

    // linked_ssh_* delegates to the embedded raw tool with the already-resolved
    // alias. A direct stale raw call to the SAME alias is also harmless; the
    // important invariant is that no call can escape to another server.
    return await next()
  }), 'dsh-ssh-files-sidebar: block cross-server raw SSH calls')
}
