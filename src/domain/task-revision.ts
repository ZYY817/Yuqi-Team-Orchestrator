/** Preserve historical results while explicitly revalidating completed consumers. */
import type { TaskId } from './ids.ts'
import type { TeamProjection } from './projection.ts'
import { MAX_TEAM_TASKS, type TeamTaskContract } from './task-contract.ts'

export interface TaskRevalidation {
  readonly rootSourceTaskId: TaskId
  readonly taskMapping: readonly { readonly sourceTaskId: TaskId; readonly taskId: TaskId }[]
}

function revalidation(contract: TeamTaskContract): TaskRevalidation | undefined {
  return contract.userRevision?.revalidation
}
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

/** Topological transitive closure, including previous revision consumers.
 * Exclude only members of the group currently being replayed, never old groups.
 */
export function taskRevisionSources(state: TeamProjection, root: string, excludeOperationId?: string): TaskId[] {
  const eligible = state.taskIds.filter(id => excludeOperationId === undefined
    || state.tasks[id]!.contract.userRevision?.operationId !== excludeOperationId)
  const affected = new Set<string>([root])
  let changed = true
  while (changed) {
    changed = false
    for (const id of eligible) {
      const contract = state.tasks[id]!.contract
      if (!affected.has(id) && (contract.dependencies.some(dep => affected.has(dep))
        || (contract.userRevision !== undefined && affected.has(contract.userRevision.sourceTaskId)))) {
        affected.add(id)
        changed = true
      }
    }
  }
  const ordered: TaskId[] = []
  const remaining = eligible.filter(id => affected.has(id))
  while (remaining.length > 0) {
    const index = remaining.findIndex(id => {
      const contract = state.tasks[id]!.contract
      return [...contract.dependencies, ...(contract.userRevision ? [contract.userRevision.sourceTaskId] : [])]
        .every(dep => !affected.has(dep) || ordered.includes(dep))
    })
    if (index < 0) throw new Error('Revision dependency graph is cyclic')
    ordered.push(remaining.splice(index, 1)[0]!)
  }
  return ordered
}

export function taskRevisionDependencies(source: TeamTaskContract, plan?: TaskRevalidation): TaskId[] {
  if (plan === undefined || source.taskId === plan.rootSourceTaskId) return [source.taskId]
  const mapping = new Map(plan.taskMapping.map(entry => [entry.sourceTaskId, entry.taskId]))
  return [...new Set([source.taskId, ...source.dependencies.map(id => mapping.get(id) ?? id)])]
}

/** Shared preflight without mutation or event allocation. */
export function taskRevisionAdmissionIssue(state: TeamProjection, sources: readonly TaskId[], hasGap: boolean): string | undefined {
  const affected = new Set<string>(sources)
  if (!['running', 'paused'].includes(state.team.status)) return 'Revision requires a running or paused Team'
  if (state.team.manualOwnership?.state === 'human-owned') return 'Return Team ownership before requesting a revision'
  if (hasGap || Object.values(state.attempts).some(attempt => attempt.status === 'unknown')
    || Object.values(state.budgetReservations).some(reservation => reservation.status === 'unknown')) {
    return 'Resolve uncertain execution before requesting a revision'
  }
  if (state.reviewIds.length > 0) return 'Existing review decisions require an explicitly replanned follow-up Team'
  // Independent tasks retain their normal scheduling/lease protection. Only
  // unsettled resources belonging to the results being replaced block admission.
  if (state.fileLeaseIds.some(id => state.fileLeases[id]!.status === 'active'
    && affected.has(state.fileLeases[id]!.taskId))) return 'Release or reconcile affected file leases before requesting a revision'
  if (Object.values(state.budgetReservations).some(reservation => reservation.status === 'active'
    && affected.has(reservation.taskId))) return 'Settle affected budget reservations before requesting a revision'
  for (const id of sources) {
    const source = state.tasks[id]
    if (source?.status !== 'completed') return 'Revision source and downstream consumers must all be completed'
    const attemptId = source.attemptIds.at(-1)
    const attempt = attemptId === undefined ? undefined : state.attempts[attemptId]
    if (attempt?.status !== 'completed' || !attempt.evidence?.hasAssistantOutput) return 'Revision requires an exact settled source result'
    if (source.attemptIds.some(id => ['dispatching', 'running', 'unknown'].includes(state.attempts[id]!.status))
      || source.verificationIds.some(id => ['pending', 'running'].includes(state.verifications[id]!.status))) return 'Revision source has unresolved execution or verification'
  }
  return undefined
}

