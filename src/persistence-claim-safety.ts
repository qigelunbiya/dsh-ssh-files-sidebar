import { remoteWorkspaceFromCwd } from './remote-workspace-safety.ts'
import { cwdFromAgentLike } from './session-ssh-target.ts'

const RUNBOOK_NAME = 'DEPLOYMENT.md'
const DIRECT_FILE_MUTATORS = new Set(['write', 'edit', 'str_replace_editor'])
const SHELL_MUTATORS = new Set(['pwsh', 'bash'])

function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) return out
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return out
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out, depth + 1)
  }
  return out
}

function argumentsOf(exec: any): unknown {
  return exec?.arguments ?? exec?.args ?? exec?.input ?? null
}

function mentionsDeploymentRunbook(exec: any): boolean {
  return collectStrings(argumentsOf(exec)).some(value => /(^|[\\/])DEPLOYMENT\.md(?:$|[\s"'`])/i.test(value) || /\bDEPLOYMENT\.md\b/i.test(value))
}

function shellLooksMutating(exec: any): boolean {
  const text = collectStrings(argumentsOf(exec)).join('\n')
  if (text.trim() === '') return false
  if (exec?.name === 'pwsh') {
    return /(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|\bdel\b|\berase\b|\bmove\b|\bcopy\b|>>?|\|\s*Tee-Object)\b?/i.test(text)
  }
  if (exec?.name === 'bash') {
    return /(?:\b(?:touch|rm|mv|cp|install|truncate)\b|\bsed\s+-[^\n]*i\b|\btee\b|>>?|\bcat\b[^\n]*>)/i.test(text)
  }
  return false
}

function blockedRunbookWriteResult(cwd: string | undefined, alias: string, remotePath: string): any {
  const message = [
    `拒绝把 ${RUNBOOK_NAME} 写入 dsh-rw Remote Workspace 占位会话。`,
    `当前会话是远程工作区 ${alias}:${remotePath}${cwd ? `（本机占位 cwd: ${cwd}）` : ''}。`,
    `${RUNBOOK_NAME} 是项目级持久部署记忆，必须落在真实 LOCAL 项目目录；~/.dsh/remote-workspaces/... 不是用户的本地项目目录，也不能把远端写入冒充成本地持久化。`,
    '请切换/打开真实本地项目 Workspace，并在该本地会话中使用 Linked SSH 绑定目标服务器；然后使用 deployment_runbook_record_observed / deployment_runbook_project_status 记录并验证部署知识。',
    '如果用户明确要在远程服务器创建普通文档，请使用不同文件名并明确说明它是 REMOTE 文件，而不是本地 DEPLOYMENT.md。',
  ].join(' ')
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message },
  }
}

/**
 * Prevent two classes of misleading persistence claims:
 *
 * 1. A mutating tool returning normally is not sufficient evidence that a file
 *    is durably present where the user expects it. The model must verify with
 *    an independent read/stat/list/status operation before saying “created”.
 * 2. dsh-rw uses ~/.dsh/remote-workspaces/... as a routing placeholder. A
 *    project DEPLOYMENT.md must never be "persisted" there or on the remote host
 *    while being described as a real local project Runbook.
 */
export function installPersistenceClaimSafety(ctx: any): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-persistence-claim-safety',
    order: 159,
    text: (context: any) => {
      const cwd = cwdFromAgentLike(context)
      const remote = remoteWorkspaceFromCwd(cwd)
      const locationRule = remote === null
        ? [
            'This is a real LOCAL-backed Workspace. Persist project documentation only under the actual project root, and verify the resulting local file before claiming success.',
            'For DEPLOYMENT.md created from observed deployment facts, prefer deployment_runbook_record_observed, then call deployment_runbook_project_status (or another independent local read/stat) and require exists=true before telling the user it was created.',
          ]
        : [
            `This is a dsh-rw REMOTE Workspace (${remote.alias}:${remote.remotePath}); the local cwd under ~/.dsh/remote-workspaces is only a routing placeholder and is NOT the user's real local project directory.`,
            'If the user asks to create a LOCAL project, LOCAL artifact, or project-local DEPLOYMENT.md from this conversation, do not use write/edit/bash/pwsh against the placeholder and do not pretend it is local persistence. Explain that a real local Workspace + Linked SSH conversation is required.',
            'Never use generic write/edit/shell tools to create or modify DEPLOYMENT.md in a Remote Workspace. The runtime also blocks obvious attempts so a nominal tool result cannot be mistaken for durable local memory.',
          ]

      return [
        '## Filesystem persistence claims must be verified',
        'Never say a file/folder was created, updated, moved, deleted, or persisted merely because a mutating tool call returned without an error. Tool success is not the final proof of filesystem state.',
        'After a user-visible filesystem mutation, perform an independent postcondition check in the SAME filesystem and location: read the file back, stat/test it, list its parent directory, or use the dedicated status tool. For important generated files, prefer reading enough content back to confirm the expected file, not only checking the parent directory.',
        'Only claim success when the verification evidence agrees with the intended state. In the final/progress message, ground the claim in concrete evidence such as the verified path, exists=true, size/hash, directory entry, or successfully read content.',
        'If the mutating tool says success but the independent check says the file is absent, inaccessible, on a different filesystem, or otherwise inconsistent, the verification result wins. State that the operation is unverified/failed, investigate the path/routing mismatch, and do not argue with the user or repeat the original success claim.',
        'Do not invent a path from a tool label or UI chip. Distinguish LOCAL, REMOTE, and dsh-rw placeholder paths explicitly.',
        ...locationRule,
      ].join('\n')
    },
  }), 'dsh-ssh-files-sidebar: persistence claim verification guidance')

  ctx.effect(() => ctx.on('tools/execute', async (exec: any, next: () => Promise<any>) => {
    const name = typeof exec?.name === 'string' ? exec.name : ''
    const isDirectMutation = DIRECT_FILE_MUTATORS.has(name)
    const isShellMutation = SHELL_MUTATORS.has(name) && shellLooksMutating(exec)
    if (!isDirectMutation && !isShellMutation) return await next()
    if (!mentionsDeploymentRunbook(exec)) return await next()

    const cwd = cwdFromAgentLike(exec)
    const remote = remoteWorkspaceFromCwd(cwd)
    if (remote === null) return await next()
    return blockedRunbookWriteResult(cwd, remote.alias, remote.remotePath)
  }), 'dsh-ssh-files-sidebar: block remote-workspace DEPLOYMENT.md persistence')
}
