import { describe, expect, it } from 'vitest'
import { DurableJournalCoordinator, TeamBootstrapCoordinator } from '../src/index.ts'
import type { TeamEvent, TeamEventJournal, TeamTaskContract } from '../src/index.ts'
import { TaskId } from '../src/index.ts'

class Journal implements TeamEventJournal {
  readonly key = 'bootstrap-controller'
  readonly events: TeamEvent[] = []
  fail = false

  read(): readonly unknown[] { return this.events }

  async commit(events: readonly TeamEvent[]): Promise<void> {
    if (this.fail) throw new Error('append failed')
    this.events.push(...events)
  }
}

function contract(taskId: string, dependencies: readonly string[] = []): TeamTaskContract {
  return {
    taskId: TaskId(taskId), revision: 1, goal: `Deliver ${taskId}`, scope: ['src'], nonGoals: ['deploy'],
    dependencies: dependencies.map(TaskId), fileScope: [`${taskId}/**`], modelRole: 'worker', modelId: 'deepseek-v4',
    acceptanceCriteria: ['tests pass'], authorityMode: 'write-authorized', inputDigest: `digest-${taskId}`, baselineRef: 'commit-1',
  }
}

function bootstrap(journal = new Journal(), tasks: readonly TeamTaskContract[] = [contract('root')]) {
  let eventNumber = 0
  const transactions = new DurableJournalCoordinator()
  const coordinator = new TeamBootstrapCoordinator(
    { nowIso: () => '2026-08-16T00:00:00Z' },
    { next: () => `bootstrap-${eventNumber++}` },
    transactions,
  )
  return { journal, coordinator, transactions, request: { metadata: { teamId: 'team-bootstrap', title: 'Bootstrap', objective: 'Initialize graph' }, tasks } }
}

