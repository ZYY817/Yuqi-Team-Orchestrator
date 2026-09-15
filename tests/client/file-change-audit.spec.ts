import { describe, expect, it } from 'vitest'
import { deriveFileChangeAudit } from '../../src/client/file-change-audit.ts'

const result = (overrides: Record<string, unknown> = {}) => ({
  kind: 'tool-result', seq: 12, callId: 'call-a', isError: false,
  call: { name: 'edit', argsRaw: JSON.stringify({ file_path: '../shared/a.ts' }) },
  meta: { diffs: [{ path: '../shared/a.ts', oldText: 'before', newText: 'after' }] },
  ...overrides,
})

describe('file evidence provenance', () => {
  it('keeps tool and self-reported evidence separate, preserves out-of-scope paths and trace identity', () => {
    expect(deriveFileChangeAudit('child-a', [result()], ['../shared/a.ts'])).toEqual([
      { source: 'tool-result-diff', path: '../shared/a.ts', sessionId: 'child-a', callId: 'call-a', eventSeq: 12, tool: 'edit' },
      { source: 'agent-report', path: '../shared/a.ts' },
    ])
  })
  it.each([
    result({ isError: true }), result({ error: { code: 'failed' } }), result({ call: null }),
    result({ call: { name: 'bash', argsRaw: '{"file_path":"../shared/a.ts"}' } }),
    result({ call: { name: 'read', argsRaw: '{"file_path":"../shared/a.ts"}' } }),
    result({ call: { name: 'write', argsRaw: '{bad json' } }), result({ seq: -1 }),
    { kind: 'assistant', content: 'wrote ../shared/a.ts' },
  ])('does not promote failures, missing pairs, shell, reads or prose to confirmed changes: %j', node => {
    expect(deriveFileChangeAudit('child-a', [node])).toEqual([])
  })
  it.each([undefined, { diffs: [] }, { diffs: [{ path: '../shared/a.ts', oldText: 'same', newText: 'same' }] },
    { diffs: [{ path: 'different.ts', oldText: 'before', newText: 'after' }] }, { diffs: [{ path: '../shared/a.ts' }] },
  ])('keeps successful write calls without trustworthy content differences unconfirmed: %j', meta => {
    const record = deriveFileChangeAudit('child-a', [result({ meta })])[0]
    expect(record?.source).toBe('successful-write-call')
    expect(record?.path).toBe('../shared/a.ts')
  })
  it('ignores call-time previews and model-written result prose', () => {
    const records = deriveFileChangeAudit('child-a', [result({ meta: undefined,
      callView: { diffs: [{ path: 'claimed.ts', oldText: '', newText: 'new' }] },
      content: [{ type: 'text', text: 'Created claimed.ts' }],
    })])
    expect(records.map(record => record.source)).toEqual(['successful-write-call'])
  })
  it('deduplicates replayed records without merging different event identities and omits content bodies', () => {
    const records = deriveFileChangeAudit('child-a', [result(), result(), result({ seq: 13 })])
    expect(records).toHaveLength(2)
    expect(JSON.stringify(records)).not.toContain('before')
    expect(JSON.stringify(records)).not.toContain('after')
  })
  it('does not invent session attribution when the child is unavailable', () => {
    expect(deriveFileChangeAudit(undefined, [result()], ['reported.ts'])).toEqual([{ source: 'agent-report', path: 'reported.ts' }])
  })
})
