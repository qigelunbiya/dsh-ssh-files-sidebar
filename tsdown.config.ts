import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

// Keep the same browser module-table externals that dsh-better-sidebar 0.16.1
// uses itself. Everything else (including both embedded plugin client sources)
// is bundled into this package's one client.js.
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]
const CSS_VIRTUAL_PREFIX = '\0dsh-ssh-files-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const require = createRequire(import.meta.url)

// Our own UI used CSS modules only, while the embedded Better Sidebar core also
// imports a plain layout.css. Handle both forms here so its browser half can be
// compiled into this plugin instead of requiring a second client loader row.
const inlineCssPlugin = {
  name: 'dsh-ssh-files-sidebar:inline-css',
  resolveId(source: string, importer?: string) {
    if (!source.endsWith('.css') || importer === undefined) return null
    const importerPath = importer.split('?')[0] ?? importer
    // Relative CSS belongs beside its importer; bare package subpaths must go
    // through Node's resolver so pnpm's virtual-store location is respected.
    const physical = source.startsWith('.') || source.startsWith('/')
      ? resolve(dirname(importerPath), source)
      : require.resolve(source, { paths: [dirname(importerPath), process.cwd()] })
    return CSS_VIRTUAL_PREFIX + physical + CSS_VIRTUAL_SUFFIX
  },
  async load(id: string) {
    if (!id.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const physical = id.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    this.addWatchFile(physical)
    const source = await readFile(physical)
    const styleId = `dsh-ssh-files-sidebar:${physical.replace(/\\/g, '/')}`

    if (physical.endsWith('.module.css')) {
      const { code, exports: cssExports } = transform({
        filename: physical.replace(/\\/g, '/'),
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, value] of Object.entries(cssExports ?? {})) classMap[local] = value.name
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
    }

    return [
      `const css = ${JSON.stringify(source.toString('utf8'))};`,
      `const styleId = ${JSON.stringify(styleId)};`,
      "if (typeof document !== 'undefined' && document.querySelector('style[data-dsh-ssh-files-css=' + JSON.stringify(styleId) + ']') === null) {",
      "  const tag = document.createElement('style');",
      "  tag.dataset.plugin = 'dsh-ssh-files-sidebar';",
      '  tag.dataset.dshSshFilesCss = styleId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      'export default "";',
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
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      'import.meta.resolve': 'undefined',
    },
    noExternal: (id: string) => CLIENT_EXTERNALS.includes(id) ? undefined : true,
    plugins: [inlineCssPlugin],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-ssh-files-sidebar", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
] satisfies UserConfig[]
