import { sessionPreset } from './session-preset.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from './projection-types.ts'
import { useYuqiLocale } from './client-locale.ts'
import { useSyncExternalStore } from 'react'
import type { TeamCatalogFace } from './sidecar-store.ts'
const noSubscribe = () => () => {}

export interface TeamReturnButtonInjected {
  readonly catalog?: TeamCatalogFace
  readonly openSession: (sessionId: SessionId) => void
}

export type TeamReturnButtonProps = PropsRuntime<'conversation.session.header.actions'> & TeamReturnButtonInjected

interface SessionRouteNode {
  readonly id: SessionId
  readonly parentId?: SessionId
  readonly agentPreset?: string
  readonly projectionValues?: {
      readonly yuqiTeam?: {
      readonly tasks?: readonly { readonly childSessionId?: string | undefined }[]
    } | null
  }
}

type SessionRouteMap =
  | Readonly<Record<SessionId, SessionRouteNode | undefined>>
  | Readonly<Record<string, SessionRouteNode | undefined>>

/** Find the visible Team root without depending on the hidden controller's body. */
export function findTeamRootSessionId(sessionId: SessionId, byId: SessionRouteMap): SessionId | undefined {
  const seen = new Set<SessionId>()
  let cursor = routeAt(byId, sessionId)
  const ancestry: SessionId[] = []
  while (cursor?.parentId !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    ancestry.push(cursor.parentId)
    cursor = routeAt(byId, cursor.parentId)
  }
  if (cursor === undefined) return findProjectedTeamRoot(sessionId, byId)
  if (cursor.id === sessionId) return findProjectedTeamRoot(sessionId, byId)
  // New Hosts retain preset projections on list rows; legacy Hosts use metadata.
  return sessionPreset(cursor) === 'yuqi-team' && ancestry.length > 0
    ? cursor.id
    : findProjectedTeamRoot(sessionId, byId)
}

function routeAt(byId: SessionRouteMap, id: SessionId): SessionRouteNode | undefined {
  return Reflect.get(byId, id) as SessionRouteNode | undefined
}

/**
 * Terminal controllers may be archived after their durable Team settles. The
 * native list then no longer contains the middle lineage node, but the visible
 * Team parent still carries the child id in its durable Projection. Use that
 * fact as the reload-safe fallback instead of retaining an in-memory route.
 */
function findProjectedTeamRoot(sessionId: SessionId, byId: SessionRouteMap): SessionId | undefined {
  for (const row of Object.values(byId)) {
    const tasks = row?.projectionValues?.yuqiTeam?.tasks
    if (row !== undefined && tasks?.some(task => task.childSessionId === String(sessionId)) === true) return row.id
  }
  return undefined
}

/** Escape a worker -> hidden controller route back to the visible Team chat. */
export function TeamReturnButton({ sessionId, useSessions, catalog, openSession }: TeamReturnButtonProps) {
  const en = useYuqiLocale() === 'en'
  const native = useSessions(state => state)
  const state = useSyncExternalStore(catalog?.subscribe ?? noSubscribe, catalog?.getSnapshot ?? (() => native), () => native)
  const target = findTeamRootSessionId(sessionId, state.byId)
  if (target === undefined) return null
  return <button type="button" className="yuqi-return-main" onClick={() => openSession(target)}>{en ? 'Back to Team controller' : '返回 Team 主对话'}</button>
}
