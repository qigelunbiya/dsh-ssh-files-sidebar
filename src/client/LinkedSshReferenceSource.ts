import { getEffectiveSshAlias, hydrateLinkedSshAlias } from './linked-ssh-store.ts'
import { listRemoteDir, type ExecResult, type RemoteDirEntry } from './api.ts'

interface ClientSessionLike {
  readonly sessionId: string
}

interface CandidateRequestLike {
  readonly query: string
  readonly quoted?: boolean
  readonly signal: AbortSignal
}

interface CandidateLike {
  readonly name: string
  readonly description?: string
  readonly icon?: 'file' | 'folder' | 'session'
  readonly section?: string
  readonly value?: string
  readonly drill?: boolean
}

interface PickLike {
  readonly candidate: CandidateLike
  readonly action?: 'pick' | 'drill'
}

interface RemoteReferenceValue {
  readonly v: 1
  readonly alias: string
  readonly path: string
  readonly kind: 'file' | 'directory'
}

interface SearchQueueItem {
  readonly path: string
  readonly depth: number
}

interface CachedSearch {
  readonly at: number
  readonly items: CandidateLike[]
}

const SOURCE_NAME = 'linked-ssh-reference'
const EXPLICIT_PREFIX = 'ssh:'
const SSH_SECTION = 'SSH文件与文件夹'
const SEARCH_LIMIT = 60
const SEARCH_MAX_DEPTH = 7
const SEARCH_DIRECTORY_BUDGET = 180
const SEARCH_BATCH_SIZE = 8
const SEARCH_DEBOUNCE_MS = 110
const SEARCH_CACHE_TTL_MS = 30_000
const REMOTE_FIND_TIMEOUT_MS = 1_800
const SEARCH_ROOTS = [
  '/apps', '/app', '/opt', '/srv', '/var/www', '/etc', '/home', '/root', '/tmp', '/usr/local',
] as const
const PRUNED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.cache', '__pycache__', '.npm', '.pnpm-store', '.yarn', 'proc', 'sys', 'dev',
])
const searchCache = new Map<string, Map<string, CachedSearch>>()

function basename(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  const at = normalized.lastIndexOf('/')
  return at >= 0 ? normalized.slice(at + 1) || '/' : normalized || '/'
}

function parentPath(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  const at = normalized.lastIndexOf('/')
  return at <= 0 ? '/' : normalized.slice(0, at)
}

function normalizeAbsolutePath(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '' || trimmed === '/') return '/'
  const withRoot = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withRoot.replace(/\/{2,}/g, '/')
}

