import { describe, expect, it, vi } from 'vitest'
import type { TeamEvent } from '../src/domain/events.ts'
import { projectionHasReconciliationGap, replayTeamEvents } from '../src/domain/projection.ts'
import { ControlOperationId } from '../src/domain/ids.ts'
import type { TeamEventJournal } from '../src/application/ports.ts'
import { DurableJournalCoordinator } from '../src/application/durable-journal.ts'
import { StartFollowupTeamCoordinator, type StartFollowupTeamRequest, type FollowupTargetCandidate } from '../src/application/start-followup-team.ts'
import { completeTeamEvents, event, TEAM_ID, TASK_ID, ATTEMPT_ID, VERIFICATION_ID } from './fixtures.ts'

const request: StartFollowupTeamRequest = {
  teamId: TEAM_ID, operationId: 'followup-1', requestDigest: 'a'.repeat(64), parentSessionId: 'parent-1',
}
const target = { teamId: 'target-1', controllerSessionId: 'controller-2', extra: { retained: true } }
const reconcileRequest = { teamId: TEAM_ID, operationId: request.operationId, parentSessionId: request.parentSessionId, sourceControllerSessionId: 'source-controller' }
const candidate: FollowupTargetCandidate = { teamId: target.teamId, controllerSessionId: target.controllerSessionId,
  sourceTeamId: TEAM_ID, sourceControllerSessionId: 'source-controller', operationId: request.operationId,
  parentSessionId: request.parentSessionId, requestDigest: request.requestDigest }
function fixture() {
  const events: TeamEvent[] = [...completeTeamEvents()]
  let serial = 0
  const transactions = new DurableJournalCoordinator()
  const coordinator = (gate = transactions) => new StartFollowupTeamCoordinator(
    { nowIso: () => '2026-09-07T00:00:00.000Z' },
    { next: () => `followup-event-${++serial}` }, gate,
  )
  const commit = vi.fn(async (batch: readonly TeamEvent[]) => { events.push(...batch) })
  const journal: TeamEventJournal = { key: 'source-controller', read: () => [...events], commit }
  return { events, commit, journal, coordinator }
}

async function pendingFollowup() {
  const h = fixture()
  await expect(h.coordinator().start(request, h.journal, async () => { throw new Error('Unknown creation') }))
    .rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
  return h
}

