import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { LinkedSshBindingStore } from './linked-ssh.ts'
import { remoteWorkspaceFromCwd } from './remote-workspace-safety.ts'
import { cwdFromAgentLike, effectiveSessionSshAlias } from './session-ssh-target.ts'

const RUNBOOK_NAME = 'DEPLOYMENT.md'
const MAX_RUNBOOK_BYTES = 512 * 1024
const RUNBOOK_VERSION = '1'

interface RunbookMeta {
  version: string | null
  project: string | null
  targetSsh: string | null
  remoteRoot: string | null
  environment: string | null
}

interface RunbookStatus {
  workspace: string
  runbookPath: string
  exists: boolean
  size: number
  sha256: string | null
  project: string | null
  targetSsh: string | null
  currentSsh: string | null
  targetMatches: boolean | null
  warnings: string[]
}

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

function localWorkspace(value: any): string {
  const cwd = cwdFromAgentLike(value)
  if (cwd === undefined) throw new Error('当前会话没有可识别的 Workspace cwd。')
  if (remoteWorkspaceFromCwd(cwd) !== null) {
    throw new Error('DEPLOYMENT.md 必须保存在真实本地项目 Workspace 中，而不是 dsh-rw Remote Workspace 占位目录。请打开本地项目并在会话顶部绑定目标 SSH 服务器。')
  }
  let stat
  try {
    stat = statSync(cwd)
  } catch {
    throw new Error(`当前本地 Workspace 不存在或不可访问：${cwd}`)
  }
  if (!stat.isDirectory()) throw new Error(`当前 Workspace 不是目录：${cwd}`)
  return cwd
}

function runbookPath(workspace: string): string {
  return join(workspace, RUNBOOK_NAME)
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
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

function parseMeta(content: string): RunbookMeta {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') {
    return { version: null, project: null, targetSsh: null, remoteRoot: null, environment: null }
  }

  const values = new Map<string, string>()
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim() === '---') break
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    values.set(match[1]!.toLowerCase(), stripScalar(match[2] ?? ''))
  }

  const nullable = (key: string): string | null => {
    const value = values.get(key)
    return value === undefined || value === '' ? null : value
  }

  return {
    version: nullable('dsh-deployment-version'),
    project: nullable('project'),
    targetSsh: nullable('target-ssh'),
    remoteRoot: nullable('remote-root'),
    environment: nullable('environment'),
  }
}

function validationWarnings(content: string, meta: RunbookMeta, currentSsh: string | null): string[] {
  const warnings: string[] = []
  if (meta.version !== RUNBOOK_VERSION) warnings.push(`frontmatter 缺少或不支持 dsh-deployment-version: ${RUNBOOK_VERSION}`)
  if (meta.project === null) warnings.push('frontmatter 缺少 project')
  if (meta.targetSsh === null) warnings.push('frontmatter 缺少 target-ssh；远程部署无法绑定到唯一服务器')
  if (meta.remoteRoot === null) warnings.push('frontmatter 缺少 remote-root')
  if (currentSsh !== null && meta.targetSsh !== null && meta.targetSsh !== currentSsh) {
    warnings.push(`目标服务器不匹配：DEPLOYMENT.md 要求 ${meta.targetSsh}，当前会话锁定 ${currentSsh}`)
  }
  if (!/(部署前检查|preflight)/i.test(content)) warnings.push('缺少部署前检查（Preflight）章节')
  if (!/(部署验证|verification|health\s*check)/i.test(content)) warnings.push('缺少部署验证 / Health Check 章节')
  if (!/(回滚|rollback)/i.test(content)) warnings.push('缺少回滚（Rollback）章节')
  if (!/(禁止事项|safety|安全边界)/i.test(content)) warnings.push('缺少禁止事项 / 安全边界章节')
  return warnings
}

function readRunbookFile(path: string): { content: string; size: number; digest: string } {
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error(`${path} 不是普通文件`)
  if (stat.size > MAX_RUNBOOK_BYTES) {
    throw new Error(`${RUNBOOK_NAME} 过大：${stat.size} bytes，当前上限为 ${MAX_RUNBOOK_BYTES} bytes`)
  }
  const content = readFileSync(path, 'utf8')
  return { content, size: Buffer.byteLength(content, 'utf8'), digest: sha256(content) }
}

