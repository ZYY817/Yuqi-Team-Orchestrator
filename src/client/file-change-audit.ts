/** Evidence derived from Host result records, never from call-time previews or prose. */
export interface FileChangeRecord {
  readonly source: 'tool-result-diff' | 'successful-write-call' | 'agent-report'
  readonly path: string
  readonly sessionId?: string
  readonly callId?: string
  readonly eventSeq?: number
  readonly tool?: string
}

export interface FileContentChange {
  /** File existence is unknown: null on a hunk side does not prove creation/deletion. */
  readonly kind: 'modified'
  readonly scope: 'fragments'
  /** Bounded, newline-separated compatibility previews; never complete file contents. */
  readonly before: string
  readonly after: string
  readonly segments: readonly FileContentChangeSegment[]
  /** All valid, changed fragments for this path in the selected result. */
  readonly segmentCount: number
  readonly omittedSegmentCount: number
  readonly truncated: boolean
}

export interface FileContentChangeSegment {
  /** Index in the result's original diffs array, not a line number. */
  readonly diffIndex: number
  /** null means absent hunk text, not proof that the file did not/does not exist. */
  readonly before: string | null
  readonly after: string | null
  readonly truncated: boolean
}

const CONTENT_SIDE_LIMIT = 12_000
const CONTENT_SEGMENT_LIMIT = 200

/** Read the exact, successful result selected by the user; never inspect call previews. */
export function readFileContentChange(record: FileChangeRecord, nodes: readonly unknown[]): FileContentChange | undefined {
  if (record.source !== 'tool-result-diff') return undefined
  // Tool history can contain credentials. Do not surface common secret files in the diff viewer.
  if (/(?:^|[\\/])(?:\.env(?:\..*)?|[^\\/]*\.(?:pem|key|p12|pfx)|credentials(?:\.[^\\/]*)?)$/iu.test(record.path)) return undefined
  for (const raw of nodes) {
    const node = object(raw)
    if (node?.kind !== 'tool-result' || node.seq !== record.eventSeq || node.callId !== record.callId
      || node.isError !== false || node.error !== undefined) continue
    const diffs = object(node.meta)?.diffs
    if (!Array.isArray(diffs)) continue
    let before = ''
    let after = ''
    let segmentCount = 0
    let truncated = false
    const segments: FileContentChangeSegment[] = []
    // Separators count toward the same side budget as fragment text.
    const take = (text: string | null, side: 'before' | 'after'): string | null => {
      if (text === null) return null
      const current = side === 'before' ? before : after
      const separator = current.length > 0 && current.length < CONTENT_SIDE_LIMIT ? '\n' : ''
      const preview = text.slice(0, Math.max(0, CONTENT_SIDE_LIMIT - current.length - separator.length))
      if (side === 'before') before += separator + preview
      else after += separator + preview
      return preview
    }
    for (let diffIndex = 0; diffIndex < diffs.length; diffIndex++) {
      const rawDiff = diffs[diffIndex]
      const diff = object(rawDiff)
      if (diff?.path !== record.path || !(diff.oldText === null || typeof diff.oldText === 'string')
        || !(diff.newText === null || typeof diff.newText === 'string') || diff.oldText === diff.newText) continue
      segmentCount++
      if (segments.length >= CONTENT_SEGMENT_LIMIT || (before.length >= CONTENT_SIDE_LIMIT && after.length >= CONTENT_SIDE_LIMIT)) {
        truncated = true
        continue
      }
      const oldPreview = take(diff.oldText, 'before')
      const newPreview = take(diff.newText, 'after')
      const segmentTruncated = oldPreview !== diff.oldText || newPreview !== diff.newText
      segments.push({ diffIndex, before: oldPreview, after: newPreview, truncated: segmentTruncated })
      truncated ||= segmentTruncated
    }
    // Do not merge other result events, even if they contain a matching path.
    return segmentCount === 0 ? undefined : {
      kind: 'modified', scope: 'fragments', before, after, segments, segmentCount,
      omittedSegmentCount: segmentCount - segments.length, truncated,
    }
  }
  return undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function path(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** No fileScope filtering: paths are displayed as reported, without claiming canonical filesystem identity. */
export function deriveFileChangeAudit(sessionId: string | undefined, nodes: readonly unknown[], reported: readonly string[] = []): readonly FileChangeRecord[] {
  const records = new Map<string, FileChangeRecord>()
  for (const raw of nodes) {
    const node = object(raw)
    if (sessionId === undefined || node?.kind !== 'tool-result' || node.isError !== false || node.error !== undefined
      || typeof node.callId !== 'string' || typeof node.seq !== 'number' || !Number.isSafeInteger(node.seq) || node.seq < 0) continue
    const call = object(node.call)
    // These Host filesystem tools supply result-time diffs. Shell/custom tools need independent instrumentation.
    if (call?.name !== 'write' && call?.name !== 'edit') continue
    let args: Record<string, unknown> | undefined
    try { args = object(JSON.parse(typeof call.argsRaw === 'string' ? call.argsRaw : '')) } catch { continue }
    if (args === undefined || !path(args.file_path)) continue
    const origin = { sessionId, callId: node.callId, eventSeq: node.seq, tool: call.name }
    const diffs = object(node.meta)?.diffs
    const validDiffs = Array.isArray(diffs) && diffs.length > 0 && diffs.every(rawDiff => {
      const diff = object(rawDiff)
      return diff !== undefined && path(diff.path) && diff.path === args.file_path
        && (diff.oldText === null || typeof diff.oldText === 'string') && (diff.newText === null || typeof diff.newText === 'string')
    }) ? diffs.map(value => object(value)!) : []
    const changed = validDiffs.filter(diff => diff.oldText !== diff.newText)
    if (changed.length > 0) {
      for (const diff of changed) {
        const record: FileChangeRecord = { ...origin, source: 'tool-result-diff', path: diff.path as string }
        records.set(JSON.stringify([sessionId, origin.eventSeq, record.source, record.path]), record)
      }
    } else {
      // Successful writes may create a file with empty diff metadata, or rewrite identical bytes.
      const record: FileChangeRecord = { ...origin, source: 'successful-write-call', path: args.file_path }
      records.set(JSON.stringify([sessionId, origin.eventSeq, record.source, record.path]), record)
    }
  }
  for (const value of reported) {
    if (path(value)) records.set(JSON.stringify(['agent-report', value]), { source: 'agent-report', path: value })
  }
  return [...records.values()]
}
