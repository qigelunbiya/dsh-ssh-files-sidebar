import { apply as applySsh } from '@linxin666/dsh-ssh'
import { apply as applyRemoteWorkspace } from 'dsh-rw'
import { SharedDshSshHostTable } from './shared-hosts.ts'

export const name = 'dsh-ssh-files-sidebar'

/** Both embedded host halves need these services. */
export const inject = ['tools', 'systemPrompt', 'webServer']

/**
 * Host half of the integrated plugin.
 *
 * Important: @linxin666/dsh-ssh is NOT a second Cordis loader row. DSH resolves
 * loader-row package names from the profile root, while this package is used via
 * link: during development and its transitive dependencies live beside the
 * linked package. Mounting the SSH plugin programmatically keeps the whole stack
 * inside one resolvable top-level row and still registers the original routes,
 * tools, settings section and connection pool.
 *
 * dsh-rw is then mounted in the same fiber with a HostTable adapter over the
 * SAME ~/.dsh/dsh-ssh.json file, so SSH credentials are configured only once.
 */
export function apply(ctx: any): void {
  // Original dsh-ssh host capabilities: host manager backend, /api/dsh-ssh/*,
  // SSH agent tools, terminal websocket, tunnels and system-prompt guidance.
  applySsh(ctx, { enabled: true, announceToAgent: true })

  // Remote workspace + native Read/Write/Edit/Glob/Grep/Bash shim, sharing the
  // dsh-ssh host store instead of maintaining a second SSH configuration.
  const hosts = new SharedDshSshHostTable()
  const config = {
    hostKeyPolicy: 'accept-new',
    knownHostsPath: '',
    commandTimeoutMs: 30_000,
    connectTimeoutMs: 15_000,
    channelOpenTimeoutMs: 10_000,
    maxOutputChars: 200_000,
    shim: true,
    shimBash: true,
    shimBashApproval: 'ask',
  }

  applyRemoteWorkspace(ctx, config as any, { hosts } as any)
}
