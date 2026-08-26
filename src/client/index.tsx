import type {} from 'dsh-better-sidebar/client/service'
import type { Context } from 'cordis'
import { RemoteFilesTab } from './RemoteFilesTab.tsx'

export const inject = ['betterSidebar']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'dsh-ssh-files-sidebar:files',
    title: 'SSH Files',
    order: 15,
    single: true,
    component: () => <RemoteFilesTab />,
  }), 'dsh-ssh-files-sidebar: register tab')
}