function statusFor(store: LinkedSshBindingStore, value: any): RunbookStatus {
  const workspace = localWorkspace(value)
  const path = runbookPath(workspace)
  const currentSsh = effectiveSessionSshAlias(store, value)
  if (!existsSync(path)) {
    return {
      workspace,
      runbookPath: path,
      exists: false,
      size: 0,
      sha256: null,
      project: null,
      targetSsh: null,
      currentSsh,
      targetMatches: null,
      warnings: ['当前项目还没有 DEPLOYMENT.md'],
    }
  }

  const file = readRunbookFile(path)
  const meta = parseMeta(file.content)
  return {
    workspace,
    runbookPath: path,
    exists: true,
    size: file.size,
    sha256: file.digest,
    project: meta.project,
    targetSsh: meta.targetSsh,
    currentSsh,
    targetMatches: meta.targetSsh === null || currentSsh === null ? null : meta.targetSsh === currentSsh,
    warnings: validationWarnings(file.content, meta, currentSsh),
  }
}

function statusText(status: RunbookStatus): string {
  const lines = [
    `workspace: ${status.workspace}`,
    `runbook: ${status.runbookPath}`,
    `exists: ${status.exists}`,
    `current SSH: ${status.currentSsh ?? '(none)'}`,
  ]
  if (status.exists) {
    lines.push(`project: ${status.project ?? '(missing)'}`)
    lines.push(`target SSH: ${status.targetSsh ?? '(missing)'}`)
    lines.push(`sha256: ${status.sha256}`)
  }
  if (status.warnings.length > 0) lines.push(`warnings:\n- ${status.warnings.join('\n- ')}`)
  return lines.join('\n')
}

function templateFor(workspace: string, alias: string | null): string {
  const project = basename(workspace) || 'project'
  const target = alias ?? '<SSH_ALIAS>'
  return `---
dsh-deployment-version: 1
project: ${project}
target-ssh: ${target}
remote-root: <REMOTE_PROJECT_ROOT>
environment: production
---

# ${project} 项目部署规范

> 这份 Runbook 是本项目的稳定部署知识。修改部署顺序、服务名、目录、端口或回滚方式前，先核对真实环境，并由用户确认后更新本文档。

## 1. 项目边界与安全规则

- 本地 Workspace：\`${workspace}\`
- 唯一目标 SSH：\`${target}\`
- 远程项目目录：\`<REMOTE_PROJECT_ROOT>\`
- 禁止操作其他 SSH 主机。
- 任何停止服务、覆盖版本、删除文件、切换软链、数据库迁移等有副作用步骤，在正式执行前都必须先展示本次执行计划并获得用户明确确认。
- 本地命令只在 LOCAL 执行；服务器命令只通过当前会话的 session-bound SSH 工具在 REMOTE 执行。

## 2. 部署前检查（Preflight）

### LOCAL

确认项目目录、依赖管理器、构建命令、当前分支/版本以及磁盘空间。这里只做只读检查，不修改项目。

\`\`\`bash
# TODO: 填入本地只读检查命令
\`\`\`

成功条件：

- TODO

### REMOTE

确认目标服务器身份、远程目录、服务管理方式、当前运行状态、磁盘空间、端口和日志位置。这里只做只读检查。

\`\`\`bash
# TODO: 填入服务器只读检查命令
\`\`\`

成功条件：

- TODO

## 3. 本地构建（LOCAL）

\`\`\`bash
# TODO: install / build
\`\`\`

构建产物：\`<LOCAL_ARTIFACT>\`

## 4. 本地打包（LOCAL）

\`\`\`bash
# TODO: package command
\`\`\`

打包产物：\`<LOCAL_PACKAGE>\`

## 5. 文件传输（LOCAL -> REMOTE）

- 本地源：\`<LOCAL_PACKAGE>\`
- 远程临时路径：\`<REMOTE_STAGING_PATH>\`
- 传输方式：使用当前会话的 \`linked_ssh_upload\`，不要手工选择其他服务器。

## 6. 发布（REMOTE）

按真实环境填写，并尽量把“停服务”放到上传和部署前检查都成功之后，缩短停机时间。

1. TODO：备份当前版本
2. TODO：停止服务
3. TODO：发布新版本
4. TODO：启动服务

## 7. 部署验证（Verification / Health Check）

\`\`\`bash
# TODO: service status / curl health endpoint / log check
\`\`\`

成功条件：

- TODO：服务状态
- TODO：健康检查
- TODO：关键日志无异常

## 8. 回滚（Rollback）

触发条件：新版本启动失败、Health Check 失败或关键日志出现阻断性错误。

1. TODO：停止失败的新版本
2. TODO：恢复最近一次可用版本
3. TODO：重新启动服务
4. TODO：再次执行健康检查

> 0.7.0 默认不自动回滚。除非本文档明确写明“允许自动回滚”并定义完整条件，否则 Agent 先向用户报告失败并请求确认。

## 9. 禁止事项 / Safety

- 不允许绕过 \`target-ssh\` 操作其他服务器。
- 不允许跳过 Preflight 和部署后的 Verification。
- 不允许在没有备份/回滚路径时直接删除旧版本。
- 不允许把 LOCAL 路径当成 REMOTE 路径，或把 REMOTE 路径交给本地文件工具。
- 数据库迁移、不可逆删除、凭据变更等高风险操作必须单独说明并再次确认。
`
}

const STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workspace: { type: 'string' },
    runbookPath: { type: 'string' },
    exists: { type: 'boolean' },
    size: { type: 'integer' },
    sha256: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    project: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    targetSsh: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    currentSsh: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    targetMatches: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['workspace', 'runbookPath', 'exists', 'size', 'sha256', 'project', 'targetSsh', 'currentSsh', 'targetMatches', 'warnings'],
} as const

/**
 * Project Deployment Runbook v1.
 *
 * DEPLOYMENT.md lives only in a real LOCAL project Workspace. It describes the
 * stable LOCAL -> TRANSFER -> REMOTE -> VERIFY / ROLLBACK workflow for that one
 * project, while the existing session SSH lock remains the authority for which
 * server may actually be touched.
 */
export function installDeploymentRunbook(ctx: any, store: LinkedSshBindingStore): void {
  const statusTool = {
    name: 'deployment_runbook_status',
    description: 'Inspect the current LOCAL project deployment Runbook (DEPLOYMENT.md): existence, hash, target SSH and validation warnings. Call this before creating/updating a runbook and before executing a project deployment.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: STATUS_OUTPUT_SCHEMA,
      render: (_args: any, value: RunbookStatus) => text(statusText(value)),
    },
    async execute(_args: Record<string, never>, exec: any): Promise<RunbookStatus> {
      return statusFor(store, exec)
    },
  }

  const readTool = {
    name: 'deployment_runbook_read',
    description: 'Read DEPLOYMENT.md from the current LOCAL project Workspace. Use it as the source of truth before deployment. Never substitute a runbook from another Workspace.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: STATUS_OUTPUT_SCHEMA,
          content: { type: 'string' },
        },
        required: ['status', 'content'],
      },
      render: (_args: any, value: { status: RunbookStatus; content: string }) => text(`${statusText(value.status)}\n\n${value.content}`),
    },
    async execute(_args: Record<string, never>, exec: any): Promise<{ status: RunbookStatus; content: string }> {
      const status = statusFor(store, exec)
      if (!status.exists) throw new Error(`当前项目没有 ${RUNBOOK_NAME}。先整理部署命令、核对环境、让用户确认顺序，然后再创建。`)
      const file = readRunbookFile(status.runbookPath)
      return { status, content: file.content }
    },
  }

  const templateTool = {
    name: 'deployment_runbook_template',
    description: 'Return the canonical DEPLOYMENT.md scaffold for the current LOCAL project and current session SSH target. Use it when drafting a first runbook, then replace TODO placeholders with facts verified from the local project and server.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspace: { type: 'string' },
          currentSsh: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          content: { type: 'string' },
        },
        required: ['workspace', 'currentSsh', 'content'],
      },
      render: (_args: any, value: { workspace: string; currentSsh: string | null; content: string }) => text(value.content),
    },
    async execute(_args: Record<string, never>, exec: any) {
      const workspace = localWorkspace(exec)
      const currentSsh = effectiveSessionSshAlias(store, exec)
      return { workspace, currentSsh, content: templateFor(workspace, currentSsh) }
    },
  }

  const writeTool = {
    name: 'deployment_runbook_write',
    description: 'Create or replace DEPLOYMENT.md in the current LOCAL Workspace after the user has explicitly confirmed the proposed command/order plan. Existing files require the sha256 returned by deployment_runbook_read/status to prevent stale overwrites.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'replace'], description: 'create fails if DEPLOYMENT.md exists; replace fails if it does not exist.' },
        content: { type: 'string', description: 'Complete DEPLOYMENT.md content. It must use dsh-deployment-version: 1 frontmatter and should contain verified LOCAL / TRANSFER / REMOTE / Verification / Rollback instructions.' },
        expectedSha256: { type: 'string', description: 'Required for replace. Must equal the current DEPLOYMENT.md sha256 from a fresh read/status.' },
        confirmedByUser: { type: 'boolean', description: 'Set true only after the user explicitly confirms the proposed deployment command order / runbook update.' },
      },
      required: ['action', 'content', 'confirmedByUser'],
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
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['created', 'path', 'sha256', 'bytes', 'warnings'],
      },
      render: (_args: any, value: { created: boolean; path: string; sha256: string; bytes: number; warnings: string[] }) => text([
        `${value.created ? 'created' : 'updated'} ${value.path}`,
        `sha256: ${value.sha256}`,
        `bytes: ${value.bytes}`,
        ...(value.warnings.length === 0 ? ['validation: OK'] : [`warnings:\n- ${value.warnings.join('\n- ')}`]),
      ].join('\n')),
    },
    async execute(args: { action: 'create' | 'replace'; content: string; expectedSha256?: string; confirmedByUser: boolean }, exec: any) {
      if (args.confirmedByUser !== true) {
        throw new Error('DEPLOYMENT.md 写入被阻止：必须先向用户展示本地/传输/服务器命令的最终顺序并获得明确确认。')
      }
      if (typeof args.content !== 'string' || args.content.trim() === '') throw new Error('DEPLOYMENT.md 内容不能为空')
      if (args.content.includes('\0')) throw new Error('DEPLOYMENT.md 内容包含 NUL 字符，拒绝写入')
      const bytes = Buffer.byteLength(args.content, 'utf8')
      if (bytes > MAX_RUNBOOK_BYTES) throw new Error(`DEPLOYMENT.md 过大：${bytes} bytes，上限 ${MAX_RUNBOOK_BYTES} bytes`)

      const workspace = localWorkspace(exec)
      const path = runbookPath(workspace)
      const exists = existsSync(path)
      if (args.action === 'create' && exists) throw new Error(`${RUNBOOK_NAME} 已存在；先调用 deployment_runbook_read，然后使用 replace + expectedSha256。`)
      if (args.action === 'replace' && !exists) throw new Error(`${RUNBOOK_NAME} 不存在；请使用 create。`)
      if (args.action === 'replace') {
        const current = readRunbookFile(path)
        if (typeof args.expectedSha256 !== 'string' || args.expectedSha256 === '') {
          throw new Error('replace 必须提供 fresh deployment_runbook_read/status 返回的 expectedSha256，避免覆盖用户刚修改的 Runbook。')
        }
        if (args.expectedSha256 !== current.digest) {
          throw new Error(`DEPLOYMENT.md 已发生变化（expected ${args.expectedSha256}, current ${current.digest}）。请重新读取、重新核对并再次确认后再更新。`)
        }
      }

      const meta = parseMeta(args.content)
      if (meta.version !== RUNBOOK_VERSION) {
        throw new Error(`DEPLOYMENT.md frontmatter 必须包含 dsh-deployment-version: ${RUNBOOK_VERSION}`)
      }
      const currentSsh = effectiveSessionSshAlias(store, exec)
      if (currentSsh !== null) {
        if (meta.targetSsh === null) throw new Error(`当前会话锁定 SSH "${currentSsh}"，DEPLOYMENT.md 必须在 frontmatter 写入 target-ssh: ${currentSsh}`)
        if (meta.targetSsh !== currentSsh) {
          throw new Error(`DEPLOYMENT.md target-ssh=${meta.targetSsh} 与当前会话唯一 SSH=${currentSsh} 不一致，拒绝写入。请先切换到正确服务器或修正文档。`)
        }
      }

      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, args.content.endsWith('\n') ? args.content : `${args.content}\n`, 'utf8')
      renameSync(tmp, path)
      const written = readRunbookFile(path)
      const writtenMeta = parseMeta(written.content)
      return {
        created: !exists,
        path,
        sha256: written.digest,
        bytes: written.size,
        warnings: validationWarnings(written.content, writtenMeta, currentSsh),
      }
    },
  }

  ctx.effect(() => {
    const disposers = [statusTool, readTool, templateTool, writeTool].map(tool => ctx.tools.register(tool))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-ssh-files-sidebar: project deployment runbook tools')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-project-deployment-runbook',
    order: 156,
    text: (context: any) => {
      const cwd = cwdFromAgentLike(context)
      if (cwd === undefined) return ''
      if (remoteWorkspaceFromCwd(cwd) !== null) {
        return [
          '## Project deployment Runbook',
          'This conversation is a dsh-rw Remote Workspace. Do NOT create a project DEPLOYMENT.md inside the placeholder Workspace.',
          'The deployment-runbook workflow is designed for a real LOCAL source Workspace plus one session-bound SSH target: local build/package work stays local, transfer is explicit, and remote service operations stay on the locked server.',
        ].join('\n')
      }

      let status: RunbookStatus
      try {
        status = statusFor(store, context)
      } catch {
        return ''
      }

      const state = status.exists
        ? `DEPLOYMENT.md exists at ${status.runbookPath}; target SSH is ${status.targetSsh ?? '(missing)'}, current session SSH is ${status.currentSsh ?? '(none)'}.`
        : `No DEPLOYMENT.md exists yet in ${status.workspace}; current session SSH is ${status.currentSsh ?? '(none)'}.`
      const mismatch = status.targetMatches === false
        ? `STOP: the Runbook target (${status.targetSsh}) does not match the current session SSH (${status.currentSsh}). Do not execute deployment steps until the user switches the session to the Runbook target.`
        : ''

      return [
        '## Project deployment Runbook (DEPLOYMENT.md)',
        state,
        mismatch,
        'Treat DEPLOYMENT.md as this Workspace project’s stable deployment/operations Runbook. Never borrow a Runbook from another Workspace.',
        '',
        'When the user gives old deployment commands or asks to create/repair deployment documentation:',
        '1. Do NOT immediately run mutating deployment commands. First classify every command/step as LOCAL, TRANSFER (LOCAL -> REMOTE), REMOTE, VERIFY, or ROLLBACK.',
        '2. Inspect the real LOCAL project with read-only tools actually available to this agent, and inspect ONLY the current session SSH target with linked_ssh_* read-only commands. Verify build scripts, artifact paths, remote directory, service manager/name, ports, logs, disk space and health checks instead of blindly trusting old copied commands.',
        '3. Improve the order to reduce downtime and risk: finish local build/package + remote preflight + upload before stopping the service when practical; define backup, verification and rollback.',
        '4. Show the user the proposed final ordered plan, explicitly marking LOCAL / TRANSFER / REMOTE / VERIFY / ROLLBACK, plus any unresolved assumptions. Ask the user to confirm/correct that plan.',
        '5. Only AFTER explicit user confirmation, create/update DEPLOYMENT.md with deployment_runbook_write. Existing Runbooks must be freshly read and replaced with expectedSha256.',
        '',
        'When the user later asks to deploy/manage this project:',
        '1. Call deployment_runbook_status and deployment_runbook_read first. DEPLOYMENT.md is the source of truth for project-specific commands and order.',
        '2. Enforce target-ssh: it must equal the current session SSH lock. A mismatch is a hard stop; never enumerate or switch to another configured host yourself.',
        '3. Perform read-only Preflight checks first. Then present the exact execution plan for THIS run and ask for explicit confirmation before uploads, service stop/restart, replacing files, deletion, migrations or other side effects.',
        '4. After confirmation, execute LOCAL steps locally, TRANSFER with linked_ssh_upload/download, and REMOTE/VERIFY steps only through the current session-bound SSH tools. Never send local paths to remote tools or remote paths to local tools.',
        '5. Verify service status/health/logs after deployment. In version 0.7.0, do not auto-rollback unless the Runbook explicitly allows automatic rollback with complete trigger conditions; otherwise report the failure and ask before rollback.',
      ].filter(Boolean).join('\n')
    },
  }), 'dsh-ssh-files-sidebar: project deployment runbook guidance')
}
