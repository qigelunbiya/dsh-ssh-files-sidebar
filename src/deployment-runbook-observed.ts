import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { LinkedSshBindingStore } from './linked-ssh.ts'
import { remoteWorkspaceFromCwd } from './remote-workspace-safety.ts'
import { cwdFromAgentLike, effectiveSessionSshAlias } from './session-ssh-target.ts'

const RUNBOOK_NAME = 'DEPLOYMENT.md'
const RUNBOOK_VERSION = '1'
const MAX_RUNBOOK_BYTES = 512 * 1024

interface ProjectRunbookStatus {
  workspace: string
  projectRoot: string
  runbookPath: string
  exists: boolean
  size: number
  sha256: string | null
  currentSsh: string | null
}

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function localWorkspace(value: any): string {
  const cwd = cwdFromAgentLike(value)
  if (cwd === undefined) throw new Error('当前会话没有可识别的 Workspace cwd。')
  if (remoteWorkspaceFromCwd(cwd) !== null) {
    throw new Error('观测到的部署记录必须写入真实本地项目目录，不能写入 dsh-rw Remote Workspace 占位目录。')
  }
  const stat = statSync(cwd)
  if (!stat.isDirectory()) throw new Error(`当前 Workspace 不是目录：${cwd}`)
  return resolve(cwd)
}

function resolveProjectRoot(workspace: string, requested?: string): string {
  const root = requested === undefined || requested.trim() === ''
    ? workspace
    : resolve(workspace, requested)
  const rel = relative(workspace, root)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`projectRoot 必须位于当前 LOCAL Workspace 内：workspace=${workspace}, projectRoot=${root}`)
  }
  let stat
  try {
    stat = statSync(root)
  } catch {
    throw new Error(`项目目录不存在或不可访问：${root}`)
  }
  if (!stat.isDirectory()) throw new Error(`projectRoot 不是目录：${root}`)
  return root
}

function stripScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

function frontmatterValue(content: string, key: string): string | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return null
  const wanted = key.toLowerCase()
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim() === '---') break
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null || match[1]!.toLowerCase() !== wanted) continue
    const value = stripScalar(match[2] ?? '')
    return value === '' ? null : value
  }
  return null
}

function readExisting(path: string): { content: string; size: number; digest: string } {
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error(`${path} 不是普通文件`)
  if (stat.size > MAX_RUNBOOK_BYTES) throw new Error(`${RUNBOOK_NAME} 过大：${stat.size} bytes`)
  const content = readFileSync(path, 'utf8')
  return { content, size: Buffer.byteLength(content, 'utf8'), digest: sha256(content) }
}

function projectStatus(store: LinkedSshBindingStore, value: any, requested?: string): ProjectRunbookStatus {
  const workspace = localWorkspace(value)
  const projectRoot = resolveProjectRoot(workspace, requested)
  const path = join(projectRoot, RUNBOOK_NAME)
  const currentSsh = effectiveSessionSshAlias(store, value)
  if (!existsSync(path)) {
    return { workspace, projectRoot, runbookPath: path, exists: false, size: 0, sha256: null, currentSsh }
  }
  const file = readExisting(path)
  return { workspace, projectRoot, runbookPath: path, exists: true, size: file.size, sha256: file.digest, currentSsh }
}

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workspace: { type: 'string' },
    projectRoot: { type: 'string' },
    runbookPath: { type: 'string' },
    exists: { type: 'boolean' },
    size: { type: 'integer' },
    sha256: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    currentSsh: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['workspace', 'projectRoot', 'runbookPath', 'exists', 'size', 'sha256', 'currentSsh'],
} as const

/**
 * Persistent memory for deployment facts that have already been executed and
 * independently verified in the current conversation.
 *
 * This complements deployment_runbook_write: that tool protects a proposed
 * Runbook before execution, while this tool records durable facts after an
 * already-authorized operation succeeded. The write itself is only local
 * documentation and never grants permission for future remote mutations.
 */
