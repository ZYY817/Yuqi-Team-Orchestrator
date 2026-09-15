/** Harness Session adapter for the Team-event journal port. */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { teamEventSchema, type TeamEvent } from '../../domain/events.ts'
import { replayTeamEvents } from '../../domain/projection.ts'
import type { TeamEventJournal } from '../../application/ports.ts'
import { projectSummarySchema, type ProjectSummary } from '../../application/project-summary.ts'
import { reviewResultSchema, type ReviewResult } from '../../application/reviewer.ts'
import type { HarnessSessionStore } from './session-store-adapter.ts'
import { appendCompatibleYuqiSessionEvent, assertYuqiSessionEventCompatibility as assertNativeCompatibility } from './session-compatibility.ts'
import { readSessionEvents as readNativeSessionEvents } from './session-events.ts'
import { appendSidecarEvent, hasSidecarSession, readSidecarEvents } from '../storage/session-sidecar.ts'
import type { PersistedSessionSnapshot } from './session-restore.ts'

export function assertYuqiSessionEventCompatibility(session: Session): void {
  if (!hasSidecarSession(session)) assertNativeCompatibility(session)
}

/** Plugin facts come from exactly one source; never merge independent seq spaces. */
export function readYuqiSessionEvents(session: Session): readonly SessionEvent[] {
  return readSidecarEvents(session) ?? readNativeSessionEvents(session)
}
const readSessionEvents = readYuqiSessionEvents

export type { HarnessSessionStore } from './session-store-adapter.ts'

/** Public non-surface Session event owned by this plugin. */
export const TEAM_SESSION_EVENT = 'yuqi/team-event' as const
/** Durable index event for the bounded project summary shown beside the Team. */
export const PROJECT_SUMMARY_SESSION_EVENT = 'yuqi/project-summary' as const
/** Durable index event for the bounded structured reviewer result. */
export const REVIEW_SESSION_EVENT = 'yuqi/review-result' as const
/** Durable parent-session bridge carrying a rebuildable controller event cut. */
export const TEAM_PARENT_PROJECTION_EVENT = 'yuqi/team-projection-bridge' as const
/** Durable controller-owned pointer to the parent Session currently allowed to control the Team. */
export const TEAM_PARENT_BINDING_EVENT = 'yuqi/team-parent-binding' as const
/** Parent-owned tombstone that removes a controller projection after a rebind. */
export const TEAM_PARENT_DETACHED_EVENT = 'yuqi/team-parent-detached' as const
/** Controller-owned proof that one exact parent report cut reached the durable parent inbox. */
export const TEAM_PARENT_REPORT_CHECKPOINT_EVENT = 'yuqi/team-parent-report-checkpoint' as const

export interface TeamParentBindingData {
  readonly parentSessionId: string
  readonly previousParentSessionId?: string
  readonly generation: number
  readonly operationId: string
  readonly boundAt: string
}

export interface TeamParentDetachedData {
  readonly controllerSessionId: string
  readonly bindingGeneration: number
}

export interface TeamProjectionBridgeData {
  readonly controllerSessionId: string
  /** Controller-owned parent-binding generation represented by this cut. */
  readonly bindingGeneration?: number
  /** Immutable controller creation order; retries and cold replay cannot change it. */
  readonly activationOrdinal?: string
  /** Monotonic activation order within one parent Session. */
  readonly activationGeneration?: number
  /** Monotonic cut revision for one controller, including summary/review changes. */
  readonly bridgeRevision?: number
  readonly sourceEventCount: number
  readonly events: readonly TeamEvent[]
  readonly projectSummary?: ProjectSummary
  readonly review?: ReviewResult
}

export interface TeamParentReportCheckpointData {
  readonly controllerSessionId: string
  readonly parentSessionId: string
  readonly bindingGeneration: number
  readonly sourceEventCount: number
  readonly messageId: string
  readonly deliveredAt: string
}

