import { useEffect, useState } from 'react'
import {
  ClusterTab,
  HostsTab,
  TransferTab,
  TunnelsTab,
  panelCss as css,
  tt,
  type PanelController,
  type SshApi,
} from './ssh-panel-bridge.js'
import { LinkedTerminalTab } from './LinkedTerminalTab.tsx'
import { subscribeLinkedTerminal } from './linked-terminal-bridge.ts'

type SshTab = 'hosts' | 'terminal' | 'transfer' | 'tunnels' | 'cluster'

interface ConnectRequest {
  alias: string
  nonce: number
  autoConnect: boolean
}

interface EmbeddedSshPanelProps {
  controller: PanelController
  api: SshApi
}

const TABS: ReadonlyArray<{ id: SshTab; label: () => string }> = [
  { id: 'hosts', label: () => tt('tab.hosts') },
  { id: 'terminal', label: () => tt('tab.terminal') },
  { id: 'transfer', label: () => tt('tab.transfer') },
  { id: 'tunnels', label: () => tt('tab.tunnels') },
  { id: 'cluster', label: () => tt('tab.cluster') },
]

/**
 * The upstream SSH panel plus one integration bridge. Linked SSH can open the
 * panel at Terminal with its session alias already selected/connected. The
 * bridge retains the latest request, so a click is not lost if the panel React
 * tree is being mounted or remounted at that exact moment.
 */
export function EmbeddedSshPanel({ controller, api }: EmbeddedSshPanelProps) {
  const [activeTab, setActiveTab] = useState<SshTab>('hosts')
  const [connectRequest, setConnectRequest] = useState<ConnectRequest | null>(null)

  const requestTerminal = (alias: string, autoConnect: boolean, nonce?: number): void => {
    setActiveTab('terminal')
    setConnectRequest(previous => ({
      alias,
      autoConnect,
      nonce: nonce ?? ((previous?.nonce ?? 0) + 1),
    }))
    controller.open()
  }

  useEffect(() => subscribeLinkedTerminal(request => {
    requestTerminal(request.alias, request.autoConnect, request.nonce)
  }), [controller])

  const handleConnect = (alias: string): void => {
    requestTerminal(alias, false)
  }

  return (
    <div className={css.panel}>
      <div className={css.panelHeader}>
        <h2 className={css.panelTitle}>{tt('panel.title')}</h2>
        <button type="button" className={css.iconButton} title="关闭" aria-label="关闭" onClick={() => { controller.close() }}>x</button>
      </div>
      <div className={css.tabBar} role="tablist">
        {TABS.map(tab => (
          <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} data-active={activeTab === tab.id ? '' : undefined} className={css.tab} onClick={() => { setActiveTab(tab.id) }}>
            {tab.label()}
          </button>
        ))}
      </div>
      <div className={css.panelContent}>
        {activeTab === 'hosts' && <HostsTab api={api} onConnect={handleConnect} />}
        {activeTab === 'terminal' && (
          <LinkedTerminalTab
            api={api}
            presetAlias={connectRequest?.alias}
            requestId={connectRequest?.nonce}
            autoConnect={connectRequest?.autoConnect ?? false}
          />
        )}
        {activeTab === 'transfer' && <TransferTab api={api} />}
        {activeTab === 'tunnels' && <TunnelsTab api={api} />}
        {activeTab === 'cluster' && <ClusterTab api={api} />}
      </div>
    </div>
  )
}
