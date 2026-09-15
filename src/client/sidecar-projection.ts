import { z } from 'zod'
import type { TeamSidecarEvent } from '../domain/team-sidecar-web-contract.ts'
import { teamEventSchema } from '../domain/events.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import { summarizeTeamForConsole } from '../application/team-console-summary.ts'
import { projectSummarySchema } from '../application/project-summary.ts'
import { reviewResultSchema } from '../application/reviewer.ts'

const facts = z.union([z.object({ event: teamEventSchema }).strict(), z.object({ events: z.array(teamEventSchema).min(1) }).strict()])
const bridgeSchema = z.object({
  controllerSessionId: z.string().min(1), sourceEventCount: z.number().int().positive(),
  events: z.array(teamEventSchema).min(1), projectSummary: projectSummarySchema.optional(), review: reviewResultSchema.optional(),
  bindingGeneration: z.number().int().nonnegative().optional(), activationOrdinal: z.string().optional(),
  activationGeneration: z.number().int().positive().optional(), bridgeRevision: z.number().int().positive().optional(),
}).strict().refine(value => value.events.length === value.sourceEventCount)
type Bridge = z.infer<typeof bridgeSchema>

/** Browser-only replay. Invalid known facts fail the query rather than retaining actionable state. */
export function reduceSidecarSession(sessionId: string, events: readonly TeamSidecarEvent[]) {
  let teamEvents: z.infer<typeof teamEventSchema>[] = []
  let projectSummary: z.infer<typeof projectSummarySchema> | undefined
  let review: z.infer<typeof reviewResultSchema> | undefined
  let active: Bridge | undefined
  let controllerSessionId = sessionId
  const generations = new Map<string, number>()
  const detached = new Map<string, number>()
  let nextGeneration = 1
  for (const event of events) {
    switch (event.type) {
      case 'yuqi/team-event': {
        const parsed = facts.parse(event.data)
        teamEvents.push(...('event' in parsed ? [parsed.event] : parsed.events))
        break
      }
      case 'yuqi/project-summary':
        projectSummary = z.object({ summary: projectSummarySchema }).parse(event.data).summary
        break
      case 'yuqi/review-result':
        review = z.object({ result: reviewResultSchema }).parse(event.data).result
        break
      case 'yuqi/team-parent-detached': {
        const tombstone = z.object({ controllerSessionId: z.string(), bindingGeneration: z.number().int().positive() }).parse(event.data)
        detached.set(tombstone.controllerSessionId, Math.max(detached.get(tombstone.controllerSessionId) ?? -1, tombstone.bindingGeneration))
        if (active?.controllerSessionId === tombstone.controllerSessionId && tombstone.bindingGeneration >= (active.bindingGeneration ?? 0)) {
          active = undefined
          teamEvents = []
          projectSummary = undefined
          review = undefined
        }
        break
      }
      case 'yuqi/team-projection-bridge': {
        const candidate = bridgeSchema.parse(event.data)
        // Validate even a superseded cut: malformed known data is not a successful snapshot.
        replayTeamEvents(candidate.events)
        if ((detached.get(candidate.controllerSessionId) ?? -1) >= (candidate.bindingGeneration ?? 0)) break
        const known = generations.get(candidate.controllerSessionId)
        if (known === undefined && candidate.activationGeneration !== undefined && [...generations.values()].includes(candidate.activationGeneration)) break
        const generation = known ?? candidate.activationGeneration ?? nextGeneration
        generations.set(candidate.controllerSessionId, generation)
        nextGeneration = Math.max(nextGeneration, generation + 1)
        const newer = active === undefined || (active.controllerSessionId === candidate.controllerSessionId
          ? (candidate.bridgeRevision !== undefined || active.bridgeRevision !== undefined
            ? candidate.bridgeRevision !== undefined && (active.bridgeRevision === undefined || candidate.bridgeRevision > active.bridgeRevision)
            : candidate.sourceEventCount >= active.sourceEventCount)
          : candidate.activationOrdinal !== undefined
            ? active.activationOrdinal === undefined || candidate.activationOrdinal > active.activationOrdinal
            : active.activationOrdinal === undefined && generation > generations.get(active.controllerSessionId)!)
        if (!newer) break
        active = candidate
        controllerSessionId = candidate.controllerSessionId
        teamEvents = [...candidate.events]
        projectSummary = candidate.projectSummary
        review = candidate.review
        break
      }
    }
  }
  if (teamEvents.length === 0) return undefined
  return summarizeTeamForConsole(replayTeamEvents(teamEvents), {
    controllerSessionId,
    ...(projectSummary === undefined ? {} : { projectSummary }),
    ...(review === undefined ? {} : { review }),
  })
}
