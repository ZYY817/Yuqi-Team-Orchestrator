import { describe, expect, it } from 'vitest'
import {
  BudgetPolicyCoordinator,
  AttemptId,
  budgetReservationDecision,
  budgetTokenLedger,
  DurableJournalCoordinator,
  ControlOperationId,
  planTeamSchedule,
  prepareTeamBatchIntent,
  projectionHasReconciliationGap,
  replayTeamEvents,
  TaskId,
  TeamId,
} from '../src/index.ts'
import type { Clock, EventIdSource, TeamEvent, TeamEventJournal } from '../src/index.ts'
import { completeTeamEvents, contract, event, TASK_ID, TEAM_ID } from './fixtures.ts'

class ClockStub implements Clock {
  #n = 0
  nowIso(): string { return `2026-08-16T00:00:${String(this.#n++).padStart(2, '0')}Z` }
}

class Ids implements EventIdSource {
  #n = 0
  next(): string { return `budget-event-${this.#n++}` }
}

class Journal implements TeamEventJournal {
  readonly key = 'budget-controller'
  readonly events: unknown[]
  constructor(events: readonly unknown[]) { this.events = [...events] }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> { this.events.push(...events) }
}

function policyBase(limit = 100): readonly TeamEvent[] {
  return [
    event(1, { type: 'yuqi/team-created', title: 'Budget', objective: 'Bound token admission' }),
    event(2, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    event(3, { type: 'yuqi/budget-policy-set', operationId: ControlOperationId('budget-policy-1'), revision: 1, tokenLimit: limit, alerts: [50], stopBehavior: 'block-new' }),
    event(4, { type: 'yuqi/task-created', contract: contract() }),
  ]
}

function attemptEvents(status: 'known' | 'unknown' | 'not-admitted' = 'known'): readonly TeamEvent[] {
  const attemptId = AttemptId('attempt-budget')
  const usage = { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }
  return [
    ...policyBase(),
    event(5, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'pending', to: 'ready' }),
    event(6, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
    event(7, { type: 'yuqi/budget-reservation-acquired', reservationId: 'reservation-1', taskId: TASK_ID, attemptId, tokenReserve: 50 }),
    event(8, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId, ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
    ...(status === 'not-admitted' ? [] : [
      event(9, { type: 'yuqi/attempt-admitted', taskId: TASK_ID, attemptId, agentSessionId: 'child-budget', messageId: 'message-budget' }),
      event(10, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId, from: 'dispatching', to: 'running' }),
      event(11, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId, from: 'running', to: 'settled' }),
      event(12, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId, runId: 'run-budget', agentSessionId: 'child-budget', provider: 'p', stopReason: 'completed', hasAssistantOutput: true, ...(status === 'known' ? { usage } : {}), settledAt: '2026-08-16T00:00:12Z' }),
    ]),
    event(13, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-1', taskId: TASK_ID, attemptId, status,
      ...(status === 'known' ? { usage: { totalTokens: 30 } } : {}),
    }),
  ]
}

function twoTaskPolicyBase(limit = 100): readonly TeamEvent[] {
  return [...policyBase(limit), event(5, { type: 'yuqi/task-created', contract: { ...contract(TaskId('task-2')), fileScope: ['tests/**'] } })]
}