const teamSessionEventDataSchema = z.union([
  z.object({ event: teamEventSchema }).strict(),
  z.object({ events: z.array(teamEventSchema).min(1) }).strict(),
])
const projectSummarySessionEventDataSchema = z.object({ summary: projectSummarySchema }).strict()
const reviewSessionEventDataSchema = z.object({ result: reviewResultSchema }).strict()
const teamProjectionBridgeDataSchema = z.object({
  controllerSessionId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  bindingGeneration: z.number().int().nonnegative().optional(),
  activationOrdinal: z.string().regex(/^[0-9a-z]{10}-[0-9a-z]{4}$/u).optional(),
  activationGeneration: z.number().int().positive().optional(),
  bridgeRevision: z.number().int().positive().optional(),
  sourceEventCount: z.number().int().positive(),
  events: z.array(teamEventSchema).min(1),
  projectSummary: projectSummarySchema.optional(),
  review: reviewResultSchema.optional(),
}).strict().refine(value => value.sourceEventCount === value.events.length, {
  message: 'sourceEventCount must equal the bridged Team event count',
})
const teamParentBindingDataSchema = z.object({
  parentSessionId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  previousParentSessionId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u).optional(),
  generation: z.number().int().positive(),
  operationId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  boundAt: z.string().datetime({ offset: true }),
}).strict()
const teamParentDetachedDataSchema = z.object({
  controllerSessionId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  bindingGeneration: z.number().int().positive(),
}).strict()
const teamParentReportCheckpointDataSchema = z.object({
  controllerSessionId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  parentSessionId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  bindingGeneration: z.number().int().nonnegative(),
  sourceEventCount: z.number().int().positive(),
  messageId: z.string().trim().min(1).max(512),
  deliveredAt: z.string().datetime({ offset: true }),
}).strict()

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One versioned Yuqi Team fact; model content remains in child Sessions. */
    'yuqi/team-event': { event: TeamEvent } | { events: readonly TeamEvent[] }
    'yuqi/project-summary': { summary: ProjectSummary }
    'yuqi/review-result': { result: ReviewResult }
    'yuqi/team-projection-bridge': TeamProjectionBridgeData
    'yuqi/team-parent-binding': TeamParentBindingData
    'yuqi/team-parent-detached': TeamParentDetachedData
    'yuqi/team-parent-report-checkpoint': TeamParentReportCheckpointData
  }
}

