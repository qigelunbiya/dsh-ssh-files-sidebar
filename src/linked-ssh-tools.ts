import type { LinkedSshBindingStore } from './linked-ssh.ts'
import { effectiveSessionSshAlias, requireEffectiveSessionSshAlias } from './session-ssh-target.ts'

interface ExecValue {
  success: boolean
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  durationMs: number
  error?: string
}

interface TransferValue {
  ok: boolean
  transferredBytes?: number
  files?: number
  bytes?: number
  error?: string
}

interface ListDirValue {
  alias: string
  path: string
  success: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  error?: string
}

interface SshInternals {
  SshEngine: new (store: any) => any
  HostStore: new () => any
}

let sshInternalsPromise: Promise<SshInternals> | undefined

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

function linkedAlias(store: LinkedSshBindingStore, exec: any): string {
  return requireEffectiveSessionSshAlias(store, exec)
}

/**
 * Load the same SSH engine/store implementation used by @linxin666/dsh-ssh,
 * without dispatching through its generic model-facing ssh_* tools.
 *
 * This separation is important: raw ssh_* tools are deliberately restricted
 * from every Agent so a conversation cannot enumerate/switch to another host.
 * The session-bound linked_ssh_* wrappers therefore talk to SshEngine directly
 * and inject the one effective alias resolved from the current conversation.
 */
