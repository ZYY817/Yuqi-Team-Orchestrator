/** Non-secret budget and conservative reservation values. */

import { z } from 'zod'

const nonNegativeInteger = z.number().int().nonnegative().finite()
const positiveInteger = z.number().int().positive().finite()
const reservationId = z.string().trim().min(1)

/** A hard limit may be configured for known Token usage or a configured cost estimate. */
export const budgetPolicySchema = z.object({
  tokenLimit: positiveInteger.optional(),
  estimatedCostMicrosLimit: positiveInteger.optional(),
  /** Soft thresholds are percentages of each configured hard limit. */
  alertPercentages: z.array(z.number().int().min(1).max(99)).default([]),
  /** Hard-limit behavior.  Execution integration decides how to carry it out safely. */
  stopBehavior: z.enum(['block-new', 'interrupt-running']).default('block-new'),
}).strict().superRefine((value, context) => {
  if (value.tokenLimit === undefined && value.estimatedCostMicrosLimit === undefined && value.alertPercentages.length > 0) {
    context.addIssue({ code: 'custom', message: 'alert thresholds require at least one hard budget limit' })
  }
  if (new Set(value.alertPercentages).size !== value.alertPercentages.length) {
    context.addIssue({ code: 'custom', message: 'alert thresholds must be unique' })
  }
})

/** Unknown usage stays absent; absent must never be treated as zero. */
export const budgetUsageSchema = z.object({
  totalTokens: nonNegativeInteger.optional(),
  estimatedCostMicros: nonNegativeInteger.optional(),
}).strict()

/** A conservative amount held before a new model request starts. */
export const budgetReservationSchema = z.object({
  reservationId,
  tokenReserve: nonNegativeInteger.default(0),
  estimatedCostMicrosReserve: nonNegativeInteger.default(0),
}).strict().superRefine((value, context) => {
  if (value.tokenReserve === 0 && value.estimatedCostMicrosReserve === 0) {
    context.addIssue({ code: 'custom', message: 'a reservation must reserve at least one budget unit' })
  }
})

export const budgetReservationRequestSchema = z.object({
  policy: budgetPolicySchema,
  usage: budgetUsageSchema,
  activeReservations: z.array(budgetReservationSchema),
  reservation: budgetReservationSchema,
}).strict()

/** Durable token usage carried by a reservation settlement. */
export const budgetTokenUsageSchema = z.object({
  totalTokens: nonNegativeInteger,
}).strict()

export const budgetReservationSettlementStatusSchema = z.enum(['known', 'not-admitted', 'unknown'])

export type BudgetReservationSettlementStatus = z.output<typeof budgetReservationSettlementStatusSchema>

/** Durable policy state projected from the Controller journal. */
export interface BudgetPolicyView {
  readonly revision: number
  readonly operationId: string
  readonly tokenLimit: number
  readonly alerts: readonly number[]
  readonly stopBehavior: 'block-new'
}

/** One attempt-scoped reservation and its fail-closed settlement state. */
export interface BudgetReservationView {
  readonly reservationId: string
  readonly taskId: string
  readonly attemptId: string
  readonly tokenReserve: number
  readonly status: 'active' | BudgetReservationSettlementStatus
  readonly usage?: Readonly<z.output<typeof budgetTokenUsageSchema>>
  readonly reason?: string
}

/** Fail-closed token admission assessment used by durable batch preparation. */
export function assessTokenReservation(input: {
  readonly tokenLimit: number
  readonly usageKnown: boolean
  readonly usedTokens: number
  readonly activeReservedTokens: number
  readonly requestedTokens: number
}): 'allow' | 'usage-unknown' | 'hard-limit' {
  if (!Number.isInteger(input.requestedTokens) || input.requestedTokens <= 0) return 'hard-limit'
  if (!input.usageKnown) return 'usage-unknown'
  return input.usedTokens + input.activeReservedTokens + input.requestedTokens > input.tokenLimit
    ? 'hard-limit'
    : 'allow'
}

export type BudgetPolicy = Readonly<z.output<typeof budgetPolicySchema>>
export type BudgetUsage = Readonly<z.output<typeof budgetUsageSchema>>
export type BudgetReservation = Readonly<z.output<typeof budgetReservationSchema>>
export type BudgetReservationRequest = Readonly<z.output<typeof budgetReservationRequestSchema>>