/** Register every required Yuqi event before persistence attempts a cold load. */
export function registerYuqiSessionEventTypes(register: (type: string) => () => void): () => void {
  const disposers = [
    TEAM_SESSION_EVENT,
    PROJECT_SUMMARY_SESSION_EVENT,
    REVIEW_SESSION_EVENT,
    TEAM_PARENT_PROJECTION_EVENT,
    TEAM_PARENT_BINDING_EVENT,
    TEAM_PARENT_DETACHED_EVENT,
    TEAM_PARENT_REPORT_CHECKPOINT_EVENT,
  ].map(register)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * Legacy discovery registry retained for third-party integrations. Cold-load
 * compatibility is provided by the event envelope's `ignorable` marker, not
 * by mutating one package instance's private vocabulary Set.
 */
export function registerProcessSessionEventType(type: string): () => void {
  const key = Symbol.for('@deepseek-ai/dsh-session/downstream-event-types/v1')
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>
  const existing = globals[key]
  const registry: Set<string> = existing instanceof Set
    ? existing as Set<string>
    : new Set<string>()
  if (!(existing instanceof Set)) globals[key] = registry
  registry.add(type)

  // Discovery describes logs written by this process and intentionally lasts
  // for the process lifetime. It is not a persistence admission mechanism.
  return () => {}
}

type YuqiSessionEventType =
  | 'yuqi/team-instruction'
  | typeof TEAM_SESSION_EVENT
  | typeof PROJECT_SUMMARY_SESSION_EVENT
  | typeof REVIEW_SESSION_EVENT
  | typeof TEAM_PARENT_PROJECTION_EVENT
  | typeof TEAM_PARENT_BINDING_EVENT
  | typeof TEAM_PARENT_DETACHED_EVENT
  | typeof TEAM_PARENT_REPORT_CHECKPOINT_EVENT

/** Append plugin-owned state as a non-surface event that older Hosts may retain safely. */
export function appendYuqiSessionEvent(
  session: Session,
  type: YuqiSessionEventType,
  data: unknown,
): SessionEvent {
  return appendCompatibleYuqiSessionEvent(session, type, data)
}

/** Runtime durable write. The synchronous export above remains legacy-only. */
export async function commitYuqiSessionEvent(session: Session, type: YuqiSessionEventType, data: unknown): Promise<SessionEvent> {
  return hasSidecarSession(session)
    ? appendSidecarEvent(session, type, data)
    : appendYuqiSessionEvent(session, type, data)
}

/** Public persistence capability used only when the normal flush listener is absent. */
export interface HarnessSessionPersistence {
  load?(id: Session['id']): Promise<PersistedSessionSnapshot | undefined>
  create(meta: Session['header']): Promise<void>
  append(id: Session['id'], events: readonly SessionEvent[]): Promise<void>
  readFrom(id: Session['id'], fromSeq: number): Promise<{ readonly events: readonly SessionEvent[] }>
  list(): Promise<readonly Session['header'][]>
}

/** Read only the controller-owned Team facts from one durable Session. */
export function readTeamEventsFromSession(session: Session): readonly TeamEvent[] {
  const result = collectTeamEvents(session)
  // A partially trusted stream is more dangerous than an unavailable one:
  // callers must never mutate a projection reconstructed around a corrupt gap.
  return result.valid ? result.events : []
}

/** Runtime parser shared by journal reads and the incremental projection. */
export function parseTeamSessionEventData(value: unknown): readonly TeamEvent[] | undefined {
  const parsed = teamSessionEventDataSchema.safeParse(value)
  if (!parsed.success) return undefined
  return 'event' in parsed.data ? [parsed.data.event] : parsed.data.events
}

/** Runtime parser for the parent-session derived index. */
export function parseTeamProjectionBridgeData(value: unknown): TeamProjectionBridgeData | undefined {
  const parsed = teamProjectionBridgeDataSchema.safeParse(value)
  if (!parsed.success) return undefined
  try {
    replayTeamEvents(parsed.data.events)
  } catch {
    return undefined
  }
  return {
    controllerSessionId: parsed.data.controllerSessionId,
    ...(parsed.data.bindingGeneration === undefined ? {} : { bindingGeneration: parsed.data.bindingGeneration }),
    ...(parsed.data.activationOrdinal === undefined ? {} : { activationOrdinal: parsed.data.activationOrdinal }),
    ...(parsed.data.activationGeneration === undefined ? {} : { activationGeneration: parsed.data.activationGeneration }),
    ...(parsed.data.bridgeRevision === undefined ? {} : { bridgeRevision: parsed.data.bridgeRevision }),
    sourceEventCount: parsed.data.sourceEventCount,
    events: parsed.data.events,
    ...(parsed.data.projectSummary === undefined ? {} : { projectSummary: parsed.data.projectSummary }),
    ...(parsed.data.review === undefined ? {} : { review: parsed.data.review }),
  }
}

export function parseTeamParentBindingData(value: unknown): TeamParentBindingData | undefined {
  const parsed = teamParentBindingDataSchema.safeParse(value)
  if (!parsed.success) return undefined
  return {
    parentSessionId: parsed.data.parentSessionId,
    ...(parsed.data.previousParentSessionId === undefined ? {} : { previousParentSessionId: parsed.data.previousParentSessionId }),
    generation: parsed.data.generation,
    operationId: parsed.data.operationId,
    boundAt: parsed.data.boundAt,
  }
}

export function parseTeamParentDetachedData(value: unknown): TeamParentDetachedData | undefined {
  const parsed = teamParentDetachedDataSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function parseTeamParentReportCheckpointData(value: unknown): TeamParentReportCheckpointData | undefined {
  const parsed = teamParentReportCheckpointDataSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** Latest delivered source cut for one exact parent-binding generation. */
export function readLatestTeamParentReportCheckpoint(
  session: Session,
  parentSessionId: string,
  bindingGeneration: number,
): TeamParentReportCheckpointData | undefined {
  let latest: TeamParentReportCheckpointData | undefined
  for (const entry of readSessionEvents(session)) {
    if (entry.type !== TEAM_PARENT_REPORT_CHECKPOINT_EVENT) continue
    const checkpoint = parseTeamParentReportCheckpointData(entry.data)
    if (checkpoint?.controllerSessionId !== String(session.id)
      || checkpoint.parentSessionId !== parentSessionId
      || checkpoint.bindingGeneration !== bindingGeneration) continue
    if (latest === undefined || checkpoint.sourceEventCount > latest.sourceEventCount) latest = checkpoint
  }
  return latest
}

/** Latest durable parent authority; legacy controllers fall back to their immutable header. */
export function readActiveTeamParentBinding(session: Session): TeamParentBindingData | undefined {
  const entries = readSessionEvents(session)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type !== TEAM_PARENT_BINDING_EVENT) continue
    const parsed = parseTeamParentBindingData(entry.data)
    if (parsed !== undefined) return parsed
  }
  const parentSessionId = session.header.parentSession
  return parentSessionId === undefined ? undefined : {
    parentSessionId: String(parentSessionId),
    generation: 0,
    operationId: 'legacy-header-binding',
    boundAt: new Date(session.header.createdAt).toISOString(),
  }
}

function collectTeamEvents(session: Session): { readonly valid: boolean; readonly events: readonly TeamEvent[] } {
  const events: TeamEvent[] = []
  try {
    for (const entry of readSessionEvents(session)) {
      if (entry.type !== TEAM_SESSION_EVENT) continue
      const parsed = parseTeamSessionEventData(entry.data)
      if (parsed === undefined) return { valid: false, events: [] }
      events.push(...parsed)
    }
    if (events.length > 0) replayTeamEvents(events)
    return { valid: true, events }
  } catch {
    return { valid: false, events: [] }
  }
}

/** Read the latest valid bounded project-summary index event. */
export function readLatestProjectSummary(session: Session): ProjectSummary | undefined {
  const entries = readSessionEvents(session)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type !== PROJECT_SUMMARY_SESSION_EVENT) continue
    const parsed = projectSummarySessionEventDataSchema.safeParse(entry.data)
    if (parsed.success) return parsed.data.summary
  }
  return undefined
}

