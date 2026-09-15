/** Public Harness Session Projection registration for the Yuqi Client surface. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type {} from '../../application/session-projection.ts'
import type { TeamEvent } from '../../domain/events.ts'
import { applyTeamEvent, replayTeamEvents } from '../../domain/projection.ts'
import type { TeamProjection } from '../../domain/projection.ts'
import { taskRevisionBatchIssue } from '../../domain/task-revision.ts'
import { summarizeTeamForConsole, teamConsoleSummarySchema } from '../../application/team-console-summary.ts'
import type { ProjectSummary } from '../../application/project-summary.ts'
import type { ReviewResult } from '../../application/reviewer.ts'
import {
  PROJECT_SUMMARY_SESSION_EVENT,
  REVIEW_SESSION_EVENT,
  TEAM_PARENT_DETACHED_EVENT,
  TEAM_PARENT_PROJECTION_EVENT,
  TEAM_SESSION_EVENT,
  applyTeamBridgeActivation,
  emptyTeamBridgeActivationState,
  parseTeamProjectionBridgeData,
  parseTeamParentDetachedData,
  readActiveTeamParentBinding,
  parseTeamSessionEventData,
  syncTeamProjectionToParent,
  type TeamBridgeActivationState,
} from './session-journal.ts'
import { projectSummarySchema } from '../../application/project-summary.ts'
import { reviewResultSchema } from '../../application/reviewer.ts'
import { harnessSessionAccess, requireHarnessSessionStore } from './session-store-adapter.ts'

interface TeamProjectionState {
  readonly projection?: TeamProjection | undefined
  readonly controllerSessionId?: string
  readonly sourceEventCount: number
  readonly projectSummary?: ProjectSummary
  readonly review?: ReviewResult
  readonly bridgeActivation?: TeamBridgeActivationState
}

type YuqiTeamProjectionDefinition = Omit<
  ProjectionDefinition<'yuqiTeam', TeamProjectionState | undefined>,
  'wire'
> & {
  readonly wire: NonNullable<ProjectionDefinition<'yuqiTeam', TeamProjectionState | undefined>['wire']>
  /** Harness 0.1.1+ flattened the wire projection contract at runtime. */
  readonly schema: ReturnType<typeof teamConsoleSummarySchema.nullable>
  readonly view: (state: TeamProjectionState | undefined) => ReturnType<typeof summarizeTeamForConsole> | null
}

/** Pure definition kept separately testable from Cordis lifecycle wiring. */
export function createTeamSessionProjection(): YuqiTeamProjectionDefinition {
  const view = (state: TeamProjectionState | undefined) => state?.projection === undefined
    ? null
    : summarizeTeamForConsole(state.projection, {
        ...(state.controllerSessionId === undefined ? {} : { controllerSessionId: state.controllerSessionId }),
        ...(state.projectSummary === undefined ? {} : { projectSummary: state.projectSummary }),
        ...(state.review === undefined ? {} : { review: state.review }),
      })
  return {
    key: 'yuqiTeam',
    stateSchema: z.custom<TeamProjectionState | undefined>(state => {
      if (state === undefined) return true
      if (typeof state !== 'object' || state === null) return false
      try {
        const projection = (state as TeamProjectionState).projection
        if (projection !== undefined && taskRevisionBatchIssue(projection) !== undefined) return false
        teamConsoleSummarySchema.nullable().parse(view(state as TeamProjectionState))
        return true
      } catch {
        return false
      }
    }),
    init: () => undefined,
    apply: (state, event) => {
      if (event.type === TEAM_SESSION_EVENT) {
        const events = parseTeamSessionEventData(event.data)
        if (events === undefined) return state
        return applyTeamFacts(state, events)
      }
      if (event.type === PROJECT_SUMMARY_SESSION_EVENT) {
        const parsed = projectSummarySchema.safeParse(
          typeof event.data === 'object' && event.data !== null ? Reflect.get(event.data, 'summary') : undefined,
        )
        if (!parsed.success) return state
        return {
          ...(state ?? { sourceEventCount: 0 }),
          projectSummary: parsed.data,
        }
      }
      if (event.type === REVIEW_SESSION_EVENT) {
        const parsed = reviewResultSchema.safeParse(
          typeof event.data === 'object' && event.data !== null ? Reflect.get(event.data, 'result') : undefined,
        )
        if (!parsed.success) return state
        return {
          ...(state ?? { sourceEventCount: 0 }),
          review: parsed.data,
        }
      }
      if (event.type === TEAM_PARENT_PROJECTION_EVENT) {
        const bridge = parseTeamProjectionBridgeData(event.data)
        return bridge === undefined ? state : applyParentBridge(state, bridge)
      }
      if (event.type === TEAM_PARENT_DETACHED_EVENT) {
        const detached = parseTeamParentDetachedData(event.data)
        if (detached === undefined || state?.controllerSessionId !== detached.controllerSessionId) return state
        const activeGeneration = state.bridgeActivation?.activeBridge?.bindingGeneration ?? 0
        if (detached.bindingGeneration < activeGeneration) return state
        const bridgeActivation = state.bridgeActivation === undefined
          ? emptyTeamBridgeActivationState()
          : removeActiveBridge(state.bridgeActivation)
        return {
          sourceEventCount: 0,
          bridgeActivation,
        }
      }
      return state
    },
    wire: {
      viewSchema: teamConsoleSummarySchema.nullable(),
      view,
    },
    // Keep both shapes while the public rc.2 typings still expose
    // `stateSchema + wire`. Newer Hosts call these top-level fields.
    schema: teamConsoleSummarySchema.nullable(),
    view,
    stateVersion: 5,
  }
}

