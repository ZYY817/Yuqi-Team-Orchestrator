import { z } from 'zod'

export const TEAM_INSTRUCTION_EVENT = 'yuqi/team-instruction' as const
export const teamInstructionSchema = z.object({
  operationId: z.string(), teamId: z.string(), controllerSessionId: z.string(),
  authorSessionId: z.string(), target: z.string(), text: z.string(), createdAt: z.string(),
  recipients: z.array(z.object({
    taskId: z.string(), goal: z.string(), childSessionId: z.string().optional(),
    status: z.enum(['sending', 'accepted', 'failed', 'unknown']),
    messageId: z.string().optional(), detail: z.string().optional(),
  })),
})
export type TeamInstruction = z.infer<typeof teamInstructionSchema>

/** Last durable revision per request; never infer reply causality from ordering. */
export function readTeamInstructions(events: readonly { type: string; data: unknown }[]): TeamInstruction[] {
  const records = new Map<string, TeamInstruction>()
  for (const event of events) {
    if (event.type !== TEAM_INSTRUCTION_EVENT) continue
    const parsed = teamInstructionSchema.safeParse(event.data)
    if (parsed.success) records.set(parsed.data.operationId, parsed.data)
  }
  return [...records.values()]
}