function activeEventsForGap(): readonly TeamEvent[] {
  return [
    ...policyBase(),
    event(23, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'pending', to: 'ready' }),
    event(24, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
    event(25, { type: 'yuqi/budget-reservation-acquired', reservationId: 'gap-reservation', taskId: TASK_ID, attemptId: AttemptId('gap-attempt'), tokenReserve: 10 }),
    event(26, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: AttemptId('gap-attempt'), ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
  ]
}

describe('durable token budget', () => {
  it('persists one journal-scoped policy, enforces revisions, and rejects interrupt-running', async () => {
    const journal = new Journal([
      event(20, { type: 'yuqi/team-created', title: 'Policy', objective: 'Set policy' }),
      event(21, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    ])
    const coordinator = new BudgetPolicyCoordinator(new ClockStub(), new Ids(), new DurableJournalCoordinator())
    await expect(coordinator.set({ teamId: 'team-other', operationId: 'wrong-team', revision: 1, tokenLimit: 100 }, journal)).rejects.toThrow(/does not own this controller journal/)
    await coordinator.set({ teamId: TEAM_ID, operationId: 'policy-op', revision: 1, tokenLimit: 100, alerts: [50] }, journal)
    const eventCountAfterFirstSet = journal.read().length
    await coordinator.set({ teamId: TEAM_ID, operationId: 'policy-op', revision: 1, tokenLimit: 100, alerts: [50] }, journal)
    expect(journal.read()).toHaveLength(eventCountAfterFirstSet)
    expect(replayTeamEvents(journal.read()).budgetPolicy).toMatchObject({ revision: 1, tokenLimit: 100, stopBehavior: 'block-new' })
    await expect(coordinator.set({ teamId: TEAM_ID, operationId: 'policy-op', revision: 1, tokenLimit: 99, alerts: [50] }, journal)).rejects.toThrow(/reused with different content/)
    await expect(coordinator.set({ teamId: TEAM_ID, operationId: 'policy-op-2', revision: 1, tokenLimit: 90 }, journal)).rejects.toThrow(/next revision/)
    await expect(coordinator.set({ teamId: TEAM_ID, operationId: 'policy-op-2', revision: 2, tokenLimit: 90 }, journal)).resolves.toBeDefined()
    expect(() => event(99, { type: 'yuqi/budget-policy-set', operationId: ControlOperationId('bad-stop'), revision: 3, tokenLimit: 90, alerts: [], stopBehavior: 'interrupt-running' as never })).toThrow()
    await coordinator.set({ teamId: TEAM_ID, operationId: 'policy-op-3', revision: 3, tokenLimit: 80 }, journal)
    await coordinator.dispose()
  })

  it('replays budget operation and reservation idempotency without widening the journal contract', () => {
    const policy = event(3, {
      type: 'yuqi/budget-policy-set', operationId: ControlOperationId('duplicate-policy'), revision: 1,
      tokenLimit: 100, alerts: [50], stopBehavior: 'block-new',
    })
    const policySource = [
      event(1, { type: 'yuqi/team-created', title: 'Budget conflicts', objective: 'Exercise durable guards' }),
      event(2, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      policy,
      event(4, { type: 'yuqi/task-created', contract: contract() }),
    ]
    expect(replayTeamEvents([...policySource, event(18, {
      type: 'yuqi/budget-policy-set', operationId: ControlOperationId('duplicate-policy'), revision: 1,
      tokenLimit: 100, alerts: [50], stopBehavior: 'block-new',
    })]).budgetPolicy).toMatchObject({ revision: 1 })
    expect(() => replayTeamEvents([...policySource, event(5, {
      type: 'yuqi/budget-policy-set', operationId: ControlOperationId('duplicate-policy'), revision: 1,
      tokenLimit: 100, alerts: [40], stopBehavior: 'block-new',
    })])).toThrow(/reused with different content/)
    expect(() => replayTeamEvents([
      ...policySource.slice(0, 2),
      event(6, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('cross-operation'), action: 'pause' }),
      event(7, {
        type: 'yuqi/budget-policy-set', operationId: ControlOperationId('cross-operation'), revision: 1,
        tokenLimit: 100, alerts: [], stopBehavior: 'block-new',
      }),
    ])).toThrow(/already used for another command/)
    expect(() => replayTeamEvents([
      ...policySource.slice(0, 2),
      event(8, {
        type: 'yuqi/budget-policy-set', operationId: ControlOperationId('invalid-first-revision'), revision: 2,
        tokenLimit: 100, alerts: [], stopBehavior: 'block-new',
      }),
    ])).toThrow(/must start at revision 1/)

    const running = [
      ...policySource,
      event(9, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'pending', to: 'ready' }),
      event(10, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
    ]
    const reservation = event(11, {
      type: 'yuqi/budget-reservation-acquired', reservationId: 'duplicate-reservation', taskId: TASK_ID,
      attemptId: AttemptId('duplicate-attempt'), tokenReserve: 10,
    })
    expect(replayTeamEvents([...running, reservation, { ...reservation, eventId: event(19, {
      type: 'yuqi/budget-reservation-acquired', reservationId: 'unused', taskId: TASK_ID,
      attemptId: AttemptId('unused-attempt'), tokenReserve: 1,
    }).eventId }]).budgetReservations['duplicate-reservation']).toMatchObject({ status: 'active' })
    expect(() => replayTeamEvents([...running, reservation, event(13, {
      type: 'yuqi/budget-reservation-acquired', reservationId: 'duplicate-reservation', taskId: TASK_ID,
      attemptId: AttemptId('duplicate-attempt'), tokenReserve: 11,
    })])).toThrow(/reused with different content/)
    expect(() => replayTeamEvents([...running, reservation, event(14, {
      type: 'yuqi/budget-reservation-acquired', reservationId: 'second-reservation', taskId: TASK_ID,
      attemptId: AttemptId('duplicate-attempt'), tokenReserve: 1,
    })])).toThrow(/already has a token budget reservation/)
    expect(() => replayTeamEvents([...running, event(15, {
      type: 'yuqi/budget-reservation-acquired', reservationId: 'over-limit', taskId: TASK_ID,
      attemptId: AttemptId('over-limit-attempt'), tokenReserve: 101,
    })])).toThrow(/blocked by hard-limit/)
    expect(() => replayTeamEvents([
      ...policySource,
      event(16, {
        type: 'yuqi/budget-reservation-acquired', reservationId: 'missing-task', taskId: TaskId('missing-task'),
        attemptId: AttemptId('missing-task-attempt'), tokenReserve: 1,
      }),
    ])).toThrow(/does not exist/)
    expect(() => replayTeamEvents([
      ...policySource.slice(0, 2),
      policySource[3]!,
      event(17, {
        type: 'yuqi/budget-reservation-acquired', reservationId: 'no-policy', taskId: TASK_ID,
        attemptId: AttemptId('no-policy-attempt'), tokenReserve: 1,
      }),
    ])).toThrow(/requires a configured budget policy/)
  })

  it('holds every reservation before task/attempt intent and blocks the next batch at the hard limit', () => {
    const projection = replayTeamEvents(twoTaskPolicyBase(10))
    const plan = planTeamSchedule(projection, { maxConcurrency: 1 })
    expect(() => prepareTeamBatchIntent(projection, {
      teamId: TEAM_ID, plan, maxConcurrency: 1,
      attempts: [{ taskId: TASK_ID, attemptId: 'attempt-without-reserve', modelProvider: 'p', modelId: 'deepseek-v4' }],
    }, new ClockStub(), new Ids())).toThrow(expect.objectContaining({ code: 'BUDGET_BLOCKED' }))
    const prepared = prepareTeamBatchIntent(projection, {
      teamId: TEAM_ID, plan, maxConcurrency: 1,
      attempts: [{ taskId: TASK_ID, attemptId: 'attempt-first', modelProvider: 'p', modelId: 'deepseek-v4', tokenReserve: 10 }],
    }, new ClockStub(), new Ids())
    expect(prepared.events.map(item => item.type)).toEqual([
      'yuqi/budget-reservation-acquired', 'yuqi/task-status-changed', 'yuqi/task-status-changed', 'yuqi/attempt-created',
    ])
    expect(prepared.projection.budgetReservations['budget:attempt-first']).toMatchObject({ status: 'active', tokenReserve: 10 })
    const afterRestart = replayTeamEvents([...twoTaskPolicyBase(10), ...prepared.events])
    expect(afterRestart.budgetReservations['budget:attempt-first']).toMatchObject({ status: 'active', tokenReserve: 10 })
    const secondPlan = planTeamSchedule(afterRestart, { maxConcurrency: 2 })
    expect(() => prepareTeamBatchIntent(afterRestart, {
      teamId: TEAM_ID, plan: secondPlan, maxConcurrency: 2,
      attempts: [{ taskId: 'task-2', attemptId: AttemptId('attempt-second'), modelProvider: 'p', modelId: 'deepseek-v4', tokenReserve: 1 }],
    }, new ClockStub(), new Ids())).toThrow(expect.objectContaining({ code: 'BUDGET_BLOCKED' }))
  })

  it('keeps unknown usage as a reconciliation gap and never counts it as zero', () => {
    const unknown = replayTeamEvents(attemptEvents('unknown'))
    expect(unknown.budgetReservations['reservation-1']?.status).toBe('unknown')
    expect(budgetTokenLedger(unknown)).toMatchObject({ usageKnown: false, usedTokens: 0, activeReservedTokens: 0 })
    expect(projectionHasReconciliationGap(unknown)).toBe(true)
    expect(budgetReservationDecision(unknown, 1)).toBe('usage-unknown')
    const known = replayTeamEvents(attemptEvents('known'))
    expect(budgetTokenLedger(known)).toMatchObject({ usageKnown: true, usedTokens: 30, activeReservedTokens: 0 })
    const released = replayTeamEvents(attemptEvents('not-admitted'))
    expect(budgetTokenLedger(released)).toMatchObject({ usageKnown: true, usedTokens: 0, activeReservedTokens: 0 })
    expect(projectionHasReconciliationGap(released)).toBe(false)
    expect(budgetReservationDecision(released, 0)).toBe('hard-limit')
  })

  it('treats malformed active attempts and ledger mismatches as reconciliation gaps', () => {
    const active = replayTeamEvents(activeEventsForGap().slice(0, -1))
    expect(projectionHasReconciliationGap(active)).toBe(true)
    const failed = replayTeamEvents([
      ...activeEventsForGap(),
      event(27, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: AttemptId('gap-attempt'), from: 'dispatching', to: 'failed' }),
    ])
    expect(projectionHasReconciliationGap(failed)).toBe(true)

    const running = replayTeamEvents(attemptEvents('known'))
    Object.assign(running.tasks[TASK_ID]!, { status: 'pending' })
    Object.assign(running.attempts['attempt-budget']!, { status: 'running' })
    expect(projectionHasReconciliationGap(running)).toBe(true)
    const completedWhileRunning = replayTeamEvents(attemptEvents('known'))
    expect(projectionHasReconciliationGap(completedWhileRunning)).toBe(true)

    const mismatched = replayTeamEvents(attemptEvents('known'))
    Object.assign(mismatched.budgetReservations['reservation-1']!, { usage: { totalTokens: 31 } })
    expect(budgetTokenLedger(mismatched).usageKnown).toBe(false)
    const noEvidence = replayTeamEvents(attemptEvents('known'))
    Object.assign(noEvidence.attempts['attempt-budget']!, { evidence: undefined })
    Object.assign(noEvidence.budgetReservations['reservation-1']!, { usage: undefined })
    expect(budgetTokenLedger(noEvidence)).toMatchObject({ usageKnown: false, usedTokens: 0 })
    const usageWithoutEvidence = replayTeamEvents(attemptEvents('known'))
    Object.assign(usageWithoutEvidence.attempts['attempt-budget']!, { evidence: undefined })
    Object.assign(usageWithoutEvidence.budgetReservations['reservation-1']!, { usage: { totalTokens: 30 } })
    expect(budgetTokenLedger(usageWithoutEvidence)).toMatchObject({ usageKnown: false, usedTokens: 30 })
    expect(budgetTokenLedger(replayTeamEvents(completeTeamEvents()))).toMatchObject({ usageKnown: true, usedTokens: 0, activeReservedTokens: 0 })
    expect(budgetReservationDecision(replayTeamEvents(completeTeamEvents()), 1)).toBe('allow')
  })

  it('does not classify an admitted running child with an exact active reservation as unknown', () => {
    const running = replayTeamEvents(attemptEvents('known').slice(0, 10))
    expect(running.attempts['attempt-budget']?.status).toBe('running')
    expect(running.attempts['attempt-budget']?.agentSessionId).toBe('child-budget')
    expect(running.attempts['attempt-budget']?.evidence).toBeUndefined()
    expect(projectionHasReconciliationGap(running)).toBe(false)
    expect(budgetTokenLedger(running)).toMatchObject({ usageKnown: true, activeReservedTokens: 50, usedTokens: 0 })
    expect(budgetReservationDecision(running, 49)).toBe('allow')
    expect(budgetReservationDecision(running, 51)).toBe('hard-limit')
    expect(projectionHasReconciliationGap({ ...running, budgetReservations: {}, budgetReservationIds: [] })).toBe(true)
    expect(projectionHasReconciliationGap({ ...running, budgetReservations: {
      'reservation-1': { ...running.budgetReservations['reservation-1']!, taskId: 'another-task' },
    } })).toBe(true)
    const crossTask = { ...running, budgetReservations: { ...running.budgetReservations,
      duplicate: { ...running.budgetReservations['reservation-1']!, reservationId: 'duplicate', taskId: 'another-task' },
    } }
    expect(projectionHasReconciliationGap(crossTask)).toBe(true)
    expect(budgetReservationDecision(crossTask, 1)).toBe('usage-unknown')
  })

  it('rejects settlement before acquisition, conflicting replay, and usage on non-known outcomes', () => {
    const source = policyBase()
    expect(() => replayTeamEvents([...source, event(40, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'missing', taskId: TASK_ID, attemptId: AttemptId('attempt-budget'), status: 'unknown',
    })])).toThrow(/does not exist/)
    const known = attemptEvents('known')
    expect(() => replayTeamEvents([...known, event(14, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-1', taskId: TASK_ID, attemptId: AttemptId('attempt-budget'), status: 'known', usage: { totalTokens: 31 },
    })])).toThrow(/already settled/)
    expect(() => replayTeamEvents([...policyBase(), event(41, {
      type: 'yuqi/budget-reservation-acquired', reservationId: 'reservation-2', taskId: TASK_ID, attemptId: AttemptId('attempt-2'), tokenReserve: 10,
    }), event(42, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-2', taskId: TASK_ID, attemptId: AttemptId('attempt-2'), status: 'unknown', usage: { totalTokens: 0 },
    })])).toThrow(/cannot carry usage/)
  })

  it('requires an active reservation whenever a budgeted attempt is created', () => {
    expect(() => replayTeamEvents([
      ...policyBase(),
      event(46, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'pending', to: 'ready' }),
      event(47, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
      event(48, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: AttemptId('no-reservation-attempt'), ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
    ])).toThrow(/requires an active token budget reservation/)
  })

  it('requires reservation acquisition before attempt creation and terminal evidence before settlement', () => {
    const attemptId = AttemptId('attempt-order')
    const noPolicyAttempt = [
      event(60, { type: 'yuqi/team-created', title: 'Order', objective: 'Order budget facts' }),
      event(61, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(62, { type: 'yuqi/task-created', contract: contract() }),
      event(63, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'pending', to: 'ready' }),
      event(64, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
      event(65, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId, ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
      event(66, { type: 'yuqi/budget-policy-set', operationId: ControlOperationId('order-policy'), revision: 1, tokenLimit: 100, alerts: [], stopBehavior: 'block-new' }),
    ]
    expect(() => replayTeamEvents([...noPolicyAttempt, event(67, {
      type: 'yuqi/budget-reservation-acquired', reservationId: 'late-reservation', taskId: TASK_ID, attemptId, tokenReserve: 10,
    })])).toThrow(/must be acquired before attempt/)

    const admittedWithoutEvidence = attemptEvents('known').slice(0, -3)
    const evidenceAttemptId = AttemptId('attempt-budget')
    expect(() => replayTeamEvents([...admittedWithoutEvidence,
      event(14, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: evidenceAttemptId, from: 'running', to: 'failed' }),
      event(15, { type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-1', taskId: TASK_ID, attemptId: evidenceAttemptId, status: 'unknown' }),
    ])).toThrow(/requires terminal attempt evidence/)

    const settledWithoutBudget = attemptEvents('known').slice(0, -1)
    expect(() => replayTeamEvents([...settledWithoutBudget, event(16, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-1', taskId: TASK_ID, attemptId: evidenceAttemptId, status: 'known', usage: { totalTokens: 31 },
    })])).toThrow(/does not match attempt usage/)
  })

  it('rejects settlements that cannot prove admission, terminal evidence, or references', () => {
    const active = attemptEvents('not-admitted').slice(0, -1)
    expect(() => replayTeamEvents([...active, event(30, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-1', taskId: TASK_ID,
      attemptId: AttemptId('attempt-budget'), status: 'known', usage: { totalTokens: 30 },
    })])).toThrow(/requires terminal attempt evidence/)
    expect(() => replayTeamEvents([...active, event(31, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-1', taskId: TASK_ID,
      attemptId: AttemptId('attempt-budget'), status: 'known',
    })])).toThrow(/requires usage/)
    expect(() => replayTeamEvents([...active, event(31, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-1', taskId: TASK_ID,
      attemptId: AttemptId('attempt-budget'), status: 'unknown',
    })])).toThrow(/requires terminal attempt evidence/)
    const admitted = attemptEvents('known').slice(0, -1)
    expect(() => replayTeamEvents([...admitted, event(32, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-1', taskId: TASK_ID,
      attemptId: AttemptId('attempt-budget'), status: 'not-admitted',
    })])).toThrow(/before child admission/)
    const terminalWithoutAdmission = [
      ...active,
      event(33, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: AttemptId('attempt-budget'), from: 'dispatching', to: 'failed' }),
    ]
    expect(() => replayTeamEvents([...terminalWithoutAdmission, event(34, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-1', taskId: TASK_ID,
      attemptId: AttemptId('attempt-budget'), status: 'not-admitted',
    })])).toThrow(/before child admission/)
    expect(() => replayTeamEvents([...active, event(35, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-1', taskId: TaskId('task-2'),
      attemptId: AttemptId('attempt-budget'), status: 'unknown',
    })])).toThrow(/does not match its attempt/)
    expect(() => replayTeamEvents([...active, event(36, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-1', taskId: TASK_ID,
      attemptId: AttemptId('missing-attempt'), status: 'unknown',
    })])).toThrow(/does not match its attempt|does not exist/)
    expect(replayTeamEvents([...attemptEvents('known'), event(37, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-1', taskId: TASK_ID,
      attemptId: AttemptId('attempt-budget'), status: 'known', usage: { totalTokens: 30 },
    })]).budgetReservations['reservation-1']).toMatchObject({ status: 'known', usage: { totalTokens: 30 } })

    const evidenceWithoutUsage = attemptEvents('unknown').slice(0, -1)
    expect(() => replayTeamEvents([...evidenceWithoutUsage, event(38, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'reservation-1', taskId: TASK_ID,
      attemptId: AttemptId('attempt-budget'), status: 'known', usage: { totalTokens: 0 },
    })])).toThrow(/requires usage in terminal attempt evidence/)

    const otherTask = TaskId('task-2')
    const crossTask = [
      ...twoTaskPolicyBase(),
      event(38, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'pending', to: 'ready' }),
      event(39, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
      event(40, { type: 'yuqi/task-status-changed', taskId: otherTask, from: 'pending', to: 'ready' }),
      event(41, { type: 'yuqi/task-status-changed', taskId: otherTask, from: 'ready', to: 'running' }),
      event(42, { type: 'yuqi/budget-reservation-acquired', reservationId: 'cross-task-reservation', taskId: TASK_ID, attemptId: AttemptId('cross-task-attempt'), tokenReserve: 10 }),
      event(43, { type: 'yuqi/budget-reservation-acquired', reservationId: 'cross-task-attempt-reservation', taskId: otherTask, attemptId: AttemptId('cross-task-attempt'), tokenReserve: 10 }),
      event(44, { type: 'yuqi/attempt-created', taskId: otherTask, attemptId: AttemptId('cross-task-attempt'), ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
    ]
    expect(() => replayTeamEvents([...crossTask, event(45, {
      type: 'yuqi/budget-reservation-settled', reservationId: 'cross-task-reservation', taskId: TASK_ID,
      attemptId: AttemptId('cross-task-attempt'), status: 'not-admitted',
    })])).toThrow(/does not match attempt/)
  })

  it('blocks retry while a prior attempt still owns an active reservation', () => {
    const attemptId = AttemptId('attempt-retry-budget')
    const retryable = [
      ...policyBase(),
      event(50, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'pending', to: 'ready' }),
      event(51, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
      event(52, { type: 'yuqi/budget-reservation-acquired', reservationId: 'retry-reservation', taskId: TASK_ID, attemptId, tokenReserve: 10 }),
      event(53, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId, ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
      event(54, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId, from: 'dispatching', to: 'failed' }),
      event(55, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' }),
    ]
    expect(() => replayTeamEvents([...retryable, event(56, {
      type: 'yuqi/task-retry-requested', operationId: ControlOperationId('retry-budget'), taskId: TASK_ID,
    })])).toThrow(/unresolved/)
  })

  it('permits retry after a reservation is durably settled as not-admitted', () => {
    const settled = [
      ...attemptEvents('not-admitted'),
      event(56, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: AttemptId('attempt-budget'), from: 'dispatching', to: 'failed' }),
      event(57, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' }),
      event(58, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('retry-after-not-admitted'), taskId: TASK_ID }),
    ]
    const projection = replayTeamEvents(settled)
    expect(projection.tasks[TASK_ID]?.status).toBe('ready')
    expect(projection.budgetReservations['reservation-1']?.status).toBe('not-admitted')
  })
})
