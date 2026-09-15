// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { nativeToolObservations } from '../../src/client/NativeToolEvidence.tsx'
const node = { kind: 'tool-result', seq: 1, callId: 'call', isError: false, call: { name: 'web_fetch' },
  meta: { url: 'https://user:secret@example.com/api?token=secret#key', statusCode: 200, truncated: false } }
it('shows actual native HTTP metadata without credentials or query values', () => {
  const records = nativeToolObservations([node, node])
  expect(records).toHaveLength(1)
  expect(records[0]?.detail).toBe('https://example.com/api · HTTP 200')
  expect(JSON.stringify(records)).not.toContain('secret')
})
it('does not promote prose, errors, arbitrary tool metadata, invalid status or schemes', () => {
  expect(nativeToolObservations([{ ...node, isError: true }, { ...node, call: { name: 'shell' } },
    { ...node, meta: { ...node.meta, statusCode: 999 } }, { ...node, meta: { ...node.meta, url: 'javascript:alert(1)' } },
    { ...node, meta: undefined, content: [{ type: 'text', text: 'HTTP 200 and screenshot passed' }] }])).toEqual([])
})
it('records actual image blocks without exposing bytes or inventing screenshot acceptance', () => {
  const records = nativeToolObservations([{ ...node, call: { name: 'browser' }, meta: undefined,
    content: [{ type: 'image', attachment: { mediaType: 'image/png', bytes: 32 } }] }])
  expect(records[0]).toMatchObject({ kind: 'image', detail: '1', tool: 'browser', callId: 'call' })
  expect(records[0]).not.toHaveProperty('passed')
})
