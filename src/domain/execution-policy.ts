/** Durable execution-policy vocabulary shared by scheduling and Host adapters. */

import { z } from 'zod'

export const directWriteStrategySchema = z.enum([
  'planned-scope-parallel',
  'strict-writer-serial',
])

export type DirectWriteStrategy = z.output<typeof directWriteStrategySchema>

/** Compatibility default: planned file scopes coordinate writers but are not a sandbox. */
export const DEFAULT_DIRECT_WRITE_STRATEGY: DirectWriteStrategy = 'planned-scope-parallel'

export function parseDirectWriteStrategy(value: unknown): DirectWriteStrategy {
  return directWriteStrategySchema.parse(value ?? DEFAULT_DIRECT_WRITE_STRATEGY)
}
