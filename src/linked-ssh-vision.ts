import { basename, extname } from 'node:path'
import { SshEngine } from '@linxin666/dsh-ssh/src/engine.ts'
import { withClient } from '@linxin666/dsh-ssh/src/engine/connection-pool.ts'
import { HostStore } from '@linxin666/dsh-ssh/src/store.ts'
import type { LinkedSshBindingStore } from './linked-ssh.ts'

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

interface VisionRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

interface RemoteVisionValue {
  alias: string
  remotePath: string
  provider: string
  model: string
  mediaType: ImageMediaType
  width: number
  height: number
  bytes: number
  description: string
}

const IMAGE_MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const DEFAULT_PROMPT = [
  '请直接分析这张图片，并用中文回答。',
  '如果是界面/UI/网页截图：说明页面结构、关键区域、可见文字、状态、报错或异常，并回答用户真正关心的问题。',
  '如果是文本密集图片：尽量准确读取关键文字和数字；看不清的内容明确说明，不要猜测。',
  '如果是普通图片：描述主体、场景、关键细节以及与用户问题相关的信息。',
].join('\n')

const REMOTE_READ_TIMEOUT_MS = 15_000
const ROUTE_DISCOVERY_TIMEOUT_MS = 6_000
const DEFAULT_VISION_TIMEOUT_MS = 45_000
const MIN_VISION_TIMEOUT_MS = 5_000
const MAX_VISION_TIMEOUT_MS = 60_000
const TOOL_TIMEOUT_MS = 70_000
const ROUTE_CACHE_TTL_MS = 5 * 60_000
const routeCache = new Map<string, { at: number; route: VisionRoute }>()

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

function mediaTypeForPath(path: string): ImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES[extname(path).toLowerCase()]
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

function abortable<T>(pending: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal, `${label} 已取消`))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => done(() => reject(abortReason(signal, `${label} 超时或已取消`)))
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      value => done(() => resolve(value)),
      error => done(() => reject(error)),
    )
  })
}

/**
 * Read one remote file straight from SFTP into host memory. No workspace file
 * or user-visible temporary download is created. The later AttachmentStore
 * commit is the Harness-native, content-addressed model transport boundary.
 */
