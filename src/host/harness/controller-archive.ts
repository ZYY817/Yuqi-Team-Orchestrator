/** Non-destructive cleanup for legacy controllers misclassified as subagents. */

import { replayTeamEvents } from '../../domain/projection.ts'
import { TEAM_SESSION_EVENT } from './session-journal.ts'

export interface ArchiveSessionPort {
  archiveSession(sessionId: string): Promise<void>
}

export interface ControllerArchivePersistence {
  list(signal?: AbortSignal): Promise<readonly ControllerArchiveHeader[]>
  inspect(sessionId: string, signal?: AbortSignal): Promise<{ readonly events: readonly ControllerArchiveEvent[] }>
}

export interface ControllerArchiveSessions {
  get?(sessionId: string): unknown
}

export interface ControllerArchiveHeader {
  readonly id: string
  readonly parentSession?: string | undefined
  readonly origin?: 'subagent' | undefined
}

export interface ControllerArchiveEvent {
  readonly type: string
  readonly data: unknown
}

/**
 * Explicit maintenance helper for proven terminal pre-fix controllers. It is
 * intentionally not run while the plugin starts: merely loading an optional
 * plugin must never hide native Sessions based on a heuristic.
 */
export async function archiveObsoleteYuqiControllers(
  registry: ArchiveSessionPort,
  persistence: ControllerArchivePersistence,
  sessions: ControllerArchiveSessions,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  signal?.throwIfAborted()
  const archived: string[] = []
  for (const header of await persistence.list(signal)) {
    signal?.throwIfAborted()
    // Maintenance must be fail-closed too: a caller that cannot inspect the
    // live Session directory cannot prove this transcript is inactive.
    if (!isLegacyController(header) || sessions.get === undefined || sessions.get(header.id) !== undefined) continue
    let inspection: { readonly events: readonly ControllerArchiveEvent[] }
    try {
      inspection = await persistence.inspect(header.id, signal)
    } catch {
      continue
    }
    if (!isSafeToArchive(inspection.events)) continue
    try {
      await registry.archiveSession(header.id)
      archived.push(header.id)
    } catch {
      // An archive failure must not prevent Host startup or turn a retained
      // transcript into a destructive cleanup candidate.
    }
  }
  return Object.freeze(archived)
}

/**
 * Terminal organizer for both current orchestrator controllers and legacy
 * misclassified ones. The caller must supply the Harness archive capability;
 * this helper never infers ownership from a header alone.
 */
export async function archiveTerminalYuqiControllers(
  registry: ArchiveSessionPort,
  persistence: ControllerArchivePersistence,
  sessions: ControllerArchiveSessions,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  signal?.throwIfAborted()
  const archived: string[] = []
  for (const header of await persistence.list(signal)) {
    signal?.throwIfAborted()
    if (!isYuqiController(header) || sessions.get === undefined || sessions.get(header.id) !== undefined) continue
    try {
      const inspection = await persistence.inspect(header.id, signal)
      if (!isSafeToArchive(inspection.events)) continue
      await registry.archiveSession(header.id)
      archived.push(header.id)
    } catch {
      // Retention is always safer than hiding an unproven or failed archive.
    }
  }
  return Object.freeze(archived)
}

export function isLegacyController(header: ControllerArchiveHeader): boolean {
  return /^yuqi-team-[A-Za-z0-9-]{1,128}$/u.test(header.id)
    && header.parentSession !== undefined
    && header.origin === 'subagent'
}

export function isYuqiController(header: ControllerArchiveHeader): boolean {
  return /^yuqi-team-[A-Za-z0-9-]{1,128}$/u.test(header.id)
    && header.parentSession !== undefined
    && (header.origin === undefined || header.origin === 'subagent')
}

function isSafeToArchive(events: readonly ControllerArchiveEvent[]): boolean {
  const teamEvents = events.flatMap(entry => {
    if (entry.type !== TEAM_SESSION_EVENT || typeof entry.data !== 'object' || entry.data === null) return []
    const data = entry.data as { readonly event?: unknown; readonly events?: unknown }
    return data.event === undefined ? (Array.isArray(data.events) ? data.events : []) : [data.event]
  })
  // A header alone cannot prove Yuqi ownership. Preserve it for the native
  // session directory and archive only an independently proven terminal Team.
  if (teamEvents.length === 0) return false
  try {
    const status = replayTeamEvents(teamEvents).team.status
    return status === 'completed' || status === 'failed' || status === 'cancelled'
  } catch {
    return false
  }
}
