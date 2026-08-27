import type { ComponentType } from 'react'

export interface SshHostSummaryBridge {
  alias: string
  host: string
  port: number
  user: string
}

export interface TerminalConnectionBridge {
  onReady?: (() => void) | undefined
  onOutput?: ((data: string) => void) | undefined
  onExit?: ((code?: number, error?: string) => void) | undefined
  send(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}

export class SshApi {
  listHosts(): Promise<SshHostSummaryBridge[]>
  openTerminal(alias: string, cols: number, rows: number): TerminalConnectionBridge
}

export class PanelController {
  getSnapshot(): { panelOpen: boolean }
  subscribe(fn: () => void): () => void
  open(): void
  close(): void
  toggle(): void
}

export function mountSidebarEntry(controller: PanelController): () => void
export function tt(key: string, params?: Record<string, unknown>): string
export function errorMessage(error: unknown): string

export const en: unknown
export const zh: unknown
export const ClusterTab: ComponentType<any>
export const HostsTab: ComponentType<any>
export const TransferTab: ComponentType<any>
export const TunnelsTab: ComponentType<any>
export const XTERM_CSS: string
export const panelCss: Record<string, string>
