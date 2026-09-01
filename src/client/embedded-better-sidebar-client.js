// Runtime-only bridge. Keeping this file as plain JS prevents our declaration-only
// TypeScript pass from type-checking dsh-better-sidebar's source tree with this
// project's stricter compiler options. tsdown still follows and bundles the
// upstream 0.16.1 client source into our single browser artifact.
import { apply as applyBetterSidebarClient } from 'dsh-better-sidebar/src/client/index.tsx'

export function apply(ctx) {
  applyBetterSidebarClient(ctx)
}
