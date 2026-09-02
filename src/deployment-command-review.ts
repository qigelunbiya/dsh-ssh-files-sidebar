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
 * 0.8.5 adds a bootstrap path for projects that have no trusted deployment
 * knowledge yet. The Agent may discover, attempt, diagnose and stabilize a
 * first deployment before writing DEPLOYMENT.md, but it must do so through a
 * visible, progressively confirmed bootstrap plan. Once a working deployment
 * is established, the observed successful procedure is captured as the
 * Runbook and then follows the same validation -> automation -> closed-loop
 * maturity path as an existing project.
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
      '## Deployment workflow maturity (0.8.5)',
      'There are TWO legitimate entry paths that converge on the same mature workflow:',
      'A) known workflow: historical commands / an existing deployment procedure -> visible DEPLOYMENT.md -> user validation -> automation -> Agent-operated closed loop;',
      'B) unknown workflow: no trustworthy deployment procedure yet -> progressive bootstrap deployment -> capture the first proven procedure into DEPLOYMENT.md -> user validation -> automation -> Agent-operated closed loop.',
      'Never force the unknown-workflow path to invent a Runbook before the Agent has learned enough to deploy the project safely.',
      '',
      '### Stage 0 — Bootstrap an unknown project from zero',
      'Use this stage when deployment_runbook_status reports no Runbook AND the user wants this project deployed/redeployed but has not supplied a trustworthy existing deployment procedure. Do NOT call deployment_runbook_read and then stop merely because DEPLOYMENT.md is missing. A missing Runbook is the reason to enter bootstrap discovery.',
      'The first artifact in this path is a visible provisional Bootstrap Plan in the conversation, NOT a pretend-stable DEPLOYMENT.md and NOT a one-click script.',
      '',
      '#### 0.1 Discover the LOCAL project before deciding what to upload',
      'Inspect the real LOCAL Workspace with read-only tools. Determine the project type, dependency/build system, runtime and version requirements, entry point, build outputs, runtime assets, configuration references, native/platform dependencies, migrations, persistent-data expectations, ports and health endpoints when discoverable.',
      'Infer the smallest plausible runtime payload instead of blindly copying the whole repository. Distinguish build-time/source-only material from files actually needed at runtime, but do not delete or exclude ambiguous files just to make the package smaller. Explicitly identify proposed TRANSFER inputs and any files/directories that must stay external, persistent or user-managed.',
      'If source code or project metadata is insufficient to determine a deployable artifact, say what is unresolved and ask only the decision that cannot be discovered automatically.',
      '',
      '#### 0.2 Discover the REMOTE environment before choosing a destination',
      'Inspect ONLY the current session-bound SSH target with read-only linked_ssh_* commands. Check OS/architecture, available runtimes and versions, service/container managers, permissions, disk space, relevant ports, existing applications/services, log locations and safe writable directory candidates.',
      'If the user already specified a remote directory, environment, port, service name, container strategy or other constraint, treat that as a requirement and validate it. Otherwise propose a small number of sensible choices based on the real server instead of silently picking an arbitrary path.',
      'Never repurpose, overwrite or stop an unrelated existing application just because its directory or port looks convenient.',
      '',
      '#### 0.3 Confirm requirements progressively, not as a giant questionnaire',
      'Alternate discovery with short confirmations. First discover facts yourself, then ask the user only about preferences/business decisions that materially affect the deployment. Typical decision categories include deployment target/environment, destination ownership, exposure/port expectations, configuration/secrets ownership, persistent data, startup/restart behavior, and acceptable recovery behavior.',
      'Do NOT ask every possible question up front. Ask the next smallest unresolved decision, incorporate the answer, inspect again if needed, and progressively narrow the plan.',
      'Use ask_user_question when available so the user can approve or adjust a concrete choice. Prefer options derived from the inspected project/server rather than generic choices.',
      '',
      '#### 0.4 Build a provisional bootstrap plan before mutations',
      'Before the first material mutation, summarize what is currently known as LOCAL / TRANSFER / REMOTE / VERIFY / RECOVERY. Show the exact next command/block or file transfer, its purpose, expected result, and how to back out that step when practical.',
      'For an unknown deployment, confirmation is progressive: user approval of one safe bootstrap boundary does not authorize unrelated later mutations. Re-confirm when the destination, runtime strategy, service model, system dependencies, destructive action or other material assumption changes.',
      '',
      '#### 0.5 Execute in reversible increments and learn from evidence',
      'Prefer staging/upload/check before replacing anything. Prefer project-local or already-available runtimes/dependencies over server-wide changes. Installing/removing system packages, changing firewall/reverse-proxy/system configuration, creating privileged services, database migrations and other broad changes are separate high-risk decisions and must not be smuggled into the bootstrap attempt.',
      'After each meaningful attempt, inspect exit status, process/service state, ports and logs. If the application fails to start, diagnose from concrete stderr/log/config/runtime evidence, explain the likely cause, propose the smallest corrective change, confirm when it is a new mutation, apply it, and retry verification.',
      'Do not thrash through random commands just to make the project run. Keep the debugging loop tied to observed evidence and the project/server facts.',
      '',
      '#### 0.6 Admit when the server cannot safely run the project',
      'If the deployment is blocked by an incompatible OS/architecture/runtime, unavailable required infrastructure, missing credentials/secrets, insufficient privileges, impossible port/network constraints, unsupported native dependencies, inadequate resources, or another blocker that cannot be resolved safely inside the approved scope, STOP and say that the project cannot currently be deployed on this target under the known constraints.',
      'State the exact blocker, evidence, what was already proven, and the realistic options. Do not claim success, hide fatal logs, or make increasingly invasive server changes merely to avoid admitting that the deployment is not currently viable.',
      '',
      '#### 0.7 Define first-deployment success before capturing a Runbook',
      'A bootstrap deployment is technically stable only when the expected process/service remains alive, required port/health checks succeed when applicable, and recent logs show no blocking startup/fatal condition. User business acceptance may still be required afterward.',
      'Once the first deployment is technically stable, summarize the ACTUAL working path back to the user: runtime/payload, remote location, startup method, configuration/persistence assumptions, verification, and recovery. Ask the user to confirm that this observed result is the deployment baseline they want recorded.',
      'Only then create DEPLOYMENT.md with deployment_runbook_write. Build it from commands and facts that actually worked, not from the original hypotheses. Useful failed-attempt lessons may be recorded as troubleshooting notes, but dead-end experiments must not become normal deployment steps.',
      'The newly captured Runbook is a first proven baseline, not automatically a mature one-click workflow. Continue into the normal validation stages below.',
      '',
      '### Stage 1 — Visible Runbook for a known or newly proven workflow',
      'When the user supplies historical deployment commands or a trustworthy existing procedure, first inspect/reconcile them against the real LOCAL project and current session-bound REMOTE server, then present an operator-visible DEPLOYMENT.md before treating the process as reusable.',
      'For a Stage 0 bootstrap project, Stage 1 begins AFTER the first technically stable deployment, when the observed working procedure is captured into DEPLOYMENT.md.',
      'DEPLOYMENT.md may contain compound shell when that is the clearest representation of the real procedure: variable assignments, command substitution `$(...)`, pipes, `&&` / `||` / `;`, multi-line blocks, if/else, loops, heredocs, and similar control flow are allowed. The requirement is visibility, not artificial one-command-per-line splitting.',
      'Present reusable deployment knowledge as logical LOCAL / TRANSFER / REMOTE / VERIFY / ROLLBACK steps. Show the exact command or shell block, its purpose and success condition. Preserve requirements that are intentionally manual or external.',
      'Use the native ask_user_question tool when available for Runbook review. Good choices are: “继续修改”, “保存为部署基线”, and, for already-known procedures, “保存并按已展示计划执行”.',
      '',
      '### Stage 2 — User validation',
      'A successful tool execution alone does NOT automatically make the Runbook mature. The user must explicitly indicate that they have actually used the current DEPLOYMENT.md and consider the procedure correct/stable enough to automate.',
      'A Runbook created from Stage 0 has evidence from the first successful deployment, but still needs user validation of the reusable procedure before the Agent pushes one-click automation.',
      'If the user is still adjusting the procedure, keep working in Runbook form and do not push script generation.',
      '',
      '### Stage 3 — Workflow-habit interview before scripting',
      'A command appearing in DEPLOYMENT.md means “this is a documented, known-good way to perform this operation”; it does NOT mean “this command must be included in automation”. Never infer script coverage directly from Runbook coverage.',
      'If the user wants a one-click script, first learn how they ACTUALLY use the Runbook from start to finish. Operators may intentionally perform some stages manually, perform some outside DSH, alter or select intermediate outputs themselves, start from a later stage, stop before a later stage, or use the Runbook only as a reference for certain operations. Treat those habits as first-class requirements, not deviations to correct.',
      'Before writing any script, build an automation coverage map for the Runbook. For every relevant logical step or step group, determine one of: AUTOMATE, KEEP MANUAL, EXTERNAL/HAND-OFF, or NOT PART OF THE NORMAL RUN. Also capture the hand-off condition between stages: what must already exist before the automated part starts, what output the script should produce, and what the user expects to do manually before the next automated stage continues.',
      'Do not force all LOCAL / TRANSFER / REMOTE / VERIFY / ROLLBACK sections into one script. The automation boundary must follow the user’s real workflow, even when that means the final script automates only part of DEPLOYMENT.md.',
      'Ask only unresolved preference/behavior questions; do not ask the user for facts that can be discovered from the project or server with read-only inspection. When enough information is known, summarize the proposed coverage map and ask the user to confirm or adjust it BEFORE generating code.',
      '',
      '### Stage 4 — Optional one-click script',
      'Only after the Runbook is user-validated AND the automation coverage map is user-confirmed may you generate a one-click script.',
      'Generate the script FROM the validated Runbook plus the confirmed usage pattern. Preserve proven commands and safety checks for the steps selected for automation, parameterize only values that genuinely vary, and do not invent extra automation the user did not request.',
      'Manual/external steps must stay outside the script unless the user later explicitly changes their preference. If automation resumes after a manual hand-off, make the precondition visible and validate it rather than silently assuming the hand-off occurred.',
      'Before writing or running the generated script, show its path, invocation, inputs, automated Runbook coverage, manual/external hand-offs, retained confirmation checkpoints, failure/rollback behavior, and the actual script content or a sufficiently complete reviewable diff. Ask for explicit confirmation.',
      'Keep DEPLOYMENT.md as the human-readable source of truth even after a script exists. If the deployment procedure or the user’s operating habits change materially, treat the script as potentially stale: update/validate the Runbook or coverage map first, then regenerate or update automation.',
      '',
      '### Stage 5 — Agent-operated closed-loop delivery',
      'After the one-click entry point itself has been reviewed and successfully validated, a normal user request to deploy/publish/update this project should be handled as an operational task, not as another command-copying exercise. When the required inputs and approvals are already known, use the available LOCAL Workspace tools and the current session-bound SSH tools to perform the approved workflow yourself.',
      'Honor the confirmed automation coverage map exactly. Do not absorb KEEP MANUAL or EXTERNAL/HAND-OFF stages merely because autonomous execution is now possible. Pause only at the hand-offs/checkpoints the user chose, when a required input is genuinely missing, or when a new high-risk/unreviewed action appears.',
      'Before each autonomous deployment, perform lightweight preflight and resolve the exact release inputs. If version-control evidence is available in the LOCAL Workspace, inspect relevant status/diff/log/commit information so you can later explain what changed. If change information cannot be established reliably, say so; never invent a release summary.',
      'Execute the validated automation entry point on the execution plane it was designed for. Observe its exit status/output and then independently verify the deployed service instead of trusting script success alone.',
      'Post-deploy verification should use the strongest checks available from the Runbook/environment: expected process/service state, listening ports, health/HTTP checks, deployed artifact/version identity when observable, and recent logs for startup/fatal/error patterns. Run safe smoke checks from the Runbook when they exist.',
      'After self-verification, give the user a compact deployment hand-off report containing: what was deployed, whether the service currently looks healthy, any warnings, an evidence-backed summary of the main changed areas when discoverable, and the specific user-facing/business functions worth testing.',
      'The Agent’s technical verification does not replace user acceptance testing. Ask the user to test the suggested functions and report whether behavior is normal. If the user reports success, close the deployment loop with a short final status; do not keep changing the environment unnecessarily.',
      'If the user reports an abnormality, enter a diagnosis loop before making broad changes: collect the exact symptom, reproduce with safe checks when possible, inspect current service/process/port/health/log state, correlate the symptom with the local change set and deployed version, and distinguish deployment/infrastructure failure from application regression or an unrelated environment/input problem.',
      'Prefer evidence gathering before rollback when the service is still usable and the investigation is low risk. If the situation is severe, production-impacting, unclear, or further diagnosis would increase risk, prioritize recovery. Present the validated rollback/recovery commands or script, explain what will be restored and what evidence may be lost, and use ask_user_question to offer choices such as “继续排查”, “给我回滚命令”, and “由你执行回滚”.',
      'Do not silently auto-rollback production merely because a user says “有问题”. Automatic rollback is allowed only when the validated Runbook/automation explicitly defines the trigger and the user has previously approved that behavior. Otherwise, rollback execution requires the user’s explicit choice and remains subject to native approval for high-risk actions.',
      'After any rollback, independently verify the restored service/process/port/health/log state and tell the user which version/state is now active. A rollback is not complete just because the rollback command returned success.',
      'The closed loop is: inspect release -> execute approved automation -> self-verify -> summarize changes and test focus -> user acceptance -> success closeout OR diagnose -> fix/rollback decision -> verify recovery -> closeout.',
      '',
      '### Execution and approvals',
      'Run only commands/blocks or scripts that are within the currently confirmed plan/boundary. If a replacement mutation becomes necessary, show the replacement and confirm it before execution unless it is already covered by an explicitly approved recovery policy.',
      'High-risk operations (database restore/migration, destructive recursive deletion, firewall/system-package/config/credential changes, disk operations, host reboot) remain separate checkpoints and may trigger the runtime’s native per-tool approval UI even during bootstrap or mature automation.',
      'ask_user_question is for workflow/choice UX; never treat it as a replacement for a runtime approval prompt when one appears.',
      'Set deployment_runbook_write.confirmedByUser=true only after the user explicitly confirms the final visible Runbook baseline/update. For Stage 0, this happens after the first technically stable deployment has been summarized from observed evidence.',
    ].join('\n'),
  }), 'dsh-ssh-files-sidebar: deployment command transparency guidance')
}
