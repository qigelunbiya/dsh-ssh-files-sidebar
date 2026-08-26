import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']
const CSS_VIRTUAL_PREFIX = '\0dsh-ssh-files-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const inlineCssModulesPlugin = {
  name: 'dsh-ssh-files-sidebar:inline-css-modules',
  resolveId(source: string, importer?: string) {
    if (!source.endsWith('.module.css') || importer === undefined) return null
    const importerPath = importer.split('?')[0] ?? importer
    const physical = resolve(dirname(importerPath), source)
    return CSS_VIRTUAL_PREFIX + physical + CSS_VIRTUAL_SUFFIX
  },
  async load(id: string) {
    if (!id.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const physical = id.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    this.addWatchFile(physical)
    const source = await readFile(physical)
    const { code, exports: cssExports } = transform({
      filename: physical.replace(/\\/g, '/'),
      code: source,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, value] of Object.entries(cssExports ?? {})) classMap[local] = value.name
    const styleId = `dsh-ssh-files-sidebar:${physical.replace(/\\/g, '/')}`
    return [
      `const css = ${JSON.stringify(code.toString())};`,
      `const styleId = ${JSON.stringify(styleId)};`,
      "if (typeof document !== 'undefined' && document.querySelector('style[data-dsh-ssh-files-css=' + JSON.stringify(styleId) + ']') === null) {",
      "  const tag = document.createElement('style');",
      "  tag.dataset.plugin = 'dsh-ssh-files-sidebar';",
      '  tag.dataset.dshSshFilesCss = styleId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      `export default ${JSON.stringify(classMap)};`,
    ].join('\n')
  },
}

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: CLIENT_EXTERNALS,
    noExternal: (id: string) => CLIENT_EXTERNALS.includes(id) ? undefined : true,
    plugins: [inlineCssModulesPlugin],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-ssh-files-sidebar", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
] satisfies UserConfig[]
