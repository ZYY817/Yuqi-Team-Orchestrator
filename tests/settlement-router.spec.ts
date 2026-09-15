import { describe, expect, it, vi } from 'vitest'
import { SettlementRouter } from '../src/index.ts'
import type { ChildEnd, ChildEndSource } from '../src/index.ts'

class EndSource implements ChildEndSource {
  listener: ((end: ChildEnd) => void) | undefined
  readonly dispose = vi.fn()

  onEnd(listener: (end: ChildEnd) => void): () => void {
    this.listener = listener
    return this.dispose
  }

  emit(childSessionId: string, runId = `run-${childSessionId}`): void {
    this.listener?.({ childSessionId, runId, provider: 'p', stopReason: 'completed', hasAssistantOutput: true })
  }
}

describe('SettlementRouter', () => {
  it('routes admitted children once and ignores duplicate or unrelated ends', () => {
    const source = new EndSource()
    const router = new SettlementRouter(source)
    const left = vi.fn()
    const right = vi.fn()
    router.openAdmission().admit('left', left)
    router.openAdmission().admit('right', right)
    source.emit('unrelated')
    source.emit('right')
    source.emit('left')
    source.emit('left', 'duplicate')
    expect(left).toHaveBeenCalledTimes(1)
    expect(right).toHaveBeenCalledTimes(1)
    expect(right.mock.calls[0]?.[0]).toMatchObject({ childSessionId: 'right' })
  })

  it('delivers an early end immediately after admission and deduplicates its buffer', () => {
    const source = new EndSource()
    const router = new SettlementRouter(source)
    const claim = router.openAdmission()
    source.emit('early', 'first')
    source.emit('early', 'duplicate')
    const listener = vi.fn()
    claim.admit('early', listener)
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ runId: 'first' })
  })

  it('fails closed after bounded early-end overflow', () => {
    const source = new EndSource()
    const router = new SettlementRouter(source, 1)
    const claim = router.openAdmission()
    source.emit('first')
    source.emit('second')
    expect(() => claim.admit('first', vi.fn())).toThrow(expect.objectContaining({ code: 'EARLY_END_OVERFLOW' }))
  })

  it('rejects invalid capacity, duplicate child ids, and reused claims', () => {
    const source = new EndSource()
    expect(() => new SettlementRouter(source, 0)).toThrow(RangeError)
    expect(() => new SettlementRouter(source, 1.5)).toThrow(RangeError)
    const router = new SettlementRouter(source)
    router.openAdmission().admit('same', vi.fn())
    expect(() => router.openAdmission().admit('same', vi.fn())).toThrow(expect.objectContaining({ code: 'CHILD_ID_COLLISION' }))
    const claim = router.openAdmission()
    claim.cancel()
    expect(() => claim.cancel()).toThrow(expect.objectContaining({ code: 'INVALID_BATCH' }))
  })

  it('clears unclaimed early ends after cancellation and disposes idempotently', () => {
    const source = new EndSource()
    const router = new SettlementRouter(source)
    const claim = router.openAdmission()
    source.emit('old')
    claim.cancel()
    const fresh = router.openAdmission()
    const listener = vi.fn()
    fresh.admit('old', listener)
    expect(listener).not.toHaveBeenCalled()
    router.dispose()
    router.dispose()
    expect(source.dispose).toHaveBeenCalledOnce()
    source.emit('old')
    expect(listener).not.toHaveBeenCalled()
    expect(() => router.openAdmission()).toThrow(expect.objectContaining({ code: 'SERVICE_DISPOSED' }))
  })

  it('rejects admission when disposal races after opening a claim', () => {
    const source = new EndSource()
    const router = new SettlementRouter(source)
    const claim = router.openAdmission()
    router.dispose()
    expect(() => claim.admit('late', vi.fn())).toThrow(expect.objectContaining({ code: 'SERVICE_DISPOSED' }))
  })
})
