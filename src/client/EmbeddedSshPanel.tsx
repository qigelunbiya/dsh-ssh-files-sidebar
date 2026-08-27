import { useEffect, useState } from 'react'
import type { SshApi } from '@linxin666/dsh-ssh/src/client/api.ts'
import type { PanelController } from '@linxin666/dsh-ssh/src/client/panel/controller.ts'
import { tt } from '@linxin666/dsh-ssh/src/client/panel/helpers.ts'
import { ClusterTab } from '@linxin666/dsh-ssh/src/client/panel/ClusterTab.tsx'
import { HostsTab } from '@linxin666/dsh-ssh/src/client/panel/HostsTab.tsx'
import { TransferTab } from '@linxin666/dsh-ssh/src/client/panel/TransferTab.tsx'
import { TunnelsTab } from '@linxin666/dsh-ssh/src/client/panel/TunnelsTab.tsx'
import css from '@linxin666/dsh-ssh/src/client/panel/panel.module.css'
import { LinkedTerminalTab } from './LinkedTerminalTab.tsx'

export const OPEN_LINKED_TERMINAL_EVENT = 'dsh-ssh-files-sidebar:open-linked-terminal'

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
 * The upstream SSH panel plus one supported bridge event. Linked SSH can open
 * the panel at Terminal with its session alias already selected/connected,
 * while all original Hosts/Transfer/Tunnel/Cluster behavior remains intact.
 */
export function EmbeddedSshPanel({ controller, api }: EmbeddedSshPanelProps) {
  const [activeTab, setActiveTab] = useState<SshTab>('hosts')
  const [connectRequest, setConnectRequest] = useState<ConnectRequest | null>(null)

  const requestTerminal = (alias: string, autoConnect: boolean): void => {
    setActiveTab('terminal')
    setConnectRequest(previous => ({
      alias,
      autoConnect,
      nonce: (previous?.nonce ?? 0) + 1,
    }))
    controller.open()
  }

  useEffect(() => {
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<{ alias?: unknown; autoConnect?: unknown }>).detail
      const alias = typeof detail?.alias === 'string' ? detail.alias.trim() : ''
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias)) return
      requestTerminal(alias, detail?.autoConnect !== false)
    }
    document.addEventListener(OPEN_LINKED_TERMINAL_EVENT, onOpen)
    return () => document.removeEventListener(OPEN_LINKED_TERMINAL_EVENT, onOpen)
  }, [controller])

  const handleConnect = (alias: string): void => {
    requestTerminal(alias, false)
  }

  return (
    <div className={css.panel}>
      <div className={css.panelHeader}>
        <h2 className={css.panelTitle}>{tt('panel.title')}</h2>
        <button type="button" className={css.iconButton} title={tt('common.close')} aria-label={tt('common.close')} onClick={() => { controller.close() }}>x</button>
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
