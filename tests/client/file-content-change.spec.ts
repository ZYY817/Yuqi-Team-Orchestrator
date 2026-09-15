import { describe, expect, it } from 'vitest'
import { deriveFileChangeAudit, readFileContentChange } from '../../src/client/file-change-audit.ts'

const node = (oldText: string | null, newText: string | null, file = 'src/a.ts') => ({
  kind: 'tool-result', seq: 3, callId: 'c', isError: false,
  call: { name: 'edit', argsRaw: JSON.stringify({ file_path: file }) },
  meta: { diffs: [{ path: file, oldText, newText }] },
})
describe('bounded recorded content preview', () => {
  it.each([[null, 'new'], ['old', 'new'], ['old', null]] as const)('shows %s → %s as fragment evidence without inferring file existence', (before, after) => {
    const nodes = [node(before, after)]
    const record = deriveFileChangeAudit('child', nodes)[0]!
    expect(readFileContentChange(record, nodes)).toEqual({
      kind: 'modified', scope: 'fragments', before: before ?? '', after: after ?? '', truncated: false,
      segments: [{ diffIndex: 0, before, after, truncated: false }], segmentCount: 1, omittedSegmentCount: 0,
    })
  })
  it('does not put bodies into the file list, and bounds a selected body', () => {
    const nodes = [node('a'.repeat(15_000), 'new')]
    const record = deriveFileChangeAudit('child', nodes)[0]!
    expect(JSON.stringify(record)).not.toContain('aaaa')
    expect(readFileContentChange(record, nodes)?.before).toHaveLength(12_000)
    expect(readFileContentChange(record, nodes)?.truncated).toBe(true)
  })
  it.each(['.env', 'nested/.env.local', 'private.key', 'cert.pem', 'credentials.json'])('hides common secret file %s', file => {
    const nodes = [node('old', 'secret', file)]
    expect(readFileContentChange(deriveFileChangeAudit('child', nodes)[0]!, nodes)).toBeUndefined()
  })
  it('never promotes self-report, other events or failed results', () => {
    const nodes = [node('old', 'new')]
    expect(readFileContentChange({ source: 'agent-report', path: 'src/a.ts' }, nodes)).toBeUndefined()
    const record = deriveFileChangeAudit('child', nodes)[0]!
    expect(readFileContentChange({ ...record, eventSeq: 99 }, nodes)).toBeUndefined()
    expect(readFileContentChange(record, [{ ...nodes[0], isError: true }])).toBeUndefined()
  })

  it('retains every write-result hunk in order rather than returning the first one', () => {
    const result = { ...node('first old', 'first new'), call: { name: 'write', argsRaw: JSON.stringify({ file_path: 'src/a.ts' }) }, meta: { diffs: [
      { path: 'src/a.ts', oldText: 'first old', newText: 'first new' },
      { path: 'src/a.ts', oldText: null, newText: 'inserted lines' },
      { path: 'src/a.ts', oldText: 'removed lines', newText: null },
      { path: 'src/a.ts', oldText: 'last old', newText: 'last new' },
    ] } }
    const record = deriveFileChangeAudit('child', [result])[0]!
    expect(readFileContentChange(record, [result])).toEqual({
      kind: 'modified', scope: 'fragments', before: 'first old\nremoved lines\nlast old', after: 'first new\ninserted lines\nlast new',
      segments: [
        { diffIndex: 0, before: 'first old', after: 'first new', truncated: false },
        { diffIndex: 1, before: null, after: 'inserted lines', truncated: false },
        { diffIndex: 2, before: 'removed lines', after: null, truncated: false },
        { diffIndex: 3, before: 'last old', after: 'last new', truncated: false },
      ], segmentCount: 4, omittedSegmentCount: 0, truncated: false,
    })
  })

  it('shares each 12k budget across segments, including separators, and reports omitted segments', () => {
    const result = { ...node('', ''), meta: { diffs: [
      { path: 'src/a.ts', oldText: 'a'.repeat(6000), newText: 'b'.repeat(6000) },
      { path: 'src/a.ts', oldText: 'c'.repeat(6000), newText: 'd'.repeat(6000) },
      { path: 'src/a.ts', oldText: 'e', newText: 'f' },
    ] } }
    const record = deriveFileChangeAudit('child', [result])[0]!
    const preview = readFileContentChange(record, [result])!
    expect(preview.before).toHaveLength(12000)
    expect(preview.after).toHaveLength(12000)
    expect(preview.segments.map(segment => segment.before ?? '').join('\n')).toBe(preview.before)
    expect(preview.segments.map(segment => segment.after ?? '').join('\n')).toBe(preview.after)
    expect(preview.segments[1]).toMatchObject({ before: 'c'.repeat(5999), after: 'd'.repeat(5999), truncated: true })
    expect(preview).toMatchObject({ segmentCount: 3, omittedSegmentCount: 1, truncated: true })
  })

  it('keeps later after fragments when only the before budget has run out', () => {
    const result = { ...node('', ''), meta: { diffs: [
      { path: 'src/a.ts', oldText: 'a'.repeat(12000), newText: null },
      { path: 'src/a.ts', oldText: 'hidden old', newText: 'visible later change' },
    ] } }
    const preview = readFileContentChange(deriveFileChangeAudit('child', [result])[0]!, [result])!
    expect(preview.after).toBe('visible later change')
    expect(preview.segments[1]).toEqual({ diffIndex: 1, before: '', after: 'visible later change', truncated: true })
    expect(preview).toMatchObject({ segmentCount: 2, omittedSegmentCount: 0, truncated: true })
  })

  it('bounds fragment metadata as well as text, with an explicit omitted count', () => {
    const result = { ...node('', ''), meta: { diffs: Array.from({ length: 205 }, () => ({ path: 'src/a.ts', oldText: null, newText: 'x' })) } }
    const preview = readFileContentChange(deriveFileChangeAudit('child', [result])[0]!, [result])!
    expect(preview.segments).toHaveLength(200)
    expect(preview).toMatchObject({ segmentCount: 205, omittedSegmentCount: 5, truncated: true })
    expect(preview.before.length).toBeLessThanOrEqual(12000)
    expect(preview.after.length).toBeLessThanOrEqual(12000)
  })

  it('skips unchanged, malformed and other-path hunks without mixing result events', () => {
    const record = deriveFileChangeAudit('child', [node('old', 'new')])[0]!
    const result = { ...node('', ''), meta: { diffs: [
      { path: 'elsewhere.ts', oldText: 'other', newText: 'other new' },
      { path: 'src/a.ts', oldText: 'same', newText: 'same' },
      { path: 'src/a.ts', oldText: 12, newText: 'bad' },
      { path: 'src/a.ts', oldText: 'kept', newText: 'changed' },
    ] } }
    const preview = readFileContentChange(record, [{ ...node('wrong', 'event'), seq: 4 }, result])!
    expect(preview.segments).toEqual([{ diffIndex: 3, before: 'kept', after: 'changed', truncated: false }])
    expect(preview.segmentCount).toBe(1)
    expect(readFileContentChange(record, [node(null, null)])).toBeUndefined()
  })

  it('does not mark exactly 12k of recorded text as truncated', () => {
    const result = node('a'.repeat(12000), 'b'.repeat(12000))
    expect(readFileContentChange(deriveFileChangeAudit('child', [result])[0]!, [result])?.truncated).toBe(false)
  })
})
