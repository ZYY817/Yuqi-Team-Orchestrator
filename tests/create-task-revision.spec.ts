import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createTeamSessionProjection } from '../src/host/harness/team-projection.ts'
import { TaskRevisionCoordinator } from '../src/application/create-task-revision.ts'
import { DurableJournalCoordinator } from '../src/application/durable-journal.ts'
import type { TeamEventJournal } from '../src/application/ports.ts'
import type { TeamEvent } from '../src/domain/events.ts'
import { replayTeamEvents } from '../src/domain/projection.ts'
import { planTeamSchedule } from '../src/application/schedule-team.ts'
import { ControlOperationId, FileLeaseId, TaskId, TeamEventId } from '../src/domain/ids.ts'
import { taskRevisionAdmissionIssue, taskRevisionBatchIssue, taskRevisionDependenciesIssue,
  taskRevisionIssue, type TaskRevalidation } from '../src/domain/task-revision.ts'
import { completeTeamEvents, contract, event, TASK_ID, TEAM_ID } from './fixtures.ts'

const request = { teamId: TEAM_ID, sourceTaskId: TASK_ID, operationId: 'revision-1', goal: 'Improve the text', acceptanceCriteria: ['Revised text is present'] }
function setup(events: readonly TeamEvent[] = completeTeamEvents().slice(0, -1)) {
  const stored = [...events]
  const commits: (readonly TeamEvent[])[] = []
  let sequence = 40
  const journal: TeamEventJournal = {
    key: 'revision-controller', read: () => stored,
    commit: async additions => { commits.push(additions); stored.push(...additions) },
  }
  const coordinator = new TaskRevisionCoordinator(
    { nowIso: () => '2026-09-07T00:00:00Z' }, { next: () => `revision-event-${++sequence}` }, new DurableJournalCoordinator(),
  )
  return { stored, journal, coordinator, commits }
}