async function loadSshInternals(): Promise<SshInternals> {
  if (sshInternalsPromise !== undefined) return await sshInternalsPromise
  sshInternalsPromise = (async () => {
    const engineSpec = '@linxin666/dsh-ssh/src/engine.ts'
    const storeSpec = '@linxin666/dsh-ssh/src/store.ts'
    const [engineModule, storeModule] = await Promise.all([
      import(engineSpec),
      import(storeSpec),
    ]) as any[]
    if (typeof engineModule?.SshEngine !== 'function' || typeof storeModule?.HostStore !== 'function') {
      throw new Error('@linxin666/dsh-ssh 当前版本没有暴露会话绑定工具所需的 SSH engine 接口')
    }
    return {
      SshEngine: engineModule.SshEngine,
      HostStore: storeModule.HostStore,
    }
  })()
  return await sshInternalsPromise
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const COMMON_ROOT_DIRS = new Set([
  'apps', 'bin', 'boot', 'dev', 'etc', 'home', 'media', 'mnt', 'opt', 'proc',
  'root', 'run', 'srv', 'sys', 'tmp', 'usr', 'var',
])

function normalizeRemotePath(value: string): string {
  const path = value.trim()
  if (path === '') return '/'
  if (path.startsWith('/') || path.startsWith('~') || path.startsWith('.')) return path
  const first = path.split('/')[0]?.toLowerCase()
  return first !== undefined && COMMON_ROOT_DIRS.has(first) ? `/${path}` : path
}

function renderExec(value: ExecValue): string {
  const parts = [`[exit code: ${value.exitCode ?? 'null'}]`]
  if (value.stdout !== '') parts.push(`stdout:\n${value.stdout}`)
  if (value.stderr !== '') parts.push(`stderr:\n${value.stderr}`)
  if (value.error !== undefined) parts.push(`error: ${value.error}`)
  return parts.join('\n')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function directExec(
  engine: any,
  alias: string,
  command: string,
  timeoutMs?: number,
): Promise<ExecValue> {
  try {
    return await engine.exec(alias, command, timeoutMs) as ExecValue
  } catch (error) {
    return {
      success: false,
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      durationMs: 0,
      error: errorMessage(error),
    }
  }
}

const EXEC_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    success: { type: 'boolean' },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    timedOut: { type: 'boolean' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    durationMs: { type: 'integer' },
    error: { type: 'string' },
  },
  required: ['success', 'exitCode', 'timedOut', 'stdout', 'stderr', 'durationMs'],
} as const

/**
 * Register model-facing tools that infer the SSH alias from the current DSH
 * session. They intentionally remove the alias parameter from the model's job:
 * the conversation's effective SSH target is the only source of truth.
 *
 * For a normal local Workspace that target comes from the header Linked SSH
 * binding. For a dsh-rw Remote Workspace it comes from that conversation cwd's
 * .dsh-rw-meta.json, matching the UI's remoteAlias ?? linkedAlias precedence.
 *
 * Unlike the old implementation these wrappers do NOT call ctx.tools.execute()
 * with ssh_exec/ssh_upload/ssh_download. That makes it safe to use DSH's native
 * per-Agent tools.restrict() and global tools.guard() to remove the raw
 * multi-host SSH surface completely.
 */
export function installLinkedSshAgentTools(ctx: any, store: LinkedSshBindingStore): void {
  let directEngine: any
  const getEngine = async (): Promise<any> => {
    if (directEngine !== undefined) return directEngine
    const internals = await loadSshInternals()
    directEngine = new internals.SshEngine(new internals.HostStore())
    return directEngine
  }

  const linkedExec = {
    name: 'linked_ssh_exec',
    description: 'Execute a command on the one SSH server bound to THIS conversation. No host alias is required or allowed. Use this for remote/server commands, process inspection, logs, services, deployment inspection, and remote filesystem operations.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'Shell command to run on the current conversation SSH server.' },
        timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds.' },
      },
      required: ['command'],
    },
    output: {
      schema: EXEC_OUTPUT_SCHEMA,
      render: (_args: any, value: ExecValue) => text(renderExec(value)),
    },
    async execute(args: { command: string; timeoutMs?: number }, exec: any): Promise<ExecValue> {
      const alias = linkedAlias(store, exec)
      const engine = await getEngine()
      return await directExec(engine, alias, args.command, args.timeoutMs)
    },
  }

  const linkedListDir = {
    name: 'linked_ssh_list_dir',
    description: 'List a directory on the one SSH server bound to THIS conversation. Prefer this instead of local Glob/Pwsh when the user asks about a remote/server directory or a path visible in SSH Files. If the user says a common Linux top-level directory such as apps/etc/var without a leading slash, it is interpreted as /apps, /etc, /var, etc.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Remote directory path, preferably absolute (for example /apps).' },
        all: { type: 'boolean', description: 'Include hidden files. Defaults to true.' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string' },
          path: { type: 'string' },
          success: { type: 'boolean' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['alias', 'path', 'success', 'exitCode', 'stdout', 'stderr'],
      },
      render: (_args: any, value: ListDirValue) => text(
        value.success
          ? `${value.alias}:${value.path}\n${value.stdout}`
          : `${value.alias}:${value.path} list failed\n${value.stderr || value.error || 'unknown error'}`,
      ),
    },
    async execute(args: { path: string; all?: boolean }, exec: any): Promise<ListDirValue> {
      const alias = linkedAlias(store, exec)
      const path = normalizeRemotePath(args.path)
      const flags = args.all === false ? '-l' : '-la'
      const engine = await getEngine()
      const result = await directExec(engine, alias, `LC_ALL=C ls ${flags} -- ${shQuote(path)}`)
      return {
        alias,
        path,
        success: result.success,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.error === undefined ? {} : { error: result.error }),
      }
    },
  }

  const linkedUpload = {
    name: 'linked_ssh_upload',
    description: 'Upload a LOCAL file to the one SSH server bound to THIS conversation. The current local Workspace stays local; this tool is the explicit LOCAL -> REMOTE bridge and does not accept an alias.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        localPath: { type: 'string', description: 'Absolute local file path on this machine.' },
        remotePath: { type: 'string', description: 'Destination path on the current conversation SSH server.' },
      },
      required: ['localPath', 'remotePath'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          transferredBytes: { type: 'integer' },
          files: { type: 'integer' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args: any, value: TransferValue) => text(value.ok
        ? `uploaded ${value.files ?? 1} file(s), ${value.transferredBytes ?? 0} bytes`
        : `upload failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args: { localPath: string; remotePath: string }, exec: any): Promise<TransferValue> {
      const alias = linkedAlias(store, exec)
      const engine = await getEngine()
      try {
        const outcome = await engine.upload(alias, args.localPath, args.remotePath, false)
        return { ok: true, transferredBytes: outcome.bytes, files: outcome.files }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
  }

  const linkedDownload = {
    name: 'linked_ssh_download',
    description: 'Download a REMOTE file from the one SSH server bound to THIS conversation to the local machine. No alias is required or allowed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        remotePath: { type: 'string', description: 'Remote file path on the current conversation SSH server.' },
        localPath: { type: 'string', description: 'Absolute destination path on the local machine.' },
      },
      required: ['remotePath', 'localPath'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          bytes: { type: 'integer' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args: any, value: TransferValue) => text(value.ok
        ? `downloaded ${value.bytes ?? 0} bytes`
        : `download failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args: { remotePath: string; localPath: string }, exec: any): Promise<TransferValue> {
      const alias = linkedAlias(store, exec)
      const engine = await getEngine()
      try {
        const outcome = await engine.download(alias, args.remotePath, args.localPath)
        return { ok: true, bytes: outcome.bytes }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
  }

  ctx.effect(() => {
    const disposers = [linkedExec, linkedListDir, linkedUpload, linkedDownload]
      .map(tool => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) dispose()
      try { directEngine?.dispose?.() } catch { /* already disposed */ }
    }
  }, 'dsh-ssh-files-sidebar: Linked SSH agent tools')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-ssh-linked-tools',
    order: 152,
    text: (context: any) => {
      const alias = effectiveSessionSshAlias(store, context)
      if (alias === null) return ''
      return [
        '## Session-bound SSH routing priority',
        `This conversation has exactly one REMOTE SSH target: "${alias}".`,
        'For local source-code/workspace requests, use the normal local tools when the Workspace is local.',
        `For remote/server requests, use linked_ssh_exec, linked_ssh_list_dir, linked_ssh_upload and linked_ssh_download. They automatically use "${alias}"; never enumerate configured hosts and never choose another alias.`,
        'If the user asks about a Linux server path or a directory visible in SSH Files (for example “看看 apps 目录”, “/apps 下有什么”, “查看 /var/log”, “服务器日志”), treat it as REMOTE. Do NOT try local Glob/Pwsh first.',
        'Example: “看看 apps 目录下有什么文件” -> linked_ssh_list_dir({ path: "/apps" }).',
      ].join('\n')
    },
  }), 'dsh-ssh-files-sidebar: Linked SSH routing guidance')
}
