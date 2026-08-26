export interface SshHostSummary {
  alias: string
  host: string
  port: number
  user: string
}

export interface RemoteDirEntry {
  name: string
  type: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
  mode?: number
}

const BASE = '/api/dsh-ssh'

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string } & T
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body as T
}

export async function listHosts(): Promise<SshHostSummary[]> {
  const response = await fetch(`${BASE}/hosts`)
  const body = await readJson<{ hosts: SshHostSummary[] }>(response)
  return body.hosts
}

export async function listRemoteDir(alias: string, path: string): Promise<RemoteDirEntry[]> {
  const params = new URLSearchParams({ alias, path })
  const response = await fetch(`${BASE}/ls?${params.toString()}`)
  const body = await readJson<{ entries: RemoteDirEntry[] }>(response)
  return body.entries
}
