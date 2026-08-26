import { apply as applyRemoteWorkspace } from 'dsh-rw'
import { SharedDshSshHostTable } from './shared-hosts.ts'

export const name = 'dsh-ssh-files-sidebar'

/** dsh-rw needs these host services for its routes, rw_* tools and native-tool shim. */
export const inject = ['tools', 'systemPrompt', 'webServer']

/**
 * Host half of the integrated plugin.
 *
 * @linxin666/dsh-ssh is activated as a bundled Cordis row by cordis.patch.yml
 * and owns the SSH UI + /api/dsh-ssh routes. Here we mount dsh-rw's remote
 * workspace engine, but replace its HostTable with an adapter over the SAME
 * ~/.dsh/dsh-ssh.json file. Result: hosts/passwords are configured once while
 * remote workspaces still get transparent native Read/Glob/Bash routing.
 */
export function apply(ctx: any): void {
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
