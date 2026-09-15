/** Add a new, source-linked task in the existing durable scheduling boundary. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { TaskId } from '../domain/ids.ts'
import { operationIdUsed, projectionHasReconciliationGap, replayTeamEvents, type TeamProjection } from '../domain/projection.ts'
import { MAX_TEAM_TASKS, teamTaskContractSchema } from '../domain/task-contract.ts'
import { taskRevisionAdmissionIssue, taskRevisionBatchIssue, taskRevisionDependencies,
  taskRevisionSources, type TaskRevalidation } from '../domain/task-revision.ts'
import type { Clock, EventIdSource, TeamEventJournal } from './ports.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'
import { YuqiOrchestratorError } from './errors.ts'

export const taskRevisionRequestSchema = z.object({
  teamId: z.string().trim().min(1),
  sourceTaskId: z.string().trim().min(1),
  operationId: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(600),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(300)).min(1).max(4),
  includeDependents: z.boolean().optional(),
}).strict()
export type TaskRevisionRequest = z.output<typeof taskRevisionRequestSchema>

export class TaskRevisionCoordinator {
  constructor(
    private readonly clock: Clock,
    private readonly eventIds: EventIdSource,
    private readonly transactions: DurableJournalCoordinator,
  ) {}

  create(input: TaskRevisionRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    const parsed = taskRevisionRequestSchema.parse(input)
    // Omitted and explicit false are the same request; preserve legacy hashes.
    const { includeDependents, ...required } = parsed
    const request = { ...required, ...(includeDependents === true ? { includeDependents: true } : {}) }
    const requestDigest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    return this.transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      if (current.team.id !== request.teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Revision targets another Team')
      const incomplete = taskRevisionBatchIssue(current)
      if (incomplete !== undefined) throw new YuqiOrchestratorError('INVALID_BATCH', incomplete)
      const taskId = TaskId(`user-revision:${createHash('sha256').update(request.operationId).digest('hex')}`)
      const existing = current.tasks[taskId]
      if (existing !== undefined) {
        const contract = existing.contract
        if (contract.userRevision?.operationId !== request.operationId
          || contract.userRevision.sourceTaskId !== request.sourceTaskId
          || contract.userRevision.requestDigest !== requestDigest) {
          throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Revision operation was reused with different requirements')
        }
        return current
      }
      if (operationIdUsed(current, request.operationId) || current.team.manualOwnershipOperations?.[request.operationId] !== undefined) {
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Revision operation identity already used')
      }
      const sources = taskRevisionSources(current, request.sourceTaskId)
      if (sources.length === 0) throw new YuqiOrchestratorError('INVALID_BATCH', 'Revision source has no execution result')
      if (sources.length > 1 && includeDependents !== true) {
        throw new YuqiOrchestratorError('INVALID_BATCH', 'Source has downstream consumers; explicitly include downstream revalidation')
      }
      const issue = taskRevisionAdmissionIssue(current, sources, projectionHasReconciliationGap(current))
      if (issue !== undefined) throw new YuqiOrchestratorError('INVALID_BATCH', issue)
      if (current.taskIds.length + sources.length > MAX_TEAM_TASKS) {
        throw new YuqiOrchestratorError('INVALID_BATCH', `Team cannot contain more than ${MAX_TEAM_TASKS} tasks`)
      }
      const mapping = sources.map(sourceTaskId => ({ sourceTaskId,
        taskId: sourceTaskId === request.sourceTaskId ? taskId
          : TaskId(`user-revalidation:${createHash('sha256').update(JSON.stringify([request.operationId, sourceTaskId])).digest('hex')}`),
      }))
      if (mapping.some(entry => current.tasks[entry.taskId] !== undefined)) {
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Revision mapped task identity already exists')
      }
      const revalidation: TaskRevalidation | undefined = sources.length > 1
        ? { rootSourceTaskId: sources[0]!, taskMapping: mapping } : undefined
      const contracts = mapping.map(({ sourceTaskId, taskId: newTaskId }) => {
        const source = current.tasks[sourceTaskId]!
        const sourceAttemptId = source.attemptIds.at(-1)!
        // Drop earlier provenance, retaining each task's own scope/route/checks.
        const { reviewRework: _review, userRevision: _revision, ...base } = source.contract
        const isRoot = sourceTaskId === request.sourceTaskId
        return teamTaskContractSchema.parse({
          ...base, taskId: newTaskId, revision: 1, kind: 'user-revision',
          goal: isRoot ? request.goal : base.goal,
          dependencies: taskRevisionDependencies(base, revalidation),
          acceptanceCriteria: isRoot ? request.acceptanceCriteria : base.acceptanceCriteria,
          inputDigest: createHash('sha256').update(JSON.stringify({ request, sourceTaskId, sourceAttemptId,
            sourceDigest: base.inputDigest, revalidation })).digest('hex'),
          userRevision: { operationId: request.operationId, requestDigest, sourceTaskId,
            sourceRevision: base.revision, sourceAttemptId,
            ...(revalidation === undefined ? {} : { revalidation }),
          },
        })
      })
      const events = contracts.map(contract => createTeamEvent(this.clock, this.eventIds, request.teamId, { type: 'yuqi/task-created', contract }))
      const next = validateTeamEvents(transaction.read(), events)
      const batchIssue = taskRevisionBatchIssue(next)
      if (batchIssue !== undefined) throw new YuqiOrchestratorError('INVALID_BATCH', batchIssue)
      await transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the revision tasks')
      return next
    })
  }
}
