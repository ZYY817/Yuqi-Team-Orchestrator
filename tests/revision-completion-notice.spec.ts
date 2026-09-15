import { describe, expect, it, vi } from 'vitest'
import { hasNewRevisionCompletion } from '../src/host/harness/revision-completion-notice.ts'
import { completeTeamEvents, TASK_ID } from './fixtures.ts'

describe('revision completion notification cut', () => {
  const events = completeTeamEvents()
  const completedIndex = events.findIndex(event => event.type === 'yuqi/task-status-changed' && event.to === 'completed')
  // This seam deliberately tests the notification predicate, not domain creation.
  const read = () => ({ events, isCompletedRevision: (id: string) => id === TASK_ID })
  it('notifies only for a completion strictly beyond the acknowledged cut', async () => {
    expect(await hasNewRevisionCompletion({ sourceEventCount: completedIndex }, async () => {}, read)).toBe(true)
    expect(await hasNewRevisionCompletion({ sourceEventCount: completedIndex + 1 }, async () => {}, read)).toBe(false)
  })
  it('does not notify ordinary work or a revision no longer completed', async () => {
    expect(await hasNewRevisionCompletion(undefined, async () => {}, () => ({ events, isCompletedRevision: () => false }))).toBe(false)
  })
  it('does not trust a failed flush and retries without losing the new completion', async () => {
    const flush = vi.fn().mockRejectedValueOnce(new Error('Disk unavailable')).mockResolvedValue(undefined)
    const current = vi.fn(read)
    const checkpoint = { sourceEventCount: completedIndex }
    await expect(hasNewRevisionCompletion(checkpoint, flush, current)).rejects.toThrow('Disk unavailable')
    expect(current).not.toHaveBeenCalled()
    expect(await hasNewRevisionCompletion(checkpoint, flush, current)).toBe(true)
    expect(flush).toHaveBeenCalledTimes(2)
  })
  it('reflushes even an already-covered checkpoint, and reads current state afterward', async () => {
    const order: string[] = []
    expect(await hasNewRevisionCompletion({ sourceEventCount: events.length }, async () => { order.push('flush') }, () => {
      order.push('read'); return read()
    })).toBe(false)
    expect(order).toEqual(['flush', 'read'])
  })
})
