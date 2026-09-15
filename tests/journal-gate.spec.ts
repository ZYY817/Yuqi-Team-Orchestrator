import { describe, expect, it } from 'vitest'
import { JournalGate } from '../src/index.ts'

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

describe('JournalGate', () => {
  it('runs the same controller in FIFO order', async () => {
    const gate = new JournalGate()
    const firstRelease = deferred()
    const order: string[] = []
    const first = gate.run('controller', async () => {
      order.push('first:start')
      await firstRelease.promise
      order.push('first:end')
      return 1
    })
    const second = gate.run('controller', async () => {
      order.push('second')
      return 2
    })

    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    firstRelease.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('allows different controllers to progress independently', async () => {
    const gate = new JournalGate()
    const leftRelease = deferred()
    const order: string[] = []
    const left = gate.run('left', async () => {
      order.push('left:start')
      await leftRelease.promise
      order.push('left:end')
    })
    const right = gate.run('right', async () => { order.push('right') })

    await right
    expect(order).toEqual(['left:start', 'right'])
    leftRelease.resolve()
    await left
  })

  it('continues after a rejected operation and removes an idle queue', async () => {
    const gate = new JournalGate()
    await expect(gate.run('controller', async () => { throw new Error('commit failed') })).rejects.toThrow('commit failed')
    await expect(gate.run('controller', async () => 'recovered')).resolves.toBe('recovered')
  })

  it('disposes idempotently after draining accepted work and rejects new work', async () => {
    const gate = new JournalGate()
    const release = deferred()
    const accepted = gate.run('controller', async () => { await release.promise })
    const firstDisposal = gate.dispose()
    expect(gate.dispose()).toBe(firstDisposal)
    await expect(gate.run('controller', async () => undefined)).rejects.toMatchObject({
      code: 'SERVICE_DISPOSED',
    })
    release.resolve()
    await expect(Promise.all([accepted, firstDisposal])).resolves.toEqual([undefined, undefined])
  })
})
