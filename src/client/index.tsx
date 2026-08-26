import { apply as applySshClient } from '@linxin666/dsh-ssh/src/client/index.ts'
import { RemoteFilesTab, remoteWorkspaceAliasFromCwd } from './RemoteFilesTab.tsx'
import { registerWorkspaceDirectoryFlow } from './WorkspaceDirectoryFlow.tsx'

// We compose the original dsh-ssh browser UI inside this one client plugin, so
// wait for the services needed by both dsh-ssh and our better-sidebar/workspace UI.
export const inject = ['betterSidebar', 'slots', 'locale']

export function apply(ctx: any): void {
  // Original dsh-ssh browser surfaces: left SSH entry + center host/terminal/
  // transfer/tunnel/cluster panel. This shares the host half mounted by our
  // package root and therefore the same ~/.dsh/dsh-ssh.json configuration.
  applySshClient(ctx)

  // Replace the raw native directory picker entry with an explicit Local /
  // Remote SSH chooser. The Remote tab uses dsh-rw's workspace route, mounted
  // by this same package's host half.
  registerWorkspaceDirectoryFlow(ctx)

  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'dsh-ssh-files-sidebar:files',
    title: 'SSH Files',
    order: 15,
    single: true,
    // Do not offer SSH Files in local workspaces. dsh-rw remote workspaces are
    // represented by ~/.dsh/remote-workspaces/<alias>/<workspace> placeholders.
    available: (_ctx: any, scope: any) => remoteWorkspaceAliasFromCwd(scope?.cwd) !== null,
    component: ({ scope }: any) => (
      <RemoteFilesTab
        sessionId={scope?.sessionId ?? 'global'}
        workspaceCwd={scope?.cwd}
      />
    ),
  }), 'dsh-ssh-files-sidebar: register tab')
}
