// Runtime-only bridge for @linxin666/dsh-ssh's browser internals.
//
// Our declaration-only TypeScript pass must not crawl the dependency's TSX
// sources: the dependency is compiled with different strictness and owns its
// CSS-module declarations inside its own build. tsdown still follows these
// imports at runtime-bundle time, where our CSS-module plugin handles them.
export { SshApi } from '@linxin666/dsh-ssh/src/client/api.ts'
export { en, zh } from '@linxin666/dsh-ssh/src/client/locales.ts'
export { PanelController } from '@linxin666/dsh-ssh/src/client/panel/controller.ts'
export { mountSidebarEntry } from '@linxin666/dsh-ssh/src/client/sidebar-entry.ts'
export { tt, errorMessage } from '@linxin666/dsh-ssh/src/client/panel/helpers.ts'
export { ClusterTab } from '@linxin666/dsh-ssh/src/client/panel/ClusterTab.tsx'
export { HostsTab } from '@linxin666/dsh-ssh/src/client/panel/HostsTab.tsx'
export { TransferTab } from '@linxin666/dsh-ssh/src/client/panel/TransferTab.tsx'
export { TunnelsTab } from '@linxin666/dsh-ssh/src/client/panel/TunnelsTab.tsx'
export { XTERM_CSS } from '@linxin666/dsh-ssh/src/client/panel/xterm.css.ts'
export { default as panelCss } from '@linxin666/dsh-ssh/src/client/panel/panel.module.css'
