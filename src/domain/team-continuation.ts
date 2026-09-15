/** Immutable link between independently scheduled Teams; not inherited execution authority. */
import { z } from 'zod'

export const teamContinuationSchema = z.object({
  sourceTeamId: z.string().trim().min(1),
  sourceControllerSessionId: z.string().trim().min(1),
  sourceEventId: z.string().trim().min(1),
  operationId: z.string().trim().min(1).max(160),
  sourceSummary: z.string().max(2000).optional(),
}).strict()
export type TeamContinuation = z.output<typeof teamContinuationSchema>

export interface TeamFollowupOperation {
  readonly requestDigest: string
  readonly parentSessionId: string
  readonly targetTeamId?: string
  readonly targetControllerSessionId?: string
}
