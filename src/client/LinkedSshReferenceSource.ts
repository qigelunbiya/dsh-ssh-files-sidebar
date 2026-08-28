import { getEffectiveSshAlias, hydrateLinkedSshAlias } from './linked-ssh-store.ts'
import { type ExecResult, type RemoteDirEntry } from './api.ts'

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

interface IndexedDirectory {
  readonly at: number
  readonly entries: readonly RemoteDirEntry[]
}

interface CachedSearch {
  readonly at: number
  readonly items: readonly CandidateLike[]
}

interface SearchQueueItem {
  readonly path: string
  readonly depth: number
}

const SOURCE_NAME = 'linked-ssh-reference'
const EXPLICIT_PREFIX = 'ssh:'
const SSH_SECTION = 'SSH文件与文件夹'
const SEARCH_LIMIT = 60
const SEARCH_DEBOUNCE_MS = 70
const SEARCH_CACHE_TTL_MS = 60_000
const DIRECTORY_CACHE_TTL_MS = 2 * 60_000
const FOREGROUND_SEARCH_LIMIT_MS = 2_450
const FAST_FIND_TIMEOUT_MS = 1_900
const SFTP_MAX_DEPTH = 5
const SFTP_DIRECTORY_BUDGET = 96
const SFTP_BATCH_SIZE = 6
const BACKGROUND_DIRECTORY_BUDGET = 120
const SEARCH_ROOTS = [
  '/apps', '/app', '/opt', '/srv', '/var/www', '/etc', '/home', '/root', '/tmp', '/usr/local',
] as const
const PRUNED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.cache', '__pycache__', '.npm', '.pnpm-store', '.yarn', 'proc', 'sys', 'dev',
])

const directoryCache = new Map<string, Map<string, IndexedDirectory>>()
const searchCache = new Map<string, Map<string, CachedSearch>>()
const warming = new Map<string, Promise<void>>()

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
    // Deliberately omit `icon`: older Harness builds can render the token name
    // ("file"/"folder") as text when a plugin bundle spans UI package revisions.
    // The section + filename remain clean and stable across those builds.
    description: `${parentPath(path)} · SSH ${alias}`,
    section: SSH_SECTION,
    value: JSON.stringify(value),
    ...(directory ? { drill: true } : {}),
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

function directoryMap(alias: string): Map<string, IndexedDirectory> {
  let map = directoryCache.get(alias)
  if (map === undefined) {
    map = new Map()
    directoryCache.set(alias, map)
  }
  return map
}

function searchMap(alias: string): Map<string, CachedSearch> {
  let map = searchCache.get(alias)
  if (map === undefined) {
    map = new Map()
    searchCache.set(alias, map)
  }
  return map
}

function rememberDirectory(alias: string, path: string, entries: readonly RemoteDirEntry[]): void {
  directoryMap(alias).set(normalizeAbsolutePath(path), { at: Date.now(), entries: [...entries] })
}

function cachedDirectory(alias: string, path: string): readonly RemoteDirEntry[] | undefined {
  const entry = directoryMap(alias).get(normalizeAbsolutePath(path))
  if (entry === undefined) return undefined
  // A stale directory is still useful for instant suggestions; background
  // warming refreshes it. Never make a user wait just to validate menu chrome.
  return entry.entries
}

function freshCachedSearch(alias: string, query: string): readonly CandidateLike[] | undefined {
  const map = searchMap(alias)
  const now = Date.now()
  const exact = map.get(query)
  if (exact !== undefined && now - exact.at <= SEARCH_CACHE_TTL_MS) return exact.items
  if (exact !== undefined) map.delete(query)
  return undefined
}

function setCachedSearch(alias: string, query: string, items: readonly CandidateLike[]): CandidateLike[] {
  const copy = [...items]
  searchMap(alias).set(query, { at: Date.now(), items: copy })
  return copy
}

