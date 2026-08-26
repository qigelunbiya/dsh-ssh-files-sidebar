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

export interface ExecResult {
  success: boolean
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  durationMs: number
  error?: string
}

const BASE = '/api/dsh-ssh'

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string } & T
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body as T
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const text = await response.text().catch(() => '')
  if (text !== '') {
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === 'string') return new Error(parsed.error)
    } catch {
      // Fall through to the raw response text.
    }
    return new Error(text)
  }
  return new Error(`${fallback}: HTTP ${response.status}`)
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}

/** POSIX-shell single-quote escaping for the short mutation commands below. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export async function listHosts(): Promise<SshHostSummary[]> {
  const response = await fetch(`${BASE}/hosts`)
  const body = await readJson<{ hosts: SshHostSummary[] }>(response)
  return body.hosts
}

export async function listRemoteDir(alias: string, path: string): Promise<RemoteDirEntry[]> {
  const response = await fetch(`${BASE}/ls?${query({ alias, path })}`)
  const body = await readJson<{ entries: RemoteDirEntry[] }>(response)
  return body.entries
}

export async function execRemote(alias: string, command: string): Promise<ExecResult> {
  const response = await fetch(`${BASE}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alias, command }),
  })
  const body = await readJson<{ result: ExecResult }>(response)
  const result = body.result
  if (!result.success) {
    const detail = result.stderr.trim() || result.error || `remote command failed with exit code ${String(result.exitCode)}`
    throw new Error(detail)
  }
  return result
}

/** Read remote bytes through dsh-ssh's existing SFTP download route. */
export async function readRemoteFile(alias: string, remotePath: string): Promise<Blob> {
  const response = await fetch(`${BASE}/download?${query({ alias, remotePath })}`)
  if (!response.ok) throw await responseError(response, 'download failed')
  return await response.blob()
}

/** Save bytes through dsh-ssh's existing SFTP upload route. */
export async function writeRemoteFile(alias: string, remotePath: string, data: Blob | string): Promise<number> {
  const body = typeof data === 'string' ? new Blob([data], { type: 'text/plain;charset=utf-8' }) : data
  const response = await fetch(`${BASE}/upload?${query({ alias, remotePath })}`, {
    method: 'POST',
    body,
  })
  if (!response.ok) throw await responseError(response, 'upload failed')

  // The upload endpoint reports its final result as NDJSON even when HTTP is 200.
  const text = await response.text()
  let transferredBytes = 0
  let sawResult = false
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const frame = JSON.parse(line) as {
        type?: unknown
        ok?: unknown
        transferredBytes?: unknown
        error?: unknown
      }
      if (frame.type !== 'result') continue
      sawResult = true
      if (frame.ok !== true) throw new Error(typeof frame.error === 'string' ? frame.error : 'upload failed')
      if (typeof frame.transferredBytes === 'number') transferredBytes = frame.transferredBytes
    } catch (error) {
      if (error instanceof SyntaxError) continue
      throw error
    }
  }
  if (!sawResult) throw new Error('upload ended without a result frame')
  return transferredBytes
}

export async function createRemoteDirectory(alias: string, path: string): Promise<void> {
  await execRemote(alias, `mkdir -- ${shellQuote(path)}`)
}

export async function renameRemotePath(alias: string, from: string, to: string): Promise<void> {
  await execRemote(alias, `mv -- ${shellQuote(from)} ${shellQuote(to)}`)
}

export async function deleteRemotePath(alias: string, path: string, isDirectory: boolean): Promise<void> {
  await execRemote(alias, isDirectory
    ? `rm -rf -- ${shellQuote(path)}`
    : `rm -f -- ${shellQuote(path)}`)
}