/** Read the latest valid bounded review index event. */
export function readLatestReviewResult(session: Session): ReviewResult | undefined {
  const entries = readSessionEvents(session)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type !== REVIEW_SESSION_EVENT) continue
    const parsed = reviewSessionEventDataSchema.safeParse(entry.data)
    if (parsed.success) return parsed.data.result
  }
  return undefined
}

/** Build a full bridge payload from the controller's durable event log. */
export function buildTeamProjectionBridge(
  session: Session,
  activation?: { readonly bindingGeneration: number; readonly activationOrdinal?: string; readonly activationGeneration: number; readonly bridgeRevision: number },
): TeamProjectionBridgeData | undefined {
  const source = collectTeamEvents(session)
  if (!source.valid || source.events.length === 0) return undefined
  const events = source.events
  const projectSummary = readLatestProjectSummary(session)
  const indexedReview = readLatestReviewResult(session)
  const projection = replayTeamEvents(events)
  const latestReviewId = projection.reviewIds.at(-1)
  const latestReview = latestReviewId === undefined ? undefined : projection.reviews[latestReviewId]
  const review = latestReview?.result === undefined
    ? indexedReview
    : reviewResultSchema.parse({ reviewId: latestReview.id, trigger: latestReview.trigger, ...latestReview.result })
  return {
    controllerSessionId: String(session.id),
    ...(activation === undefined ? {} : activation),
    sourceEventCount: events.length,
    events: [...events],
    ...(projectSummary === undefined ? {} : { projectSummary }),
    ...(review === undefined ? {} : { review }),
  }
}

/** Read a controller cut from either its direct Team events or a parent bridge. */
export function readTeamProjectionEvents(session: Session): readonly TeamEvent[] {
  const bridge = selectActiveTeamProjectionBridge(readSessionEvents(session))
  if (bridge !== undefined) return bridge.events
  return readTeamEventsFromSession(session)
}

/** Read one exact controller cut from a parent Session without relying on bridge order. */
export function readTeamProjectionEventsForController(session: Session, controllerSessionId: string): readonly TeamEvent[] | undefined {
  const entries = readSessionEvents(session)
  const bridge = selectLatestControllerBridge(entries, controllerSessionId)
  if (bridge === undefined) return undefined
  const detachedGeneration = latestDetachedGeneration(entries, controllerSessionId)
  return detachedGeneration >= (bridge.bindingGeneration ?? 0) ? undefined : bridge.events
}

export interface TeamBridgeActivationState {
  readonly activeBridge?: TeamProjectionBridgeData
  readonly activationGenerations: Readonly<Record<string, number>>
  readonly nextActivationGeneration: number
}

export function emptyTeamBridgeActivationState(): TeamBridgeActivationState {
  return { activationGenerations: {}, nextActivationGeneration: 1 }
}

