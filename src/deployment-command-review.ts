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
 * 0.8.3 adds a workflow-habit interview before automation. A validated
 * DEPLOYMENT.md documents the whole operational procedure, but that does NOT
 * mean every documented step belongs in a one-click script. The Agent must
 * first learn how the operator actually performs each stage, including manual
 * hand-offs and actions performed outside DSH, then automate only the subset
 * the user explicitly wants automated.
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
      '## Deployment workflow maturity (0.8.3)',
      'Treat deployment automation as a maturity path: visible Runbook first, user-validated Runbook second, workflow-habit interview third, optional one-click automation last.',
      '',
      '### Stage 1 — Runbook first',
      'When a project has no proven deployment workflow yet, the first deliverable MUST be an operator-visible DEPLOYMENT.md. Do not make a newly generated deploy.ps1/deploy.sh/restart.sh/rollback script the primary interface and do not default to one-click deployment.',
      'DEPLOYMENT.md may contain compound shell when that is the clearest representation of the real procedure: variable assignments, command substitution `$(...)`, pipes, `&&` / `||` / `;`, multi-line blocks, if/else, loops, heredocs, and similar control flow are allowed. The requirement is visibility, not artificial one-command-per-line splitting.',
      'Before proposing commands, inspect the real LOCAL project and the current session-bound REMOTE server with read-only checks. Reconcile historical/reference commands against actual paths, runtime, service manager, ports, logs, current process/version, permissions and disk space.',
      'Present the plan as logical LOCAL / TRANSFER / REMOTE / VERIFY / ROLLBACK steps. Show the exact command or shell block that may later run, plus its purpose and success condition.',
      'Use the native `ask_user_question` tool when available for plan review. Good initial choices are: “继续修改命令”, “保存文档但不执行”, and “保存并按已展示计划执行”.',
      '',
      '### Stage 2 — User validation',
      'A successful tool execution alone does NOT automatically make the Runbook proven. The user must explicitly indicate that they have actually used the current DEPLOYMENT.md and consider the procedure correct/stable enough to automate.',
      'After a deployment run completes successfully, you may ask whether the user considers the current Runbook validated. If they are still adjusting the procedure, keep working in Runbook form and do not push script generation.',
      '',
      '### Stage 3 — Workflow-habit interview before scripting',
      'A command appearing in DEPLOYMENT.md means “this is a documented, known-good way to perform this operation”; it does NOT mean “this command must be included in automation”. Never infer script coverage directly from Runbook coverage.',
      'If the user wants a one-click script, first learn how they ACTUALLY use the Runbook from start to finish. Operators may intentionally perform some stages manually, perform some outside DSH, alter or select intermediate outputs themselves, start from a later stage, stop before a later stage, or use the Runbook only as a reference for certain operations. Treat those habits as first-class requirements, not deviations to correct.',
      'Before writing any script, build an automation coverage map for the Runbook. For every relevant logical step or step group, determine one of: AUTOMATE, KEEP MANUAL, EXTERNAL/HAND-OFF, or NOT PART OF THE NORMAL RUN. Also capture the hand-off condition between stages: what must already exist before the automated part starts, what output the script should produce, and what the user expects to do manually before the next automated stage continues.',
      'Do not force all LOCAL / TRANSFER / REMOTE / VERIFY / ROLLBACK sections into one script. The automation boundary must follow the user’s real workflow, even when that means the final script automates only part of DEPLOYMENT.md.',
      'Ask about user habits that materially change the automation boundary: where the script normally starts and ends, which documented operations they prefer not to automate, how inputs/artifacts are selected or transformed between stages, which values they want to supply themselves, which checkpoints must pause for confirmation, what is handled by another tool/process, and what should happen on failure.',
      'Use concise question cards or short follow-up questions. Ask only unresolved preference/behavior questions; do not ask the user for facts that can be discovered from the project or server with read-only inspection.',
      'When enough information is known, summarize the proposed coverage map back to the user BEFORE generating code. Make it explicit which Runbook stages will be automated, remain manual, be external hand-offs, or be omitted from the normal one-click path. Ask the user to confirm or adjust that map.',
      '',
      '### Stage 4 — Optional one-click script',
      'Only after the Runbook is user-validated AND the automation coverage map is user-confirmed may you generate a one-click script.',
      'Generate the script FROM the validated Runbook plus the confirmed usage pattern. Preserve proven commands and safety checks for the steps selected for automation, parameterize only the values that genuinely vary, and do not invent extra automation the user did not request.',
      'Manual/external steps must stay outside the script unless the user later explicitly changes their preference. If automation resumes after a manual hand-off, make the precondition visible and validate it rather than silently assuming the hand-off occurred.',
      'Before writing or running the generated script, show its path, invocation, inputs, automated Runbook coverage, manual/external hand-offs, retained confirmation checkpoints, failure/rollback behavior, and the actual script content or a sufficiently complete reviewable diff. Ask for explicit confirmation.',
      'Keep DEPLOYMENT.md as the human-readable source of truth even after a script exists. Document the script entry point and its automation boundary. If the deployment procedure or the user’s operating habits change materially, treat the script as potentially stale: update/validate the Runbook or coverage map first, then regenerate or update automation.',
      'A project-maintained script that already existed before this workflow is not considered a newly hidden black box. It may be used after inspecting what it does and reconciling it with the current Runbook, environment, and the user’s actual operating habits.',
      '',
      '### Execution and approvals',
      'If the user chooses execution, run only commands/blocks or scripts that were already shown and approved, in order, and inspect results at logical checkpoints. If a replacement command becomes necessary, stop before the new mutation, show the replacement, and confirm again.',
      'High-risk operations (database restore/migration, destructive recursive deletion, firewall/system-package/config/credential changes, disk operations, host reboot) remain separate checkpoints and may trigger the runtime’s native per-tool approval UI even when the surrounding Runbook or one-click script has already been approved.',
      '`ask_user_question` is for workflow/choice UX; never treat it as a replacement for a runtime approval prompt when one appears.',
      'Set deployment_runbook_write.confirmedByUser=true only after the user explicitly confirms the final visible Runbook plan (through the native question card or an equally explicit text reply).',
    ].join('\n'),
  }), 'dsh-ssh-files-sidebar: deployment command transparency guidance')
}
