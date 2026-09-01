const RUNBOOK_WRITE_TOOL = 'deployment_runbook_write'
const LINKED_SSH_EXEC_TOOL = 'linked_ssh_exec'

const HIGH_RISK_RE = /(?:\brm\s+(?:-[^\s]*r[^\s]*|--recursive)\b|\bfind\b[^\n]*(?:-delete|-exec)\b|\b(?:mkfs|fdisk|parted)\b|\bdd\b[^\n]*\bof=|\b(?:iptables|nft|ufw|firewall-cmd)\b|\b(?:apt(?:-get)?|yum|dnf)\b[^\n]*\b(?:install|remove|purge|upgrade|dist-upgrade)\b|\b(?:rpm|dpkg)\b[^\n]*(?:-[iUe]|--install|--erase)|\b(?:reboot|shutdown|poweroff|halt)\b|\b(?:DROP|TRUNCATE|ALTER\s+TABLE|DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b)/i

// The only automation shape we reject at the Runbook boundary is a generated
// one-click deployment wrapper. Compound commands that stay visible inside
// DEPLOYMENT.md are intentionally allowed: variables, $(...), pipes, &&/||,
// if/else, loops, heredocs, and multi-line shell blocks can all be useful when
// they make the operator-visible procedure more accurate.
const ONE_CLICK_SCRIPT_NAME_RE = /(?:deploy(?:ment)?|redeploy|restart|rollback|release|publish|start[-_]?service|stop[-_]?service)[^\\/\s]*\.(?:sh|bash|zsh|ps1|cmd|bat|py)\b/i
const SCRIPT_CREATION_CONTEXT_RE = /(?:\b(?:cat|echo|printf|tee|set-content|out-file|new-item)\b|(?:^|\s)(?:>|>>))/i
const SCRIPT_EXEC_CONTEXT_RE = /(?:^|\s)(?:bash|sh|zsh|pwsh|powershell(?:\.exe)?|\.\/?|\.\\|[A-Za-z]:[\\/])/i

function objectString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : null
}

function runbookContainsGeneratedOneClickScript(content: string): boolean {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let fenced = false
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (!fenced || !ONE_CLICK_SCRIPT_NAME_RE.test(line)) continue
    if (SCRIPT_CREATION_CONTEXT_RE.test(line) || SCRIPT_EXEC_CONTEXT_RE.test(line)) return true
  }
  return false
}

/**
 * Deployment command transparency layer.
 *
 * 0.8.1 deliberately relaxes the old "one command per step" restriction.
 * Visible compound shell is fine; the boundary only prevents DEPLOYMENT.md
 * from becoming a launcher for a generated one-click deploy/restart/rollback
 * script, while unusually high-risk remote commands still use the runtime's
 * native approval checkpoint.
 */
export function installDeploymentCommandReview(ctx: any): void {
  ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
    if (exec?.name === RUNBOOK_WRITE_TOOL) {
      const content = objectString(exec.arguments, 'content')
      if (content !== null && runbookContainsGeneratedOneClickScript(content)) {
        return {
          kind: 'deny',
          reason: 'DEPLOYMENT.md 可以包含变量、条件判断、循环、命令替换、&&/||、管道和多行复合命令；但不要把整套部署/重启/回滚流程再生成成 deploy/restart/rollback 等一键脚本文件后调用。请把实际逻辑直接保留在 Runbook 中供用户查看。',
        }
      }
      return await next()
    }

    if (exec?.name !== LINKED_SSH_EXEC_TOOL) return await next()
    const command = objectString(exec.arguments, 'command')
    if (command === null || command.trim() === '') return await next()

    // Compound remote commands are allowed in 0.8.1. The user can review a
    // complete visible shell block as one logical deployment step. Only truly
    // high-risk operations need an additional native approval checkpoint.
    if (HIGH_RISK_RE.test(command)) {
      return {
        kind: 'ask',
        reason: '这是高风险远程操作（可能涉及递归删除、数据库修改、系统/防火墙/软件包变更、磁盘操作或重启）。请核对已展示的精确命令后，仅批准本次调用。',
      }
    }

    return await next()
  }, { prepend: true })

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-deployment-command-transparency',
    order: 157,
    text: () => [
      '## Deployment command transparency (0.8.1)',
      'For project deployment/service-management work, keep the procedure visible to the operator. The goal is transparency, not forcing every shell token into a separate command.',
      'DEPLOYMENT.md MAY contain compound shell when that is the clearest representation of the real procedure: variable assignments, command substitution `$(...)`, pipes, `&&` / `||` / `;`, multi-line blocks, if/else, loops, heredocs, and similar shell control flow are allowed. Do not reject or rewrite a valid Runbook merely because it uses these constructs.',
      'It is also fine to group several tightly related shell lines into one logical REMOTE or VERIFY step, as long as the full command/block is shown in DEPLOYMENT.md and is readable before execution.',
      'The main prohibition is generating a new one-click deploy/restart/rollback wrapper script (.ps1/.sh/.bat/.cmd/.py) that hides the actual sequence and then telling the user to run that script. Keep the real commands visible in DEPLOYMENT.md instead. If the project already has a maintained deployment script, or the user explicitly asks to use/create a script, treat that as an explicit exception and explain what the script does before running it.',
      'Before proposing commands, inspect the real LOCAL project and the current session-bound REMOTE server with read-only checks. Reconcile the user\'s historical/reference commands against the actual installed tools, paths, runtime, service manager, ports, logs, current process/version, permissions and disk space.',
      'Present the final plan as logical steps marked LOCAL / TRANSFER / REMOTE / VERIFY / ROLLBACK. Show the exact command or shell block that may later run, plus a short purpose and success condition. A logical step may contain a compound command when that mirrors the real operational procedure better than artificially splitting it.',
      'Use the native `ask_user_question` tool when it is available for plan review, choices, or confirmation instead of ending with a plain-text “是否继续？”. Keep the card concise and single-select. Good choices are: “继续修改命令”, “保存文档但不执行”, and “保存并按已展示计划执行”.',
      'If the user chooses execution, execute only commands/blocks that were already shown and approved, in order, and inspect the result after each logical step. If output is unexpected, a path/version/target changes, or a replacement command becomes necessary, STOP before the new mutation, show the replacement command, and confirm again.',
      'High-risk operations (database restore/migration, destructive recursive deletion, firewall/system-package/config/credential changes, disk operations, host reboot) remain separate checkpoints and may trigger the runtime\'s native per-tool approval UI even when they are part of an otherwise approved compound block.',
      '`ask_user_question` is for plan/choice UX; never treat it as a replacement for a runtime approval prompt when one appears.',
      'Set deployment_runbook_write.confirmedByUser=true only after the user explicitly confirms the final visible plan (through the native question card or an equally explicit text reply).',
    ].join('\n'),
  }), 'dsh-ssh-files-sidebar: deployment command transparency guidance')
}