function indexedMatches(alias: string, rawQuery: string): CandidateLike[] {
  const query = rawQuery.toLocaleLowerCase()
  const seen = new Set<string>()
  const matches: CandidateLike[] = []
  for (const [parent, indexed] of directoryMap(alias)) {
    for (const entry of indexed.entries) {
      if (entry.type !== 'dir' && entry.type !== 'file') continue
      if (!entry.name.toLocaleLowerCase().includes(query)) continue
      const path = joinRemotePath(parent, entry.name)
      if (seen.has(path)) continue
      seen.add(path)
      matches.push(candidate(alias, path, entry.type === 'dir' ? 'directory' : 'file'))
      if (matches.length >= SEARCH_LIMIT) return sortCandidates(matches)
    }
  }
  return sortCandidates(matches)
}

function withDeadline(parent: AbortSignal, ms: number): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let timeout = false
  const onParentAbort = (): void => controller.abort(parent.reason)
  if (parent.aborted) controller.abort(parent.reason)
  else parent.addEventListener('abort', onParentAbort, { once: true })
  const timer = window.setTimeout(() => {
    timeout = true
    controller.abort(new DOMException('SSH @ search deadline exceeded', 'TimeoutError'))
  }, ms)
  return {
    signal: controller.signal,
    dispose: () => {
      window.clearTimeout(timer)
      parent.removeEventListener('abort', onParentAbort)
    },
    timedOut: () => timeout,
  }
}