/**
 * One selector shared by parent UI replay and command targeting. New bridges
 * carry a Host-assigned generation; legacy bridges receive their first-seen
 * generation once, so an old controller replay can never reactivate it.
 */
export function applyTeamBridgeActivation(
  state: TeamBridgeActivationState,
  bridge: TeamProjectionBridgeData,
): TeamBridgeActivationState {
  const knownGeneration = state.activationGenerations[bridge.controllerSessionId]
  const used = new Set(Object.values(state.activationGenerations))
  const requestedGeneration = bridge.activationGeneration
  if (knownGeneration === undefined && requestedGeneration !== undefined && used.has(requestedGeneration)) {
    // A generation is an exact single-controller activation identity. A
    // conflicting durable claim is ignored rather than remapped by arrival.
    return state
  }
  const generation = knownGeneration ?? (
    requestedGeneration ?? nextUnusedGeneration(state.nextActivationGeneration, used)
  )
  const activationGenerations = knownGeneration === undefined
    ? { ...state.activationGenerations, [bridge.controllerSessionId]: generation }
    : state.activationGenerations
  const nextActivationGeneration = Math.max(state.nextActivationGeneration, generation + 1)
  const active = state.activeBridge
  if (active === undefined) return { activeBridge: bridge, activationGenerations, nextActivationGeneration }

  const activeGeneration = activationGenerations[active.controllerSessionId]!
  const sameController = bridge.controllerSessionId === active.controllerSessionId
  const candidateOrdinal = bridge.activationOrdinal
  const activeOrdinal = active.activationOrdinal
  const candidateIsActive = sameController
    ? isNewerBridgeCut(bridge, active)
    : candidateOrdinal !== undefined
      ? activeOrdinal === undefined || candidateOrdinal > activeOrdinal
      : activeOrdinal === undefined && generation > activeGeneration
  return {
    activeBridge: candidateIsActive ? bridge : active,
    activationGenerations,
    nextActivationGeneration,
  }
}

export function selectActiveTeamProjectionBridge(events: readonly SessionEvent[]): TeamProjectionBridgeData | undefined {
  let state = emptyTeamBridgeActivationState()
  for (const entry of events) {
    if (entry.type === TEAM_PARENT_DETACHED_EVENT) {
      const detached = parseTeamParentDetachedData(entry.data)
      if (detached !== undefined && state.activeBridge?.controllerSessionId === detached.controllerSessionId
        && detached.bindingGeneration >= (state.activeBridge.bindingGeneration ?? 0)) {
        const { activeBridge: _activeBridge, ...inactiveState } = state
        state = inactiveState
      }
      continue
    }
    if (entry.type !== TEAM_PARENT_PROJECTION_EVENT) continue
    const bridge = parseTeamProjectionBridgeData(entry.data)
    if (bridge !== undefined) state = applyTeamBridgeActivation(state, bridge)
  }
  return state.activeBridge
}

/**
 * Publish a rebuildable derived index to the parent Session when that public
 * SessionStore lookup is available. A bridge failure never invalidates the
 * already-flushed controller source; later source commits and Session lifecycle
 * recovery both retry it.
 */
export async function syncTeamProjectionToParent(session: Session, sessions: HarnessSessionStore): Promise<boolean> {
  try {
    const binding = readActiveTeamParentBinding(session)
    if (binding === undefined || sessions.get === undefined) return false
    const detachmentSynced = await syncPreviousParentDetachment(session, binding, sessions)
    const parent = sessions.get(binding.parentSessionId as Session['id'])
    if (parent === undefined) return false
    const base = buildTeamProjectionBridge(session)
    if (base === undefined) return false
    // Restoring a parent or creating an unrelated Session can replay the same
    // controller cut. Never append an identical derived index twice. A matching
    // live event is not proof of durability, though: it may be the residue of a
    // failed flush, so retry the flush before reporting success.
    const parentEvents = readSessionEvents(parent)
    if (parentEvents.some(event => {
      if (event.type !== TEAM_PARENT_PROJECTION_EVENT) return false
      const existing = parseTeamProjectionBridgeData(event.data)
      return existing !== undefined
        && (existing.bindingGeneration ?? 0) === binding.generation
        && sameBridgeContent(existing, base)
    })) {
      const parentSynced = hasSidecarSession(parent) || await sessions.flush(parent)
      return detachmentSynced && parentSynced
    }
    const bridge = { ...base,
      ...nextBridgeActivation(parentEvents, String(session.id)),
      bindingGeneration: binding.generation,
    }
    await commitYuqiSessionEvent(parent, TEAM_PARENT_PROJECTION_EVENT, bridge)
    const parentSynced = hasSidecarSession(parent) || await sessions.flush(parent)
    return detachmentSynced && parentSynced
  } catch (error) {
    // IDs, payloads and arbitrary exception text can contain sensitive data.
    // Expose a stable operational signal without swallowing synchronization loss.
    const code = error !== null && typeof error === 'object' && 'code' in error
      && typeof error.code === 'string' && /^[A-Z_]+$/u.test(error.code) ? error.code : 'SYNC_FAILED'
    console.warn(`[yuqi-team] parent projection synchronization failed code=${code}; controller facts remain durable`)
    return false
  }
}

