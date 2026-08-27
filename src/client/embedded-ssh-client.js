// Runtime-only bridge. Keeping this file as plain JS prevents our declaration-only
// TypeScript pass from type-checking the dependency's source tree with our stricter
// compiler options. tsdown still follows and bundles the source at runtime build.
import { SshApi } from '@linxin666/dsh-ssh/src/client/api.ts'
import { en, zh } from '@linxin666/dsh-ssh/src/client/locales.ts'
import { PanelController } from '@linxin666/dsh-ssh/src/client/panel/controller.ts'
import { mountSidebarEntry } from '@linxin666/dsh-ssh/src/client/sidebar-entry.ts'
import { mountEmbeddedSshPanel } from './EmbeddedSshMount.tsx'

const NS = 'dsh-ssh'

/**
 * Original dsh-ssh browser surfaces with one integration seam: our panel can
 * receive the current session's Linked SSH target and open Terminal directly.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ssh: dictionaries')

  const controller = new PanelController()
  const api = new SshApi()
  const disposers = []
  try {
    disposers.push(mountSidebarEntry(controller))
    disposers.push(mountEmbeddedSshPanel(controller, api))
  } catch (error) {
    console.warn('[dsh-ssh] mount failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-ssh: ui mounts')
}
