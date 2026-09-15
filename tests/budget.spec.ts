import { describe, expect, it } from 'vitest'
import { reserveBudget } from '../src/application/budget.ts'
import type { BudgetReservationRequest } from '../src/domain/budget.ts'

function request(overrides: Partial<BudgetReservationRequest> = {}): BudgetReservationRequest {
  return {
    policy: { tokenLimit: 100, estimatedCostMicrosLimit: 1_000, alertPercentages: [50, 80], stopBehavior: 'block-new' },
    usage: { totalTokens: 40, estimatedCostMicros: 400 },
    activeReservations: [],
    reservation: { reservationId: 'reserve-1', tokenReserve: 15, estimatedCostMicrosReserve: 150 },
    ...overrides,
  }
}

describe('conservative budget reservations', () => {
  it('reserves within configured limits and emits each threshold exactly when crossed', () => {
    const result = reserveBudget(request())
    expect(result).toMatchObject({
      kind: 'reserved', action: 'allow', activeReservations: [{ reservationId: 'reserve-1' }],
      alerts: [
        { metric: 'tokens', thresholdPercent: 50 },
        { metric: 'estimated-cost-micros', thresholdPercent: 50 },
      ],
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.activeReservations)).toBe(true)

    const afterThreshold = reserveBudget(request({
      activeReservations: [{ reservationId: 'reserve-1', tokenReserve: 15, estimatedCostMicrosReserve: 150 }],
      reservation: { reservationId: 'reserve-2', tokenReserve: 1, estimatedCostMicrosReserve: 1 },
    }))
    expect(afterThreshold.alerts).toEqual([])
  })

  it('blocks a reservation that would exceed a hard limit and exposes the selected stop behavior', () => {
    expect(reserveBudget(request({ reservation: { reservationId: 'too-many', tokenReserve: 61, estimatedCostMicrosReserve: 1 } })))
      .toMatchObject({ kind: 'blocked', action: 'block-new', blockReasons: ['hard-limit'], activeReservations: [] })
    expect(reserveBudget(request({
      policy: { tokenLimit: 100, alertPercentages: [], stopBehavior: 'interrupt-running' },
      usage: { totalTokens: 100 }, reservation: { reservationId: 'over', tokenReserve: 1, estimatedCostMicrosReserve: 0 },
    }))).toMatchObject({ kind: 'blocked', action: 'interrupt-running', blockReasons: ['hard-limit'] })
  })

  it('fails closed when a configured metric has unknown usage, but permits a policy without limits', () => {
    expect(reserveBudget(request({ usage: { estimatedCostMicros: 100 } })))
      .toMatchObject({ kind: 'blocked', action: 'block-new', blockReasons: ['usage-unknown'] })
    expect(reserveBudget(request({
      policy: { alertPercentages: [], stopBehavior: 'block-new' }, usage: {}, reservation: { reservationId: 'unlimited', tokenReserve: 999, estimatedCostMicrosReserve: 0 },
    }))).toMatchObject({ kind: 'reserved', action: 'allow' })
  })

  it('makes a matching reservation idempotent and rejects a conflicting reuse', () => {
    const active = [{ reservationId: 'reserve-1', tokenReserve: 15, estimatedCostMicrosReserve: 150 }]
    expect(reserveBudget(request({ activeReservations: active }))).toMatchObject({ kind: 'idempotent', action: 'allow', alerts: [], activeReservations: active })
    expect(() => reserveBudget(request({ activeReservations: active, reservation: { reservationId: 'reserve-1', tokenReserve: 16, estimatedCostMicrosReserve: 150 } })))
      .toThrow(expect.objectContaining({ code: 'BUDGET_RESERVATION_CONFLICT' }))
  })

  it('rejects malformed policy and reservation ledgers instead of inventing missing budget data', () => {
    expect(() => reserveBudget(request({ policy: { alertPercentages: [50], stopBehavior: 'block-new' } }))).toThrow()
    expect(() => reserveBudget(request({ policy: { tokenLimit: 100, alertPercentages: [50, 50], stopBehavior: 'block-new' } }))).toThrow()
    expect(() => reserveBudget(request({ reservation: { reservationId: 'empty' } as unknown as BudgetReservationRequest['reservation'] }))).toThrow()
    expect(() => reserveBudget(request({ activeReservations: [
      { reservationId: 'same', tokenReserve: 1 }, { reservationId: 'same', tokenReserve: 2 },
    ] as unknown as BudgetReservationRequest['activeReservations'] }))).toThrow(expect.objectContaining({ code: 'DUPLICATE_ACTIVE_RESERVATION' }))
  })
})
