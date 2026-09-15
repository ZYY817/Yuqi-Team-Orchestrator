import { describe, expect, it } from 'vitest'
import type { TeamEvent } from '../src/domain/events.ts'
import type { TeamEventJournal } from '../src/application/ports.ts'
import { DurableJournalCoordinator } from '../src/application/durable-journal.ts'
import { ReviewResultCoordinator } from '../src/application/record-review-result.ts'
import { completeTeamEvents, event } from './fixtures.ts'
import { TaskId } from '../src/domain/ids.ts'
import { contract } from './fixtures.ts'

class Journal implements TeamEventJournal {
  readonly key = `review-result-${Math.random()}`
  readonly events: unknown[]
  readonly transactions: TeamEvent[][] = []
  constructor(seed: readonly unknown[]) { this.events = [...seed] }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> {
    this.transactions.push([...events])
    this.events.push(...events)
  }
}

function seed() {
  return [
    event(1, { type: 'yuqi/team-created', title: 'Yuqi Team', objective: 'Build the plugin', reviewPolicy: {
      mode: 'quality-gate', maxReworkRounds: 2, additionalPrompt: '',
    } }),
    ...completeTeamEvents().slice(1, -1),
  ]
}

describe('ReviewResultCoordinator', () => {
  it.each(['model-diverse', 'context-only'] as const)('persists and replays %s reviewer route independence', async reviewerIndependence => {
    let id = 180
    const transactions = new DurableJournalCoordinator()
    const coordinator = new ReviewResultCoordinator({ nowIso: () => '2026-08-31T00:00:00Z' }, { next: () => `review-route-${id++}` }, transactions)
    const journal = new Journal(seed())
    await coordinator.request({ teamId: 'team-1', reviewId: `review-${reviewerIndependence}`, trigger: 'quality-gate', candidateEventId: 'event-16', round: 0 }, journal)
    const projection = await coordinator.record({
      teamId: 'team-1', candidateEventId: 'event-16', reviewerIndependence,
      result: {
        reviewId: `review-${reviewerIndependence}`, trigger: 'quality-gate', reviewerSessionId: `reviewer-${reviewerIndependence}`,
        decision: 'pass', findings: [], unverified: [],
      },
    }, journal)

    expect(journal.transactions.at(-1)?.[0]).toMatchObject({ type: 'yuqi/review-result-recorded', reviewerIndependence })
    expect(projection.reviews[`review-${reviewerIndependence}`]?.reviewerIndependence).toBe(reviewerIndependence)
    await transactions.dispose()
  })

  it('persists one request and one fixed-schema result idempotently', async () => {
    let id = 200
    const transactions = new DurableJournalCoordinator()
    const coordinator = new ReviewResultCoordinator({ nowIso: () => '2026-08-31T00:00:00Z' }, { next: () => `review-event-${id++}` }, transactions)
    const journal = new Journal(seed())
    const candidateEventId = 'event-16'
    await coordinator.request({ teamId: 'team-1', reviewId: 'review-1', trigger: 'quality-gate', candidateEventId, round: 0 }, journal)
    const result = {
      reviewId: 'review-1', trigger: 'quality-gate' as const, reviewerSessionId: 'reviewer-1',
      decision: 'pass' as const, findings: [], unverified: [],
    }
    const projection = await coordinator.record({ teamId: 'team-1', candidateEventId, result }, journal)
    await coordinator.record({ teamId: 'team-1', candidateEventId, result }, journal)
    expect(projection.reviews['review-1']).toMatchObject({ status: 'completed', result: { decision: 'pass' } })
    expect(journal.transactions.map(events => events.map(item => item.type))).toEqual([
      ['yuqi/review-requested'], ['yuqi/review-result-recorded'],
    ])
    await transactions.dispose()
  })

  it('rejects stale candidates and pass results carrying uncertainty', async () => {
    let id = 300
    const transactions = new DurableJournalCoordinator()
    const coordinator = new ReviewResultCoordinator({ nowIso: () => '2026-08-31T00:00:00Z' }, { next: () => `review-event-${id++}` }, transactions)
    const journal = new Journal(seed())
    await coordinator.request({ teamId: 'team-1', reviewId: 'review-2', trigger: 'quality-gate', candidateEventId: 'event-16', round: 0 }, journal)
    await expect(coordinator.record({
      teamId: 'team-1', candidateEventId: 'stale', result: {
        reviewId: 'review-2', trigger: 'quality-gate', reviewerSessionId: 'reviewer-2',
        decision: 'pass', findings: [], unverified: [],
      },
    }, journal)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await expect(coordinator.record({
      teamId: 'team-1', candidateEventId: 'event-16', result: {
        reviewId: 'review-2', trigger: 'quality-gate', reviewerSessionId: 'reviewer-2',
        decision: 'pass', findings: [], unverified: ['not checked'],
      },
    }, journal)).rejects.toThrow()
    expect(journal.transactions).toHaveLength(1)
    await transactions.dispose()
  })

  it('rejects mismatched or disabled requests and enforces idempotent request facts', async () => {
    let id = 400
    const transactions = new DurableJournalCoordinator()
    const coordinator = new ReviewResultCoordinator({ nowIso: () => '2026-08-31T00:00:00Z' }, { next: () => `review-event-${id++}` }, transactions)
    const journal = new Journal(seed())
    await expect(coordinator.request({ teamId: 'other', reviewId: 'review-x', trigger: 'quality-gate', candidateEventId: 'event-16', round: 0 }, journal))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await coordinator.request({ teamId: 'team-1', reviewId: 'review-x', trigger: 'quality-gate', candidateEventId: 'event-16', round: 0 }, journal)
    await expect(coordinator.request({ teamId: 'team-1', reviewId: 'review-x', trigger: 'quality-gate', candidateEventId: 'event-16', round: 1 }, journal))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await coordinator.request({ teamId: 'team-1', reviewId: 'review-x', trigger: 'quality-gate', candidateEventId: 'event-16', round: 0 }, journal)
    expect(journal.transactions).toHaveLength(1)

    const off = new Journal([
      event(1, { type: 'yuqi/team-created', title: 'Off', objective: 'No review', reviewPolicy: { mode: 'off', maxReworkRounds: 0, additionalPrompt: '' } }),
      ...completeTeamEvents().slice(1, -1),
    ])
    await expect(coordinator.request({ teamId: 'team-1', reviewId: 'review-off', trigger: 'quality-gate', candidateEventId: 'event-16', round: 0 }, off))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await transactions.dispose()
  })

  it('validates result identity and creates review rework idempotently', async () => {
    let id = 500
    const transactions = new DurableJournalCoordinator()
    const coordinator = new ReviewResultCoordinator({ nowIso: () => '2026-08-31T00:00:00Z' }, { next: () => `review-event-${id++}` }, transactions)
    const journal = new Journal(seed())
    await coordinator.request({ teamId: 'team-1', reviewId: 'review-rework', trigger: 'quality-gate', candidateEventId: 'event-16', round: 0 }, journal)
    await expect(coordinator.record({
      teamId: 'team-1', candidateEventId: 'event-16', result: {
        reviewId: 'missing', trigger: 'quality-gate', reviewerSessionId: 'reviewer', decision: 'pass', findings: [], unverified: [],
      },
    }, journal)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })

    const result = {
      reviewId: 'review-rework', trigger: 'quality-gate' as const, reviewerSessionId: 'reviewer',
      decision: 'changes_required' as const,
      findings: [{ severity: 'medium' as const, evidence: ['src/a.ts:1'], impact: 'wrong', recommendation: 'fix' }], unverified: [],
    }
    await coordinator.record({ teamId: 'team-1', candidateEventId: 'event-16', result }, journal)
    await expect(coordinator.record({
      teamId: 'team-1', candidateEventId: 'event-16', result: { ...result, reviewerSessionId: 'different-reviewer' },
    }, journal)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })

    const rework = {
      ...contract(TaskId('review-rework-task')), kind: 'review-rework' as const,
      authorityMode: 'full-access' as const, reviewRework: { sourceReviewId: 'review-rework', round: 1 },
    }
    await expect(coordinator.createRework({ teamId: 'team-1', sourceReviewId: 'wrong', contract: rework }, journal))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    const reworked = await coordinator.createRework({ teamId: 'team-1', sourceReviewId: 'review-rework', contract: rework }, journal)
    expect(reworked.tasks['review-rework-task']?.contract.authorityMode).toBe('write-authorized')
    await coordinator.createRework({ teamId: 'team-1', sourceReviewId: 'review-rework', contract: rework }, journal)
    await expect(coordinator.createRework({
      teamId: 'team-1', sourceReviewId: 'review-rework', contract: { ...rework, goal: 'different' },
    }, journal)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    expect(journal.transactions.flat().filter(item => item.type === 'yuqi/task-created')).toHaveLength(1)
    await transactions.dispose()
  })

  it('records user decisions with durable reason and operation idempotency', async () => {
    let id = 600
    const transactions = new DurableJournalCoordinator()
    const coordinator = new ReviewResultCoordinator({ nowIso: () => '2026-08-31T00:00:00Z' }, { next: () => `review-event-${id++}` }, transactions)
    const journal = new Journal(seed())
    await coordinator.request({ teamId: 'team-1', reviewId: 'review-decision', trigger: 'quality-gate', candidateEventId: 'event-16', round: 0 }, journal)
    await coordinator.record({
      teamId: 'team-1', candidateEventId: 'event-16', result: {
        reviewId: 'review-decision', trigger: 'quality-gate', reviewerSessionId: 'reviewer-decision',
        decision: 'inconclusive', findings: [], unverified: ['manual decision required'],
      },
    }, journal)
    await expect(coordinator.decide({
      teamId: 'team-1', operationId: 'decision-1', reviewId: 'review-decision', candidateEventId: 'event-16', round: 0,
      decision: 'waive', reason: '   ',
    }, journal)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    const request = {
      teamId: 'team-1', operationId: 'decision-1', reviewId: 'review-decision', candidateEventId: 'event-16', round: 0,
      decision: 'waive' as const, reason: '  accepted risk  ',
    }
    const decided = await coordinator.decide(request, journal)
    expect(decided.reviews['review-decision']?.userDecision).toMatchObject({ decision: 'waive', reason: 'accepted risk' })
    await coordinator.decide({ ...request, reason: 'accepted risk' }, journal)
    await expect(coordinator.decide({ ...request, decision: 'cancel' }, journal))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await transactions.dispose()
  })
})