/** Shared admission/replay validator; accepts only the exact next group member. */
export function taskRevisionIssue(state: TeamProjection, contract: TeamTaskContract, hasReconciliationGap: boolean): string | undefined {
  const origin = contract.userRevision
  if (contract.kind !== 'user-revision' || origin === undefined) return 'Missing user revision provenance'
  const plan = revalidation(contract)
  const root = plan?.rootSourceTaskId ?? origin.sourceTaskId
  const sources = taskRevisionSources(state, root, origin.operationId)
  if (sources.length === 0 || sources[0] !== root) return 'Revision source does not exist'
  if (plan === undefined && sources.length > 1) return 'Source has downstream consumers; explicitly include downstream revalidation'
  const issue = taskRevisionAdmissionIssue(state, sources, hasReconciliationGap)
  if (issue !== undefined) return issue
  const members = state.taskIds.filter(id => state.tasks[id]!.contract.userRevision?.operationId === origin.operationId)
  if (state.taskIds.length - members.length + sources.length > MAX_TEAM_TASKS) return `Team cannot contain more than ${MAX_TEAM_TASKS} tasks`
  if (plan !== undefined) {
    if (sources.length < 2 || !same(plan.taskMapping.map(entry => entry.sourceTaskId), sources)
      || new Set(plan.taskMapping.map(entry => entry.taskId)).size !== sources.length
      || plan.taskMapping.some(entry => sources.includes(entry.taskId))) return 'Invalid downstream revalidation mapping'
    if (members.length >= sources.length) return 'Revision operation already exists'
    const expected = plan.taskMapping[members.length]!
    if (expected.taskId !== contract.taskId || expected.sourceTaskId !== origin.sourceTaskId) return 'Revision group must be created in mapped dependency order'
    for (const [index, id] of members.entries()) {
      const member = state.tasks[id]!.contract
      const memberOrigin = member.userRevision
      if (memberOrigin === undefined || id !== plan.taskMapping[index]!.taskId || memberOrigin.sourceTaskId !== sources[index]
        || memberOrigin.requestDigest !== origin.requestDigest || !same(revalidation(member), plan)) return 'Revision operation conflicts with its existing group'
    }
    if (plan.taskMapping.slice(members.length).some(entry => state.tasks[entry.taskId] !== undefined)) return 'Revision mapped task identity already exists'
  } else if (members.length > 0) return 'Revision operation already exists'
  const source = state.tasks[origin.sourceTaskId]
  if (source?.contract.revision !== origin.sourceRevision || source.attemptIds.at(-1) !== origin.sourceAttemptId) return 'Revision source is not the expected completed task'
  if (contract.authorityMode !== source.contract.authorityMode
    || !same(contract.scope, source.contract.scope) || !same(contract.nonGoals, source.contract.nonGoals)
    || contract.modelRole !== source.contract.modelRole || contract.baselineRef !== source.contract.baselineRef
    || contract.maxAttempts !== source.contract.maxAttempts || !same(contract.fileScope, source.contract.fileScope)
    || !same(contract.modelRequest, source.contract.modelRequest) || contract.modelId !== source.contract.modelId
    || !same(contract.verificationChecks, source.contract.verificationChecks)) return 'Revision must preserve source scope, authority, route and verification checks'
  if (origin.sourceTaskId !== root && (contract.goal !== source.contract.goal
    || !same(contract.acceptanceCriteria, source.contract.acceptanceCriteria))) return 'Downstream revalidation must preserve its original goal and acceptance criteria'
  if (!same(contract.dependencies, taskRevisionDependencies(source.contract, plan))) return 'Revision must retain its source dependency and mapped upstream dependencies'
  return undefined
}

/** For task-revised; projection separately requires immutable provenance. */
export function taskRevisionDependenciesIssue(previous: TeamTaskContract, next: TeamTaskContract): string | undefined {
  if (previous.userRevision !== undefined && !same(previous.dependencies, next.dependencies)) return 'User revision must retain its source dependency and mapped upstream dependencies'
  return undefined
}

/** Call at the END of whole replay/transaction, not after each task-created.
 * A truncated group must not expose an independently runnable new root.
 */
export function taskRevisionBatchIssue(state: TeamProjection): string | undefined {
  const checked = new Set<string>()
  for (const id of state.taskIds) {
    const contract = state.tasks[id]!.contract
    const plan = revalidation(contract)
    const origin = contract.userRevision
    if (plan === undefined || origin === undefined || checked.has(origin.operationId)) continue
    checked.add(origin.operationId)
    const members = state.taskIds.filter(id => state.tasks[id]!.contract.userRevision?.operationId === origin.operationId)
    if (members.length !== plan.taskMapping.length) return 'Incomplete downstream revalidation group'
    for (const entry of plan.taskMapping) {
      const member = state.tasks[entry.taskId]?.contract
      if (member?.userRevision?.operationId !== origin.operationId
        || member.userRevision.requestDigest !== origin.requestDigest
        || member.userRevision.sourceTaskId !== entry.sourceTaskId
        || !same(revalidation(member), plan)) return 'Incomplete or conflicting downstream revalidation group'
    }
  }
  return undefined
}
