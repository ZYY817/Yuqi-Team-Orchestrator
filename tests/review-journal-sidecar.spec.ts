import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { parseReviewerOutput } from '../src/application/reviewer.ts'
import { HarnessReviewJournal, REVIEW_SESSION_EVENT } from '../src/host/harness/review-journal.ts'
import * as journalModule from '../src/host/harness/session-journal.ts'
import * as sidecar from '../src/host/storage/session-sidecar.ts'
import type { OwnedEventRecord, OwnedEventTable } from '../src/host/storage/owned-event-store.ts'

afterEach(() => { vi.restoreAllMocks() })

const result = parseReviewerOutput('{"decision":"pass","findings":[],"unverified":[]}',
  { reviewId: 'sidecar-review', trigger: 'user-request' }, 'reviewer-child')

it('commits and rereads through a real repository binding while leaving native history untouched', async () => {
  const records = new Map<string, OwnedEventRecord>()
  const table: OwnedEventTable = {
    get: key => records.get(key),
    entries: () => records.entries(),
    put: async (key, value) => { records.set(key, value) },
    update: async (key, transform) => {
      const updated = transform(records.get(key)!)
      records.set(key, updated)
      return updated
    },
  }
  const repository = new sidecar.SidecarRepository(table)
  const session = Session.create(SessionId('real-review-sidecar'))
  repository.bind(session)
  const nativeAppend = vi.spyOn(session, 'append').mockImplementation(() => { throw new Error('Host append forbidden') })
  const flush = vi.fn(async () => true)
  const journal = new HarnessReviewJournal(session, { flush })
  try {
    await journal.commit(result)
    expect(journal.read()).toEqual([result])
    expect(sidecar.readSidecarEvents(session)).toEqual([
      expect.objectContaining({ type: REVIEW_SESSION_EVENT, data: { result }, ignorable: true }),
    ])
    const restored = Session.create(session.id)
    repository.bind(restored)
    expect(new HarnessReviewJournal(restored, { flush }).read()).toEqual([result])
    expect(session.events).toEqual([])
    expect(nativeAppend).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  } finally {
    repository.dispose()
  }
})

it('prefers sidecar review history, including an empty history, and falls back only when unbound', () => {
  const session = Session.create(SessionId('review-sidecar-read'))
  session.append(REVIEW_SESSION_EVENT, { result })
  const journal = new HarnessReviewJournal(session, { flush: async () => true })
  const read = vi.spyOn(sidecar, 'readSidecarEvents').mockReturnValue([])
  expect(journal.read()).toEqual([])
  const sidecarResult = { ...result, reviewId: 'sidecar-only' }
  read.mockReturnValue([
    { type: 'turn/start', data: { turn: 1 } } as SessionEvent,
    { type: REVIEW_SESSION_EVENT, data: { result: sidecarResult } } as SessionEvent,
  ])
  expect(journal.read()).toEqual([sidecarResult])
  read.mockReturnValue(undefined)
  expect(journal.read()).toEqual([result])
})

it('awaits sidecar durability before projection without appending or flushing the Host Session', async () => {
  const session = Session.create(SessionId('review-sidecar-commit'))
  const nativeAppend = vi.spyOn(session, 'append').mockImplementation(() => { throw new Error('Host append forbidden') })
  const flush = vi.fn(async () => true)
  const sync = vi.spyOn(journalModule, 'syncTeamProjectionToParent').mockResolvedValue(true)
  vi.spyOn(sidecar, 'hasSidecarSession').mockReturnValue(true)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const append = vi.spyOn(sidecar, 'appendSidecarEvent').mockImplementation(async () => {
    await gate
    return { type: REVIEW_SESSION_EVENT, data: { result } } as SessionEvent
  })
  const journal = new HarnessReviewJournal(session, { flush })
  let completed = false
  const pending = journal.commit(result).then(() => { completed = true })
  try {
    await Promise.resolve()
    expect(append).toHaveBeenCalledWith(session, REVIEW_SESSION_EVENT, { result })
    expect(completed).toBe(false)
    expect(sync).not.toHaveBeenCalled()
  } finally {
    release()
    await pending
  }
  expect(sync).toHaveBeenCalledOnce()
  expect(nativeAppend).not.toHaveBeenCalled()
  expect(flush).not.toHaveBeenCalled()
})

it('propagates sidecar append failure without native fallback or projection confirmation', async () => {
  const session = Session.create(SessionId('review-sidecar-failure'))
  const nativeAppend = vi.spyOn(session, 'append')
  const flush = vi.fn(async () => true)
  const sync = vi.spyOn(journalModule, 'syncTeamProjectionToParent').mockResolvedValue(true)
  vi.spyOn(sidecar, 'hasSidecarSession').mockReturnValue(true)
  vi.spyOn(sidecar, 'appendSidecarEvent').mockRejectedValue(new Error('sidecar failed'))
  await expect(new HarnessReviewJournal(session, { flush }).commit(result)).rejects.toThrow('sidecar failed')
  expect(nativeAppend).not.toHaveBeenCalled()
  expect(flush).not.toHaveBeenCalled()
  expect(sync).not.toHaveBeenCalled()
})