describe('durable Team bootstrap', () => {
  it('durably defaults automatic task attempt budgets and remains idempotent', async () => {
    const setup = bootstrap()
    const { modelId: _rootModel, ...root } = contract('root')
    const { modelId: _explicitModel, ...explicit } = contract('explicit')
    const request = { ...setup.request, metadata: { ...setup.request.metadata,
      modelRouting: { providerScope: { kind: 'controller-only' as const }, teamPolicy: {
        kind: 'automatic' as const, tierCandidates: { quick: [], standard: [], critical: [] },
      } },
    }, tasks: [{ ...root, modelRequest: { kind: 'default' as const } },
      { ...explicit, modelRequest: { kind: 'default' as const }, maxAttempts: 1 }] }
    const first = await setup.coordinator.bootstrap(request, setup.journal)
    expect(first.tasks.root?.contract.maxAttempts).toBe(3)
    expect(first.tasks.explicit?.contract.maxAttempts).toBe(1)
    const size = setup.journal.events.length
    await setup.coordinator.bootstrap(request, setup.journal)
    expect(setup.journal.events).toHaveLength(size)
  })
  it('atomically creates a running Team and topologically ordered task DAG', async () => {
    const setup = bootstrap(new Journal(), [contract('leaf', ['middle']), contract('middle', ['root']), contract('root')])
    const request = {
      ...setup.request,
      metadata: {
        ...setup.request.metadata,
        controllerModel: { provider: 'deepseek', model: 'deepseek-v4', maxTokens: 8192 },
        directWriteStrategy: 'strict-writer-serial' as const,
        modelRouting: {
          providerScope: { kind: 'controller-plus-allowlist' as const, providerAllowlist: ['external'] },
          teamPolicy: { kind: 'fixed' as const, model: { modelProvider: 'external', modelId: 'worker-model' } },
        },
      },
    }
    const projection = await setup.coordinator.bootstrap(request, setup.journal)
    expect(projection.team.status).toBe('running')
    expect(projection.team.locale).toBe('zh')
    expect(projection.team.reviewPolicy).toEqual({ mode: 'manual', maxReworkRounds: 2, additionalPrompt: '' })
    expect(projection.team.controllerModel).toEqual({ provider: 'deepseek', model: 'deepseek-v4', maxTokens: 8192 })
    expect(projection.team.directWriteStrategy).toBe('strict-writer-serial')
    expect(projection.team.modelRouting).toEqual({
      providerScope: { kind: 'controller-plus-allowlist', providerAllowlist: ['external'] },
      teamPolicy: { kind: 'fixed', model: { modelProvider: 'external', modelId: 'worker-model' } },
    })
    expect(projection.taskIds).toEqual([TaskId('root'), TaskId('middle'), TaskId('leaf')])
    expect(setup.journal.events.map(event => event.type)).toEqual([
      'yuqi/team-created', 'yuqi/team-status-changed', 'yuqi/task-created', 'yuqi/task-created', 'yuqi/task-created',
    ])
    await setup.transactions.dispose()

    const providerOnly = bootstrap()
    const providerProjection = await providerOnly.coordinator.bootstrap({
      ...providerOnly.request,
      metadata: {
        ...providerOnly.request.metadata,
        controllerModel: { provider: 'deepseek' },
      },
    }, providerOnly.journal)
    expect(providerProjection.team.controllerModel).toEqual({ provider: 'deepseek' })
    expect(providerProjection.team.directWriteStrategy).toBe('planned-scope-parallel')
    await providerOnly.transactions.dispose()
  })

  it('atomically creates a paused Team when plan confirmation is required', async () => {
    const setup = bootstrap(new Journal(), [contract('root'), contract('leaf', ['root'])])
    const projection = await setup.coordinator.bootstrap({
      ...setup.request,
      requirePlanConfirmation: true,
    }, setup.journal)

    expect(projection.team.status).toBe('paused')
    expect(projection.team.startedAt).toBe('2026-08-16T00:00:00Z')
    expect(projection.team.planConfirmationRequired).toBe(true)
    expect(projection.controlOperations['plan-review:team-bootstrap']).toEqual({
      id: 'plan-review:team-bootstrap',
      action: 'pause',
    })
    expect(setup.journal.events.map(event => event.type)).toEqual([
      'yuqi/team-created', 'yuqi/team-control-requested', 'yuqi/team-status-changed', 'yuqi/team-status-changed',
      'yuqi/team-status-changed', 'yuqi/task-created', 'yuqi/task-created',
    ])
    await setup.transactions.dispose()
  })

  it('persists an explicit English locale and keeps omitted legacy metadata Chinese-compatible', async () => {
    const english = bootstrap()
    const projection = await english.coordinator.bootstrap({
      ...english.request,
      metadata: { ...english.request.metadata, locale: 'en' },
    }, english.journal)
    expect(english.journal.events[0]).toMatchObject({ type: 'yuqi/team-created', locale: 'en' })
    expect(projection.team.locale).toBe('en')
    await english.transactions.dispose()

    const legacy = bootstrap()
    const legacyProjection = await legacy.coordinator.bootstrap(legacy.request, legacy.journal)
    expect(legacyProjection.team.locale).toBe('zh')
    await legacy.transactions.dispose()
  })

  it.each([
    { mode: 'off', maxReworkRounds: 0, additionalPrompt: 'disabled criteria remain durable' },
    { mode: 'manual', maxReworkRounds: 1, additionalPrompt: 'manual criteria' },
    { mode: 'quality-gate', maxReworkRounds: 3, additionalPrompt: 'inspect migrations and rollback' },
  ] as const)('copies the complete $mode policy into the Team event and projection', async reviewPolicy => {
    const setup = bootstrap()
    const projection = await setup.coordinator.bootstrap({
      ...setup.request,
      metadata: { ...setup.request.metadata, reviewPolicy },
    }, setup.journal)

    expect(setup.journal.events[0]).toMatchObject({ type: 'yuqi/team-created', reviewPolicy })
    expect(projection.team.reviewPolicy).toEqual(reviewPolicy)
    await setup.transactions.dispose()
  })

  it('replays an identical initialized bundle and rejects conflicting metadata or graph', async () => {
    const setup = bootstrap()
    const first = await setup.coordinator.bootstrap(setup.request, setup.journal)
    const count = setup.journal.events.length
    const second = await setup.coordinator.bootstrap(setup.request, setup.journal)
    expect(second.lastEventId).toBe(first.lastEventId)
    expect(setup.journal.events).toHaveLength(count)
    await expect(setup.coordinator.bootstrap({ ...setup.request, metadata: { ...setup.request.metadata, title: 'Different' } }, setup.journal)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await expect(setup.coordinator.bootstrap({
      ...setup.request,
      metadata: { ...setup.request.metadata, controllerModel: { provider: 'deepseek' } },
    }, setup.journal)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await expect(setup.coordinator.bootstrap({ ...setup.request, tasks: [contract('other')] }, setup.journal)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await expect(setup.coordinator.bootstrap({ ...setup.request, requirePlanConfirmation: true }, setup.journal)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await setup.transactions.dispose()

    const gated = bootstrap()
    await gated.coordinator.bootstrap({ ...gated.request, requirePlanConfirmation: true }, gated.journal)
    await expect(gated.coordinator.bootstrap({ ...gated.request, requirePlanConfirmation: false }, gated.journal)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await gated.transactions.dispose()
  })

  it('rejects invalid dependency graphs before publishing durable facts', async () => {
    const missing = bootstrap(new Journal(), [contract('child', ['missing'])])
    await expect(missing.coordinator.bootstrap(missing.request, missing.journal)).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    expect(missing.journal.events).toHaveLength(0)
    await missing.transactions.dispose()

    const cycle = bootstrap(new Journal(), [contract('left', ['right']), contract('right', ['left'])])
    await expect(cycle.coordinator.bootstrap(cycle.request, cycle.journal)).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    expect(cycle.journal.events).toHaveLength(0)
    await cycle.transactions.dispose()

    const duplicate = bootstrap(new Journal(), [contract('same'), contract('same')])
    await expect(duplicate.coordinator.bootstrap(duplicate.request, duplicate.journal)).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    expect(duplicate.journal.events).toHaveLength(0)
    await duplicate.transactions.dispose()

    const invalidControllerLimit = bootstrap()
    await expect(invalidControllerLimit.coordinator.bootstrap({
      ...invalidControllerLimit.request,
      metadata: {
        ...invalidControllerLimit.request.metadata,
        controllerModel: { provider: 'deepseek', maxTokens: 0 },
      },
    }, invalidControllerLimit.journal)).rejects.toThrow()
    expect(invalidControllerLimit.journal.events).toHaveLength(0)
    await invalidControllerLimit.transactions.dispose()
  })

  it('does not publish a partial bootstrap when append fails', async () => {
    const setup = bootstrap()
    setup.journal.fail = true
    await expect(setup.coordinator.bootstrap(setup.request, setup.journal)).rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
    expect(setup.journal.events).toHaveLength(0)
    await expect(setup.coordinator.bootstrap(setup.request, setup.journal)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    await setup.transactions.dispose()
  })

  it('rejects an empty task graph before publishing any Team facts', async () => {
    const setup = bootstrap(new Journal(), [])
    await expect(setup.coordinator.bootstrap(setup.request, setup.journal)).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    expect(setup.journal.events).toHaveLength(0)
    await setup.transactions.dispose()
  })
})
