import { Component, type ErrorInfo, type ReactNode } from 'react'
import type { PanelController } from './ssh-panel-bridge.js'

interface Props {
  controller: PanelController
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Keep runtime integration failures visible. A React render exception used to
 * leave Harness with its conversation hidden and an all-white SSH pane, which
 * made the actual cause impossible to see from the UI.
 */
export class EmbeddedSshErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[dsh-ssh-files-sidebar] embedded SSH panel render failed', error, info)
  }

  render(): ReactNode {
    const error = this.state.error
    if (error === null) return this.props.children

    return (
      <div style={{ padding: 20, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', color: 'inherit' }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>SSH 面板加载失败</div>
        <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, opacity: .8, marginBottom: 14 }}>
          {error.stack || error.message || String(error)}
        </div>
        <button
          type="button"
          onClick={() => { this.props.controller.close() }}
          style={{ border: '1px solid rgba(128,128,128,.35)', borderRadius: 7, background: 'transparent', color: 'inherit', padding: '6px 10px', cursor: 'pointer' }}
        >
          关闭 SSH 面板
        </button>
      </div>
    )
  }
}
