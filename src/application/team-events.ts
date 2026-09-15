/** Shared construction and validation for application-authored Team events. */

import { TeamEventId, TeamId } from '../domain/ids.ts'
import { applyTeamEvent, parseTeamEvent, replayTeamEvents } from '../domain/projection.ts'
import type { TeamProjection } from '../domain/projection.ts'
import type { TeamEvent } from '../domain/events.ts'
import type { Clock, EventIdSource } from './ports.ts'
import { taskRevisionBatchIssue } from '../domain/task-revision.ts'
import { YuqiOrchestratorError } from './errors.ts'

export type TeamEventBody = TeamEvent extends infer Event
  ? Event extends TeamEvent
    ? Omit<Event, 'schemaVersion' | 'eventId' | 'teamId' | 'occurredAt'>
    : never
  : never

/** Create one schema-v1 event through the application clock and id seams. */
export function createTeamEvent(
  clock: Clock,
  eventIds: EventIdSource,
  teamId: string,
  body: TeamEventBody,
): TeamEvent {
  return parseTeamEvent({
    schemaVersion: 1,
    eventId: TeamEventId(eventIds.next()),
    teamId: TeamId(teamId),
    occurredAt: clock.nowIso(),
    ...body,
  })
}

/** Apply a proposed transaction without mutating its source projection. */
export function applyTeamEventBatch(projection: TeamProjection, events: readonly TeamEvent[]): TeamProjection {
  let next = projection
  for (const event of events) next = applyTeamEvent(next, event)
  const revisionIssue = taskRevisionBatchIssue(next)
  if (revisionIssue !== undefined) throw new YuqiOrchestratorError('INVALID_BATCH', revisionIssue)
  return next
}

/** Replay persisted inputs and validate a proposed transaction against them. */
export function validateTeamEvents(inputs: readonly unknown[], events: readonly TeamEvent[]): TeamProjection {
  return applyTeamEventBatch(replayTeamEvents(inputs), events)
}