describe('follow-up target reconciliation', () => {
  it('confirms one exact target, and subsequent reconciliation skips enumeration', async () => {
    const h = await pendingFollowup()
    const findTargets = vi.fn(async () => [candidate])
    expect(await h.coordinator().reconcile(reconcileRequest, h.journal, findTargets))
      .toEqual({ kind: 'reconciled', teamId: target.teamId, controllerSessionId: target.controllerSessionId })
    expect(h.events.at(-1)?.type).toBe('yuqi/team-followup-created')
    expect(await h.coordinator().reconcile(reconcileRequest, h.journal, findTargets))
      .toEqual({ kind: 'existing', teamId: target.teamId, controllerSessionId: target.controllerSessionId })
    expect(findTargets).toHaveBeenCalledOnce()
    expect(h.commit).toHaveBeenCalledTimes(2)
  })
  it('accepts verified older provenance with no digest', async () => {
    const h = await pendingFollowup()
    const { requestDigest: _digest, ...older } = candidate
    expect((await h.coordinator().reconcile(reconcileRequest, h.journal, async () => [older])).kind).toBe('reconciled')
  })
  it.each([
    { candidates: [] },
    { candidates: [candidate, candidate] },
    { candidates: [candidate, { ...candidate, teamId: 'other-target', controllerSessionId: 'other-controller' }] },
  ])(
    'keeps pending on zero or multiple candidates %j', async ({ candidates }) => {
      const h = await pendingFollowup()
      const before = [...h.events]
      await expect(h.coordinator().reconcile(reconcileRequest, h.journal, async () => candidates)).rejects.toMatchObject({
        code: candidates.length === 0 ? 'CONTROLLER_REQUIRES_RECONCILIATION' : 'CONTROL_OPERATION_CONFLICT',
      })
      expect(h.events).toEqual(before)
      expect(h.commit).toHaveBeenCalledOnce()
    },
  )
  it.each([
    { sourceTeamId: 'wrong' }, { sourceControllerSessionId: 'wrong' }, { operationId: 'wrong' },
    { parentSessionId: 'wrong' }, { requestDigest: 'b'.repeat(64) }, { teamId: TEAM_ID },
    { controllerSessionId: 'source-controller' }, { controllerSessionId: request.parentSessionId },
    { controllerSessionId: '' },
  ])('rejects mismatching or malformed provenance %j', async override => {
    const h = await pendingFollowup()
    const before = [...h.events]
    await expect(h.coordinator().reconcile(reconcileRequest, h.journal, async () => [{ ...candidate, ...override }]))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    expect(h.events).toEqual(before)
  })
  it('does not select a valid candidate out of a mixed untrusted result', async () => {
    const h = await pendingFollowup()
    await expect(h.coordinator().reconcile(reconcileRequest, h.journal, async () => [candidate, { ...candidate, sourceTeamId: 'wrong' }]))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    expect(h.commit).toHaveBeenCalledOnce()
  })
  it('does not enumerate without pending intent or with wrong source/parent identity', async () => {
    const h = fixture()
    const findTargets = vi.fn(async () => [candidate])
    await expect(h.coordinator().reconcile(reconcileRequest, h.journal, findTargets)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    const pending = await pendingFollowup()
    for (const override of [{ teamId: 'wrong' }, { sourceControllerSessionId: 'wrong' }, { parentSessionId: 'wrong' }]) {
      await expect(pending.coordinator().reconcile({ ...reconcileRequest, ...override }, pending.journal, findTargets)).rejects.toThrow()
    }
    expect(findTargets).not.toHaveBeenCalled()
  })
  it('preserves pending when enumeration fails', async () => {
    const h = await pendingFollowup()
    const before = [...h.events]
    await expect(h.coordinator().reconcile(reconcileRequest, h.journal, async () => { throw new Error('Partial enumeration') }))
      .rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(h.events).toEqual(before)
  })
  it('cannot bypass same-process journal poison, including after a reconciliation write failure', async () => {
    const h = await pendingFollowup()
    h.commit.mockRejectedValueOnce(new Error('Uncertain write'))
    const findTargets = vi.fn(async () => [candidate])
    await expect(h.coordinator().reconcile(reconcileRequest, h.journal, findTargets)).rejects.toMatchObject({ code: 'SETTLEMENT_PERSISTENCE_FAILED' })
    await expect(h.coordinator().reconcile(reconcileRequest, h.journal, findTargets)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(findTargets).toHaveBeenCalledOnce()
    // Simulated fresh-process replay only: the API never creates a replacement gate.
    expect((await h.coordinator(new DurableJournalCoordinator()).reconcile(reconcileRequest, h.journal, findTargets)).kind).toBe('reconciled')
  })
  it('refuses enumeration after an earlier start persistence failure poisons the shared journal', async () => {
    const h = fixture()
    h.commit.mockImplementationOnce(async batch => { h.events.push(...batch) }).mockRejectedValueOnce(new Error('No created acknowledgement'))
    await expect(h.coordinator().start(request, h.journal, async () => target)).rejects.toMatchObject({ code: 'SETTLEMENT_PERSISTENCE_FAILED' })
    const findTargets = vi.fn(async () => [candidate])
    await expect(h.coordinator().reconcile(reconcileRequest, h.journal, findTargets)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(findTargets).not.toHaveBeenCalled()
  })
  it('serializes concurrent reconciliation so only one enumeration and commit occurs', async () => {
    const h = await pendingFollowup()
    const findTargets = vi.fn(async () => [candidate])
    const results = await Promise.all([
      h.coordinator().reconcile(reconcileRequest, h.journal, findTargets),
      h.coordinator().reconcile(reconcileRequest, h.journal, findTargets),
    ])
    expect(results.map(result => result.kind)).toEqual(['reconciled', 'existing'])
    expect(findTargets).toHaveBeenCalledOnce()
    expect(h.commit).toHaveBeenCalledTimes(2)
  })
})

describe('source-journal follow-up Team saga', () => {
  it.each([
    ['failed', 'pending'], ['failed', 'running'],
    ['cancelled', 'pending'], ['cancelled', 'running'],
  ] as const)('rejects %s source with %s verification until verification closes', async (status, verificationStatus) => {
    const h = fixture()
    // Keep a real created/running verification, but settle its attempt so the
    // active-verification clause is the only remaining quiescence blocker.
    const prefix = completeTeamEvents().slice(0, verificationStatus === 'pending' ? 12 : 13)
    h.events.splice(0, h.events.length, ...prefix,
      event(20, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'settled', to: 'completed' }),
      ...(status === 'failed'
        ? [event(21, { type: 'yuqi/team-status-changed', from: 'running', to: 'failed' })]
        : [event(21, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
          event(22, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' })]),
    )
    const source = replayTeamEvents(h.events)
    expect(source.team.status).toBe(status)
    expect(source.verifications[VERIFICATION_ID]?.status).toBe(verificationStatus)
    expect(source.attempts[ATTEMPT_ID]?.status).toBe('completed')
    expect(projectionHasReconciliationGap(source)).toBe(false)
    const before = [...h.events]
    const start = vi.fn(async () => target)
    const validateStart = vi.fn(async () => {})
    await expect(h.coordinator().start(request, h.journal, start, validateStart))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
    expect(h.events).toEqual(before)
    expect(h.commit).not.toHaveBeenCalled()
    expect(validateStart).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    // Positive control: closing only verification makes the same source eligible.
    h.events.push(event(23, { type: 'yuqi/verification-status-changed', taskId: TASK_ID,
      attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID, from: verificationStatus, to: 'cancelled' }))
    expect((await h.coordinator().start(request, h.journal, start, validateStart)).kind).toBe('started')
    expect(start).toHaveBeenCalledOnce()
  })
  it('rejects a different operation while an earlier intent remains unresolved', async () => {
    const h = fixture()
    await expect(h.coordinator().start(request, h.journal, async () => { throw new Error('Uncertain target') }))
      .rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    const before = [...h.events]
    expect(replayTeamEvents(before).followupOperations?.[request.operationId]?.targetTeamId).toBeUndefined()
    const start = vi.fn(async () => target)
    const validateStart = vi.fn(async () => {})
    await expect(h.coordinator(new DurableJournalCoordinator()).start(
      { ...request, operationId: 'different-followup' }, h.journal, start, validateStart,
    )).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
    expect(h.events).toEqual(before)
    expect(h.commit).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
    expect(validateStart).not.toHaveBeenCalled()
  })
  it('rejects a follow-up operation identity already used by Team control', async () => {
    const h = fixture()
    // Record a valid control intent while the original fixture Team is running.
    h.events.splice(2, 0, event(20, { type: 'yuqi/team-control-requested',
      operationId: ControlOperationId(request.operationId), action: 'pause' }))
    expect(replayTeamEvents(h.events).controlOperations[request.operationId]?.action).toBe('pause')
    const before = [...h.events]
    const start = vi.fn(async () => target)
    await expect(h.coordinator().start(request, h.journal, start)).rejects.toMatchObject({ code: 'ENTITY_ALREADY_EXISTS' })
    expect(start).not.toHaveBeenCalled()
    expect(h.commit).not.toHaveBeenCalled()
    expect(h.events).toEqual(before)
  })
  it.each(['requested', 'created'] as const)('rejects Team control reuse of a %s follow-up identity', async phase => {
    const h = fixture()
    if (phase === 'created') await h.coordinator().start(request, h.journal, async () => target)
    else await expect(h.coordinator().start(request, h.journal, async () => { throw new Error('Uncertain target') }))
      .rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    const before = [...h.events]
    const control = (id: string) => event(24, { type: 'yuqi/team-control-requested', operationId: ControlOperationId(id), action: 'cancel' })
    // Prove rejection is the identity collision, not malformed control/event data.
    expect(replayTeamEvents([...before, control('unrelated-control')]).controlOperations['unrelated-control']?.action).toBe('cancel')
    expect(() => replayTeamEvents([...before, control(request.operationId)]))
      .toThrow(expect.objectContaining({ code: 'ENTITY_ALREADY_EXISTS' }))
    expect(h.events).toEqual(before)
  })
  it('awaits preflight before intent persistence or start', async () => {
    const h = fixture()
    let entered!: () => void
    let release!: () => void
    const checking = new Promise<void>(resolve => { entered = resolve })
    const pending = new Promise<void>(resolve => { release = resolve })
    const validateStart = vi.fn(async () => { entered(); await pending })
    const start = vi.fn(async () => target)
    const result = h.coordinator().start(request, h.journal, start, validateStart)
    await checking
    expect(h.commit).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    release()
    expect((await result).kind).toBe('started')
    expect(validateStart).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
    expect(h.commit).toHaveBeenCalledTimes(2)
  })
  it('preserves the preflight error without intent or poisoning, allowing a later retry', async () => {
    const h = fixture()
    const before = [...h.events]
    const error = new Error('Parent is occupied')
    const validateStart = vi.fn(async () => {}).mockRejectedValueOnce(error)
    const start = vi.fn(async () => target)
    const coordinator = h.coordinator()
    await expect(coordinator.start(request, h.journal, start, validateStart)).rejects.toBe(error)
    expect(h.events).toEqual(before)
    expect(h.commit).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect((await coordinator.start(request, h.journal, start, validateStart)).kind).toBe('started')
    expect(validateStart).toHaveBeenCalledTimes(2)
    expect(start).toHaveBeenCalledOnce()
  })
  it('skips preflight for an already-created idempotent request', async () => {
    const h = fixture()
    await h.coordinator().start(request, h.journal, async () => target)
    const validateStart = vi.fn(async () => { throw new Error('Must not recheck changed parent state') })
    const start = vi.fn(async () => target)
    expect(await h.coordinator().start(request, h.journal, start, validateStart))
      .toEqual({ kind: 'existing', teamId: target.teamId, controllerSessionId: target.controllerSessionId })
    expect(validateStart).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(h.commit).toHaveBeenCalledTimes(2)
  })
  it('skips preflight for an unresolved existing intent', async () => {
    const h = fixture()
    await expect(h.coordinator().start(request, h.journal, async () => { throw new Error('Uncertain start') })).rejects.toThrow()
    const validateStart = vi.fn(async () => {})
    const start = vi.fn(async () => target)
    await expect(h.coordinator().start(request, h.journal, start, validateStart))
      .rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(validateStart).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(h.commit).toHaveBeenCalledOnce()
  })
  it('commits intent before start and created before returning the full generic value', async () => {
    const h = fixture()
    const start = vi.fn(async () => {
      expect(h.commit).toHaveBeenCalledOnce()
      expect(replayTeamEvents(h.events).followupOperations?.[request.operationId]).toMatchObject({
        requestDigest: request.requestDigest, parentSessionId: request.parentSessionId,
      })
      expect(h.events.at(-1)?.type).toBe('yuqi/team-followup-requested')
      return target
    })
    const result = await h.coordinator().start(request, h.journal, start)
    expect(result).toEqual({ kind: 'started', value: target })
    if (result.kind === 'started') expect(result.value).toBe(target)
    expect(h.commit).toHaveBeenCalledTimes(2)
    expect(h.events.at(-1)).toMatchObject({ type: 'yuqi/team-followup-created', targetTeamId: target.teamId, targetControllerSessionId: target.controllerSessionId })
  })
  it('returns an existing target after replay without rerunning start or appending', async () => {
    const h = fixture()
    await h.coordinator().start(request, h.journal, async () => target)
    const start = vi.fn(async () => target)
    expect(await h.coordinator(new DurableJournalCoordinator()).start(request, h.journal, start))
      .toEqual({ kind: 'existing', teamId: target.teamId, controllerSessionId: target.controllerSessionId })
    expect(start).not.toHaveBeenCalled()
    expect(h.commit).toHaveBeenCalledTimes(2)
  })
  it.each(['requestDigest', 'parentSessionId'] as const)('rejects reused identity with changed %s', async field => {
    const h = fixture()
    await h.coordinator().start(request, h.journal, async () => target)
    const start = vi.fn(async () => target)
    await expect(h.coordinator().start({ ...request, [field]: field === 'requestDigest' ? 'b'.repeat(64) : 'other-parent' }, h.journal, start))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    expect(start).not.toHaveBeenCalled()
  })
  it('checks source Team identity even for an already-created operation', async () => {
    const h = fixture()
    await h.coordinator().start(request, h.journal, async () => target)
    const start = vi.fn(async () => target)
    await expect(h.coordinator().start({ ...request, teamId: 'wrong' }, h.journal, start)).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    expect(start).not.toHaveBeenCalled()
  })
  it('retains intent after callback failure and refuses a blind retry with a fresh gate', async () => {
    const h = fixture()
    const start = vi.fn(async () => { throw new Error('start may have created a controller') })
    await expect(h.coordinator().start(request, h.journal, start)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    const retry = vi.fn(async () => target)
    await expect(h.coordinator(new DurableJournalCoordinator()).start(request, h.journal, retry)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(retry).not.toHaveBeenCalled()
    expect(h.commit).toHaveBeenCalledOnce()
    expect(h.events.at(-1)?.type).toBe('yuqi/team-followup-requested')
  })
  it('never starts when intent persistence fails and keeps the gate poisoned', async () => {
    const h = fixture()
    h.commit.mockRejectedValueOnce(new Error('write uncertain'))
    const start = vi.fn(async () => target)
    await expect(h.coordinator().start(request, h.journal, start)).rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
    await expect(h.coordinator().start(request, h.journal, start)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(start).not.toHaveBeenCalled()
  })
  it('retains intent when publishing created fails and never reruns a successful start', async () => {
    const h = fixture()
    h.commit.mockImplementationOnce(async batch => { h.events.push(...batch) })
      .mockRejectedValueOnce(new Error('created write failed'))
    const start = vi.fn(async () => target)
    await expect(h.coordinator().start(request, h.journal, start)).rejects.toMatchObject({ code: 'SETTLEMENT_PERSISTENCE_FAILED' })
    await expect(h.coordinator(new DurableJournalCoordinator()).start(request, h.journal, start)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(start).toHaveBeenCalledOnce()
    expect(h.events.at(-1)?.type).toBe('yuqi/team-followup-requested')
  })
  it('recovers a created record persisted before an acknowledgement failure without starting again', async () => {
    const h = fixture()
    h.commit.mockImplementationOnce(async batch => { h.events.push(...batch) })
      .mockImplementationOnce(async batch => { h.events.push(...batch); throw new Error('ack lost') })
    const start = vi.fn(async () => target)
    await expect(h.coordinator().start(request, h.journal, start)).rejects.toMatchObject({ code: 'SETTLEMENT_PERSISTENCE_FAILED' })
    expect(await h.coordinator(new DurableJournalCoordinator()).start(request, h.journal, start))
      .toEqual({ kind: 'existing', teamId: target.teamId, controllerSessionId: target.controllerSessionId })
    expect(start).toHaveBeenCalledOnce()
  })
  it('serializes concurrent calls from separate coordinators sharing the gate', async () => {
    const h = fixture()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const pending = new Promise<void>(resolve => { release = resolve })
    const start = vi.fn(async () => { entered(); await pending; return target })
    const first = h.coordinator().start(request, h.journal, start)
    await started
    const second = h.coordinator().start(request, h.journal, start)
    release()
    expect((await first).kind).toBe('started')
    expect((await second).kind).toBe('existing')
    expect(start).toHaveBeenCalledOnce()
    expect(h.commit).toHaveBeenCalledTimes(2)
  })
  it('uses domain validation before starting an ineligible source', async () => {
    const h = fixture()
    h.events.pop() // All tasks complete, but source Team is still running.
    const start = vi.fn(async () => target)
    const validateStart = vi.fn(async () => {})
    await expect(h.coordinator().start(request, h.journal, start, validateStart)).rejects.toThrow()
    expect(validateStart).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(h.commit).not.toHaveBeenCalled()
  })
})