export function installObservedDeploymentRunbook(ctx: any, store: LinkedSshBindingStore): void {
  const statusTool = {
    name: 'deployment_runbook_project_status',
    description: 'Inspect DEPLOYMENT.md for the actual LOCAL project root, including a subdirectory of the current Workspace. Use this before recording an observed deployment when the deployed project is not the Workspace root.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectRoot: { type: 'string', description: 'Project directory inside the current LOCAL Workspace. Relative paths such as 131test are preferred. Omit when the Workspace itself is the project root.' },
      },
    },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args: any, value: ProjectRunbookStatus) => text([
        `workspace: ${value.workspace}`,
        `project root: ${value.projectRoot}`,
        `runbook: ${value.runbookPath}`,
        `exists: ${value.exists}`,
        `sha256: ${value.sha256 ?? '(none)'}`,
        `current SSH: ${value.currentSsh ?? '(none)'}`,
      ].join('\n')),
    },
    async execute(args: { projectRoot?: string }, exec: any): Promise<ProjectRunbookStatus> {
      return projectStatus(store, exec, args.projectRoot)
    },
  }

  const recordTool = {
    name: 'deployment_runbook_record_observed',
    description: 'Create or refresh DEPLOYMENT.md from deployment/operations facts that were ALREADY executed and verified in this conversation. Use it after a successful deploy/redeploy/start/stop/restart/config activation so a later conversation can reuse the learned procedure. Do not use it for speculative or unexecuted commands.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'replace'] },
        projectRoot: { type: 'string', description: 'Actual deployed project directory inside the current LOCAL Workspace. Relative paths are preferred. Omit only when the Workspace itself is the project root.' },
        content: { type: 'string', description: 'Complete DEPLOYMENT.md built from commands and facts that actually worked. Keep it proportional to project complexity and include reusable deploy/verify/recovery/operations knowledge.' },
        expectedSha256: { type: 'string', description: 'Required for replace. Obtain it from deployment_runbook_project_status or a fresh project-local runbook read.' },
        reason: { type: 'string', enum: ['first-success', 'operations-learned', 'procedure-corrected'], description: 'Why durable deployment knowledge is being recorded.' },
        observedFacts: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Concrete facts observed from the successful operation, such as deployed path, config path, service manager, port, artifact or commands that worked.' },
        verificationEvidence: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Concrete post-operation evidence, such as health response, listening/closed port, process/service state, nginx -t result or relevant logs.' },
      },
      required: ['action', 'content', 'reason', 'observedFacts', 'verificationEvidence'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          created: { type: 'boolean' },
          path: { type: 'string' },
          sha256: { type: 'string' },
          bytes: { type: 'integer' },
          projectRoot: { type: 'string' },
        },
        required: ['created', 'path', 'sha256', 'bytes', 'projectRoot'],
      },
      render: (_args: any, value: { created: boolean; path: string; sha256: string; bytes: number; projectRoot: string }) => text([
        `${value.created ? 'created' : 'updated'} observed deployment runbook: ${value.path}`,
        `project root: ${value.projectRoot}`,
        `sha256: ${value.sha256}`,
        `bytes: ${value.bytes}`,
      ].join('\n')),
    },
    async execute(args: {
      action: 'create' | 'replace'
      projectRoot?: string
      content: string
      expectedSha256?: string
      reason: 'first-success' | 'operations-learned' | 'procedure-corrected'
      observedFacts: string[]
      verificationEvidence: string[]
    }, exec: any) {
      if (typeof args.content !== 'string' || args.content.trim() === '') throw new Error('DEPLOYMENT.md 内容不能为空')
      if (args.content.includes('\0')) throw new Error('DEPLOYMENT.md 内容包含 NUL 字符，拒绝写入')
      if (!Array.isArray(args.observedFacts) || args.observedFacts.length === 0) throw new Error('必须提供至少一条 observedFacts，不能把猜测写成已验证部署知识。')
      if (!Array.isArray(args.verificationEvidence) || args.verificationEvidence.length === 0) throw new Error('必须提供至少一条 verificationEvidence；没有验证证据时不能把流程记为成功基线。')

      const bytes = Buffer.byteLength(args.content, 'utf8')
      if (bytes > MAX_RUNBOOK_BYTES) throw new Error(`DEPLOYMENT.md 过大：${bytes} bytes，上限 ${MAX_RUNBOOK_BYTES} bytes`)

      const status = projectStatus(store, exec, args.projectRoot)
      const path = status.runbookPath
      if (args.action === 'create' && status.exists) {
        throw new Error(`${path} 已存在；先读取/检查现有 Runbook，再使用 replace + expectedSha256。当前 sha256=${status.sha256}`)
      }
      if (args.action === 'replace' && !status.exists) throw new Error(`${path} 不存在；请使用 create。`)
      if (args.action === 'replace') {
        if (typeof args.expectedSha256 !== 'string' || args.expectedSha256 === '') {
          throw new Error(`replace 必须提供 expectedSha256。请先调用 deployment_runbook_project_status。当前 sha256=${status.sha256}`)
        }
        if (args.expectedSha256 !== status.sha256) {
          throw new Error(`DEPLOYMENT.md 已变化（expected ${args.expectedSha256}, current ${status.sha256}）。请重新读取并合并用户修改后再记录。`)
        }
      }

      const version = frontmatterValue(args.content, 'dsh-deployment-version')
      if (version !== RUNBOOK_VERSION) throw new Error(`DEPLOYMENT.md frontmatter 必须包含 dsh-deployment-version: ${RUNBOOK_VERSION}`)
      const project = frontmatterValue(args.content, 'project')
      if (project === null) throw new Error('DEPLOYMENT.md frontmatter 必须包含 project')
      const remoteRoot = frontmatterValue(args.content, 'remote-root')
      if (remoteRoot === null || /^<.*>$/.test(remoteRoot)) throw new Error('观测部署记录必须写入真实 remote-root，不能保留占位符。')

      const currentSsh = effectiveSessionSshAlias(store, exec)
      if (currentSsh === null) throw new Error('当前会话没有绑定 SSH；无法把观测到的远程部署知识绑定到唯一服务器。')
      const targetSsh = frontmatterValue(args.content, 'target-ssh')
      if (targetSsh !== currentSsh) {
        throw new Error(`DEPLOYMENT.md target-ssh=${targetSsh ?? '(missing)'} 与当前会话 SSH=${currentSsh} 不一致，拒绝记录。`)
      }

      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, args.content.endsWith('\n') ? args.content : `${args.content}\n`, 'utf8')
      renameSync(tmp, path)
      const written = readExisting(path)
      return {
        created: !status.exists,
        path,
        sha256: written.digest,
        bytes: written.size,
        projectRoot: status.projectRoot,
      }
    },
  }

  ctx.effect(() => {
    const disposers = [statusTool, recordTool].map(tool => ctx.tools.register(tool))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-ssh-files-sidebar: observed deployment runbook memory tools')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-observed-deployment-memory',
    order: 157.8,
    text: () => [
      '## Persistent deployment memory after successful operations',
      'DEPLOYMENT.md is not only a pre-deployment plan. It is also the project-local durable memory that allows a NEW conversation to recover deployment and operations knowledge learned in an earlier conversation.',
      'After a user-authorized deploy/redeploy/start/stop/restart/config activation or similar operation has actually been executed, inspect the result. If concrete verification shows the operation reached its intended technical state and durable procedure knowledge was learned, record that knowledge before ending the turn.',
      '',
      '### First successful deployment',
      'If the actual deployed project has no DEPLOYMENT.md yet, create a concise observed baseline with deployment_runbook_record_observed. Do NOT wait for the user to separately ask for documentation, and do NOT require a second confirmation merely to persist facts from remote mutations the user already requested and that have already completed. This local documentation write is not a new deployment mutation.',
      'This observed-capture rule supersedes older Stage-0 wording that required a separate post-success confirmation before the first Runbook could be written. User confirmation is still required for proposed/unexecuted plans and for remote side effects; it is not required just to record already executed, verified facts.',
      '',
      '### Put the file in the actual project directory',
      'The current Workspace may be a parent directory containing a newly created or selected project subfolder. Persist DEPLOYMENT.md inside the ACTUAL project root, not automatically at the conversation cwd. Use deployment_runbook_project_status / deployment_runbook_record_observed with projectRoot when needed. Example shape only: a project created under ./some-project should receive ./some-project/DEPLOYMENT.md.',
      '',
      '### Keep the Runbook proportional to the real project',
      'A tiny static site may need only a short Runbook; a multi-service application may need a much richer one. Do not force fake build/package/service sections when they do not apply. Still preserve enough structure for a later conversation to safely recover the real workflow: frontmatter target, LOCAL inputs when relevant, TRANSFER, REMOTE deploy/start behavior, Preflight, Verification/Health Check, recovery or rollback, and safety boundaries.',
      'Record the commands/paths/config/service/port/artifact facts that actually worked. Do not promote failed experiments into normal steps. Failed attempts may appear only as concise troubleshooting notes when they teach a durable constraint.',
      '',
      '### Learn operations as well as deployment',
      'If a later successful action teaches a reusable start/stop/restart/status/log/health/config-reload procedure, update the existing Runbook when that knowledge is durable. Record the reusable procedure, not merely a transient sentence such as “the service is stopped right now”.',
      'If the operation reveals that an existing Runbook command/path/service assumption was wrong, correct the Runbook from observed evidence using replace + a fresh expectedSha256.',
      'Do not rewrite the Runbook for every harmless read-only check or one-off incident. Update it when the new information would materially help a later conversation operate or deploy the project correctly.',
      '',
      '### Failure is not a successful baseline',
      'Do not create a normal successful DEPLOYMENT.md merely because several deployment commands were attempted. If the application is still broken or the server cannot safely run it, report the blocker instead. Capture the normal baseline only after the intended technical state is verified.',
      '',
      'After creating/updating the observed Runbook, tell the user the exact local DEPLOYMENT.md path in the same language as the conversation. The Runbook preserves knowledge across conversations, but it never grants blanket authorization for future remote mutations; future deployment still follows the normal plan/approval rules.',
    ].join('\n'),
  }), 'dsh-ssh-files-sidebar: persistent observed deployment memory guidance')
}
