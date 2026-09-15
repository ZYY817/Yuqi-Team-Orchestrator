import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * A controller restored only in the host bridge is not necessarily present in
 * the native subagent index. In that narrow case, route only to one root
 * session whose projected Team identity matches both requested IDs.
 */
function projectedRootParent(sessions: ClientContext['sessions'], controllerId: string, teamId: string | undefined): SessionId | undefined {
  if (!teamId) return undefined
  const rows = sessions.list.getSnapshot().byId as Record<string, unknown>
  const matches = Object.entries(rows).filter(([id, row]) => {
    const candidate = row as { parentId?: unknown; origin?: unknown; projectionValues?: unknown }
    if (candidate.parentId !== undefined || candidate.origin === 'subagent' || sessions.subagentAddress(id as SessionId) !== undefined) return false
    const team = (candidate.projectionValues as { yuqiTeam?: unknown } | undefined)?.yuqiTeam as {
      controllerSessionId?: unknown; team?: { id?: unknown }
    } | undefined
    return team?.controllerSessionId === controllerId && team.team?.id === teamId
  })
  return matches.length === 1 ? matches[0]?.[0] as SessionId : undefined
}

/** Same native address checks as management navigation, but return the user parent. */
export async function resolveTeamParentSession(sessions: ClientContext['sessions'], controllerId: string, teamId?: string): Promise<SessionId | undefined> {
  const id = controllerId as SessionId
  try {
    const row = sessions.list.getSnapshot().byId[id]
    let address = sessions.subagentAddress(id)
    const child = row?.parentId !== undefined || row?.origin === 'subagent' || controllerId.startsWith('yuqi-team-') || address !== undefined
    if (!child) return row === undefined ? undefined : id // Legacy root controller.
    if (address === undefined && row?.parentId !== undefined) {
      await sessions.refreshSubagents(row.parentId)
      address = sessions.subagentAddress(id)
    }
    // A cold-restored controller can be absent from the native index. Its
    // parent is recoverable only from an exact Team projection, never by a
    // current-tab or controller-name heuristic.
    if (address === undefined) return projectedRootParent(sessions, controllerId, teamId)
    if (address.childSessionId !== id || address.parentSessionId === id
      || (row?.parentId !== undefined && address.parentSessionId !== row.parentId)) return undefined
    const current = sessions.list.getSnapshot().byId[id]
    if (current?.parentId !== row?.parentId) return undefined
    const parent = sessions.list.getSnapshot().byId[address.parentSessionId]
    // The tool must run in the actual user parent, not another background child.
    if (parent === undefined || parent.origin === 'subagent' || parent.parentId !== undefined
      || sessions.subagentAddress(address.parentSessionId) !== undefined) return undefined
    return address.parentSessionId
  } catch { return undefined }
}

/** Prefer a verified native parent, then ask the Host to resolve cold bindings. */
export async function resolveTeamParentWithFallback(
  sessions: ClientContext['sessions'],
  controllerId: string,
  teamId: string,
  resolveColdParent: () => Promise<string>,
): Promise<string> {
  return (await resolveTeamParentSession(sessions, controllerId, teamId))
    ?? await resolveColdParent()
}
