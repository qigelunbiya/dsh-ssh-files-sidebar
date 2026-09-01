const RUNBOOK_WRITE_TOOL = 'deployment_runbook_write'
const LINKED_SSH_EXEC_TOOL = 'linked_ssh_exec'

const SIDE_EFFECT_RE = /(?:\b(?:rm|mv|cp|mkdir|rmdir|touch|truncate|chmod|chown|chgrp|ln|kill|pkill|killall|nohup|tee|dd|mount|umount|reboot|shutdown)\b|(?:^|\s)install\s+|\bsystemctl\s+(?:start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)\b|\bservice\s+\S+\s+(?:start|stop|restart|reload)\b|\b(?:docker|podman)\s+(?:run|start|stop|restart|rm|rmi|pull|push|build|exec)\b|\b(?:docker|podman)\s+compose\s+(?:up|down|start|stop|restart|rm|pull|build)\b|\bpm2\s+(?:start|stop|restart|reload|delete|save)\b|\bsupervisorctl\s+(?:start|stop|restart|reload|update)\b|\bsed\s+[^\n]*-i\b|\bgit\s+(?:pull|checkout|switch|reset|clean|merge|rebase)\b|\bapt(?:-get)?\s+[^\n]*\b(?:install|remove|purge|upgrade|dist-upgrade)\b|\b(?:yum|dnf)\s+[^\n]*\b(?:install|remove|erase|upgrade|update)\b|\b(?:rpm|dpkg)\b[^\n]*(?:-[iUe]|--install|--erase)|\bpip\s+install\b|\bnpm\s+(?:install|ci)\b|\bpnpm\s+install\b|\byarn\s+install\b)/i
const HIGH_RISK_RE = /(?:\brm\s+(?:-[^\s]*r[^\s]*|--recursive)\b|\bfind\b[^\n]*(?:-delete|-exec)\b|\b(?:mkfs|fdisk|parted)\b|\bdd\b[^\n]*\bof=|\b(?:iptables|nft|ufw|firewall-cmd)\b|\b(?:apt(?:-get)?|yum|dnf)\b[^\n]*\b(?:install|remove|purge|upgrade|dist-upgrade)\b|\b(?:rpm|dpkg)\b[^\n]*(?:-[iUe]|--install|--erase)|\b(?:reboot|shutdown|poweroff|halt)\b|\b(?:DROP|TRUNCATE|ALTER\s+TABLE|DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b)/i
const SCRIPT_CREATION_RE = /(?:\bcat\s*>|\btee\s+|\bset-content\b|\bout-file\b)[^\n]*\.(?:sh|bash|zsh|ps1|cmd|bat|py)\b/i
const SCRIPT_EXEC_RE = /(?:^|\s)(?:bash|sh|zsh)\s+(?:[^\n]*\/)?(?:deploy|deployment|restart|rollback|release)[^\s]*\.(?:sh|bash|zsh)\b|(?:^|\s)(?:\.\/|\/\S*\/)(?:deploy|deployment|restart|rollback|release)[^\s]*\.(?:sh|bash|zsh)\b|(?:^|\s)(?:pwsh|powershell(?:\.exe)?)\b[^\n]*(?:deploy|deployment|restart|rollback|release)[^\s]*\.ps1\b/i
const CONTROL_FLOW_RE = /(?:^|[\s;])(?:if|then|elif|else|fi|for|while|until|case|esac|do|done)\b|<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*|(?:^|\s)(?:bash|sh|zsh)\s+-c\b|(?:^|\s)(?:pwsh|powershell(?:\.exe)?)\s+-(?:command|file)\b/i
const COMPOUND_RE = /\r|\n|&&|\|\||;/

function objectString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : null
}

function isOpaqueMutatingCommand(command: string): boolean {
  if (!SIDE_EFFECT_RE.test(command)) return false
  return COMPOUND_RE.test(command) || CONTROL_FLOW_RE.test(command) || SCRIPT_EXEC_RE.test(command)
}

function runbookContainsOpaqueAutomation(content: string): boolean {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let fenced = false
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (!fenced) continue
    if (SCRIPT_CREATION_RE.test(line) || SCRIPT_EXEC_RE.test(line) || isOpaqueMutatingCommand(line)) return true
  }
  return false
}