const pendingParentSyncs = new WeakMap<HarnessSessionStore, Map<string, { dirty: boolean }>>()

/** Coalesce UI work outside the authoritative journal/settlement critical path.
 * A source commit during an in-flight sync requests one more latest cut, never
 * one expensive full-history copy for every usage sample. Cold recovery and
 * explicit rebind still use the awaited sync API above. */
function scheduleTeamProjectionToParent(session: Session, sessions: HarnessSessionStore): void {
  let pending = pendingParentSyncs.get(sessions)
  if (!pending) { pending = new Map(); pendingParentSyncs.set(sessions, pending) }
  const key = String(session.id)
  const existing = pending.get(key)
  if (existing) { existing.dirty = true; return }
  const job = { dirty: true }
  pending.set(key, job)
  const run = async () => {
    try {
      do {
        job.dirty = false
        await syncTeamProjectionToParent(session, sessions)
      } while (job.dirty)
    } finally { pending.delete(key) }
  }
  setTimeout(() => { void run() }, 0)
}

async function syncPreviousParentDetachment(
  session: Session,
  binding: TeamParentBindingData,
  sessions: HarnessSessionStore,
): Promise<boolean> {
  try {
    const previousParentSessionId = binding.previousParentSessionId
    if (previousParentSessionId === undefined || previousParentSessionId === binding.parentSessionId) return true
    if (sessions.get === undefined) return false
    const previous = sessions.get(previousParentSessionId as Session['id'])
    if (previous === undefined) return false
    const controllerSessionId = String(session.id)
    const alreadyDetached = readSessionEvents(previous).some(event => {
      if (event.type !== TEAM_PARENT_DETACHED_EVENT) return false
      const detached = parseTeamParentDetachedData(event.data)
      return detached?.controllerSessionId === controllerSessionId
        && detached.bindingGeneration >= binding.generation
    })
    if (!alreadyDetached) {
      await commitYuqiSessionEvent(previous, TEAM_PARENT_DETACHED_EVENT, {
        controllerSessionId,
        bindingGeneration: binding.generation,
      })
    }
    // As with bridges, an existing in-memory tombstone can be left behind by a
    // failed flush. Re-flushing is the only public durability acknowledgement.
    return hasSidecarSession(previous) || await sessions.flush(previous)
  } catch {
    return false
  }
}

export function sameBridgeContent(left: TeamProjectionBridgeData, right: TeamProjectionBridgeData): boolean {
  return left.controllerSessionId === right.controllerSessionId
    && left.sourceEventCount === right.sourceEventCount
    && JSON.stringify(left.events) === JSON.stringify(right.events)
    && JSON.stringify(left.projectSummary) === JSON.stringify(right.projectSummary)
    && JSON.stringify(left.review) === JSON.stringify(right.review)
}

function selectLatestControllerBridge(events: readonly SessionEvent[], controllerSessionId: string): TeamProjectionBridgeData | undefined {
  let selected: TeamProjectionBridgeData | undefined
  for (const entry of events) {
    if (entry.type !== TEAM_PARENT_PROJECTION_EVENT) continue
    const bridge = parseTeamProjectionBridgeData(entry.data)
    if (bridge?.controllerSessionId !== controllerSessionId) continue
    if (selected === undefined || isNewerBridgeCut(bridge, selected)) selected = bridge
  }
  return selected
}

