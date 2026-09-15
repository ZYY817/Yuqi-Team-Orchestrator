import { z } from 'zod'
import { hasActiveAttempts, hasUnresolvedRecoveryFacts } from '../../application/control-team.ts'
import { projectSummarySchema } from '../../application/project-summary.ts'
import { reviewResultSchema } from '../../application/reviewer.ts'
import type { TeamEvent } from '../../domain/events.ts'
import { replayTeamEvents } from '../../domain/projection.ts'
import { isSchedulableTaskStatus } from '../../domain/states.ts'
import { WORKSPACE_CHANGE_SNAPSHOT_EVENT, WORKSPACE_SNAPSHOT_LIMITS } from '../workspace-change-snapshot.ts'
import {
  parseTeamSessionEventData, parseTeamProjectionBridgeData, parseTeamParentDetachedData,
  parseTeamParentBindingData, parseTeamParentReportCheckpointData,
  TEAM_SESSION_EVENT, TEAM_PARENT_PROJECTION_EVENT, TEAM_PARENT_DETACHED_EVENT,
  TEAM_PARENT_BINDING_EVENT, TEAM_PARENT_REPORT_CHECKPOINT_EVENT,
  PROJECT_SUMMARY_SESSION_EVENT, REVIEW_SESSION_EVENT,
} from './session-journal.ts'

const identifier = z.string().min(1).max(4096)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const fingerprint = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().nonnegative().max(WORKSPACE_SNAPSHOT_LIMITS.maxFileBytes) }).strict()
const relativePath = z.string().min(1).max(1024).refine(value =>
  !/^[A-Za-z]:|^\/|[\\\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
const change = z.object({ path: relativePath, kind: z.enum(['added', 'modified', 'deleted']),
  before: fingerprint.optional(), after: fingerprint.optional() }).strict().refine(value =>
  value.kind === 'added' ? value.before === undefined && value.after !== undefined
    : value.kind === 'deleted' ? value.before !== undefined && value.after === undefined
      : value.before !== undefined && value.after !== undefined
        && (value.before.sha256 !== value.after.sha256 || value.before.size !== value.after.size))
// No existing runtime schema accompanies WorkspaceChangeSnapshotEvent. This
// strict subset follows the collector's DTO and resource bounds, with no IO.
const workspaceSnapshot = z.object({
  version: z.literal(1), childSessionId: identifier, runId: identifier,
  scope: z.literal('workspace'), attribution: z.literal('unavailable'),
  beforeCapturedAt: z.string().datetime({ offset: true }), afterCapturedAt: z.string().datetime({ offset: true }),
  partial: z.boolean(), reasons: z.array(z.string().min(1).max(1024)).max(8192),
  limits: z.object({
    maxFiles: positive.max(WORKSPACE_SNAPSHOT_LIMITS.maxFiles),
    maxEntries: positive.max(WORKSPACE_SNAPSHOT_LIMITS.maxEntries),
    maxFileBytes: positive.max(WORKSPACE_SNAPSHOT_LIMITS.maxFileBytes),
    maxTotalBytes: positive.max(WORKSPACE_SNAPSHOT_LIMITS.maxTotalBytes),
    maxChanges: positive.max(WORKSPACE_SNAPSHOT_LIMITS.maxChanges),
    timeoutMs: positive.max(WORKSPACE_SNAPSHOT_LIMITS.timeoutMs),
  }).strict(),
  changes: z.array(change).max(WORKSPACE_SNAPSHOT_LIMITS.maxChanges),
}).strict().refine(value => value.partial === (value.reasons.length > 0)
  && value.changes.length <= value.limits.maxChanges
  && new Set(value.changes.map(item => item.path)).size === value.changes.length
  && value.changes.every(item => [item.before, item.after].every(file =>
    file === undefined || file.size <= value.limits.maxFileBytes)))

const envelope = z.object({ type: z.string(), seq: positive,
  time: z.number().finite().nonnegative(), ignorable: z.literal(true), data: z.unknown() }).strict()
const summary = z.object({ summary: projectSummarySchema }).strict()
const review = z.object({ result: reviewResultSchema }).strict()

export type RetainableOrphan = 'child-evidence' | 'parent-index' | 'terminal-controller'

/** Throws on unknown/corrupt/incomplete control facts. Retention grants NO
 * recovery, inbox delivery, Session creation, checkpoint, or deletion authority.
 * Pass the validated detached output of repository.readStoredEvents(id).
 * Parent bridges are derived cuts: their controller may remain active elsewhere.
 */
export function assertRetainableOrphan(events: readonly unknown[]): RetainableOrphan {
  const reject = (): never => { throw new Error('Sidecar orphan is not safely retainable') }
  if (!Array.isArray(events) || events.length === 0) return reject()
  const facts: TeamEvent[] = []
  let child = false, parent = false, controller = false
  let childId: string | undefined
  for (const [index, raw] of events.entries()) {
    const checked = envelope.safeParse(raw)
    if (!checked.success || !Object.hasOwn(checked.data, 'data') || checked.data.seq !== index + 1) return reject()
    const { type, data } = checked.data
    switch (type) {
      case WORKSPACE_CHANGE_SNAPSHOT_EVENT: {
        const parsed = workspaceSnapshot.safeParse(data)
        if (!parsed.success || (childId !== undefined && childId !== parsed.data.childSessionId)) return reject()
        childId = parsed.data.childSessionId
        child = true
        break
      }
      case TEAM_PARENT_PROJECTION_EVENT:
        if (!parseTeamProjectionBridgeData(data)) return reject()
        parent = true
        break
      case TEAM_PARENT_DETACHED_EVENT:
        if (!parseTeamParentDetachedData(data)) return reject()
        parent = true
        break
      case TEAM_SESSION_EVENT: {
        const parsed = parseTeamSessionEventData(data)
        if (!parsed) return reject()
        facts.push(...parsed)
        controller = true
        break
      }
      case TEAM_PARENT_BINDING_EVENT:
        if (!parseTeamParentBindingData(data)) return reject()
        controller = true
        break
      case TEAM_PARENT_REPORT_CHECKPOINT_EVENT:
        if (!parseTeamParentReportCheckpointData(data)) return reject()
        controller = true
        break
      case PROJECT_SUMMARY_SESSION_EVENT:
        if (!summary.safeParse(data).success) return reject()
        controller = true
        break
      case REVIEW_SESSION_EVENT:
        if (!review.safeParse(data).success) return reject()
        controller = true
        break
      default: return reject()
    }
  }
  if (child && !parent && !controller) return 'child-evidence'
  if (parent && !child && !controller) return 'parent-index'
  if (!controller || child || parent || facts.length === 0) return reject()
  // Replay errors intentionally propagate; never turn a corrupt stream into [].
  const projection = replayTeamEvents(facts)
  if (!['completed', 'failed', 'cancelled'].includes(projection.team.status)
    || hasActiveAttempts(projection) || hasUnresolvedRecoveryFacts(projection)
    || projection.taskIds.some(id => isSchedulableTaskStatus(projection.tasks[id]?.status))) return reject()
  return 'terminal-controller'
}
