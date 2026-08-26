import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * dsh-rw HostTable-compatible adapter backed by @linxin666/dsh-ssh's
 * ~/.dsh/dsh-ssh.json store. This keeps one host/password configuration for
 * the SSH operations UI, remote-workspace picker, rw_* tools and the sidebar.
 */

interface DshSshAuth {
  kind: 'key' | 'password'
  keyPath?: string
  passphrase?: string
  password?: string
}

interface DshSshStoredHost {
  alias: string
  host: string
  port: number
  user: string
  auth: DshSshAuth
  proxyJump?: string[]
  description?: string
  environment?: string
  tags?: string[]
  location?: string
  createdAt?: number
  updatedAt?: number
}

interface DshSshStoreFile {
  version: number
  hosts: DshSshStoredHost[]
}

interface RwHostEntry {
  alias: string
  host: string
  port: number
  user: string
  auth:
    | { kind: 'key'; keyPath: string; passphrase?: string }
    | { kind: 'password'; password?: string }
  source: 'manual'
}

interface RwHostSummary {
  alias: string
  host: string
  port: number
  user: string
  authKind: 'key' | 'password'
  keyReady: boolean
  passwordSet: boolean
  source: 'manual'
}

const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function storePath(): string {
  return join(homedir(), '.dsh', 'dsh-ssh.json')
}

function readStore(): DshSshStoreFile {
  const path = storePath()
  if (!existsSync(path)) return { version: 1, hosts: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DshSshStoreFile>
    if (!Array.isArray(parsed.hosts)) return { version: 1, hosts: [] }
    return { version: typeof parsed.version === 'number' ? parsed.version : 1, hosts: parsed.hosts as DshSshStoredHost[] }
  } catch {
    // dsh-ssh itself owns corruption recovery. Do not overwrite a file that
    // cannot be parsed from this compatibility adapter.
    return { version: 1, hosts: [] }
  }
}

function saveStore(file: DshSshStoreFile): void {
  const path = storePath()
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch { /* Windows / unsupported fs */ }
  const tmp = `${path}.sidebar-${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* Windows / unsupported fs */ }
  renameSync(tmp, path)
}

function toRw(entry: DshSshStoredHost): RwHostEntry {
  return {
    alias: entry.alias,
    host: entry.host,
    port: entry.port ?? 22,
    user: entry.user,
    auth: entry.auth?.kind === 'key'
      ? {
          kind: 'key',
          keyPath: entry.auth.keyPath ?? '',
          ...(entry.auth.passphrase ? { passphrase: entry.auth.passphrase } : {}),
        }
      : {
          kind: 'password',
          ...(entry.auth?.password ? { password: entry.auth.password } : {}),
        },
    source: 'manual',
  }
}

export class SharedDshSshHostTable {
  list(): RwHostEntry[] {
    return readStore().hosts
      .filter(entry => typeof entry?.alias === 'string' && typeof entry?.host === 'string' && typeof entry?.user === 'string')
      .map(toRw)
  }

  find(alias: string): RwHostEntry | undefined {
    const entry = readStore().hosts.find(candidate => candidate.alias === alias)
    return entry === undefined ? undefined : toRw(entry)
  }

  summarize(entry: RwHostEntry): RwHostSummary {
    return {
      alias: entry.alias,
      host: entry.host,
      port: entry.port,
      user: entry.user,
      authKind: entry.auth.kind,
      keyReady: entry.auth.kind === 'key' && entry.auth.keyPath !== '' && existsSync(expandHome(entry.auth.keyPath)),
      passwordSet: entry.auth.kind === 'password' && !!entry.auth.password,
      source: 'manual',
    }
  }

  summaries(): RwHostSummary[] {
    return this.list().map(entry => this.summarize(entry))
  }

  addManual(payload: {
    alias: string
    host: string
    port?: number
    user: string
    password?: string
    keyPath?: string
    passphrase?: string
  }): RwHostEntry {
    const alias = payload.alias.trim()
    if (!ALIAS_RE.test(alias)) throw new Error(`invalid alias: ${JSON.stringify(alias)}`)
    if (payload.host.trim() === '') throw new Error('host is required')
    if (payload.user.trim() === '') throw new Error('user is required')
    const port = payload.port ?? 22
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${String(port)}`)
    const hasKey = typeof payload.keyPath === 'string' && payload.keyPath !== ''
    const hasPassword = typeof payload.password === 'string' && payload.password !== ''
    if (!hasKey && !hasPassword) throw new Error('either keyPath or password is required')

    const file = readStore()
    if (file.hosts.some(entry => entry.alias === alias)) throw new Error(`host alias already exists: ${alias}`)
    const now = Date.now()
    const stored: DshSshStoredHost = {
      alias,
      host: payload.host.trim(),
      port,
      user: payload.user.trim(),
      auth: hasKey
        ? {
            kind: 'key',
            keyPath: expandHome(payload.keyPath as string),
            ...(payload.passphrase ? { passphrase: payload.passphrase } : {}),
          }
        : { kind: 'password', password: payload.password },
      proxyJump: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
    }
    file.hosts.push(stored)
    saveStore(file)
    return toRw(stored)
  }

  removeManual(alias: string): void {
    const file = readStore()
    const next = file.hosts.filter(entry => entry.alias !== alias)
    if (next.length === file.hosts.length) return
    file.hosts = next
    saveStore(file)
  }
}