function latestDetachedGeneration(events: readonly SessionEvent[], controllerSessionId: string): number {
  let generation = -1
  for (const entry of events) {
    if (entry.type !== TEAM_PARENT_DETACHED_EVENT) continue
    const detached = parseTeamParentDetachedData(entry.data)
    if (detached?.controllerSessionId === controllerSessionId) generation = Math.max(generation, detached.bindingGeneration)
  }
  return generation
}

function nextBridgeActivation(
  events: readonly SessionEvent[],
  controllerSessionId: string,
): { readonly activationOrdinal?: string; readonly activationGeneration: number; readonly bridgeRevision: number } {
  let state = emptyTeamBridgeActivationState()
  let maxRevision = 0
  for (const entry of events) {
    if (entry.type !== TEAM_PARENT_PROJECTION_EVENT) continue
    const bridge = parseTeamProjectionBridgeData(entry.data)
    if (bridge === undefined) continue
    state = applyTeamBridgeActivation(state, bridge)
    if (bridge.controllerSessionId === controllerSessionId) maxRevision = Math.max(maxRevision, bridge.bridgeRevision ?? 0)
  }
  const known = state.activationGenerations[controllerSessionId]
  const used = new Set(Object.values(state.activationGenerations))
  const activationOrdinal = controllerActivationOrdinal(controllerSessionId)
  return {
    ...(activationOrdinal === undefined ? {} : { activationOrdinal }),
    activationGeneration: known ?? nextUnusedGeneration(state.nextActivationGeneration, used),
    bridgeRevision: maxRevision + 1,
  }
}

function controllerActivationOrdinal(sessionId: string): string | undefined {
  const match = /^yuqi-team-([0-9a-z]{10})-([0-9a-z]{4})-[0-9a-f-]{36}$/u.exec(sessionId)
  return match === null ? undefined : `${match[1]}-${match[2]}`
}

function isNewerBridgeCut(candidate: TeamProjectionBridgeData, current: TeamProjectionBridgeData): boolean {
  if (candidate.bridgeRevision !== undefined || current.bridgeRevision !== undefined) {
    if (candidate.bridgeRevision === undefined) return false
    if (current.bridgeRevision === undefined) return true
    if (candidate.bridgeRevision !== current.bridgeRevision) return candidate.bridgeRevision > current.bridgeRevision
  }
  return candidate.sourceEventCount >= current.sourceEventCount
}

function nextUnusedGeneration(start: number, used: ReadonlySet<number>): number {
  let generation = start
  while (used.has(generation)) generation += 1
  return generation
}

/** Projects and appends Team facts within one controller Session. */
export class HarnessSessionJournal implements TeamEventJournal {
  readonly #session: Session
  readonly #sessions: HarnessSessionStore
  readonly #persistence: HarnessSessionPersistence | undefined
  readonly #onTeamCommit: (() => void) | undefined

  constructor(
    session: Session,
    sessions: HarnessSessionStore,
    persistence?: HarnessSessionPersistence,
    onTeamCommit?: () => void,
  ) {
    this.#session = session
    this.#sessions = sessions
    this.#persistence = persistence
    this.#onTeamCommit = onTeamCommit
  }

