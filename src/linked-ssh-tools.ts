import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LinkedSshBindingStore } from './linked-ssh.ts'

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

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

function agentSessionId(exec: any): string {
  const id = exec?.agent?.id
  if (typeof id !== 'string' || id === '') {
    throw new Error('当前工具调用没有可识别的 DSH session，无法解析 Linked SSH 目标。')
  }
  return id
}

function linkedAlias(store: LinkedSshBindingStore, exec: any): string {
  const sessionId = agentSessionId(exec)
  const binding = store.get(sessionId)
  if (binding === undefined) {
    throw new Error('当前会话没有绑定 Linked SSH。请先在会话顶部“标准模式”右侧选择服务器。')
  }
  return binding.alias
}

async function callNested(ctx: any, exec: any, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await ctx.tools.execute({
    callId: `${String(exec.callId)}:${name}`,
    name,
    arguments: args,
    signal: exec.signal,
    agent: exec.agent,
    parent: exec.token,
  })
  if (result.isError) {
    throw new Error(result.error?.message ?? `${name} failed`)
  }
  return result.value
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

/**
 * Register model-facing tools that infer the SSH alias from the current DSH
 * session. They intentionally remove the alias parameter from the model's job:
 * the header Linked SSH selector is the only source of truth.
 */
export function installLinkedSshAgentTools(ctx: any, store: LinkedSshBindingStore): void {
  const linkedExec = defineTool({
    name: 'linked_ssh_exec',
    description: 'Execute a command on the SSH server linked to THIS session. No host alias is required or allowed. Use this for remote/server commands, logs, services, deployment inspection, and remote filesystem operations when the session header shows a Linked SSH target.',
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to run on the currently linked remote server.' },
      timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          timedOut: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value: ExecValue) => text(renderExec(value)),
    },
    async execute(args, exec) {
      const alias = linkedAlias(store, exec)
      return await callNested(ctx, exec, 'ssh_exec', {
        alias,
        command: args.command,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      }) as ExecValue
    },
  })

  const linkedListDir = defineTool({
    name: 'linked_ssh_list_dir',
    description: 'List a directory on the SSH server linked to THIS session. Prefer this instead of local Glob/Pwsh when the user asks about a remote/server directory or a path visible in SSH Files. If the user says a common Linux top-level directory such as apps/etc/var without a leading slash, it is interpreted as /apps, /etc, /var, etc.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote directory path, preferably absolute (for example /apps).' },
      all: { type: 'boolean', description: 'Include hidden files. Defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string', required: true },
          path: { type: 'string', required: true },
          success: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(
        value.success
          ? `${value.alias}:${value.path}\n${value.stdout}`
          : `${value.alias}:${value.path} list failed\n${value.stderr || value.error || 'unknown error'}`,
      ),
    },
    async execute(args, exec) {
      const alias = linkedAlias(store, exec)
      const path = normalizeRemotePath(args.path)
      const flags = args.all === false ? '-l' : '-la'
      const result = await callNested(ctx, exec, 'ssh_exec', {
        alias,
        command: `LC_ALL=C ls ${flags} -- ${shQuote(path)}`,
      }) as ExecValue
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
  })

  const linkedUpload = defineTool({
    name: 'linked_ssh_upload',
    description: 'Upload a LOCAL file to the SSH server linked to THIS session. The current local Workspace stays local; this tool is the explicit LOCAL -> REMOTE bridge and does not require an alias.',
    parameters: {
      localPath: { type: 'string', required: true, description: 'Absolute local file path on this machine.' },
      remotePath: { type: 'string', required: true, description: 'Destination path on the currently linked remote server.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          transferredBytes: { type: 'integer' },
          files: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: TransferValue) => text(value.ok
        ? `uploaded ${value.files ?? 1} file(s), ${value.transferredBytes ?? 0} bytes`
        : `upload failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args, exec) {
      const alias = linkedAlias(store, exec)
      return await callNested(ctx, exec, 'ssh_upload', {
        alias,
        localPath: args.localPath,
        remotePath: args.remotePath,
      }) as TransferValue
    },
  })

  const linkedDownload = defineTool({
    name: 'linked_ssh_download',
    description: 'Download a REMOTE file from the SSH server linked to THIS session to the local machine. No alias is required.',
    parameters: {
      remotePath: { type: 'string', required: true, description: 'Remote file path on the currently linked server.' },
      localPath: { type: 'string', required: true, description: 'Absolute destination path on the local machine.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          bytes: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: TransferValue) => text(value.ok
        ? `downloaded ${value.bytes ?? 0} bytes`
        : `download failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args, exec) {
      const alias = linkedAlias(store, exec)
      return await callNested(ctx, exec, 'ssh_download', {
        alias,
        remotePath: args.remotePath,
        localPath: args.localPath,
      }) as TransferValue
    },
  })

  ctx.effect(() => {
    const disposers = [linkedExec, linkedListDir, linkedUpload, linkedDownload]
      .map(tool => ctx.tools.register(tool))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-ssh-files-sidebar: Linked SSH agent tools')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-ssh-linked-tools',
    order: 152,
    text: (context: any) => {
      const sessionId = typeof context?.agent?.id === 'string' ? context.agent.id : ''
      if (sessionId === '' || store.get(sessionId) === undefined) return ''
      return [
        '## Linked SSH routing priority',
        'This session has both a LOCAL Workspace and a session-bound REMOTE SSH target.',
        'For local source-code/workspace requests, use the normal local tools (read/write/edit/glob/grep/bash/pwsh).',
        'For remote/server requests, prefer linked_ssh_exec, linked_ssh_list_dir, linked_ssh_upload and linked_ssh_download. These tools automatically use the server selected in the session header, so NEVER invent or omit an SSH alias.',
        'If the user asks about a Linux server path or a directory visible in SSH Files (for example “看看 apps 目录”, “/apps 下有什么”, “查看 /var/log”, “服务器日志”), treat it as REMOTE. Do NOT try local Glob/Pwsh first.',
        'Example: “看看 apps 目录下有什么文件” -> linked_ssh_list_dir({ path: "/apps" }).',
      ].join('\n')
    },
  }), 'dsh-ssh-files-sidebar: Linked SSH routing guidance')
}