/**
 * Deployment command transparency layer.
 *
 * 0.7.1 keeps the runbook as human-reviewable commands instead of turning it
 * into a generated one-click script. The system prompt owns the normal flow;
 * the pre-execute hook is only a last-resort fence against opaque/batched
 * remote mutations and a native approval checkpoint for unusually high-risk
 * single remote commands.
 */
export function installDeploymentCommandReview(ctx: any): void {
  ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
    if (exec?.name === RUNBOOK_WRITE_TOOL) {
      const content = objectString(exec.arguments, 'content')
      if (content !== null && runbookContainsOpaqueAutomation(content)) {
        return {
          kind: 'deny',
          reason: 'DEPLOYMENT.md 必须保存为可逐条核对的命令 Runbook，拒绝写入一键部署/重启/回滚脚本、脚本生成命令或包含写操作的复合 shell 流程。请拆成独立步骤和独立命令后再保存。',
        }
      }
      return await next()
    }

    if (exec?.name !== LINKED_SSH_EXEC_TOOL) return await next()
    const command = objectString(exec.arguments, 'command')
    if (command === null || command.trim() === '') return await next()

    if (isOpaqueMutatingCommand(command)) {
      return {
        kind: 'deny',
        reason: '拒绝执行黑盒/批量远程写操作：部署和服务管理命令必须拆成可单独核对的一条命令。不要使用一键脚本、控制流、分号、&&/|| 串联多个写操作；请改用绝对路径并逐条执行。',
      }
    }

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
      '## Deployment command transparency (0.7.1)',
      'For project deployment/service-management work, use a command-first workflow, not a script-first workflow.',
      'Never create, recommend, or prefer a one-click deploy/restart/rollback helper script (.sh/.ps1/.bat/.cmd/.py) unless the user explicitly asks for a script. DEPLOYMENT.md is an operator-readable Runbook, not an executable deployment program.',
      'Before proposing commands, inspect the real LOCAL project and the current session-bound REMOTE server with read-only checks. Reconcile the user\'s historical/reference commands against the actual installed tools, paths, Java/runtime, service manager, ports, logs, current process/version, permissions and disk space. Do not make the user debug commands that could have been verified read-only first.',
      'Present the final plan as numbered steps marked LOCAL / TRANSFER / REMOTE / VERIFY / ROLLBACK. Show every exact command the operator may later run. Prefer one command per code block (or one clearly separated command line), with a short purpose and success condition. Do not hide stop + copy + start + verify inside one large shell block.',
      'Prefer absolute paths over `cd ... && ...`. A pipe used only to filter read-only output is fine, but do not chain multiple state-changing actions with `;`, `&&`, `||`, shell loops/conditionals, heredocs, or `sh -c`/`bash -c`.',
      'Use the native `ask_user_question` tool when it is available for plan review, choices, or confirmation instead of ending with a plain-text “是否继续？”. Keep the card concise and single-select. Good choices are: “继续修改命令”, “保存文档但不执行”, and “保存并按已展示命令逐条执行”.',
      'If the user chooses execution, execute only the exact commands that were already shown and approved, in order. Read the result after each command. If output is unexpected, a path/version/target changes, or a replacement command becomes necessary, STOP before the new mutation, show the replacement command, and use `ask_user_question` again.',
      'Do not ask again merely because another already-reviewed ordinary command is next. The point of the review card is that the user can inspect the transparent command list once and then allow sequential execution. High-risk operations (database restore/migration, destructive recursive deletion, firewall/system-package/config/credential changes, disk operations, host reboot) remain separate checkpoints and may also trigger the runtime\'s native per-tool approval UI.',
      '`ask_user_question` is for plan/choice UX; never treat it as a replacement for a runtime approval prompt when one appears.',
      'Set deployment_runbook_write.confirmedByUser=true only after the user explicitly confirms the final command plan (through the native question card or an equally explicit text reply).',
    ].join('\n'),
  }), 'dsh-ssh-files-sidebar: deployment command transparency guidance')
}