  get key(): string {
    return String(this.#session.id)
  }

  read(): readonly unknown[] {
    return readTeamEventsFromSession(this.#session)
  }

  async commit(events: readonly TeamEvent[]): Promise<void> {
    if (events.length > 1) await commitYuqiSessionEvent(this.#session, TEAM_SESSION_EVENT, { events: [...events] })
    else if (events.length === 1) await commitYuqiSessionEvent(this.#session, TEAM_SESSION_EVENT, { event: events[0]! })
    await this.#flushOrPersist(`Yuqi Team journal ${this.key}`)
    this.#onTeamCommit?.()
    scheduleTeamProjectionToParent(this.#session, this.#sessions)
  }

  /** Persist the bounded summary index in the same source Session. */
  async commitProjectSummary(summary: ProjectSummary): Promise<void> {
    await commitYuqiSessionEvent(this.#session, PROJECT_SUMMARY_SESSION_EVENT, { summary })
    await this.#flushOrPersist(`Yuqi project summary journal ${this.key}`)
    scheduleTeamProjectionToParent(this.#session, this.#sessions)
  }

  /** Persist proof only after the corresponding report is durable in the parent inbox. */
  async commitParentReportCheckpoint(checkpoint: TeamParentReportCheckpointData): Promise<void> {
    const parsed = parseTeamParentReportCheckpointData(checkpoint)
    if (parsed === undefined || parsed.controllerSessionId !== this.key) {
      throw new Error(`Yuqi parent report checkpoint does not belong to controller ${this.key}`)
    }
    const conflicting = readSessionEvents(this.#session).find(entry => {
      if (entry.type !== TEAM_PARENT_REPORT_CHECKPOINT_EVENT) return false
      const existing = parseTeamParentReportCheckpointData(entry.data)
      return existing?.controllerSessionId === parsed.controllerSessionId
        && existing.parentSessionId === parsed.parentSessionId
        && existing.bindingGeneration === parsed.bindingGeneration
        && existing.sourceEventCount === parsed.sourceEventCount
        && existing.messageId !== parsed.messageId
    })
    if (conflicting !== undefined) throw new Error(`Yuqi parent report cut ${parsed.sourceEventCount} has conflicting message identities`)
    const exists = readSessionEvents(this.#session).some(entry => {
      if (entry.type !== TEAM_PARENT_REPORT_CHECKPOINT_EVENT) return false
      const existing = parseTeamParentReportCheckpointData(entry.data)
      return existing?.controllerSessionId === parsed.controllerSessionId
        && existing.parentSessionId === parsed.parentSessionId
        && existing.bindingGeneration === parsed.bindingGeneration
        && existing.sourceEventCount === parsed.sourceEventCount
        && existing.messageId === parsed.messageId
    })
    if (!exists) await commitYuqiSessionEvent(this.#session, TEAM_PARENT_REPORT_CHECKPOINT_EVENT, parsed)
    await this.#flushOrPersist(`Yuqi parent report checkpoint ${this.key}`)
  }

  /** Move parent control authority without moving or duplicating the Team journal. */
  async rebindParent(parentSessionId: string, operationId: string): Promise<TeamParentBindingData> {
    const current = readActiveTeamParentBinding(this.#session)
    if (current?.operationId === operationId) {
      if (current.parentSessionId !== parentSessionId) throw new Error(`Parent binding operation ${operationId} conflicts with its durable target`)
      await syncTeamProjectionToParent(this.#session, this.#sessions)
      return current
    }
    if (current?.parentSessionId === parentSessionId) {
      await syncTeamProjectionToParent(this.#session, this.#sessions)
      return current
    }
    const binding: TeamParentBindingData = {
      parentSessionId,
      ...(current === undefined ? {} : { previousParentSessionId: current.parentSessionId }),
      generation: (current?.generation ?? 0) + 1,
      operationId,
      boundAt: new Date().toISOString(),
    }
    await commitYuqiSessionEvent(this.#session, TEAM_PARENT_BINDING_EVENT, binding)
    await this.#flushOrPersist(`Yuqi parent binding ${this.key}`)
    await syncTeamProjectionToParent(this.#session, this.#sessions)
    return binding
  }

  /**
   * Normal Harness profiles persist via the session/flush listener. Some
   * scoped preset sessions expose no listener; in that case append the exact
   * live tail through the public persistence service instead of losing Team
   * state or pretending a non-durable bootstrap succeeded.
   */
  async #flushOrPersist(label: string): Promise<void> {
    if (hasSidecarSession(this.#session)) return
    if (await this.#sessions.flush(this.#session)) return
    if (this.#persistence === undefined) throw new Error(`${label} has no durability listener`)

    const headers = await this.#persistence.list()
    const exists = headers.some(header => String(header.id) === String(this.#session.id))
    if (!exists) {
      await this.#persistence.create(this.#session.header)
    }
    const stored = exists ? (await this.#persistence.readFrom(this.#session.id, 0)).events : []
    const live = readSessionEvents(this.#session)
    if (stored.length > live.length || !sameEventPrefix(stored, live)) {
      throw new Error(`${label} durable history does not match the live session`)
    }
    const tail = live.slice(stored.length)
    if (tail.length > 0) await this.#persistence.append(this.#session.id, tail)
    const durable = (await this.#persistence.readFrom(this.#session.id, 0)).events
    if (durable.length !== live.length || !sameEventPrefix(durable, live)) {
      throw new Error(`${label} could not prove the complete live session durable`)
    }
  }
}

function sameEventPrefix(stored: readonly SessionEvent[], live: readonly SessionEvent[]): boolean {
  return stored.every((event, index) => JSON.stringify(event) === JSON.stringify(live[index]))
}
