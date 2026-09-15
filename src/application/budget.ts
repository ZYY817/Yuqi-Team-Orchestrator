/** Pure pre-dispatch budget reservation and threshold assessment. */

import type { BudgetPolicy, BudgetReservation, BudgetReservationRequest, BudgetUsage } from '../domain/budget.ts'
import { budgetReservationRequestSchema } from '../domain/budget.ts'
import { ControlOperationId } from '../domain/ids.ts'
import type { TeamProjection } from '../domain/projection.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { YuqiOrchestratorError } from './errors.ts'
import type { Clock, EventIdSource, TeamEventJournal } from './ports.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'

export type BudgetErrorCode = 'DUPLICATE_ACTIVE_RESERVATION' | 'BUDGET_RESERVATION_CONFLICT'

export class BudgetError extends Error {
  readonly code: BudgetErrorCode

  constructor(code: BudgetErrorCode, message: string) {
    super(message)
    this.name = 'BudgetError'
    this.code = code
  }
}

export type BudgetMetric = 'tokens' | 'estimated-cost-micros'
export type BudgetDecisionKind = 'reserved' | 'idempotent' | 'blocked'
export type BudgetBlockReason = 'hard-limit' | 'usage-unknown'

export interface BudgetAlert {
  readonly metric: BudgetMetric
  readonly thresholdPercent: number
}

export interface BudgetDecision {
  readonly kind: BudgetDecisionKind
  readonly action: 'allow' | 'block-new' | 'interrupt-running'
  readonly blockReasons: readonly BudgetBlockReason[]
  readonly alerts: readonly BudgetAlert[]
  readonly activeReservations: readonly BudgetReservation[]
}

/**
 * Atomically assess one proposed reservation against current usage and existing holds.
 * The caller persists the returned reservation list before starting any model request.
 */
export function reserveBudget(input: BudgetReservationRequest): BudgetDecision {
  const request = budgetReservationRequestSchema.parse(input)
  const sameId = findReservation(request.activeReservations, request.reservation.reservationId)
  assertUniqueReservations(request.activeReservations)
  if (sameId !== undefined) {
    if (!sameReservation(sameId, request.reservation)) {
      throw new BudgetError('BUDGET_RESERVATION_CONFLICT', `Reservation ${request.reservation.reservationId} has conflicting values`)
    }
    return freezeDecision('idempotent', 'allow', [], [], request.activeReservations)
  }

  const tokenAssessment = assessMetric(
    'tokens', request.policy.tokenLimit, request.usage.totalTokens,
    sum(request.activeReservations, reservation => reservation.tokenReserve), request.reservation.tokenReserve, request.policy.alertPercentages,
  )
  const costAssessment = assessMetric(
    'estimated-cost-micros', request.policy.estimatedCostMicrosLimit, request.usage.estimatedCostMicros,
    sum(request.activeReservations, reservation => reservation.estimatedCostMicrosReserve), request.reservation.estimatedCostMicrosReserve, request.policy.alertPercentages,
  )
  const assessments = [tokenAssessment, costAssessment]
  const blockReasons = assessments.flatMap(assessment => assessment.blockReason === undefined ? [] : [assessment.blockReason])
  if (blockReasons.length > 0) {
    const hardLimit = blockReasons.includes('hard-limit')
    return freezeDecision('blocked', hardLimit ? request.policy.stopBehavior : 'block-new', blockReasons, [], request.activeReservations)
  }
  const activeReservations = [...request.activeReservations, request.reservation]
  return freezeDecision('reserved', 'allow', [], assessments.flatMap(assessment => assessment.alerts), activeReservations)
}

/** Durable token-only policy command scoped to one Controller journal. */
export interface SetBudgetPolicyRequest {
  readonly teamId: string
  readonly operationId: string
  readonly revision: number
  readonly tokenLimit: number
  readonly alerts?: readonly number[]
}

/** Persists budget policy revisions before any batch reservation can be acquired. */
export class BudgetPolicyCoordinator {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator

  constructor(clock: Clock, eventIds: EventIdSource, transactions: DurableJournalCoordinator) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions
  }

  set(request: SetBudgetPolicyRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    return this.#transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      if (current.team.id !== request.teamId) {
        throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
      }
      const operationId = ControlOperationId(request.operationId)
      const alerts = [...(request.alerts ?? [])]
      const previous = current.budgetPolicyOperations[operationId]
      if (previous !== undefined) {
        if (previous.revision === request.revision
          && previous.tokenLimit === request.tokenLimit
          && sameNumbers(previous.alerts, alerts)
          && previous.stopBehavior === 'block-new') {
          return current
        }
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Budget policy operation ${operationId} was reused with different content`)
      }
      const event = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
        type: 'yuqi/budget-policy-set', operationId, revision: request.revision,
        tokenLimit: request.tokenLimit, alerts, stopBehavior: 'block-new',
      })
      const next = validateTeamEvents(transaction.read(), [event])
      await transaction.commit([event], 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the token budget policy')
      return next
    })
  }

  dispose(): Promise<void> {
    return this.#transactions.dispose()
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

interface MetricAssessment {
  readonly blockReason?: BudgetBlockReason
  readonly alerts: readonly BudgetAlert[]
}

function assessMetric(
  metric: BudgetMetric,
  limit: number | undefined,
  used: number | undefined,
  activeReserved: number,
  requested: number,
  thresholds: readonly number[],
): MetricAssessment {
  if (limit === undefined) return { alerts: [] }
  if (used === undefined) return { blockReason: 'usage-unknown', alerts: [] }
  const before = used + activeReserved
  const after = before + requested
  if (after > limit) return { blockReason: 'hard-limit', alerts: [] }
  return {
    alerts: thresholds
      .filter(threshold => before * 100 < limit * threshold && after * 100 >= limit * threshold)
      .map(threshold => Object.freeze({ metric, thresholdPercent: threshold })),
  }
}

function findReservation(reservations: readonly BudgetReservation[], id: string): BudgetReservation | undefined {
  return reservations.find(reservation => reservation.reservationId === id)
}

function assertUniqueReservations(reservations: readonly BudgetReservation[]): void {
  const ids = new Set<string>()
  for (const reservation of reservations) {
    if (ids.has(reservation.reservationId)) {
      throw new BudgetError('DUPLICATE_ACTIVE_RESERVATION', `Active reservation ${reservation.reservationId} is duplicated`)
    }
    ids.add(reservation.reservationId)
  }
}

function sameReservation(left: BudgetReservation, right: BudgetReservation): boolean {
  return left.tokenReserve === right.tokenReserve && left.estimatedCostMicrosReserve === right.estimatedCostMicrosReserve
}

function sum(items: readonly BudgetReservation[], select: (item: BudgetReservation) => number): number {
  return items.reduce((total, item) => total + select(item), 0)
}

function freezeDecision(
  kind: BudgetDecisionKind,
  action: BudgetDecision['action'],
  blockReasons: readonly BudgetBlockReason[],
  alerts: readonly BudgetAlert[],
  activeReservations: readonly BudgetReservation[],
): BudgetDecision {
  return Object.freeze({
    kind,
    action,
    blockReasons: Object.freeze([...blockReasons]),
    alerts: Object.freeze(alerts.map(alert => Object.freeze({ ...alert }))),
    activeReservations: Object.freeze(activeReservations.map(reservation => Object.freeze({ ...reservation }))),
  })
}
