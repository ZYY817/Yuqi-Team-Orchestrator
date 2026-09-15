import { describe, expect, it } from 'vitest'
import { inspectModelCallFailure } from '../src/host/harness/model-call-failure.ts'

const model = { modelProvider: 'p', modelId: 'a' }
const failure = { code: 'RATE_LIMIT', status: 429, message: 'provider rejected request' }
function native(extra: { type: string; data: unknown }[] = []) {
  return { meta: { id: 'child', parentSession: 'parent', seedLength: 0 }, events: [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'request/context', data: { provider: 'p', model: 'a' } },
    ...extra,
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'error', failure } } } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: failure } } },
  ].map((event, seq) => ({ ...event, seq })) }
}
const inspect = (source: ReturnType<typeof native>) => inspectModelCallFailure(source, 'child', 'parent', model)
describe('native zero-output model failure proof', () => {
  it('requires matching structured finish and terminal failure', () => {
    expect(inspect(native())).toEqual({ code: 'RATE_LIMIT', status: 429 })
    const missing = native(); missing.events.splice(3, 1)
    expect(inspect(missing)).toBeUndefined()
  })
  it('allows exhausted Host same-model retries only while every call remains output-free', () => {
    expect(inspect(native([{ type: 'assistant/chunk', data: { turn: 1, step: 1,
      chunk: { type: 'finish', reason: { kind: 'error', failure } } } }]))).toEqual({ code: 'RATE_LIMIT', status: 429 })
  })
  it.each(['text-delta', 'reasoning-delta', 'tool-call-delta', 'block-start', 'block-end'])('refuses any %s output', type => {
    expect(inspect(native([{ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type, text: 'partial' } } }]))).toBeUndefined()
  })
  it.each(['tool/call', 'tool/result', 'assistant/message'])('refuses %s even if final output is absent', type => {
    expect(inspect(native([{ type, data: {} }]))).toBeUndefined()
  })
  it('rejects wrong ownership, route, missing end, generic errors, queued follow-ups and aborts', () => {
    const source = native()
    expect(inspectModelCallFailure(source, 'child', 'other-parent', model)).toBeUndefined()
    expect(inspectModelCallFailure(source, 'child', 'parent', { ...model, modelId: 'b' })).toBeUndefined()
    const noEnd = native(); noEnd.events.pop(); expect(inspect(noEnd)).toBeUndefined()
    const generic = native(); generic.events[3]!.data = { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', status: 429 } } } }
    expect(inspect(generic)).toBeUndefined()
    const abort = native(); abort.events.at(-1)!.data = { turn: 1, reason: { kind: 'aborted' } }
    expect(inspect(abort)).toBeUndefined()
    expect(inspect(native([{ type: 'agent/inbox/spliced', data: { inserted: [{}, {}] } }]))).toBeUndefined()
  })
})
