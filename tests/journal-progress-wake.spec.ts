import { describe, expect, it, vi } from 'vitest'
import { JournalProgressWake } from '../src/host/harness/journal-progress-wake.ts'

describe('journal observation wake', () => {
  it('rechecks after subscribing and skips an obsolete observation', async () => {
    const wake = new JournalProgressWake()
    wake.committed('controller')
    const observe = vi.fn(async () => {})
    await wake.wait('controller', new AbortController().signal, () => true, observe)
    expect(observe).not.toHaveBeenCalled()
  })

  it('interrupts only observation, not its runner signal', async () => {
    const wake = new JournalProgressWake()
    const runner = new AbortController()
    let dispatchable = false
    let observedSignal: AbortSignal | undefined
    const waiting = wake.wait('controller', runner.signal, () => dispatchable, signal => {
      observedSignal = signal
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    dispatchable = true
    wake.committed('other-controller')
    expect(observedSignal?.aborted).toBe(false)
    wake.committed('controller')
    await waiting
    expect(observedSignal?.aborted).toBe(true)
    expect(runner.signal.aborted).toBe(false)
  })

  it('treats a typed child-list cancellation as the expected internal wake edge', async () => {
    const wake = new JournalProgressWake()
    const runner = new AbortController()
    let dispatchable = false
    const waiting = wake.wait('controller', runner.signal, () => dispatchable, signal =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        const error = new Error('subagent listing was cancelled')
        Object.assign(error, { code: 'CANCELLED' })
        reject(error)
      }, { once: true })))
    dispatchable = true
    wake.committed('controller')
    await waiting
    expect(runner.signal.aborted).toBe(false)
  })

  it('does not interrupt for ready but non-dispatchable work', async () => {
    const wake = new JournalProgressWake()
    let finish!: () => void
    let observedSignal: AbortSignal | undefined
    const waiting = wake.wait('controller', new AbortController().signal, () => false, signal => {
      observedSignal = signal
      return new Promise(resolve => { finish = resolve })
    })
    wake.committed('controller')
    wake.committed('controller')
    expect(observedSignal?.aborted).toBe(false)
    finish()
    await waiting
  })

  it('does not swallow a real observation error racing a wake', async () => {
    const wake = new JournalProgressWake()
    const failure = new Error('Native ownership unknown')
    let dispatchable = false
    let fail!: (cause: Error) => void
    const waiting = wake.wait('controller', new AbortController().signal, () => dispatchable,
      () => new Promise((_resolve, reject) => { fail = reject }))
    dispatchable = true
    wake.committed('controller')
    fail(failure)
    await expect(waiting).rejects.toBe(failure)
  })

  it('propagates runner cancellation and removes its subscription', async () => {
    const wake = new JournalProgressWake()
    const runner = new AbortController()
    const check = vi.fn(() => false)
    const failure = new Error('Runner cancelled')
    const waiting = wake.wait('controller', runner.signal, check,
      signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    runner.abort(failure)
    await expect(waiting).rejects.toBe(failure)
    const count = check.mock.calls.length
    wake.committed('controller')
    expect(check).toHaveBeenCalledTimes(count)
  })
})