function joinRemotePath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent.replace(/\/+$/, '')}/${name}`
}

function ensureDirectoryToken(path: string): string {
  const normalized = normalizeAbsolutePath(path)
  return normalized.endsWith('/') ? normalized : `${normalized}/`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function parseCandidate(value: string | undefined): RemoteReferenceValue | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<RemoteReferenceValue>
    if (parsed.v !== 1) return undefined
    if (typeof parsed.alias !== 'string' || parsed.alias === '') return undefined
    if (typeof parsed.path !== 'string' || !parsed.path.startsWith('/')) return undefined
    if (parsed.kind !== 'file' && parsed.kind !== 'directory') return undefined
    return parsed as RemoteReferenceValue
  } catch {
    return undefined
  }
}

function candidate(alias: string, path: string, kind: RemoteReferenceValue['kind']): CandidateLike {
  const directory = kind === 'directory'
  const value: RemoteReferenceValue = { v: 1, alias, path, kind }
  return {
    name: `${basename(path)}${directory ? '/' : ''}`,
    // Keep the row compact and easy to distinguish from the local Workspace
    // group: path first, then the authoritative SSH target.
    description: `${parentPath(path)} · SSH ${alias}`,
    icon: directory ? 'folder' : 'file',
    section: SSH_SECTION,
    value: JSON.stringify(value),
    ...(directory ? { drill: true } : {}),
  }
}

function pathRequest(query: string): { directory: string; needle: string } | undefined {
  let value = query.trim()
  const explicit = value.toLowerCase().startsWith(EXPLICIT_PREFIX)
  if (explicit) value = value.slice(EXPLICIT_PREFIX.length)

  const pathLike = explicit || value.startsWith('/') || value.includes('/')
  if (!pathLike) return undefined

  const normalized = normalizeAbsolutePath(value)
  if (value.endsWith('/') || normalized === '/') return { directory: normalized, needle: '' }
  const slash = normalized.lastIndexOf('/')
  return {
    directory: slash <= 0 ? '/' : normalized.slice(0, slash),
    needle: normalized.slice(slash + 1),
  }
}

function sortCandidates(items: CandidateLike[]): CandidateLike[] {
  return items.sort((left, right) => {
    const leftValue = parseCandidate(left.value)
    const rightValue = parseCandidate(right.value)
    if (leftValue?.kind !== rightValue?.kind) return leftValue?.kind === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

async function safeListRemoteDir(alias: string, path: string): Promise<RemoteDirEntry[]> {
  try {
    return await listRemoteDir(alias, path)
  } catch {
    return []
  }
}

function waitForSearchDebounce(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = window.setTimeout(done, SEARCH_DEBOUNCE_MS)
    function done(): void {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function cacheFor(alias: string): Map<string, CachedSearch> {
  let cache = searchCache.get(alias)
  if (cache === undefined) {
    cache = new Map()
    searchCache.set(alias, cache)
  }
  return cache
}

function getCachedSearch(alias: string, query: string): CandidateLike[] | undefined {
  const cache = cacheFor(alias)
  const now = Date.now()
  for (const [key, value] of cache) {
    if (now - value.at > SEARCH_CACHE_TTL_MS) cache.delete(key)
  }

  const exact = cache.get(query)
  if (exact !== undefined) return exact.items

  // When the user keeps typing the same filename, refine a complete earlier
  // result set locally instead of re-touching SSH on every keystroke.
  let bestPrefix = ''
  let best: CachedSearch | undefined
  for (const [key, value] of cache) {
    if (key.length < 2 || key.length >= query.length || !query.startsWith(key)) continue
    // A full SEARCH_LIMIT page may have been truncated, so do not treat it as
    // a complete universe for a more specific query.
    if (value.items.length >= SEARCH_LIMIT) continue
    if (key.length > bestPrefix.length) {
      bestPrefix = key
      best = value
    }
  }
  if (best === undefined) return undefined

  const needle = query.toLocaleLowerCase()
  const filtered = best.items.filter(item => {
    const value = parseCandidate(item.value)
    return value !== undefined && (
      basename(value.path).toLocaleLowerCase().includes(needle) ||
      value.path.toLocaleLowerCase().includes(needle)
    )
  })
  cache.set(query, { at: now, items: filtered })
  return filtered
}

function setCachedSearch(alias: string, query: string, items: CandidateLike[]): CandidateLike[] {
  cacheFor(alias).set(query, { at: Date.now(), items })
  return items
}

async function pathCandidates(alias: string, query: string, signal: AbortSignal): Promise<CandidateLike[]> {
  const request = pathRequest(query)
  if (request === undefined || signal.aborted) return []

  const entries = await listRemoteDir(alias, request.directory)
  if (signal.aborted) return []
  const needle = request.needle.toLocaleLowerCase()

  return sortCandidates(entries
    .filter(entry => entry.type === 'dir' || entry.type === 'file')
    .filter(entry => needle === '' || entry.name.toLocaleLowerCase().includes(needle))
    .slice(0, SEARCH_LIMIT)
    .map(entry => candidate(
      alias,
      joinRemotePath(request.directory, entry.name),
      entry.type === 'dir' ? 'directory' : 'file',
    )))
}

async function rootCandidates(alias: string, signal: AbortSignal): Promise<CandidateLike[]> {
  if (signal.aborted) return []
  const entries = await listRemoteDir(alias, '/')
  if (signal.aborted) return []
  return sortCandidates(entries
    .filter(entry => entry.type === 'dir' || entry.type === 'file')
    .slice(0, SEARCH_LIMIT)
    .map(entry => candidate(alias, `/${entry.name}`, entry.type === 'dir' ? 'directory' : 'file')))
}

function fastFindCommand(term: string): string {
  const roots = SEARCH_ROOTS.map(shellQuote).join(' ')
  const pattern = shellQuote(`*${term}*`)
  return [
    `for r in ${roots}; do`,
    '  [ -d "$r" ] || continue',
    `  find "$r" -maxdepth ${SEARCH_MAX_DEPTH} \\(`,
    `    -type d -o -type f`,
    `  \\)`,
    `  ! -path '*/node_modules/*'`,
    `  ! -path '*/.git/*'`,
    `  ! -path '*/.cache/*'`,
    `  ! -path '*/__pycache__/*'`,
    `  -iname ${pattern} -printf '%y\\t%p\\n' 2>/dev/null`,
    'done',
    `| head -n ${SEARCH_LIMIT}`,
  ].join(' ')
}

async function execFastFind(alias: string, term: string, signal: AbortSignal): Promise<CandidateLike[] | undefined> {
  try {
    const response = await fetch('/api/dsh-ssh/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({ alias, command: fastFindCommand(term), timeoutMs: REMOTE_FIND_TIMEOUT_MS }),
    })
    const body = await response.json().catch(() => ({})) as { result?: ExecResult; error?: string }
    if (!response.ok || body.result === undefined) return undefined
    if (signal.aborted) return []
    if (!body.result.success && body.result.stdout.trim() === '') return undefined

    const seen = new Set<string>()
    const items: CandidateLike[] = []
    for (const line of body.result.stdout.split(/\r?\n/)) {
      if (line === '') continue
      const tab = line.indexOf('\t')
      if (tab <= 0) continue
      const type = line.slice(0, tab)
      const path = line.slice(tab + 1)
      if (!path.startsWith('/') || seen.has(path)) continue
      const kind: RemoteReferenceValue['kind'] | undefined = type === 'd' ? 'directory' : type === 'f' ? 'file' : undefined
      if (kind === undefined) continue
      seen.add(path)
      items.push(candidate(alias, path, kind))
    }
    return sortCandidates(items).slice(0, SEARCH_LIMIT)
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return []
    return undefined
  }
}

/** Reliable fallback using the same SFTP-backed API as SSH Files. */
async function recursiveSftpSearch(alias: string, term: string, signal: AbortSignal): Promise<CandidateLike[]> {
  const needle = term.toLocaleLowerCase()
  const queue: SearchQueueItem[] = SEARCH_ROOTS.map(path => ({ path, depth: 0 }))
  const seenDirectories = new Set<string>()
  const seenMatches = new Set<string>()
  const matches: CandidateLike[] = []
  let visited = 0

  while (queue.length > 0 && visited < SEARCH_DIRECTORY_BUDGET && matches.length < SEARCH_LIMIT) {
    if (signal.aborted) return []

    const batch: SearchQueueItem[] = []
    while (batch.length < SEARCH_BATCH_SIZE && queue.length > 0 && visited + batch.length < SEARCH_DIRECTORY_BUDGET) {
      const item = queue.shift()!
      if (seenDirectories.has(item.path)) continue
      seenDirectories.add(item.path)
      batch.push(item)
    }
    if (batch.length === 0) continue
    visited += batch.length

    const listings = await Promise.all(batch.map(async item => ({
      item,
      entries: await safeListRemoteDir(alias, item.path),
    })))
    if (signal.aborted) return []

    for (const { item, entries } of listings) {
      for (const entry of entries) {
        if (entry.type !== 'dir' && entry.type !== 'file') continue
        const path = joinRemotePath(item.path, entry.name)
        const kind: RemoteReferenceValue['kind'] = entry.type === 'dir' ? 'directory' : 'file'

        if (entry.name.toLocaleLowerCase().includes(needle) && !seenMatches.has(path)) {
          seenMatches.add(path)
          matches.push(candidate(alias, path, kind))
          if (matches.length >= SEARCH_LIMIT) break
        }

        if (
          entry.type === 'dir' &&
          item.depth < SEARCH_MAX_DEPTH &&
          !PRUNED_DIRECTORY_NAMES.has(entry.name)
        ) {
          queue.push({ path, depth: item.depth + 1 })
        }
      }
      if (matches.length >= SEARCH_LIMIT) break
    }
  }

  return sortCandidates(matches)
}

async function remoteCandidates(alias: string, rawQuery: string, signal: AbortSignal): Promise<CandidateLike[]> {
  const query = rawQuery.trim()
  const pathMode = pathRequest(query)
  if (pathMode !== undefined) return await pathCandidates(alias, query, signal)
  if (query === '') return await rootCandidates(alias, signal)
  if (query.length < 2) return []

  const normalizedQuery = query.toLocaleLowerCase()
  const cached = getCachedSearch(alias, normalizedQuery)
  if (cached !== undefined) return cached

  // Do not launch an SSH search for every intermediate key while the user is
  // still typing. Superseded requests are aborted by Harness.
  await waitForSearchDebounce(signal)
  if (signal.aborted) return []

  const afterDebounceCache = getCachedSearch(alias, normalizedQuery)
  if (afterDebounceCache !== undefined) return afterDebounceCache

  // Fast path: one server-side find usually answers in tens/hundreds of ms.
  // If that command is unavailable or fails on an unusual server, fall back
  // to the proven SFTP traversal used by SSH Files.
  const fast = await execFastFind(alias, query, signal)
  if (signal.aborted) return []
  if (fast !== undefined) return setCachedSearch(alias, normalizedQuery, fast)

  const fallback = await recursiveSftpSearch(alias, query, signal)
  if (signal.aborted) return []
  return setCachedSearch(alias, normalizedQuery, fallback)
}

function serializeReference(ref: string): string {
  const value = parseCandidate(ref)
  if (value === undefined) throw new Error('invalid SSH file reference')
  // The submitted user bubble renders the codec serialization. Keep this
  // human-readable and compact; the Agent already has Linked SSH routing rules
  // and only needs the authoritative alias + path here.
  return `【SSH${value.kind === 'directory' ? '文件夹' : '文件'}：${value.alias}:${value.path}】`
}

/** Register a second @ group beside DSH's built-in local "文件与文件夹" group. */
export function registerLinkedSshReferenceSource(ctx: any): void {
  const source = {
    trigger: '@' as const,
    name: SOURCE_NAME,
    order: 10,
    showGroupTitle: false,
    warm(session: ClientSessionLike): void {
      void hydrateLinkedSshAlias(String(session.sessionId))
    },
    async candidates(session: ClientSessionLike, request: CandidateRequestLike): Promise<readonly CandidateLike[]> {
      const sessionId = String(session.sessionId)
      await hydrateLinkedSshAlias(sessionId)
      if (request.signal.aborted) return []
      const alias = getEffectiveSshAlias(sessionId)
      if (alias === null) return []
      try {
        return await remoteCandidates(alias, request.query, request.signal)
      } catch (error) {
        if (request.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return []
        console.warn('[dsh-ssh-files-sidebar] SSH @ search failed:', error)
        return []
      }
    },
    onPick({ candidate: picked, action }: PickLike) {
      const value = parseCandidate(picked.value)
      if (value === undefined) return undefined

      if (value.kind === 'directory' && action === 'drill') {
        return {
          text: `@${EXPLICIT_PREFIX}${ensureDirectoryToken(value.path)}`,
          continue: true,
        }
      }

      return {
        insert: {
          source: SOURCE_NAME,
          ref: JSON.stringify(value),
          label: `SSH:${value.alias} · ${basename(value.path)}${value.kind === 'directory' ? '/' : ''}`,
          appearance: value.kind === 'directory' ? 'folder' as const : 'file' as const,
          clipboardText: `@${EXPLICIT_PREFIX}${value.path}${value.kind === 'directory' ? '/' : ''}`,
        },
      }
    },
    codec: {
      clipboardText(ref: string): string {
        const value = parseCandidate(ref)
        if (value === undefined) return '@ssh:'
        return `@${EXPLICIT_PREFIX}${value.path}${value.kind === 'directory' ? '/' : ''}`
      },
      async serialize(ref: string, _signal: AbortSignal): Promise<string> {
        return serializeReference(ref)
      },
    },
  }

  const inputTriggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : ctx.inputTriggers
  if (inputTriggers?.registerSource === undefined) {
    throw new Error('inputTriggers service is unavailable; SSH @ references cannot be registered')
  }
  ctx.effect(
    () => inputTriggers.registerSource(source),
    'dsh-ssh-files-sidebar: SSH @ references',
  )
}
