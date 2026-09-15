/** Bounded observations of a shared workspace; never proof of agent ownership. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import path from 'node:path'

export const WORKSPACE_CHANGE_SNAPSHOT_EVENT = 'yuqi/workspace-change-snapshot' as const
export interface SnapshotLimits {
  maxFiles: number
  maxEntries: number
  maxFileBytes: number
  maxTotalBytes: number
  maxChanges: number
  timeoutMs: number
}
export const WORKSPACE_SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
  maxFiles: 2048, maxEntries: 8192, maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024, maxChanges: 512, timeoutMs: 1500,
})
export interface FileFingerprint { readonly sha256: string; readonly size: number }
export interface WorkspaceSnapshot {
  readonly root: string
  readonly capturedAt: string
  readonly files: ReadonlyMap<string, FileFingerprint>
  readonly partial: boolean
  readonly absenceReliable: boolean
  readonly reasons: readonly string[]
  readonly limits: SnapshotLimits
}
export interface WorkspaceChangeSnapshotEvent {
  readonly version: 1
  readonly childSessionId: string
  readonly runId: string
  readonly scope: 'workspace'
  readonly attribution: 'unavailable'
  readonly beforeCapturedAt: string
  readonly afterCapturedAt: string
  readonly partial: boolean
  readonly reasons: readonly string[]
  readonly limits: SnapshotLimits
  readonly changes: readonly {
    readonly path: string
    readonly kind: 'added' | 'modified' | 'deleted'
    readonly before?: FileFingerprint
    readonly after?: FileFingerprint
  }[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'yuqi/workspace-change-snapshot': WorkspaceChangeSnapshotEvent
  }
}

/** Case-insensitive directory basenames, excluded at every depth, not path prefixes. */
export const WORKSPACE_SNAPSHOT_EXCLUDED_DIRECTORIES = Object.freeze([
  '.git', 'node_modules', '.yuqi-team', 'build', 'dist', 'coverage', '.next', '.cache', '.turbo', '.venv', 'venv',
])
const excluded = new Set(WORKSPACE_SNAPSHOT_EXCLUDED_DIRECTORIES)
const sensitive = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.npmrc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|auth\.json|id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx|keystore)$/iu

/** Bounds waiting as well as work. A timed-out operation must check signal before later writes. */
export async function boundedSnapshotOperation<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T | undefined> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)).catch(() => undefined),
      new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(undefined) }, timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}

