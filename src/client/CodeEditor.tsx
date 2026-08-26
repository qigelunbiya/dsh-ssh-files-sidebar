import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from '@codemirror/search'
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { go } from '@codemirror/lang-go'
import { rust } from '@codemirror/lang-rust'
import { xml } from '@codemirror/lang-xml'

export interface CodeEditorHandle {
  focus(): void
  openSearch(): void
}

interface CodeEditorProps {
  path: string
  value: string
  onChange: (value: string) => void
  onSave: () => void | Promise<void>
}

function extensionOf(path: string): string {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  if (name === 'dockerfile' || name === 'makefile' || name.startsWith('.env')) return name.replace(/^\./, '')
  const dot = name.lastIndexOf('.')
  return dot < 0 ? name.replace(/^\./, '') : name.slice(dot + 1)
}

function languageExtension(path: string) {
  const ext = extensionOf(path)
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return javascript({ jsx: ext === 'jsx' })
  if (['ts', 'tsx'].includes(ext)) return javascript({ typescript: true, jsx: ext === 'tsx' })
  if (['py', 'pyw', 'pyi'].includes(ext)) return python()
  if (['json', 'jsonc'].includes(ext)) return json()
  if (['html', 'htm'].includes(ext)) return html()
  if (['css', 'scss', 'less'].includes(ext)) return css()
  if (['md', 'markdown'].includes(ext)) return markdown()
  if (['yaml', 'yml'].includes(ext)) return yaml()
  if (['sql'].includes(ext)) return sql()
  if (['c', 'h', 'cc', 'cpp', 'cxx', 'hpp'].includes(ext)) return cpp()
  if (ext === 'java') return java()
  if (ext === 'go') return go()
  if (ext === 'rs') return rust()
  if (['xml', 'svg'].includes(ext)) return xml()
  return []
}

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(props, forwardedRef) {
  const { path, value, onChange, onSave } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const syncingRef = useRef(false)

  onChangeRef.current = onChange
  onSaveRef.current = onSave

  useImperativeHandle(forwardedRef, () => ({
    focus: () => viewRef.current?.focus(),
    openSearch: () => {
      const view = viewRef.current
      if (view !== null) {
        openSearchPanel(view)
        view.focus()
      }
    },
  }), [])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        EditorState.tabSize.of(2),
        EditorView.lineWrapping,
        EditorView.updateListener.of(update => {
          if (update.docChanged && !syncingRef.current) onChangeRef.current(update.state.doc.toString())
        }),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              void onSaveRef.current()
              return true
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        languageExtension(path),
        EditorView.theme({
          '&': { height: '100%', backgroundColor: 'transparent', color: 'inherit', fontSize: '12px' },
          '.cm-scroller': {
            overflow: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            lineHeight: '1.55',
          },
          '.cm-gutters': { backgroundColor: 'transparent', color: 'rgba(128,128,128,.8)', border: 'none' },
          '.cm-activeLine': { backgroundColor: 'rgba(128,128,128,.08)' },
          '.cm-activeLineGutter': { backgroundColor: 'rgba(128,128,128,.10)' },
          '.cm-search': { backgroundColor: 'var(--color-background, Canvas)', color: 'inherit' },
        }),
      ],
    })

    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [path])

  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const current = view.state.doc.toString()
    if (current === value) return
    syncingRef.current = true
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    syncingRef.current = false
  }, [value])

  return <div ref={hostRef} style={{ height: '100%', minHeight: 0, width: '100%', overflow: 'hidden' }} />
})
