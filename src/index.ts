import { apply as applySsh } from '@linxin666/dsh-ssh'
import { apply as applyRemoteWorkspace } from 'dsh-rw'
import { installLinkedSsh } from './linked-ssh.ts'
import { installLinkedSshAgentTools } from './linked-ssh-tools.ts'
import { installLinkedSshVisionTool } from './linked-ssh-vision.ts'
import { SharedDshSshHostTable } from './shared-hosts.ts'

export const name = 'dsh-ssh-files-sidebar'

/** Both embedded host halves need these services. */
export const inject = ['tools', 'systemPrompt', 'webServer']

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
  // Original dsh-ssh host capabilities: host manager backend, /api/dsh-ssh/*,
  // SSH agent tools, terminal websocket, tunnels and system-prompt guidance.
  applySsh(ctx, { enabled: true, announceToAgent: true })

  // One shared view of ~/.dsh/dsh-ssh.json backs both Remote Workspace and the
  // new Local Workspace + Linked SSH mode.
  const hosts = new SharedDshSshHostTable()

  // Session-scoped Linked SSH bindings live on the host as well as in the
  // browser cache. This gives the model a deterministic LOCAL/REMOTE context.
  const linkedStore = installLinkedSsh(ctx, hosts)

  // Session-bound model tools remove the alias parameter entirely. The server
  // selected in the conversation header is injected by the plugin at execution
  // time, so the model cannot accidentally call ssh_exec without an alias or
  // drift away from SSH Files / SSH Terminal.
  installLinkedSshAgentTools(ctx, linkedStore)

  // Direct remote image inspection. Server bytes are streamed by SFTP into
  // memory, validated by Harness' AttachmentStore, and sent to a registered
  // image-capable model with hard cancellation/timeout boundaries. No local
  // Workspace copy is created simply to inspect a remote screenshot.
  installLinkedSshVisionTool(ctx, linkedStore)

  // Sent SSH references intentionally reuse Harness' native @file display
  // grammar, e.g. @ssh:131:/apps/web/test.txt. Teach the Agent that the token
  // is remote data even though the user bubble renders it as a normal file chip.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-ssh-reference-syntax',
    order: 152,
    text: () => [
      '## SSH reference syntax',
      'A token shaped like @ssh:<alias>:/absolute/path (or @"ssh:<alias>:/path with spaces") is an explicit SSH file/folder reference created by the UI.',
      'Treat it as a path on SSH <alias>, not as a local Workspace path. Use Linked SSH / ssh_* remote operations for it; never pass it to local Read/Glob/Pwsh/Bash by mistake.',
    ].join('\n'),
  }), 'dsh-ssh-files-sidebar: SSH reference syntax')

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
  applyRemoteWorkspace(ctx, config as any, {
    hosts,
    pickDirectory: () => pickLocalDirectory(ctx),
  } as any)
}
