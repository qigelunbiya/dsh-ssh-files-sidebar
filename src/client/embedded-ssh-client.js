// Runtime-only bridge. Keeping this file as plain JS prevents our declaration-only
// TypeScript pass from type-checking the dependency's source tree with our stricter
// compiler options. tsdown still follows and bundles the source at runtime build.
export { apply } from '@linxin666/dsh-ssh/src/client/index.ts'
