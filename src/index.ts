import { apply as applySsh } from '@linxin666/dsh-ssh'
import { apply as applyRemoteWorkspace } from 'dsh-rw'
import { installDeploymentRunbook } from './deployment-runbook.ts'
import { installLinkedSsh } from './linked-ssh.ts'
import { installLinkedSshAgentTools } from './linked-ssh-tools.ts'
import { installLinkedSshVisionTool } from './linked-ssh-vision.ts'
import { installLinkedSshOcrTool } from './linked-ssh-ocr.ts'
import { EphemeralRwSession, installRemoteWorkspaceSessionSafety } from './remote-workspace-safety.ts'
import { installSessionSshTargetSafety } from './session-ssh-safety.ts'
import { SharedDshSshHostTable } from './shared-hosts.ts'

export const name = 'dsh-ssh-files-sidebar'

/** Both embedded host halves need these services. */
export const inject = ['tools', 'systemPrompt', 'webServer', 'agents']

interface DirectoryPickerLike {
  capability?: () =>
    | Promise<{ kind?: string; pick?: (signal?: AbortSignal) => Promise<unknown> } | null | undefined>
    | { kind?: string; pick?: (signal?: AbortSignal) => Promise<unknown> }
    | null
    | undefined
}

/**
 * Resolve the DSH directory-picker lazily, when the operator actually clicks
 * "打开系统文件夹选择器".
 *
 * dsh-rw normally samples ctx.get('directoryPicker') during its apply(). In an
 * integrated wrapper like this one the directory-picker-auto row may activate
 * later in the loader tree, which made dsh-rw permanently capture undefined
 * even though the native picker became available moments later. Resolving here
 * at click time keeps the dependency optional while still using DSH's official
 * native picker backend on local Web sessions.
 */
async function pickLocalDirectory(ctx: any): Promise<string | null> {
  const picker = (typeof ctx?.get === 'function' ? ctx.get('directoryPicker') : undefined) as DirectoryPickerLike | undefined
  if (!picker || typeof picker.capability !== 'function') {
    throw new Error('本机目录选择器尚未就绪，请稍后重试；也可以直接输入本机目录路径。')
  }

  const capability = await picker.capability()
  if (!capability || capability.kind !== 'native' || typeof capability.pick !== 'function') {
    throw new Error('当前 DSH 运行环境没有可用的系统文件夹选择器，请直接输入本机目录路径。')
  }

  const controller = new AbortController()
  try {
    const picked = await capability.pick(controller.signal)
    return typeof picked === 'string' && picked.trim() !== '' ? picked : null
  } finally {
    controller.abort()
  }
}

/**
 * Host half of the integrated plugin.
 *
 * Important: @linxin666/dsh-ssh is NOT a second Cordis loader row. DSH resolves
 * loader-row package names from the profile root, while this package is used via
 * link: during development and its transitive dependencies live beside the
 * linked package. Mounting the SSH plugin programmatically keeps the whole stack
 * inside one resolvable top-level row and still registers the original routes,
 * tools, settings section and connection pool.
 *
 * dsh-rw is then mounted in the same fiber with a HostTable adapter over the
 * SAME ~/.dsh/dsh-ssh.json file, so SSH credentials are configured only once.
 */
