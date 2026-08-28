import { extname } from 'node:path'
import type { LinkedSshBindingStore } from './linked-ssh.ts'

interface SshInternals {
  SshEngine: new (store: any) => any
  HostStore: new () => any
  withClient: (engine: any, alias: string, fn: (client: any) => Promise<any>) => Promise<any>
}

interface SystemOcrModule {
  recognize: (
    image: Uint8Array,
    accuracy?: unknown,
    preferredLangs?: string[],
    signal?: AbortSignal,
  ) => Promise<{ text?: string; confidence?: number } | string>
  OcrAccuracy?: { Accurate?: unknown; Fast?: unknown; accurate?: unknown; fast?: unknown }
}

interface RemoteOcrValue {
  alias: string
  remotePath: string
  engine: string
  language: string
  bytes: number
  text: string
  confidence?: number
  durationMs: number
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const DEFAULT_LANGUAGE = 'zh-cn'
const REMOTE_READ_TIMEOUT_MS = 15_000
const DEFAULT_OCR_TIMEOUT_MS = 30_000
const MIN_OCR_TIMEOUT_MS = 5_000
const MAX_OCR_TIMEOUT_MS = 60_000
const TOOL_TIMEOUT_MS = 70_000
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

let sshInternalsPromise: Promise<SshInternals> | undefined
let systemOcrPromise: Promise<SystemOcrModule> | undefined

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

function agentSessionId(exec: any): string {
  const id = exec?.agent?.id
  if (typeof id !== 'string' || id === '') {
    throw new Error('当前工具调用没有可识别的 DSH session，无法解析 Linked SSH 目标。')
  }
  return id
}

function linkedAlias(store: LinkedSshBindingStore, exec: any): string {
  const binding = store.get(agentSessionId(exec))
  if (binding === undefined) {
    throw new Error('当前会话没有绑定 Linked SSH。请先在会话顶部选择服务器。')
  }
  return binding.alias
}

function normalizeRemotePath(value: string): string {
  const path = value.trim()
  if (path === '') throw new Error('remotePath 不能为空')
  if (path.startsWith('/')) return path.replace(/\/{2,}/g, '/')
  return `/${path.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/')
}

function combineSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout])
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  return new Error(reason === undefined ? fallback : String(reason))
}

async function loadSshInternals(): Promise<SshInternals> {
  if (sshInternalsPromise !== undefined) return await sshInternalsPromise
  sshInternalsPromise = (async () => {
    const engineSpec = '@linxin666/dsh-ssh/src/engine.ts'
    const poolSpec = '@linxin666/dsh-ssh/src/engine/connection-pool.ts'
    const storeSpec = '@linxin666/dsh-ssh/src/store.ts'
    const [engineModule, poolModule, storeModule] = await Promise.all([
      import(engineSpec),
      import(poolSpec),
      import(storeSpec),
    ]) as any[]
    if (typeof engineModule?.SshEngine !== 'function' || typeof storeModule?.HostStore !== 'function' || typeof poolModule?.withClient !== 'function') {
      throw new Error('@linxin666/dsh-ssh 当前版本没有暴露 OCR 所需的 SSH engine 接口')
    }
    return {
      SshEngine: engineModule.SshEngine,
      HostStore: storeModule.HostStore,
      withClient: poolModule.withClient,
    }
  })()
  return await sshInternalsPromise
}

/**
 * Load the native host OCR lazily. @napi-rs/system-ocr uses Windows Media OCR
 * on Windows and VisionKit on macOS. It accepts Uint8Array directly, so the
 * remote image never needs to be written into the local Workspace or temp dir.
 */
async function loadSystemOcr(): Promise<SystemOcrModule> {
  if (systemOcrPromise !== undefined) return await systemOcrPromise
  systemOcrPromise = (async () => {
    const spec = '@napi-rs/system-ocr'
    try {
      const module = await import(spec) as any
      if (typeof module?.recognize !== 'function') {
        throw new Error('模块没有导出 recognize()')
      }
      return module as SystemOcrModule
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `本机 OCR 引擎不可用：${detail}。Windows 需要安装插件依赖 @napi-rs/system-ocr；它使用 Windows Media OCR，不需要视觉模型 API Key。`,
      )
    }
  })()
  return await systemOcrPromise
}

async function readRemoteBytes(
  internals: SshInternals,
  engine: any,
  alias: string,
  remotePath: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return await internals.withClient(engine, alias, async (client: any) => {
    return await new Promise<Uint8Array>((resolve, reject) => {
      let settled = false
      let sftp: any
      let stream: any
      const chunks: Buffer[] = []
      let total = 0

      const finish = (error?: unknown, data?: Uint8Array): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        try { stream?.destroy?.() } catch { /* already closed */ }
        try { sftp?.end?.() } catch { /* already closed */ }
        if (error !== undefined) {
          reject(error instanceof Error ? error : new Error(String(error)))
          return
        }
        resolve(data ?? new Uint8Array())
      }
      const onAbort = (): void => finish(abortReason(signal, '读取远程图片超时或已取消'))
      if (signal.aborted) {
        finish(abortReason(signal, '读取远程图片超时或已取消'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })

      client.sftp((sftpError: Error | undefined, channel: any) => {
        if (sftpError !== undefined) {
          finish(sftpError)
          return
        }
        if (settled) {
          try { channel.end() } catch { /* already closed */ }
          return
        }
        sftp = channel
        sftp.stat(remotePath, (statError: Error | undefined, stats: any) => {
          if (statError !== undefined) {
            finish(statError)
            return
          }
          if (stats?.isDirectory?.()) {
            finish(new Error(`远程路径是目录，不是图片文件：${remotePath}`))
            return
          }
          const declaredSize = Number(stats?.size ?? 0)
          if (!Number.isFinite(declaredSize) || declaredSize < 0) {
            finish(new Error(`无法确认远程图片大小：${remotePath}`))
            return
          }
          if (declaredSize > MAX_IMAGE_BYTES) {
            finish(new Error(`远程图片过大：${declaredSize} bytes，本地 OCR 上限为 ${MAX_IMAGE_BYTES} bytes`))
            return
          }

          stream = sftp.createReadStream(remotePath, { highWaterMark: 128 * 1024 })
          stream.on('data', (chunk: Buffer | Uint8Array) => {
            if (settled) return
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            total += buffer.length
            if (total > MAX_IMAGE_BYTES) {
              finish(new Error(`远程图片读取超过 OCR 上限 ${MAX_IMAGE_BYTES} bytes`))
              return
            }
            chunks.push(buffer)
          })
          stream.once('error', (error: Error) => finish(error))
          stream.once('end', () => {
            if (settled) return
            const data = Buffer.concat(chunks, total)
            finish(undefined, new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
          })
        })
      })
    })
  })
}

function normalizeOcrResult(value: { text?: string; confidence?: number } | string): { text: string; confidence?: number } {
  if (typeof value === 'string') return { text: value }
  const recognized = typeof value?.text === 'string' ? value.text : ''
  return typeof value?.confidence === 'number'
    ? { text: recognized, confidence: value.confidence }
    : { text: recognized }
}

function isNoTextError(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown } | null
  if (record?.code === 'GenericFailure') return true
  const message = typeof record?.message === 'string' ? record.message.toLowerCase() : ''
  return message.includes('no text') || message.includes('no recognizable text')
}

async function recognizeBytes(
  bytes: Uint8Array,
  language: string,
  mode: 'accurate' | 'fast',
  signal: AbortSignal,
): Promise<{ text: string; confidence?: number; language: string; engine: string }> {
  const ocr = await loadSystemOcr()
  const accuracy = mode === 'fast'
    ? ocr.OcrAccuracy?.Fast ?? ocr.OcrAccuracy?.fast
    : ocr.OcrAccuracy?.Accurate ?? ocr.OcrAccuracy?.accurate

  const call = async (preferredLangs?: string[]) => {
    return normalizeOcrResult(await ocr.recognize(bytes, accuracy, preferredLangs, signal))
  }

  try {
    const result = await call(language === '' ? undefined : [language])
    return { ...result, language: language || 'system-default', engine: process.platform === 'win32' ? 'windows-media-ocr' : process.platform === 'darwin' ? 'macos-visionkit-ocr' : 'system-ocr' }
  } catch (error) {
    if (signal.aborted) throw abortReason(signal, '本地 OCR 超时或已取消')
    if (isNoTextError(error)) {
      return { text: '', confidence: 0, language: language || 'system-default', engine: process.platform === 'win32' ? 'windows-media-ocr' : 'system-ocr' }
    }
    // A requested language can be unavailable on the host. Retry once using
    // the OS user's configured OCR languages before surfacing the failure.
    if (language !== '') {
      try {
        const result = await call(undefined)
        return { ...result, language: 'system-default', engine: process.platform === 'win32' ? 'windows-media-ocr' : process.platform === 'darwin' ? 'macos-visionkit-ocr' : 'system-ocr' }
      } catch (fallbackError) {
        if (signal.aborted) throw abortReason(signal, '本地 OCR 超时或已取消')
        if (isNoTextError(fallbackError)) {
          return { text: '', confidence: 0, language: 'system-default', engine: process.platform === 'win32' ? 'windows-media-ocr' : 'system-ocr' }
        }
        throw fallbackError
      }
    }
    throw error
  }
}

/**
 * Give a text-only Agent local OCR over a file that lives on Linked SSH:
 * remote SFTP bytes -> Windows Media OCR/VisionKit -> plain text tool result.
 * No visual LLM, API key, local Workspace copy, or user-visible download.
 */
export function installLinkedSshOcrTool(ctx: any, store: LinkedSshBindingStore): void {
  let ocrSsh: any
  let internals: SshInternals | undefined
  const getOcrSsh = async (): Promise<{ internals: SshInternals; engine: any }> => {
    if (internals === undefined) internals = await loadSshInternals()
    if (ocrSsh === undefined) ocrSsh = new internals.SshEngine(new internals.HostStore())
    return { internals, engine: ocrSsh }
  }

  const tool = {
    name: 'linked_ssh_ocr_image',
    description: 'Extract text from an image on the SSH server linked to THIS session using LOCAL system OCR. This works with text-only LLMs and needs NO vision-model API key. The remote image is streamed by SFTP directly into memory; it is not downloaded into the local Workspace. Best for UI screenshots, logs, forms, tables and text-heavy images. It cannot reliably understand non-text visual semantics such as objects, colors or actions.',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        remotePath: { type: 'string', description: 'Remote image path on the linked SSH server.' },
        language: { type: 'string', description: 'Preferred OCR language. Default zh-cn. On Windows only the first preferred language is used; if unavailable the plugin retries with system-default languages.' },
        mode: { type: 'string', enum: ['accurate', 'fast'], description: 'OCR accuracy mode. Default accurate. Windows Media OCR may ignore this flag.' },
        timeoutMs: { type: 'integer', description: 'OCR timeout in milliseconds. Default 30000; allowed range 5000-60000.' },
      },
      required: ['remotePath'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string' },
          remotePath: { type: 'string' },
          engine: { type: 'string' },
          language: { type: 'string' },
          bytes: { type: 'integer' },
          text: { type: 'string' },
          confidence: { type: 'number' },
          durationMs: { type: 'integer' },
        },
        required: ['alias', 'remotePath', 'engine', 'language', 'bytes', 'text', 'durationMs'],
      },
      render: (_args: any, value: RemoteOcrValue) => text([
        `${value.alias}:${value.remotePath}`,
        `ocr: ${value.engine} · language=${value.language} · ${value.bytes} bytes · ${value.durationMs} ms`,
        value.text === ''
          ? '[OCR 没有识别到可用文字；这不代表图片为空，只表示纯 OCR 无法提供非文字视觉信息。]'
          : `<ocr_text>\n${value.text}\n</ocr_text>`,
      ].join('\n')),
    },
    async execute(args: { remotePath: string; language?: string; mode?: 'accurate' | 'fast'; timeoutMs?: number }, exec: any): Promise<RemoteOcrValue> {
      const alias = linkedAlias(store, exec)
      const remotePath = normalizeRemotePath(args.remotePath)
      if (!IMAGE_EXTENSIONS.has(extname(remotePath).toLowerCase())) {
        throw new Error(`不支持的 OCR 图片格式：${remotePath}；目前支持 PNG/JPEG/WebP/GIF/BMP。`)
      }
      if (process.platform !== 'win32' && process.platform !== 'darwin') {
        throw new Error(`本地系统 OCR 当前只支持 Windows/macOS；当前 DSH Host 平台是 ${process.platform}。`)
      }

      const ssh = await getOcrSsh()
      const bytes = await readRemoteBytes(
        ssh.internals,
        ssh.engine,
        alias,
        remotePath,
        combineSignal(exec?.signal, REMOTE_READ_TIMEOUT_MS),
      )

      const requestedTimeout = Number.isInteger(args.timeoutMs) ? Number(args.timeoutMs) : DEFAULT_OCR_TIMEOUT_MS
      const timeoutMs = Math.max(MIN_OCR_TIMEOUT_MS, Math.min(MAX_OCR_TIMEOUT_MS, requestedTimeout))
      const language = typeof args.language === 'string' ? args.language.trim() : DEFAULT_LANGUAGE
      const mode = args.mode === 'fast' ? 'fast' : 'accurate'
      const started = Date.now()
      let recognized
      try {
        recognized = await recognizeBytes(bytes, language, mode, combineSignal(exec?.signal, timeoutMs))
      } catch (error) {
        throw new Error(`本地 OCR 失败：${error instanceof Error ? error.message : String(error)}`)
      }

      return {
        alias,
        remotePath,
        engine: recognized.engine,
        language: recognized.language,
        bytes: bytes.byteLength,
        text: recognized.text.trim(),
        ...(recognized.confidence === undefined ? {} : { confidence: recognized.confidence }),
        durationMs: Date.now() - started,
      }
    },
  }

  ctx.effect(() => {
    const disposeTool = ctx.tools.register(tool)
    return () => {
      disposeTool()
      try { ocrSsh?.dispose?.() } catch { /* already disposed */ }
    }
  }, 'dsh-ssh-files-sidebar: direct Linked SSH local OCR')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-ssh-linked-ocr',
    order: 154,
    text: (context: any) => {
      const sessionId = typeof context?.agent?.id === 'string' ? context.agent.id : ''
      if (sessionId === '' || store.get(sessionId) === undefined) return ''
      return [
        '## Linked SSH OCR for text-only models',
        'linked_ssh_ocr_image gives this Agent OCR ability even when the current LLM accepts text only. It uses the DSH host operating system OCR locally and requires no vision-model API key.',
        'For UI screenshots, webpages, terminal captures, forms, tables, logs, error screenshots, or any text-heavy image on Linked SSH, prefer linked_ssh_ocr_image. Read the returned <ocr_text> and then reason about it normally as text.',
        'If linked_ssh_read_image fails because a visual provider is unauthenticated/unavailable, immediately fall back to linked_ssh_ocr_image instead of downloading the image or retrying the broken visual API.',
        'OCR only extracts visible text. If the question depends on non-text visual semantics (objects, colors, charts, spatial relationships, actions), explain the limitation or use a working vision model when one is configured.',
        'Never call linked_ssh_download merely to OCR a server image: linked_ssh_ocr_image streams the remote bytes directly into memory.',
      ].join('\n')
    },
  }), 'dsh-ssh-files-sidebar: Linked SSH OCR guidance')
}
