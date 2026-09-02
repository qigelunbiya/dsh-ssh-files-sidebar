const LINKED_SSH_EXEC_TOOL = 'linked_ssh_exec'

const HIGH_RISK_RE = /(?:\brm\s+(?:-[^\s]*r[^\s]*|--recursive)\b|\bfind\b[^\n]*(?:-delete|-exec)\b|\b(?:mkfs|fdisk|parted)\b|\bdd\b[^\n]*\bof=|\b(?:iptables|nft|ufw|firewall-cmd)\b|\b(?:apt(?:-get)?|yum|dnf)\b[^\n]*\b(?:install|remove|purge|upgrade|dist-upgrade)\b|\b(?:rpm|dpkg)\b[^\n]*(?:-[iUe]|--install|--erase)|\b(?:reboot|shutdown|poweroff|halt)\b|\b(?:DROP|TRUNCATE|ALTER\s+TABLE|DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b)/i

function objectString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : null
}

/**
 * Deployment command transparency + maturity guidance.
 *
 * 0.8.2 treats one-click automation as a later maturity stage, not something
 * inherently forbidden. The initial artifact is always an operator-visible
 * DEPLOYMENT.md. After the user has actually used that Runbook and explicitly
 * says the procedure is stable/correct, the Agent may offer to turn the proven
 * workflow into a one-click script. High-risk remote operations still use the
 * runtime's native approval checkpoint regardless of maturity stage.
 */
export function installDeploymentCommandReview(ctx: any): void {
  ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
    if (exec?.name !== LINKED_SSH_EXEC_TOOL) return await next()
    const command = objectString(exec.arguments, 'command')
    if (command === null || command.trim() === '') return await next()

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
      '## Deployment workflow maturity (0.8.2)',
      'Treat deployment automation as a maturity path: visible Runbook first, validated Runbook second, optional one-click automation last.',
      '',
      '### Stage 1 — Runbook first',
      'When a project has no proven deployment workflow yet, the first deliverable MUST be an operator-visible DEPLOYMENT.md. Do not make a newly generated deploy.ps1/deploy.sh/restart.sh/rollback script the primary interface and do not default to “one-click deployment”.',
      'DEPLOYMENT.md may contain compound shell when that is the clearest representation of the real procedure: variable assignments, command substitution `$(...)`, pipes, `&&` / `||` / `;`, multi-line blocks, if/else, loops, heredocs, and similar control flow are allowed. The requirement is visibility, not artificial one-command-per-line splitting.',
      'Before proposing commands, inspect the real LOCAL project and the current session-bound REMOTE server with read-only checks. Reconcile the user\'s historical/reference commands against actual paths, runtime, service manager, ports, logs, current process/version, permissions and disk space.',
      'Present the plan as logical LOCAL / TRANSFER / REMOTE / VERIFY / ROLLBACK steps. Show the exact command or shell block that may later run, plus its purpose and success condition.',
      'Use the native `ask_user_question` tool when available for plan review. Good initial choices are: “继续修改命令”, “保存文档但不执行”, and “保存并按已展示计划执行”.',
      '',
      '### Stage 2 — User validation',
      'A successful tool execution alone does NOT automatically make the Runbook “proven”. The user must explicitly indicate that they have used the current DEPLOYMENT.md and consider the procedure correct/stable enough to automate.',
      'After a deployment run completes successfully, you may ask whether the user considers the current Runbook validated. If they are still adjusting commands, keep working in Runbook form and do not push script generation.',
      '',
      '### Stage 3 — Optional one-click script',
      'Only after the user explicitly says the current DEPLOYMENT.md is validated/stable should you offer an optional automation step such as “要不要把这套已验证流程固化成一键脚本？”. Never generate the script merely because the Runbook exists or because one run happened to succeed.',
      'If the user wants a script, first consult them about HOW they actually use DEPLOYMENT.md. Do not blindly translate the whole document line-for-line. Resolve at least: where they normally launch it (Windows PowerShell / Linux shell / CI / another entry point), which Runbook sections they actually run each time, which values vary between runs (version, artifact, directory, profile, port, etc.), which checkpoints must remain manual, whether build + upload + restart + verification should all be included, desired failure/rollback behavior, and where logs/output should go.',
      'Use concise question cards or short follow-up questions to gather those usage details before writing the script. Prefer choices based on facts already learned from the project instead of asking generic questions the environment inspection can answer.',
      'Then generate the one-click script FROM the validated Runbook plus the user\'s real usage pattern. Preserve the proven commands and safety checks, parameterize the values that actually vary, and avoid inventing extra automation the user did not ask for.',
      'Before writing or running the generated script, show its path, inputs, covered Runbook steps, retained manual checkpoints, failure/rollback behavior, and the actual script content or a sufficiently complete reviewable diff. Ask for explicit confirmation.',
      'Keep DEPLOYMENT.md as the human-readable source of truth even after a script exists. Document the script entry point and how it maps back to the Runbook. If the deployment procedure later changes materially, treat the script as potentially stale: update/test the Runbook first, get the new flow validated, then regenerate or update the automation.',
      'A project-maintained script that already existed before this workflow is not considered a newly hidden black box. It may be used after inspecting what it does and reconciling it with the current Runbook/environment.',
      '',
      '### Execution and approvals',
      'If the user chooses execution, run only commands/blocks or scripts that were already shown and approved, in order, and inspect results at logical checkpoints. If a replacement command becomes necessary, stop before the new mutation, show the replacement, and confirm again.',
      'High-risk operations (database restore/migration, destructive recursive deletion, firewall/system-package/config/credential changes, disk operations, host reboot) remain separate checkpoints and may trigger the runtime\'s native per-tool approval UI even when the surrounding Runbook or one-click script has already been approved.',
      '`ask_user_question` is for workflow/choice UX; never treat it as a replacement for a runtime approval prompt when one appears.',
      'Set deployment_runbook_write.confirmedByUser=true only after the user explicitly confirms the final visible Runbook plan (through the native question card or an equally explicit text reply).',
    ].join('\n'),
  }), 'dsh-ssh-files-sidebar: deployment command transparency guidance')
}
