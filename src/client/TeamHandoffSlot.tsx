import { sessionPreset } from './session-preset.ts'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TeamHandoffButton } from './TeamHandoffButton.tsx'
import type { CreateTeamHandoff } from './team-handoff.ts'
import { useSyncExternalStore } from 'react'
import type { TeamCatalogFace } from './sidecar-store.ts'
const noSubscribe = () => () => {}

export interface TeamHandoffInjected {
  readonly catalog?: TeamCatalogFace
  readonly dataReady?: () => boolean
  readonly createHandoff: CreateTeamHandoff
  readonly openTarget: (sessionId: string) => Promise<boolean>
}

export function TeamHandoffSlot({ sessionId, useSessions, catalog, dataReady, createHandoff, openTarget }:
  PropsRuntime<'conversation.session.header.actions'> & TeamHandoffInjected) {
  const native = useSessions(state => state)
  const state = useSyncExternalStore(catalog?.subscribe ?? noSubscribe, catalog?.getSnapshot ?? (() => native), () => native)
  const row = state.byId[sessionId]
  if (row === undefined || dataReady?.() === false) return null
  return <TeamHandoffButton source={{
    sessionId: String(sessionId), cwd: row.cwd ?? '',
    parentSessionId: row.origin === 'subagent' ? row.parentId : undefined, agentPreset: sessionPreset(row),
    isTeam: row.projectionValues?.yuqiTeam != null || row.origin === 'subagent',
    isIdle: !row.running,
  }} createHandoff={createHandoff} openTarget={openTarget} />
}