async function listRemoteDirSignal(alias: string, path: string, signal: AbortSignal): Promise<RemoteDirEntry[]> {
  const params = new URLSearchParams({ alias, path })
  const response = await fetch(`/api/dsh-ssh/ls?${params.toString()}`, { signal })
  const body = await response.json().catch(() => ({})) as { entries?: RemoteDirEntry[]; error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  const entries = Array.isArray(body.entries) ? body.entries : []
  rememberDirectory(alias, path, entries)
  return entries
}

async function waitForSearchDebounce(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    const timer = window.setTimeout(done, SEARCH_DEBOUNCE_MS)
    function done(): void {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

async function pathCandidates(alias: string, query: string, signal: AbortSignal): Promise<CandidateLike[]> {
  const request = pathRequest(query)
  if (request === undefined || signal.aborted) return []

  let entries = cachedDirectory(alias, request.directory)
  if (entries === undefined) {
    const deadline = withDeadline(signal, FOREGROUND_SEARCH_LIMIT_MS)
    try {
      entries = await listRemoteDirSignal(alias, request.directory, deadline.signal)
    } catch {
      entries = cachedDirectory(alias, request.directory) ?? []
    } finally {
      deadline.dispose()
    }
  }
  if (signal.aborted) return []
  const needle = request.needle.toLocaleLowerCase()
  return sortCandidates(entries
    .filter(entry => entry.type === 'dir' || entry.type === 'file')
    .filter(entry => needle === '' || entry.name.toLocaleLowerCase().includes(needle))
    .slice(0, SEARCH_LIMIT)
    .map(entry => candidate(alias, joinRemotePath(request.directory, entry.name), entry.type === 'dir' ? 'directory' : 'file')))
}

async function rootCandidates(alias: string, signal: AbortSignal): Promise<CandidateLike[]> {
  let entries = cachedDirectory(alias, '/')
  if (entries === undefined) {
    const deadline = withDeadline(signal, FOREGROUND_SEARCH_LIMIT_MS)
    try {
      entries = await listRemoteDirSignal(alias, '/', deadline.signal)
    } catch {
      entries = cachedDirectory(alias, '/') ?? []
    } finally {
      deadline.dispose()
    }
  }
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
    '  [ -d "$r" ] || continue;',
    `  find "$r" -maxdepth 7 \\(`,
    `    -type d \\( -name node_modules -o -name .git -o -name .cache -o -name __pycache__ \\) -prune`,
    `    -o \\( -type f -o -type d \\) -iname ${pattern} -printf '%y\\t%p\\n'`,
    '  \\) 2>/dev/null;',
    'done',
    `| head -n ${SEARCH_LIMIT}`,
  ].join(' ')
}

async function execFastFind(alias: string, term: string, signal: AbortSignal): Promise<CandidateLike[]> {
  try {
    const response = await fetch('/api/dsh-ssh/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({ alias, command: fastFindCommand(term), timeoutMs: FAST_FIND_TIMEOUT_MS }),
    })
    const body = await response.json().catch(() => ({})) as { result?: ExecResult; error?: string }
    if (!response.ok || body.result === undefined || signal.aborted) return []
    const seen = new Set<string>()
    const items: CandidateLike[] = []
    for (const line of body.result.stdout.split(/\r?\n/)) {
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
  } catch {
    return []
  }
}

async function boundedSftpSearch(alias: string, term: string, signal: AbortSignal): Promise<CandidateLike[]> {
  const needle = term.toLocaleLowerCase()
  const queue: SearchQueueItem[] = SEARCH_ROOTS.map(path => ({ path, depth: 0 }))
  const visited = new Set<string>()
  const matched = new Set<string>()
  const results: CandidateLike[] = []
  let count = 0

  while (queue.length > 0 && count < SFTP_DIRECTORY_BUDGET && results.length < SEARCH_LIMIT && !signal.aborted) {
    const batch: SearchQueueItem[] = []
    while (batch.length < SFTP_BATCH_SIZE && queue.length > 0 && count + batch.length < SFTP_DIRECTORY_BUDGET) {
      const item = queue.shift()!
      if (visited.has(item.path)) continue
      visited.add(item.path)
      batch.push(item)
    }
    if (batch.length === 0) continue
    count += batch.length

    const listings = await Promise.all(batch.map(async item => {
      try {
        const cached = cachedDirectory(alias, item.path)
        const entries = cached ?? await listRemoteDirSignal(alias, item.path, signal)
        return { item, entries }
      } catch {
        return { item, entries: [] as readonly RemoteDirEntry[] }
      }
    }))
    if (signal.aborted) break

    for (const { item, entries } of listings) {
      for (const entry of entries) {
        if (entry.type !== 'dir' && entry.type !== 'file') continue
        const path = joinRemotePath(item.path, entry.name)
        if (entry.name.toLocaleLowerCase().includes(needle) && !matched.has(path)) {
          matched.add(path)
          results.push(candidate(alias, path, entry.type === 'dir' ? 'directory' : 'file'))
          if (results.length >= SEARCH_LIMIT) break
        }
        if (
          entry.type === 'dir' &&
          item.depth < SFTP_MAX_DEPTH &&
          !PRUNED_DIRECTORY_NAMES.has(entry.name)
        ) queue.push({ path, depth: item.depth + 1 })
      }
    }
  }
  return sortCandidates(results)
}

async function firstUsefulSearch(alias: string, term: string, parentSignal: AbortSignal): Promise<CandidateLike[]> {
  const deadline = withDeadline(parentSignal, FOREGROUND_SEARCH_LIMIT_MS)
  try {
    const indexed = indexedMatches(alias, term)
    if (indexed.length > 0) return indexed

    // Race two independent fast paths. We settle immediately when either one
    // finds a match, but never let the composer spinner survive beyond 2.45 s.
    return await new Promise<CandidateLike[]>(resolve => {
      let pending = 2
      let settled = false
      const finish = (items: CandidateLike[]): void => {
        if (settled) return
        if (items.length > 0) {
          settled = true
          resolve(items)
          return
        }
        pending -= 1
        if (pending === 0) {
          settled = true
          resolve(indexedMatches(alias, term))
        }
      }
      const onAbort = (): void => {
        if (settled) return
        settled = true
        resolve(indexedMatches(alias, term))
      }
      deadline.signal.addEventListener('abort', onAbort, { once: true })
      void execFastFind(alias, term, deadline.signal).then(finish, () => finish([]))
      void boundedSftpSearch(alias, term, deadline.signal).then(finish, () => finish([]))
    })
  } finally {
    deadline.dispose()
  }
}

async function warmReferenceIndex(alias: string): Promise<void> {
  const existing = warming.get(alias)
  if (existing !== undefined) return existing
  const task = (async () => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 12_000)
    try {
      const queue: SearchQueueItem[] = SEARCH_ROOTS.map(path => ({ path, depth: 0 }))
      const seen = new Set<string>()
      let visited = 0
      while (queue.length > 0 && visited < BACKGROUND_DIRECTORY_BUDGET && !controller.signal.aborted) {
        const batch: SearchQueueItem[] = []
        while (batch.length < SFTP_BATCH_SIZE && queue.length > 0 && visited + batch.length < BACKGROUND_DIRECTORY_BUDGET) {
          const item = queue.shift()!
          if (seen.has(item.path)) continue
          seen.add(item.path)
          batch.push(item)
        }
        if (batch.length === 0) continue
        visited += batch.length
        const listings = await Promise.all(batch.map(async item => {
          try {
            const current = directoryMap(alias).get(item.path)
            const fresh = current !== undefined && Date.now() - current.at < DIRECTORY_CACHE_TTL_MS
            const entries = fresh ? current.entries : await listRemoteDirSignal(alias, item.path, controller.signal)
            return { item, entries }
          } catch {
            return { item, entries: [] as readonly RemoteDirEntry[] }
          }
        }))
        for (const { item, entries } of listings) {
          for (const entry of entries) {
            if (entry.type !== 'dir' || PRUNED_DIRECTORY_NAMES.has(entry.name) || item.depth >= 3) continue
            queue.push({ path: joinRemotePath(item.path, entry.name), depth: item.depth + 1 })
          }
        }
      }
    } finally {
      window.clearTimeout(timer)
    }
  })().finally(() => {
    if (warming.get(alias) === task) warming.delete(alias)
  })
  warming.set(alias, task)
  return task
}