async function readRemoteBytes(
  engine: SshEngine,
  alias: string,
  remotePath: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return await withClient(engine, alias, async (client: any) => {
    return await new Promise<Uint8Array>((resolve, reject) => {
      let settled = false
      let sftp: any
      let stream: any
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
          if (declaredSize > maxBytes) {
            finish(new Error(`远程图片过大：${declaredSize} bytes，当前图片读取上限为 ${maxBytes} bytes`))
            return
          }

          const chunks: Buffer[] = []
          let total = 0
          stream = sftp.createReadStream(remotePath, { highWaterMark: 128 * 1024 })
          stream.on('data', (chunk: Buffer | Uint8Array) => {
            if (settled) return
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            total += buffer.length
            if (total > maxBytes) {
              finish(new Error(`远程图片读取超过上限 ${maxBytes} bytes`))
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

function routeKey(exec: any): string {
  const routed = exec?.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec?.agent?.options?.provider ?? ''
  const model = routed?.model ?? exec?.agent?.options?.model ?? ''
  return `${String(provider)}\u0000${String(model)}`
}

function currentRoute(exec: any): { provider?: string; model?: string } {
  const routed = exec?.agent?.session?.requestHeader?.()?.config
  return {
    provider: routed?.provider ?? exec?.agent?.options?.provider,
    model: routed?.model ?? exec?.agent?.options?.model,
  }
}

function lowCostReasoning(info: any): string | undefined {
  const efforts = Array.isArray(info?.reasoning?.efforts)
    ? info.reasoning.efforts.map((item: any) => item?.id).filter((id: unknown): id is string => typeof id === 'string')
    : []
  for (const id of ['off', 'minimal', 'low']) {
    if (efforts.includes(id)) return id
  }
  return undefined
}

async function resolveVisionRoute(llm: any, exec: any, signal: AbortSignal): Promise<VisionRoute> {
  const key = routeKey(exec)
  const cached = routeCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < ROUTE_CACHE_TTL_MS) return cached.route

  const current = currentRoute(exec)
  if (typeof current.provider === 'string' && current.provider !== '' && typeof current.model === 'string' && current.model !== '') {
    try {
      const info = await abortable(
        Promise.resolve(llm.resolveModelInfo(current.provider, current.model, signal)),
        signal,
        '解析当前模型能力',
      )
      if (Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')) {
        const route = {
          provider: current.provider,
          model: current.model,
          ...(lowCostReasoning(info) === undefined ? {} : { reasoningEffort: lowCostReasoning(info) }),
        }
        routeCache.set(key, { at: Date.now(), route })
        return route
      }
    } catch {
      // Continue to registered vision-route discovery below.
    }
  }

  const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  const ordered = [...providers].sort((a: any, b: any) => {
    const aCurrent = a?.id === current.provider ? 0 : 1
    const bCurrent = b?.id === current.provider ? 0 : 1
    return aCurrent - bCurrent
  })
  const catalogs = await Promise.all(ordered.map(async (provider: any) => {
    if (typeof provider?.id !== 'string' || provider.id === '') return { provider: '', models: [] as any[] }
    try {
      const models = await abortable(Promise.resolve(llm.listModels(provider.id)), signal, `读取 ${provider.id} 模型列表`)
      return { provider: provider.id, models: Array.isArray(models) ? models : [] }
    } catch {
      return { provider: provider.id, models: [] as any[] }
    }
  }))

  for (const catalog of catalogs) {
    for (const model of catalog.models) {
      if (typeof model?.id !== 'string' || model.id === '') continue
      if (!Array.isArray(model.inputModalities) || !model.inputModalities.includes('image')) continue
      let info = model
      try {
        info = await abortable(
          Promise.resolve(llm.resolveModelInfo(catalog.provider, model.id, signal)),
          signal,
          `验证视觉模型 ${catalog.provider}/${model.id}`,
        )
      } catch {
        continue
      }
      if (!Array.isArray(info?.inputModalities) || !info.inputModalities.includes('image')) continue
      const effort = lowCostReasoning(info)
      const route: VisionRoute = {
        provider: catalog.provider,
        model: model.id,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      }
      routeCache.set(key, { at: Date.now(), route })
      return route
    }
  }

  throw new Error(
    '没有找到已注册且明确声明支持 image 输入的模型。请在 DSH 模型配置中启用一个视觉模型，并确保该模型的 inputModalities/input 包含 image。',
  )
}

async function describeWithVisionModel(
  llm: any,
  route: VisionRoute,
  ref: any,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const messages = [{
    id: `linked-ssh-vision-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: prompt },
      { type: 'image', attachment: ref },
    ],
  }]
  const request: any = {
    provider: route.provider,
    model: route.model,
    messages,
    maxTokens: 4096,
    signal,
    purpose: 'auxiliary',
  }
  if (route.reasoningEffort !== undefined) request.reasoningEffort = route.reasoningEffort

  const byIndex = new Map<number, string>()
  let finish: any
  for await (const chunk of llm.stream(request)) {
    if (signal.aborted) throw abortReason(signal, '视觉模型调用超时或已取消')
    if (chunk?.type === 'text-delta') {
      byIndex.set(chunk.index, (byIndex.get(chunk.index) ?? '') + String(chunk.text ?? ''))
    } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') {
      if ((byIndex.get(chunk.index) ?? '') === '') byIndex.set(chunk.index, String(chunk.block.text ?? ''))
    } else if (chunk?.type === 'finish') {
      finish = chunk.reason
    }
  }

  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    const detail = finish?.failure?.message ?? 'unknown error'
    throw new Error(`视觉模型调用失败：${detail}`)
  }
  const description = [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, value]) => value)
    .join('\n')
    .trim()
  if (description === '') {
    throw new Error('视觉模型调用已结束，但没有返回可用的图片描述。')
  }
  return description
}

/**
 * Install a direct-remote vision bridge. SFTP streams remote bytes to memory,
 * AttachmentStore validates/normalizes them, then an image-capable registered
 * DSH model performs a bounded one-shot vision call. No linked_ssh_download is
 * involved, so server images never need a workspace copy just to be inspected.
 */
export function installLinkedSshVisionTool(ctx: any, store: LinkedSshBindingStore): void {
  const visionSsh = new SshEngine(new HostStore())

  const tool = {
    name: 'linked_ssh_read_image',
    description: 'Read and understand a PNG/JPEG/WebP/GIF image directly from the SSH server linked to THIS session. It streams the remote file via SFTP into memory and sends it through Harness attachments to an image-capable registered model. Do NOT download the image into the local Workspace first. Use this for screenshots/images visible in SSH Files or referenced as @ssh:... .',
    timeoutMs: TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        remotePath: { type: 'string', description: 'Image path on the linked SSH server, preferably absolute, e.g. /opt/app/screenshot.png.' },
        prompt: { type: 'string', description: 'Optional question/instruction for the vision model. Omit for a detailed general analysis.' },
        timeoutMs: { type: 'integer', description: 'Vision-model timeout in milliseconds. Default 45000; allowed range 5000-60000.' },
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
          provider: { type: 'string' },
          model: { type: 'string' },
          mediaType: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          description: { type: 'string' },
        },
        required: ['alias', 'remotePath', 'provider', 'model', 'mediaType', 'width', 'height', 'bytes', 'description'],
      },
      render: (_args: any, value: RemoteVisionValue) => text([
        `${value.alias}:${value.remotePath}`,
        `vision: ${value.provider}/${value.model} · ${value.mediaType} · ${value.width}x${value.height} · ${value.bytes} bytes`,
        value.description,
      ].join('\n')),
    },
    async execute(args: { remotePath: string; prompt?: string; timeoutMs?: number }, exec: any): Promise<RemoteVisionValue> {
      const alias = linkedAlias(store, exec)
      const remotePath = normalizeRemotePath(args.remotePath)
      const mediaType = mediaTypeForPath(remotePath)
      if (mediaType === undefined) {
        throw new Error(`不支持的远程图片格式：${remotePath}；目前支持 PNG/JPEG/WebP/GIF。`)
      }

      const agentCtx = exec?.agent?.ctx
      const attachments = agentCtx?.get?.('attachments') ?? ctx.get?.('attachments')
      const llm = agentCtx?.get?.('llm') ?? ctx.get?.('llm')
      if (attachments === undefined) throw new Error('DSH AttachmentStore 未挂载，无法把远程图片交给视觉模型。')
      if (llm === undefined) throw new Error('DSH LLM 服务未挂载，无法执行视觉模型调用。')

      const limits = attachments.imageLimits
      if (limits?.mediaTypes !== undefined && !limits.mediaTypes.includes(mediaType)) {
        throw new Error(`当前 DSH AttachmentStore 不接受 ${mediaType} 图片。`)
      }
      const byteCap = limits === undefined
        ? 20 * 1024 * 1024
        : Math.min(limits.maxImageBytes, limits.maxMessageImageBytes)

      const readSignal = combineSignal(exec?.signal, REMOTE_READ_TIMEOUT_MS)
      const bytes = await readRemoteBytes(visionSsh, alias, remotePath, byteCap, readSignal)
      let ref: any
      try {
        ref = await abortable(
          Promise.resolve(attachments.saveImage({ data: bytes, mediaType, name: basename(remotePath) })),
          combineSignal(exec?.signal, 15_000),
          '校验远程图片',
        )
      } catch (error) {
        throw new Error(`远程图片无法进入 DSH 图片附件管线：${error instanceof Error ? error.message : String(error)}`)
      }

      const route = await resolveVisionRoute(
        llm,
        exec,
        combineSignal(exec?.signal, ROUTE_DISCOVERY_TIMEOUT_MS),
      )
      const requestedTimeout = Number.isInteger(args.timeoutMs) ? Number(args.timeoutMs) : DEFAULT_VISION_TIMEOUT_MS
      const visionTimeout = Math.max(MIN_VISION_TIMEOUT_MS, Math.min(MAX_VISION_TIMEOUT_MS, requestedTimeout))
      const prompt = typeof args.prompt === 'string' && args.prompt.trim() !== '' ? args.prompt.trim() : DEFAULT_PROMPT
      const description = await describeWithVisionModel(
        llm,
        route,
        ref,
        prompt,
        combineSignal(exec?.signal, visionTimeout),
      )

      return {
        alias,
        remotePath,
        provider: route.provider,
        model: route.model,
        mediaType: ref.mediaType,
        width: ref.width,
        height: ref.height,
        bytes: ref.bytes,
        description,
      }
    },
  }

  ctx.effect(() => {
    const disposeTool = ctx.tools.register(tool)
    return () => {
      disposeTool()
      visionSsh.dispose()
    }
  }, 'dsh-ssh-files-sidebar: direct Linked SSH vision')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-ssh-linked-vision',
    order: 153,
    text: (context: any) => {
      const sessionId = typeof context?.agent?.id === 'string' ? context.agent.id : ''
      if (sessionId === '' || store.get(sessionId) === undefined) return ''
      return [
        '## Linked SSH image inspection',
        'When the user asks to view/read/understand a PNG/JPEG/WebP/GIF on the linked server, or references an image through @ssh:..., use linked_ssh_read_image with the REMOTE path.',
        'linked_ssh_read_image reads the image directly through SFTP and a bounded vision-model call. Do NOT call linked_ssh_download followed by local read_image/models_read_image merely to inspect a server image.',
        'If linked_ssh_read_image reports that no image-capable model is configured, explain that configuration issue instead of retrying indefinitely.',
      ].join('\n')
    },
  }), 'dsh-ssh-files-sidebar: Linked SSH vision guidance')
}