function applyTeamFacts(state: TeamProjectionState | undefined, events: readonly TeamEvent[]): TeamProjectionState | undefined {
  /* v8 ignore next -- parseTeamSessionEventData guarantees a non-empty event batch. */
  if (events.length === 0) return state
  try {
    const [first, ...rest] = events
    let projection = applyTeamEvent(state?.projection, first!)
    for (const event of rest) projection = applyTeamEvent(projection, event)
    // Publication boundary is the complete Session envelope, just as journal
    // replay validates the complete durable transaction. Never publish its prefix.
    if (taskRevisionBatchIssue(projection) !== undefined) return state
    return {
      ...(state?.controllerSessionId === undefined ? {} : { controllerSessionId: state.controllerSessionId }),
      sourceEventCount: teamEventCount(projection),
      projection,
      ...(state?.projectSummary === undefined ? {} : { projectSummary: state.projectSummary }),
      ...(state?.review === undefined ? {} : { review: state.review }),
      ...(state?.bridgeActivation === undefined ? {} : { bridgeActivation: state.bridgeActivation }),
    }
  } catch {
    return state
  }
}

function applyParentBridge(
  state: TeamProjectionState | undefined,
  bridge: {
    readonly controllerSessionId: string
    readonly sourceEventCount: number
    readonly events: readonly TeamEvent[]
    readonly projectSummary?: ProjectSummary
    readonly review?: ReviewResult
  },
): TeamProjectionState | undefined {
  /* v8 ignore next -- the bridge schema proves these envelope invariants. */
  if (!Number.isSafeInteger(bridge.sourceEventCount) || bridge.sourceEventCount < 1 || bridge.controllerSessionId.length === 0) return state
  const previousActivation = state?.bridgeActivation ?? emptyTeamBridgeActivationState()
  const knownBefore = previousActivation.activationGenerations[bridge.controllerSessionId]
  const bridgeActivation = applyTeamBridgeActivation(previousActivation, bridge)
  if (bridgeActivation.activeBridge !== bridge) {
    if (bridgeActivation === previousActivation) return state
    return knownBefore === undefined && state !== undefined ? { ...state, bridgeActivation } : state
  }
  let projection: TeamProjection
  try {
    projection = replayTeamEvents(bridge.events)
  /* v8 ignore next -- parseTeamProjectionBridgeData already replays this exact cut. */
  } catch {
    return state
  }
  return {
    projection,
    controllerSessionId: bridge.controllerSessionId,
    sourceEventCount: bridge.sourceEventCount,
    bridgeActivation,
    ...(bridge.projectSummary === undefined ? {} : { projectSummary: bridge.projectSummary }),
    ...(bridge.review === undefined ? {} : { review: bridge.review }),
  }
}

function teamEventCount(projection: TeamProjection): number {
  return Object.keys(projection.appliedEventFingerprints).length
}

function removeActiveBridge(state: TeamBridgeActivationState): TeamBridgeActivationState {
  const { activeBridge: _activeBridge, ...inactiveState } = state
  return inactiveState
}

/** Register only when Harness composes the optional projection service. */
export function registerTeamSessionProjection(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(createTeamSessionProjection())
    const access = harnessSessionAccess(projectionCtx)
    const sessions = requireHarnessSessionStore(projectionCtx)
    // A restored controller can already contain a complete Team stream before
    // any new journal commit occurs. Seed the parent-derived index at the public
    // Session lifecycle boundary so existing Teams recover after restart/cold load.
    const sync = (session: Session): void => {
      void syncTeamProjectionToParent(session, sessions).catch(() => false)
    }
    for (const session of access.list?.() ?? []) sync(session)
    // Parent/controller Sessions may be hydrated by a sibling Host scope after
    // this projection plugin starts. Listen globally or their durable Team
    // bridge will never be rebuilt until another Team event happens.
    projectionCtx.on('session/created', session => {
      sync(session)
      for (const candidate of access.list?.() ?? []) {
        const binding = readActiveTeamParentBinding(candidate)
        if (binding?.parentSessionId === String(session.id) || binding?.previousParentSessionId === String(session.id)) sync(candidate)
      }
    }, { global: true })
  })
}