async function remoteCandidates(alias: string, rawQuery: string, signal: AbortSignal): Promise<CandidateLike[]> {
  const query = rawQuery.trim()
  const pathMode = pathRequest(query)
  if (pathMode !== undefined) return await pathCandidates(alias, query, signal)
  if (query === '') return await rootCandidates(alias, signal)

  // Anything the background index already knows is returned synchronously-fast,
  // even for a single-character query.
  const indexed = indexedMatches(alias, query)
  if (indexed.length > 0) return indexed

  const normalized = query.toLocaleLowerCase()
  const cached = freshCachedSearch(alias, normalized)
  if (cached !== undefined) return [...cached]

  await waitForSearchDebounce(signal)
  if (signal.aborted) return []
  const afterDebounce = indexedMatches(alias, query)
  if (afterDebounce.length > 0) return afterDebounce

  const found = await firstUsefulSearch(alias, query, signal)
  if (signal.aborted) return []
  void warmReferenceIndex(alias)
  return setCachedSearch(alias, normalized, found)
}

function wireMention(value: RemoteReferenceValue): string {
  const path = value.kind === 'directory' ? ensureDirectoryToken(value.path) : value.path
  const token = `ssh:${value.alias}:${path}`
  // DSH's sent-user-text projection already renders every @path token as the
  // same compact file/folder chip used by local Workspace references. Reuse
  // that grammar so SSH references look native in conversation history.
  return /\s/u.test(token) ? `@"${token}"` : `@${token}`
}

function serializeReference(ref: string): string {
  const value = parseCandidate(ref)
  if (value === undefined) throw new Error('invalid SSH file reference')
  return wireMention(value)
}

/** Register a second @ group beside DSH's built-in local "文件与文件夹" group. */
export function registerLinkedSshReferenceSource(ctx: any): void {
  const source = {
    trigger: '@' as const,
    name: SOURCE_NAME,
    order: 10,
    showGroupTitle: false,
    warm(session: ClientSessionLike): void {
      void (async () => {
        const sessionId = String(session.sessionId)
        await hydrateLinkedSshAlias(sessionId)
        const alias = getEffectiveSshAlias(sessionId)
        if (alias !== null) void warmReferenceIndex(alias)
      })()
    },
    async candidates(session: ClientSessionLike, request: CandidateRequestLike): Promise<readonly CandidateLike[]> {
      const sessionId = String(session.sessionId)
      await hydrateLinkedSshAlias(sessionId)
      if (request.signal.aborted) return []
      const alias = getEffectiveSshAlias(sessionId)
      if (alias === null) return []
      void warmReferenceIndex(alias)
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
          clipboardText: wireMention(value),
        },
      }
    },
    codec: {
      clipboardText(ref: string): string {
        const value = parseCandidate(ref)
        return value === undefined ? '@ssh:' : wireMention(value)
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
