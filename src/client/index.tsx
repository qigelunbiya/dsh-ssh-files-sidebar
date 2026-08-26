import { RemoteFilesTab } from './RemoteFilesTab.tsx'

export const inject = ['betterSidebar']

export function apply(ctx: any): void {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'dsh-ssh-files-sidebar:files',
    title: 'SSH Files',
    order: 15,
    single: true,
    component: ({ scope }: any) => <RemoteFilesTab sessionId={scope?.sessionId ?? 'global'} />,
  }), 'dsh-ssh-files-sidebar: register tab')
}
