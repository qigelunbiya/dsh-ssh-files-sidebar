import { RemoteFilesTab, remoteWorkspaceAliasFromCwd } from './RemoteFilesTab.tsx'
import { registerWorkspaceDirectoryFlow } from './WorkspaceDirectoryFlow.tsx'

export const inject = ['betterSidebar', 'slots']

export function apply(ctx: any): void {
  // Replace the raw native directory picker entry with an explicit Local / Remote SSH chooser.
  // The Remote tab uses dsh-rw's workspace route, which is mounted by this same package's host half.
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
