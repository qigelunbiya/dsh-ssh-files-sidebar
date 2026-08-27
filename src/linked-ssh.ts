import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

interface LinkedSshBinding {
  alias: string
  updatedAt: number
}

interface BindingFile {
  version: 1
  sessions: Record<string, LinkedSshBinding>
}

interface HostEntryLike {
  alias: string
  host: string
  port: number
  user: string
}

interface HostLookupLike {
  find(alias: string): HostEntryLike | undefined
}

const STORE_FILE = 'dsh-ssh-linked-sessions.json'
const API_PATH = '/api/dsh-ssh-files-sidebar/linked-ssh'
const MAX_BODY_BYTES = 16 * 1024
const MAX_BINDINGS = 1000
const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

function filePath(): string {
  return join(homedir(), '.dsh', STORE_FILE)
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !/[\0\r\n]/.test(value)
}

function validAlias(value: unknown): value is string {
  return typeof value === 'string' && ALIAS_RE.test(value)
}

function readFile(): BindingFile {
  const path = filePath()
  if (!existsSync(path)) return { version: 1, sessions: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BindingFile>
    if (parsed.version !== 1 || parsed.sessions === null || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) {
      return { version: 1, sessions: {} }
    }
    const sessions: Record<string, LinkedSshBinding> = {}
    for (const [sessionId, value] of Object.entries(parsed.sessions)) {
      if (!validSessionId(sessionId) || value === null || typeof value !== 'object') continue
      const alias = (value as Partial<LinkedSshBinding>).alias
      const updatedAt = (value as Partial<LinkedSshBinding>).updatedAt
      if (!validAlias(alias)) continue
      sessions[sessionId] = {
        alias,
        updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0,
      }
    }
    return { version: 1, sessions }
  } catch {
    // A malformed file is treated as empty here; unlike the SSH credential
    // store this file contains only session->alias references, never secrets.
    return { version: 1, sessions: {} }
  }
}

function writeFile(file: BindingFile): void {
  const path = filePath()
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch { /* Windows / unsupported fs */ }

  const entries = Object.entries(file.sessions)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_BINDINGS)
  const compact: BindingFile = { version: 1, sessions: Object.fromEntries(entries) }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(compact, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* Windows / unsupported fs */ }
  renameSync(tmp, path)
}

export class LinkedSshBindingStore {
  get(sessionId: string): LinkedSshBinding | undefined {
    return readFile().sessions[sessionId]
  }

  set(sessionId: string, alias: string): LinkedSshBinding {
    if (!validSessionId(sessionId)) throw new Error('invalid sessionId')
    if (!validAlias(alias)) throw new Error('invalid SSH alias')
    const file = readFile()
    const binding = { alias, updatedAt: Date.now() }
    file.sessions[sessionId] = binding
    writeFile(file)
    return binding
  }

  remove(sessionId: string): void {
    if (!validSessionId(sessionId)) throw new Error('invalid sessionId')
    const file = readFile()
    if (!(sessionId in file.sessions)) return
    delete file.sessions[sessionId]
    writeFile(file)
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** Same loopback/same-origin fence as the embedded dsh-ssh command routes. */
function isTrustedRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function hostView(host: HostEntryLike | undefined): Record<string, unknown> | undefined {
  if (host === undefined) return undefined
  return { alias: host.alias, host: host.host, port: host.port, user: host.user }
}

function promptText(store: LinkedSshBindingStore, hosts: HostLookupLike, context: any): string {
  const sessionId = typeof context?.agent?.id === 'string' ? context.agent.id : ''
  if (sessionId === '') return ''
  const binding = store.get(sessionId)
  if (binding === undefined) return ''
  const host = hosts.find(binding.alias)
  if (host === undefined) {
    return [
      '## Linked SSH target',
      `This session is linked to SSH alias "${binding.alias}", but that alias is no longer present in the SSH host store.`,
      'Do not guess a replacement host. Ask the user to reconnect the session to an existing SSH host.',
    ].join('\n')
  }

  const cwd = typeof context?.agent?.session?.header?.cwd === 'string'
    ? context.agent.session.header.cwd
    : undefined
  return [
    '## Linked SSH target',
    `This session has an explicit remote target: SSH alias "${binding.alias}" (${host.user}@${host.host}:${host.port}).`,
    cwd === undefined
      ? 'The DSH Workspace remains LOCAL.'
      : `The DSH Workspace remains LOCAL at ${cwd}.`,
    'Routing rule: native read/write/edit/str_replace_editor/glob/grep/bash/pwsh tools continue to operate on the LOCAL workspace. Do not treat them as remote commands merely because SSH is linked.',
    `For REMOTE operations use the ssh_* tools with alias "${binding.alias}" (for example ssh_exec, ssh_upload, ssh_download).`,
    `When the user says “服务器”, “远程”, “上传到服务器”, “查看服务器日志” or “部署” without naming another host, use "${binding.alias}" as the default remote target instead of calling ssh_list to guess.`,
    'Keep LOCAL build/package work and REMOTE server work conceptually separate. File transfer is the explicit bridge between them.',
  ].join('\n')
}

/**
 * Host-side half of Linked SSH: durable session bindings, browser API, and a
 * per-agent dynamic prompt section so the model knows LOCAL vs REMOTE routing.
 */
export function installLinkedSsh(ctx: any, hosts: HostLookupLike): LinkedSshBindingStore {
  const store = new LinkedSshBindingStore()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrustedRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }

      const method = req.method ?? 'GET'
      if (method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        if (!validSessionId(sessionId)) {
          writeJson(res, 400, { error: 'valid sessionId query parameter is required' })
          return
        }
        const binding = store.get(sessionId)
        if (binding === undefined) {
          writeJson(res, 200, { binding: null })
          return
        }
        writeJson(res, 200, { binding: { ...binding, host: hostView(hosts.find(binding.alias)) } })
        return
      }

      if (method !== 'POST') {
        writeJson(res, 405, { error: `method not allowed: ${method}` })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined || !validSessionId(body.sessionId)) {
        writeJson(res, 400, { error: 'valid JSON body with sessionId is required' })
        return
      }
      const sessionId = body.sessionId
      if (body.alias === null) {
        store.remove(sessionId)
        writeJson(res, 200, { binding: null })
        return
      }
      if (!validAlias(body.alias)) {
        writeJson(res, 400, { error: 'valid alias or null is required' })
        return
      }
      const host = hosts.find(body.alias)
      if (host === undefined) {
        writeJson(res, 400, { error: `unknown SSH host alias: ${body.alias}` })
        return
      }
      const binding = store.set(sessionId, body.alias)
      writeJson(res, 200, { binding: { ...binding, host: hostView(host) } })
    },
  }), 'dsh-ssh-files-sidebar: linked SSH route')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-ssh-linked-target',
    order: 151,
    text: (context: any) => promptText(store, hosts, context),
  }), 'dsh-ssh-files-sidebar: linked SSH agent context')

  return store
}