/** No contents, absolute paths, or raw filesystem errors leave this collector. */
export async function captureWorkspaceSnapshot(root: string, options: Partial<SnapshotLimits> = {}, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  const limits = { ...WORKSPACE_SNAPSHOT_LIMITS }
  for (const key of Object.keys(limits) as (keyof SnapshotLimits)[]) {
    const value = options[key]
    if (value !== undefined && Number.isSafeInteger(value) && value > 0) limits[key] = Math.min(value, limits[key])
  }
  const files = new Map<string, FileFingerprint>()
  const reasons = new Set<string>()
  const capturedAt = new Date().toISOString()
  const absolute = path.resolve(root)
  let entries = 0
  let fileCount = 0
  let bytes = 0
  const result = await boundedSnapshotOperation(async timeout => {
    const check = () => {
      if (timeout.aborted || signal?.aborted) { reasons.add('cancelled'); throw new Error('cancelled') }
    }
    // Check every component, including ancestors of the supplied workspace.
    const safePath = async (target: string) => {
      const parsed = path.parse(target)
      let cursor = parsed.root
      for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        check()
        cursor = path.join(cursor, part)
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error('symlink')
      }
      const canonical = await realpath(target)
      if (process.platform === 'win32' ? canonical.toLowerCase() !== target.toLowerCase() : canonical !== target) throw new Error('path-changed')
      check()
    }
    const walk = async (directory: string, depth: number): Promise<void> => {
      check()
      if (depth > 32) { reasons.add('depth-limit'); return }
      await safePath(directory)
      const dir = await opendir(directory)
      try {
        for await (const entry of dir) {
          check()
          if (++entries > limits.maxEntries) { reasons.add('entry-limit'); return }
          // Worktrees use a .git pointer file instead of a directory.
          if (entry.name.toLowerCase() === '.git' && !entry.isDirectory()) { reasons.add('excluded'); continue }
          if (excluded.has(entry.name.toLowerCase()) && entry.isDirectory()) {
            reasons.add('excluded')
            reasons.add(`excluded-directory:${entry.name.toLowerCase()}`)
            continue
          }
          if (sensitive.test(entry.name)) { reasons.add('sensitive-excluded'); continue }
          const target = path.join(directory, entry.name)
          const relative = path.relative(absolute, target).split(path.sep).join('/')
          if (relative.length > 1024 || /[\u0000-\u001f\u007f\\]/u.test(relative)) { reasons.add('path-excluded'); continue }
          try {
            const stat = await lstat(target)
            if (stat.isSymbolicLink()) { reasons.add('symlink-excluded'); continue }
            if (stat.isDirectory()) { await walk(target, depth + 1); continue }
            if (!stat.isFile() || stat.nlink > 1) { reasons.add('special-file-excluded'); continue }
            if (++fileCount > limits.maxFiles) { reasons.add('file-limit'); return }
            if (stat.size > limits.maxFileBytes) { reasons.add('file-size-limit'); continue }
            if (bytes + stat.size > limits.maxTotalBytes) { reasons.add('total-size-limit'); return }
            await safePath(target)
            const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
            try {
              const first = await file.stat()
              if (!first.isFile() || first.nlink > 1 || first.ino !== stat.ino || first.dev !== stat.dev || first.size !== stat.size) throw new Error('changed')
              const hash = createHash('sha256')
              const buffer = Buffer.alloc(64 * 1024)
              let size = 0
              while (true) {
                check()
                const read = await file.read(buffer, 0, Math.min(buffer.length, limits.maxFileBytes - size + 1), null)
                if (read.bytesRead === 0) break
                size += read.bytesRead
                bytes += read.bytesRead
                if (size > limits.maxFileBytes || bytes > limits.maxTotalBytes) throw new Error('size-limit')
                hash.update(buffer.subarray(0, read.bytesRead))
              }
              const last = await file.stat()
              await safePath(target)
              const current = await lstat(target)
              if (size !== first.size || last.size !== first.size || last.mtimeMs !== first.mtimeMs || last.ctimeMs !== first.ctimeMs
                || current.ino !== first.ino || current.dev !== first.dev || current.isSymbolicLink()) throw new Error('changed')
              check()
              files.set(relative, { sha256: hash.digest('hex'), size })
            } finally { await file.close() }
          } catch { reasons.add('unreadable-or-unstable') }
          if (fileCount >= limits.maxFiles || entries >= limits.maxEntries || bytes >= limits.maxTotalBytes) {
            reasons.add('resource-limit'); return
          }
        }
      } finally { await dir.close().catch(() => undefined) }
    }
    try { await walk(absolute, 0); return true } catch { reasons.add('unreadable-or-unstable'); return false }
  }, limits.timeoutMs)
  if (result === undefined) reasons.add('timeout')
  if (signal?.aborted) reasons.add('cancelled')
  // Detached copies: an outstanding OS read cannot mutate a returned snapshot.
  return { root: absolute, capturedAt, files: new Map(files), partial: reasons.size > 0,
    absenceReliable: [...reasons].every(reason => ['excluded', 'sensitive-excluded', 'path-excluded'].includes(reason)
      || reason.startsWith('excluded-directory:')),
    reasons: [...reasons].sort(), limits }
}

export function compareWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot, childSessionId: string, runId: string): WorkspaceChangeSnapshotEvent {
  const reasons = new Set([...before.reasons, ...after.reasons])
  const changes: WorkspaceChangeSnapshotEvent['changes'][number][] = []
  const sameRoot = before.root === after.root
  if (!sameRoot) reasons.add('workspace-mismatch')
  if (sameRoot) for (const name of [...new Set([...before.files.keys(), ...after.files.keys()])].sort()) {
    const old = before.files.get(name)
    const current = after.files.get(name)
    if (old && current && old.sha256 === current.sha256 && old.size === current.size) continue
    // Absence from an incomplete scan is not evidence of creation/deletion.
    if ((!old && !before.absenceReliable) || (!current && !after.absenceReliable)) { reasons.add('unconfirmed-absence'); continue }
    if (changes.length >= before.limits.maxChanges) { reasons.add('change-limit'); break }
    changes.push({ path: name, kind: !old ? 'added' : !current ? 'deleted' : 'modified',
      ...(old ? { before: old } : {}), ...(current ? { after: current } : {}) })
  }
  return { version: 1, childSessionId, runId, scope: 'workspace', attribution: 'unavailable',
    beforeCapturedAt: before.capturedAt, afterCapturedAt: after.capturedAt,
    partial: reasons.size > 0, reasons: [...reasons].sort(), limits: before.limits, changes }
}