export function apply(ctx: any): void {
  // Keep the original dsh-ssh backend/UI/raw tools registered for routes,
  // terminal, tunnels and file APIs, but do not let its standalone multi-host
  // prompt teach the Agent to enumerate every configured server. The raw tools
  // are additionally removed/guarded from every Agent below.
  applySsh(ctx, { enabled: true, announceToAgent: false })

  // One shared view of ~/.dsh/dsh-ssh.json backs both Remote Workspace and the
  // new Local Workspace + Linked SSH mode.
  const hosts = new SharedDshSshHostTable()

  // Session-scoped Linked SSH bindings live on the host as well as in the
  // browser cache. This gives the model a deterministic LOCAL/REMOTE context.
  const linkedStore = installLinkedSsh(ctx, hosts)

  // Hard invariant: the Agent never gets a generic multi-host SSH surface.
  // Official per-Agent ToolRuntime restrictions hide raw ssh_* schemas and
  // dispatch, while a global monotonic guard blocks stale/hand-crafted raw
  // calls. The model-facing linked_ssh_* wrappers use SshEngine directly, so
  // this fence cannot break their internal operation.
  installSessionSshTargetSafety(ctx, linkedStore)

  // Session-bound model tools remove the alias parameter entirely. The target
  // comes from Remote Workspace metadata first, otherwise the header Linked SSH
  // binding, exactly matching SSH Files / SSH Terminal UI precedence.
  installLinkedSshAgentTools(ctx, linkedStore)

  // Direct remote image inspection. Server bytes are streamed by SFTP into
  // memory, validated by Harness' AttachmentStore, and sent to a registered
  // image-capable model with hard cancellation/timeout boundaries. No local
  // Workspace copy is created simply to inspect a remote screenshot.
  installLinkedSshVisionTool(ctx, linkedStore)

  // Local OCR fallback/primary path for text-only models. It streams the same
  // remote bytes straight into Windows Media OCR (or macOS VisionKit) and
  // returns plain text to the Agent. It needs no visual-model API key and does
  // not materialize the image into the local Workspace or temp directory.
  installLinkedSshOcrTool(ctx, linkedStore)

  // Project deployment knowledge layer. A LOCAL source Workspace owns exactly
  // one DEPLOYMENT.md Runbook; the Agent can inspect/create/update it, but the
  // runbook's target-ssh must match the conversation's existing SSH lock. This
  // keeps build/package local, transfer explicit, and service operations remote.
  installDeploymentRunbook(ctx, linkedStore)

  // Sent SSH references intentionally reuse Harness' native @file display
  // grammar, e.g. @ssh:131:/apps/web/test.txt. Teach the Agent that the token
  // is remote data even though the user bubble renders it as a normal file chip.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-ssh-reference-syntax',
    order: 152,
    text: () => [
      '## SSH reference syntax',
      'A token shaped like @ssh:<alias>:/absolute/path (or @"ssh:<alias>:/path with spaces") is an explicit SSH file/folder reference created by the UI.',
      'Treat it as a path on the current conversation SSH target, not as a local Workspace path. Use the advertised session-bound linked_ssh_* operations; never enumerate/switch hosts and never pass the remote path to local `read`, `glob`, `pwsh`, or `bash` by mistake.',
    ].join('\n'),
  }), 'dsh-ssh-files-sidebar: SSH reference syntax')

  // dsh-rw 0.4.x owns one process-global persisted Session. In a multi-session
  // Harness that can leak the last Remote Workspace into an unrelated local
  // conversation. Keep the picker/status state process-local and rewrite the
  // model-facing dsh-rw surface from each conversation's actual cwd instead.
  const rwSession = new EphemeralRwSession()
  installRemoteWorkspaceSessionSafety(ctx)

  // Remote workspace + native Read/Write/Edit/Glob/Grep/Bash shim, sharing the
  // dsh-ssh host store instead of maintaining a second SSH configuration.
  const config = {
    hostKeyPolicy: 'accept-new',
    knownHostsPath: '',
    commandTimeoutMs: 30_000,
    connectTimeoutMs: 15_000,
    channelOpenTimeoutMs: 10_000,
    maxOutputChars: 200_000,
    shim: true,
    shimBash: true,
    shimBashApproval: 'ask',
  }

  // Pass an explicit lazy picker instead of letting dsh-rw snapshot the
  // optional directoryPicker service during apply(). The web bundle mounts
  // directory-picker-auto as a separate loader row, so activation order must
  // not decide whether this button works for the rest of the process lifetime.
  //
  // The explicit ephemeral session is equally important: dsh-rw's default
  // Session reads/writes ~/.dsh/dsh-rw-session.json globally. Remote-native
  // routing is already cwd/placeholder-driven, so persisting that mutable
  // selection only creates cross-conversation ambiguity and is unnecessary.
  applyRemoteWorkspace(ctx, config as any, {
    hosts,
    session: rwSession,
    pickDirectory: () => pickLocalDirectory(ctx),
  } as any)
}