describe('source-linked user revisions', () => {
  it('preserves original evidence and schedules a new task with no attempts', async () => {
    const s = setup()
    const original = replayTeamEvents(s.stored)
    const next = await s.coordinator.create(request, s.journal)
    const id = next.taskIds.at(-1)!
    expect(next.tasks[TASK_ID]).toEqual(original.tasks[TASK_ID])
    expect(next.attempts).toEqual(original.attempts)
    expect(next.tasks[id]?.attemptIds).toEqual([])
    expect(next.tasks[id]?.contract.userRevision?.sourceAttemptId).toBe('attempt-1')
    expect(planTeamSchedule(next, { maxConcurrency: 2 }).dispatchTaskIds).toEqual([id])
  })
  it('coalesces concurrent duplicate requests and rejects different requirements', async () => {
    const s = setup()
    await Promise.all([s.coordinator.create(request, s.journal), s.coordinator.create(request, s.journal)])
    expect(replayTeamEvents(s.stored).taskIds).toHaveLength(2)
    const count = s.stored.length
    await expect(s.coordinator.create({ ...request, goal: 'Different request' }, s.journal)).rejects.toThrow('different requirements')
    expect(s.stored).toHaveLength(count)
    const reloaded = setup(s.stored)
    await reloaded.coordinator.create(request, reloaded.journal)
    expect(reloaded.stored).toHaveLength(count)
  })
  it('does not revive a completed Team', async () => {
    const s = setup(completeTeamEvents())
    await expect(s.coordinator.create(request, s.journal)).rejects.toThrow()
    expect(s.stored).toHaveLength(17)
  })
  it('keeps source provenance immutable through later configuration revisions', async () => {
    const s = setup()
    const next = await s.coordinator.create(request, s.journal)
    const created = next.tasks[next.taskIds.at(-1)!]!.contract
    const { userRevision: _origin, ...rest } = created
    expect(() => replayTeamEvents([...s.stored, event(20, {
      type: 'yuqi/task-revised', contract: { ...rest, revision: 2, kind: 'work' },
    })])).toThrow('immutable')
  })
  it('reserves the revision identity against later control commands', async () => {
    const s = setup()
    await s.coordinator.create(request, s.journal)
    expect(() => replayTeamEvents([...s.stored, event(20, {
      type: 'yuqi/team-control-requested', operationId: ControlOperationId(request.operationId), action: 'pause',
    })])).toThrow('belongs to a user revision')
  })
  it('does not let later configuration edits erase the source dependency', async () => {
    const s = setup()
    const next = await s.coordinator.create(request, s.journal)
    const created = next.tasks[next.taskIds.at(-1)!]!.contract
    expect(() => replayTeamEvents([...s.stored, event(20, {
      type: 'yuqi/task-revised', contract: { ...created, revision: 2, dependencies: [] },
    })])).toThrow('retain its source dependency')
  })
  it('uses immutable request facts for idempotency after later task edits', async () => {
    const s = setup()
    const next = await s.coordinator.create(request, s.journal)
    const created = next.tasks[next.taskIds.at(-1)!]!.contract
    s.stored.push(event(20, {
      type: 'yuqi/task-revised', contract: { ...created, revision: 2, goal: 'Refined goal' },
    }))
    const count = s.stored.length
    const replay = await s.coordinator.create(request, s.journal)
    expect(s.stored).toHaveLength(count)
    expect(replay.tasks[created.taskId]?.contract.goal).toBe('Refined goal')
  })
  it('rejects a source already consumed by another task', async () => {
    const s = setup([...completeTeamEvents().slice(0, -1), event(18, {
      type: 'yuqi/task-created', contract: contract(TaskId('consumer'), 1, [TASK_ID]),
    })])
    await expect(s.coordinator.create(request, s.journal)).rejects.toThrow('downstream')
    expect(s.stored).toHaveLength(17)
  })
  it('rejects an operation identity used by Team control', async () => {
    const s = setup([...completeTeamEvents().slice(0, -1), event(18, {
      type: 'yuqi/team-control-requested', operationId: ControlOperationId('revision-1'), action: 'pause',
    })])
    await expect(s.coordinator.create(request, s.journal)).rejects.toThrow('already used')
  })
  it('keeps paused Teams paused with the revision queued', async () => {
    const s = setup([...completeTeamEvents().slice(0, -1),
      event(18, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(19, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
    ])
    const next = await s.coordinator.create(request, s.journal)
    expect(next.team.status).toBe('paused')
    expect(planTeamSchedule(next, { maxConcurrency: 2 }).dispatchTaskIds).toEqual([])
  })
  it('poisons uncertain persistence instead of blindly creating another revision', async () => {
    const s = setup()
    const broken = { ...s.journal, commit: async () => { throw new Error('disk unavailable') } }
    await expect(s.coordinator.create(request, broken)).rejects.toThrow('durably persist')
    await expect(s.coordinator.create(request, broken)).rejects.toThrow('uncertain')
  })
})

/** Replay-realistic completed DAG: independent attempts/evidence for each task. */
function completedGraph(nodes: readonly { id: string; dependencies: string[] }[]): TeamEvent[] {
  const events: TeamEvent[] = [...completeTeamEvents().slice(0, 2)]
  for (const node of nodes) {
    for (const original of completeTeamEvents().slice(2, -1)) {
      const copy = JSON.parse(JSON.stringify(original)
        .replaceAll('"task-1"', JSON.stringify(node.id))
        .replaceAll('"attempt-1"', JSON.stringify(`attempt-${node.id}`))
        .replaceAll('"session-worker-1"', JSON.stringify(`session-${node.id}`))
        .replaceAll('"verification-1"', JSON.stringify(`verification-${node.id}`))
        .replaceAll('"fixture-verdict-passed"', JSON.stringify(`verdict-${node.id}`))) as TeamEvent
      const next = { ...copy, eventId: TeamEventId(`graph-event-${events.length}`) }
      events.push(next.type === 'yuqi/task-created'
        ? { ...next, contract: { ...next.contract, goal: `Deliver ${node.id}`,
          dependencies: node.dependencies.map(TaskId) } } : next)
    }
  }
  return events
}
const chain = [{ id: 'root', dependencies: [] }, { id: 'child', dependencies: ['root'] },
  { id: 'grandchild', dependencies: ['child'] }]
const cascadeRequest = { ...request, sourceTaskId: 'root', includeDependents: true }

function newTasks(projection: ReturnType<typeof replayTeamEvents>) {
  return projection.taskIds.map(id => projection.tasks[id]!)
    .filter(task => task.contract.userRevision?.operationId === request.operationId)
}

describe('explicit downstream revalidation', () => {
  it('creates the entire chain in one commit without changing any old task or attempt', async () => {
    const s = setup(completedGraph(chain))
    const before = replayTeamEvents(s.stored)
    const after = await s.coordinator.create(cascadeRequest, s.journal)
    const tasks = newTasks(after)
    expect(s.commits).toHaveLength(1)
    expect(s.commits[0]).toHaveLength(3)
    expect(tasks.map(task => task.contract.userRevision?.sourceTaskId)).toEqual(['root', 'child', 'grandchild'])
    for (const id of before.taskIds) expect(after.tasks[id]).toEqual(before.tasks[id])
    expect(after.attempts).toEqual(before.attempts)
    expect(tasks.every(task => task.status === 'pending' && task.attemptIds.length === 0)).toBe(true)
    expect(tasks[0]!.contract.dependencies).toEqual(['root'])
    expect(tasks[1]!.contract.dependencies).toEqual(['child', tasks[0]!.contract.taskId])
    expect(tasks[2]!.contract.dependencies).toEqual(['grandchild', tasks[1]!.contract.taskId])
    expect(planTeamSchedule(after, { maxConcurrency: 10 }).dispatchTaskIds).toEqual([tasks[0]!.contract.taskId])
    for (const task of tasks.slice(1)) {
      const old = before.tasks[task.contract.userRevision!.sourceTaskId]!.contract
      expect(task.contract).toMatchObject({ goal: old.goal, acceptanceCriteria: old.acceptanceCriteria,
        scope: old.scope, fileScope: old.fileScope, authorityMode: old.authorityMode, modelId: old.modelId })
    }
  })
  it('maps branching/diamond dependencies once and retains completed external inputs', async () => {
    const nodes = [{ id: 'outside', dependencies: [] }, { id: 'root', dependencies: [] },
      { id: 'left', dependencies: ['root'] }, { id: 'right', dependencies: ['root'] },
      { id: 'join', dependencies: ['left', 'right', 'outside'] }]
    const s = setup(completedGraph(nodes))
    const after = await s.coordinator.create(cascadeRequest, s.journal)
    const tasks = newTasks(after)
    expect(tasks).toHaveLength(4)
    expect(tasks[3]!.contract.dependencies).toEqual(['join', tasks[1]!.contract.taskId, tasks[2]!.contract.taskId, 'outside'])
    expect(tasks.some(task => task.contract.userRevision?.sourceTaskId === 'outside')).toBe(false)
  })
  it.each([undefined, false])('rejects completed downstream without explicit consent (%s)', async includeDependents => {
    const s = setup(completedGraph(chain))
    const { includeDependents: _include, ...base } = cascadeRequest
    await expect(s.coordinator.create({ ...base, ...(includeDependents === undefined ? {} : { includeDependents }) }, s.journal))
      .rejects.toThrow('downstream')
    expect(s.commits).toHaveLength(0)
  })
  it('rejects noncompleted downstream even with consent, without partial publication', async () => {
    const s = setup([...completedGraph(chain.slice(0, 1)), event(18, {
      type: 'yuqi/task-created', contract: contract(TaskId('child'), 1, [TaskId('root')]),
    })])
    const count = s.stored.length
    await expect(s.coordinator.create(cascadeRequest, s.journal)).rejects.toThrow('completed')
    expect(s.stored).toHaveLength(count)
    expect(s.commits).toHaveLength(0)
  })
  it('coalesces the entire concurrent group and cold retries; changed consent conflicts', async () => {
    const s = setup(completedGraph(chain))
    await Promise.all([s.coordinator.create(cascadeRequest, s.journal), s.coordinator.create(cascadeRequest, s.journal)])
    expect(s.commits).toHaveLength(1)
    const cold = setup(s.stored)
    await cold.coordinator.create(cascadeRequest, cold.journal)
    expect(cold.commits).toHaveLength(0)
    await expect(cold.coordinator.create({ ...cascadeRequest, includeDependents: false }, cold.journal)).rejects.toThrow('different requirements')
  })
  it('normalizes explicit false to the old omitted-field request hash', async () => {
    const s = setup()
    await s.coordinator.create(request, s.journal)
    await s.coordinator.create({ ...request, includeDependents: false }, s.journal)
    expect(s.commits).toHaveLength(1)
  })
  it('checks total group size before allocating/committing at the 100 task cap', async () => {
    const nodes = Array.from({ length: 51 }, (_, i) => ({ id: i === 0 ? 'root' : `node-${i}`,
      dependencies: i === 0 ? [] : [i === 1 ? 'root' : `node-${i - 1}`] }))
    const s = setup(completedGraph(nodes))
    await expect(s.coordinator.create(cascadeRequest, s.journal)).rejects.toThrow('100')
    expect(s.commits).toHaveLength(0)
  })
  it('allows exactly 100 tasks and keeps a paused Team paused', async () => {
    const nodes = Array.from({ length: 50 }, (_, i) => ({ id: i === 0 ? 'root' : `node-${i}`,
      dependencies: i === 0 ? [] : [i === 1 ? 'root' : `node-${i - 1}`] }))
    const s = setup([...completedGraph(nodes),
      event(18, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(19, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' })])
    const after = await s.coordinator.create(cascadeRequest, s.journal)
    expect(after.taskIds).toHaveLength(100)
    expect(after.team.status).toBe('paused')
    expect(planTeamSchedule(after, { maxConcurrency: 100 }).dispatchTaskIds).toEqual([])
  })
  it('detects a truncated group and prevents later dependency edits', async () => {
    const s = setup(completedGraph(chain))
    const after = await s.coordinator.create(cascadeRequest, s.journal)
    const tasks = newTasks(after)
    const last = tasks.at(-1)!.contract.taskId
    const { [last]: _removed, ...remaining } = after.tasks
    expect(taskRevisionBatchIssue({ ...after, tasks: remaining, taskIds: after.taskIds.filter(id => id !== last) })).toContain('Incomplete')
    expect(() => replayTeamEvents(s.stored.slice(0, -1))).toThrow('Incomplete')
    const original = tasks[1]!.contract
    expect(taskRevisionDependenciesIssue(original, { ...original, revision: 2, dependencies: [original.userRevision!.sourceTaskId] }))
      .toContain('retain its source dependency')
    expect(() => replayTeamEvents([...s.stored, event(20, { type: 'yuqi/task-revised',
      contract: { ...original, revision: 2, dependencies: [original.userRevision!.sourceTaskId] } })])).toThrow('retain its source dependency')
  })
  it('rejects tampered mappings and inherited scope at the shared validator', async () => {
    const s = setup(completedGraph(chain))
    const before = replayTeamEvents(s.stored)
    const after = await s.coordinator.create(cascadeRequest, s.journal)
    const root = newTasks(after)[0]!.contract
    const origin = root.userRevision as NonNullable<typeof root.userRevision> & { revalidation: TaskRevalidation }
    const changed = { ...root, userRevision: { ...origin,
      revalidation: { ...origin.revalidation, taskMapping: origin.revalidation.taskMapping.slice(0, -1) } } }
    expect(taskRevisionIssue(before, changed, false)).toContain('mapping')
    expect(taskRevisionIssue(before, { ...root, fileScope: ['outside/**'] }, false)).toContain('preserve')
  })
  it('rejects review history, human ownership, uncertainty, and active leases during preflight', () => {
    const state = replayTeamEvents(completedGraph(chain))
    const sources = chain.map(node => TaskId(node.id))
    expect(taskRevisionAdmissionIssue(state, sources, true)).toContain('uncertain')
    const leaseId = FileLeaseId('unresolved-lease')
    expect(taskRevisionAdmissionIssue({ ...state, fileLeaseIds: [leaseId], fileLeases: {
      [leaseId]: { leaseId, taskId: TaskId('root'), mode: 'write', fileScope: ['src/**'], status: 'active' },
    } }, sources, false)).toContain('leases')
    const attemptId = state.tasks.root!.attemptIds.at(-1)!
    expect(taskRevisionAdmissionIssue({ ...state, attempts: { ...state.attempts,
      [attemptId]: { ...state.attempts[attemptId]!, status: 'unknown' },
    } }, sources, false)).toContain('uncertain')
    expect(taskRevisionAdmissionIssue({ ...state, reviewIds: ['historical-review'] }, sources, false)).toContain('review')
    expect(taskRevisionAdmissionIssue({ ...state, team: { ...state.team, manualOwnership: {
      state: 'human-owned', taskId: TaskId('root'), acquisitionId: ControlOperationId('human'),
      workspacePath: '/workspace', acquiredAt: '2026-09-07T00:00:00Z',
    } } }, sources, false)).toContain('ownership')
  })
  it('admits a completed A revision while independent B remains running', async () => {
    // Trim B at its running attempt, keeping all of A's completed evidence.
    const s = setup(completedGraph([{ id: 'root', dependencies: [] }, { id: 'B', dependencies: [] }]).slice(0, -8))
    const before = replayTeamEvents(s.stored)
    expect(before.tasks.B!.status).toBe('running')
    const after = await s.coordinator.create({ ...cascadeRequest, includeDependents: false }, s.journal)
    expect(newTasks(after)).toHaveLength(1)
    expect(after.tasks.B).toEqual(before.tasks.B)
    expect(after.attempts).toEqual(before.attempts)
  })
  it('scopes active leases and reservations to affected taskIds but rejects global unknowns', () => {
    const state = replayTeamEvents(completedGraph([...chain, { id: 'B', dependencies: [] }]).slice(0, -8))
    const sources = chain.map(node => TaskId(node.id))
    const leaseId = FileLeaseId('B-lease')
    const lease = { leaseId, taskId: TaskId('B'), mode: 'write' as const, fileScope: ['src/**'], status: 'active' as const }
    const reservation = { reservationId: 'B-budget', taskId: 'B', attemptId: 'attempt-B', tokenReserve: 10, status: 'active' as const }
    const active = { ...state, fileLeaseIds: [leaseId], fileLeases: { [leaseId]: lease },
      budgetReservationIds: ['B-budget'], budgetReservations: { 'B-budget': reservation } }
    // Scope overlap still does not grant execution: the scheduler owns that gate.
    expect(taskRevisionAdmissionIssue(active, sources, false)).toBeUndefined()
    expect(taskRevisionAdmissionIssue({ ...active, fileLeases: {
      [leaseId]: { ...lease, taskId: TaskId('grandchild') },
    } }, sources, false)).toContain('leases')
    expect(taskRevisionAdmissionIssue({ ...active, budgetReservations: {
      'B-budget': { ...reservation, taskId: 'child' },
    } }, sources, false)).toContain('budget')
    expect(taskRevisionAdmissionIssue({ ...active, budgetReservations: {
      'B-budget': { ...reservation, status: 'unknown' },
    } }, sources, false)).toContain('uncertain')
    const attemptId = state.tasks.B!.attemptIds.at(-1)!
    expect(taskRevisionAdmissionIssue({ ...active, attempts: { ...active.attempts,
      [attemptId]: { ...active.attempts[attemptId]!, status: 'unknown' },
    } }, sources, false)).toContain('uncertain')
  })
  it('publishes a complete revision envelope consistently with replay, never a partial group', async () => {
    const s = setup(completedGraph(chain))
    const before = [...s.stored]
    const after = await s.coordinator.create(cascadeRequest, s.journal)
    const additions = s.commits[0]!
    const envelope = (events: readonly TeamEvent[], seq: number) => ({
      type: 'yuqi/team-event', data: { events }, seq, time: 1, ignorable: true,
    }) as SessionEvent
    const definition = createTeamSessionProjection()
    const initial = definition.apply(definition.init(), envelope(before, 1))
    const partial = definition.apply(initial, envelope(additions.slice(0, -1), 2))
    expect(partial).toBe(initial)
    expect(() => replayTeamEvents([...before, ...additions.slice(0, -1)])).toThrow('Incomplete')
    const complete = definition.apply(initial, envelope(additions, 2))
    expect(complete?.projection).toEqual(after)
    expect(definition.stateSchema.safeParse(complete).success).toBe(true)
    expect(definition.apply(complete, envelope(additions, 3))?.projection).toEqual(after)
    // Even a persisted projection cache must not resurrect an incomplete group.
    const removed = newTasks(after).at(-1)!.contract.taskId
    const { [removed]: _removed, ...remaining } = after.tasks
    expect(definition.stateSchema.safeParse({ ...complete, projection: { ...after,
      tasks: remaining, taskIds: after.taskIds.filter(id => id !== removed),
    } }).success).toBe(false)
  })
})
