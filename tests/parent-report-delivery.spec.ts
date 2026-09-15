import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { AttemptId, ControlOperationId, TaskId, WorkspaceId, type TeamEvent } from '../src/index.ts'
import {
  buildBoundedParentReport,
  deliverParentReport,
  PARENT_REPORT_MAX_CHARS,
  parentReportMessageId,
} from '../src/host/harness/parent-report-delivery.ts'
import {
  HarnessSessionJournal,
  parseTeamParentReportCheckpointData,
  readLatestTeamParentReportCheckpoint,
  TEAM_PARENT_BINDING_EVENT,
  TEAM_PARENT_PROJECTION_EVENT,
  TEAM_PARENT_REPORT_CHECKPOINT_EVENT,
  TEAM_SESSION_EVENT,
} from '../src/host/harness/session-journal.ts'
import { completeTeamEvents, contract, event } from './fixtures.ts'
import { snapshotOnlySession } from './snapshot-session-fixture.ts'
import { SidecarRepository, appendSidecarEvent, hasSidecarSession } from '../src/host/storage/session-sidecar.ts'
import type { OwnedEventRecord, OwnedEventTable } from '../src/host/storage/owned-event-store.ts'
import { YuqiTeamOrchestratorService } from '../src/host/harness/service.ts'
import type { HarnessSessionStore } from '../src/host/harness/session-store-adapter.ts'

describe('durable parent report delivery', () => {
  it('suppresses an older parent bridge after the controller has committed a newer cut', async () => {
    const events = completeTeamEvents().slice(0, 3)
    const harness = setupDelivery(undefined, events)
    await harness.journal.commit([event(20, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'pausing', reason: 'newer control fact',
    })])

    await expect(deliverParentReport(harness.request())).resolves.toEqual({
      kind: 'suppressed', sourceEventCount: events.length,
    })
    expect(harness.inbox.nextTurn).toHaveLength(0)
    expect(readLatestTeamParentReportCheckpoint(harness.controller.session, String(harness.parent.id), 1)).toBeUndefined()
  })

  it('suppresses an old running bridge when a child settles without changing Team status', async () => {
    const events = completeTeamEvents().slice(0, 8)
    const harness = setupDelivery(undefined, events)
    await harness.journal.commit([
      event(20, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'settled' }),
    ])

    await expect(deliverParentReport(harness.request())).resolves.toEqual({
      kind: 'suppressed', sourceEventCount: events.length,
    })
    expect(harness.inbox.nextTurn).toHaveLength(0)
  })

  it('suppresses an exact UI-only cut without sending or forging a delivery checkpoint', async () => {
    const harness = setupDelivery()
    const send = vi.spyOn(harness.parent, 'send')
    await expect(deliverParentReport({ ...harness.request(), shouldDeliver: () => false }))
      .resolves.toEqual({ kind: 'suppressed', sourceEventCount: completeTeamEvents().length })
    expect(send).not.toHaveBeenCalled()
    expect(harness.inbox.nextTurn).toHaveLength(0)
    expect(readLatestTeamParentReportCheckpoint(harness.controller.session, String(harness.parent.id), 1)).toBeUndefined()

    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({ kind: 'delivered' })
    expect(send).toHaveBeenCalledOnce()
    expect(readLatestTeamParentReportCheckpoint(harness.controller.session, String(harness.parent.id), 1)).toBeDefined()
  })

  it.each(['false', 'throw'] as const)('flushes the live parent of a cold controller and keeps %s failures unacknowledged', async failure => {
    const harness = setupDelivery()
    const records = new Map<string, OwnedEventRecord>()
    const table: OwnedEventTable = {
      get: key => records.get(key), entries: () => records.entries(),
      put: async (key, value) => { records.set(key, value) },
      update: async (key, transform) => {
        const next = transform(records.get(key)!)
        records.set(key, next)
        return next
      },
    }
    const repository = new SidecarRepository(table)
    let durable = false
    let liveParent = harness.parent
    const flush = vi.fn(async (session: Session) => {
      expect(session).toBe(liveParent.session)
      if (!durable && failure === 'throw') throw new Error('native write failed')
      return durable
    })
    const service = Object.create(YuqiTeamOrchestratorService.prototype) as {
      parentProjectionSessionStore(session: Session, base?: HarnessSessionStore): Promise<HarnessSessionStore>
      controllerAgents: Map<SessionId, Agent>
    }
    Object.assign(service, {
      ctx: { get: () => ({ flush, get: () => liveParent.session }), sessionPersistence: {} },
      controllerAgents: new Map([[harness.parent.id, liveParent]]),
      bindSidecar: (session: Session) => { if (!hasSidecarSession(session)) repository.bind(session) },
    })
    try {
      // Cold controller persistence is intentionally not a native inbox barrier.
      const controllerSession = Session.create(harness.controller.id, [], harness.controller.session.header)
      const parentSession = Session.create(harness.parent.id, [], harness.parent.session.header)
      repository.bind(controllerSession)
      repository.bind(parentSession)
      for (const event of harness.controller.session.events) {
        if (event.type.startsWith('yuqi/')) await appendSidecarEvent(controllerSession, event.type, event.data)
      }
      for (const event of harness.parent.session.events) {
        if (event.type.startsWith('yuqi/')) await appendSidecarEvent(parentSession, event.type, event.data)
      }
      const inbox = new Inbox(parentSession, { inserted() {}, discarded() {}, claimed() {} })
      const parent = { ...harness.parent, session: parentSession, inbox,
        send: (message: Parameters<Agent['send']>[0], target: Parameters<Agent['send']>[1]) => inbox.append(target, message),
      } as unknown as Agent
      liveParent = parent
      service.controllerAgents = new Map([[parent.id, parent]])
      const controller = { ...harness.controller, session: controllerSession }
      const sessions = await service.parentProjectionSessionStore(controllerSession)
      const journal = new HarnessSessionJournal(controllerSession, sessions)
      const request = { ...harness.request(), controller, parent, sessions, journal }
      await expect(deliverParentReport(request)).resolves.toMatchObject({ kind: 'pending', reason: 'parent-flush-failed' })
      expect(readLatestTeamParentReportCheckpoint(controllerSession, String(parent.id), 1)).toBeUndefined()
      expect(inbox.nextTurn).toHaveLength(1)
      durable = true
      await expect(deliverParentReport(request)).resolves.toMatchObject({ kind: 'delivered', replayedInboxWrite: true })
      expect(flush).toHaveBeenCalledTimes(2)
      const checkpoint = readLatestTeamParentReportCheckpoint(controllerSession, String(parent.id), 1)
      expect(checkpoint?.sourceEventCount).toBe(completeTeamEvents().length)
      // A fresh repository/session represents reopening the durable controller.
      const reopenedRepository = new SidecarRepository(table)
      const reopened = Session.create(harness.controller.id, [], controllerSession.header)
      reopenedRepository.bind(reopened)
      try {
        for (const event of repository.readStoredEvents(String(controllerSession.id))) await appendSidecarEvent(reopened, event.type, event.data)
        const reopenedController = { ...harness.controller, session: reopened }
        await expect(deliverParentReport({ ...request, controller: reopenedController, journal: new HarnessSessionJournal(reopened, sessions) }))
          .resolves.toMatchObject({ kind: 'already-delivered' })
        expect(inbox.nextTurn).toHaveLength(1)
      } finally { reopenedRepository.dispose() }
    } finally { repository.dispose() }
  })
  it('reads a sidecar bridge while deduplicating retries from the native inbox', async () => {
    let flushed = false
    const harness = setupDelivery(() => flushed)
    const parentSession = Session.create(harness.parent.id)
    const records = new Map<string, OwnedEventRecord>()
    const table: OwnedEventTable = {
      get: key => records.get(key), entries: () => records.entries(),
      put: async (key, value) => { records.set(key, value) },
      update: async (key, transform) => {
        const value = transform(records.get(key)!)
        records.set(key, value)
        return value
      },
    }
    const repository = new SidecarRepository(table)
    repository.bind(parentSession)
    const inbox = new Inbox(parentSession, { inserted() {}, discarded() {}, claimed() {} })
    const parent = { ...harness.parent, session: parentSession, inbox,
      send: vi.fn((message: Parameters<Agent['send']>[0], target: Parameters<Agent['send']>[1]) => inbox.append(target, message)),
    } as unknown as Agent
    const request = { ...harness.request(), parent }
    try {
      await expect(deliverParentReport(request)).resolves.toMatchObject({ kind: 'pending', reason: 'projection-unavailable' })
      const bridge = harness.parent.session.events.find(event => event.type === TEAM_PARENT_PROJECTION_EVENT)!
      await appendSidecarEvent(parentSession, TEAM_PARENT_PROJECTION_EVENT, bridge.data)
      await expect(deliverParentReport(request)).resolves.toMatchObject({ kind: 'pending', reason: 'parent-flush-failed' })
      expect(inbox.nextTurn).toHaveLength(1)
      flushed = true
      await expect(deliverParentReport(request)).resolves.toMatchObject({ kind: 'delivered', replayedInboxWrite: true })
      await expect(deliverParentReport(request)).resolves.toMatchObject({ kind: 'already-delivered' })
      expect(parent.send).toHaveBeenCalledTimes(1)
      expect(parentSession.events.some(event => event.type.startsWith('yuqi/'))).toBe(false)
    } finally {
      repository.dispose()
    }
  })
  it('reads snapshot-only parent history and retries an existing inbox write without duplication', async () => {
    let flushed = false
    const harness = setupDelivery(() => flushed)
    const request = harness.request()
    const parent = { ...harness.parent, session: snapshotOnlySession(harness.parent.session) } as Agent
    await expect(deliverParentReport({ ...request, parent })).resolves.toMatchObject({ kind: 'pending', reason: 'parent-flush-failed' })
    expect(harness.inbox.nextTurn).toHaveLength(1)
    flushed = true
    await expect(deliverParentReport({ ...request, parent })).resolves.toMatchObject({ kind: 'delivered', replayedInboxWrite: true })
    await expect(deliverParentReport({ ...request, parent })).resolves.toMatchObject({ kind: 'already-delivered' })
    expect(harness.inbox.nextTurn).toHaveLength(1)
  })
  it('delivers manual return context to the parent inbox and deduplicates the same durable cut', async () => {
    const events = [...recoverableRefusal('journal').events.slice(0, 7),
      event(40, { type: 'yuqi/task-manual-acquired', taskId: TaskId('task-1'), operationId: ControlOperationId('parent-manual-a'), workspacePath: 'F:/managed/reason' }),
      event(41, { type: 'yuqi/task-manual-returned', taskId: TaskId('task-1'), acquisitionId: ControlOperationId('parent-manual-a'), operationId: ControlOperationId('parent-manual-r'), summary: 'Changed app/a.txt manually. Verification still required.' }),
    ]
    const harness = setupDelivery(undefined, events)
    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({ kind: 'delivered' })
    const text = harness.inbox.nextTurn[0]!.content.find(block => block.type === 'text')!.text
    expect(text).toContain('teamStatus=paused')
    expect(text).toContain('manualReturnSummary task=task-1')
    expect(text).toContain('Changed app/a.txt manually. Verification still required.')
    expect(text).toContain('not verified completion')
    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({ kind: 'already-delivered' })
    expect(harness.inbox.nextTurn).toHaveLength(1)
  })
  it.each(['zh', 'en'] as const)('keeps admitted execution and aborted facts in a long cancelled report (%s)', async locale => {
    const events = [
      ...completeTeamEvents().slice(0, 8).map(item => item.type === 'yuqi/team-created' ? { ...item, locale } : item),
      ...Array.from({ length: 30 }, (_, index) => event(100 + index, {
        type: 'yuqi/task-created', contract: { ...contract(TaskId(`pending-${index}`)), goal: 'x'.repeat(1_000) },
      })),
      event(200, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
      event(201, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'cancelled' }),
      event(202, {
        type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'),
        runId: 'cancel-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'aborted',
        hasAssistantOutput: false, settledAt: '2026-09-05T08:00:00Z',
      }),
      event(203, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'cancelled' }),
      ...Array.from({ length: 30 }, (_, index) => event(210 + index, {
        type: 'yuqi/task-status-changed', taskId: TaskId(`pending-${index}`), from: 'pending', to: 'cancelled',
      })),
      event(250, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' }),
    ]
    const harness = setupDelivery(undefined, events)
    await deliverParentReport(harness.request())
    const text = harness.inbox.nextTurn[0]!.content.find(block => block.type === 'text')!.text
    expect(text).toContain('teamStatus=cancelled')
    expect(text).toContain('admittedAttempts=1')
    expect(text).toContain('admittedChildren=1')
    expect(text).toContain('admittedAttempt=attempt-1 task=task-1 child=session-worker-1 stopReason=aborted')
    expect(text).toContain(locale === 'en' ? 'Cancelled does not mean never started.' : 'cancelled 不代表从未启动')
    expect(text).toContain(locale === 'en' ? 'latest Host task/attempt states and corresponding execution records' : '最新 Host task/attempt 状态与对应执行记录')
    expect(text).toContain(locale === 'en' ? 'it does not make a pending/cancelled task completed' : '不能把 pending/cancelled 任务说成已完成')
    expect(text).toContain(locale === 'en' ? 'do not infer execution for a pending task without an attempt record' : 'pending 任务没有 attempt 记录时不得推断已执行')
    expect(text).toContain(locale === 'en' ? 'Do not use an older paused snapshot to infer no execution' : '不得依据旧 paused 快照推断未执行')
    expect(text).toContain(locale === 'en' ? '[report truncated]' : '[报告已截断]')
    expect(text.length).toBeLessThanOrEqual(PARENT_REPORT_MAX_CHARS)
    // Admission and end evidence do not prove a particular tool call or token count.
    expect(text).not.toContain('ask_user_question')
    expect(text).not.toContain('9516')
    const withoutEndEvidence = reportFor(events.filter(item => item.type !== 'yuqi/attempt-evidence-recorded'))
    expect(withoutEndEvidence).toContain('child=session-worker-1 stopReason=unknown')
    expect(withoutEndEvidence).not.toContain('stopReason=aborted')
    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({ kind: 'already-delivered' })
    expect(harness.inbox.nextTurn).toHaveLength(1)
  })

  it.each(['zh', 'en'] as const)('does not invent execution or user actions when cancelled without admission (%s)', locale => {
    const events = [
      ...completeTeamEvents().slice(0, 3).map(item => item.type === 'yuqi/team-created' ? { ...item, locale } : item),
      event(20, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
      event(21, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'pending', to: 'cancelled' }),
      event(22, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' }),
    ]
    const text = reportFor(events)
    expect(text).toContain('admittedAttempts=0')
    expect(text).toContain('admittedChildren=0')
    expect(text).not.toContain('admittedAttempt=')
    expect(text).not.toContain('stopReason=aborted')
    expect(text).toContain(locale === 'en'
      ? 'No child admission is recorded in this cut; this alone does not establish what the user clicked or why cancellation occurred.'
      : '此快照没有 child 接纳记录；仅凭这一点不能断言用户点击情况或取消原因。')
  })

  it.each(['zh', 'en'] as const)('preserves snapshot and conditional start guidance after truncation (%s)', async locale => {
    const events = [
      ...completeTeamEvents().slice(0, 3).map(item => item.type === 'yuqi/team-created'
        ? { ...item, locale, title: 'x'.repeat(PARENT_REPORT_MAX_CHARS) } : item),
      ...Array.from({ length: 30 }, (_, index) => event(100 + index, {
        type: 'yuqi/task-created',
        contract: { ...contract(TaskId(`long-${index}`)), goal: 'y'.repeat(1_000) },
      })),
      event(200, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(201, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused', reason: 'waiting for initial plan confirmation' }),
    ]
    const harness = setupDelivery(undefined, events)
    await deliverParentReport(harness.request())
    const message = harness.inbox.nextTurn[0]!
    const text = message.content.find(block => block.type === 'text')!.text
    expect(text.length).toBeLessThanOrEqual(PARENT_REPORT_MAX_CHARS)
    expect(text).toContain(locale === 'en' ? '[report truncated]' : '[报告已截断]')
    expect(text).toContain(locale === 'en' ? 'The user may act in the panel while a reply is being generated.' : '用户可能在回答生成期间操作面板。')
    expect(text).toContain(locale === 'en' ? 'Prefer newer state or operation results' : '以更新的状态或操作结果为准')
    expect(text).toContain(locale === 'en' ? 'solely from this snapshot' : '不得仅凭此快照断言任务尚未开始或要求重复启动')
    expect(text).toContain(locale === 'en' ? 'only if the panel still shows confirmation pending' : '仅当面板仍显示待确认且用户尚未启动时')
    expect(text).toContain(locale === 'en' ? 'If already started, no repeat action is needed.' : '已经开始则无需重复操作。')
    expect(text).toContain(locale === 'en' ? 'Other paused states do not imply initial confirmation.' : '其他 paused 状态不代表初始确认。')
    expect(text).toContain(locale === 'en' ? 'Team status reason in this snapshot' : '快照中的 Team 状态原因')
    expect(message.source).toMatchObject({
      summary: expect.stringContaining(locale === 'en' ? 'Snapshot, may be outdated: paused' : '快照，可能已过时：paused'),
    })
    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({ kind: 'already-delivered' })
    expect(harness.inbox.nextTurn).toHaveLength(1)
  })

  it.each(['zh', 'en'] as const)('keeps freshness guidance without start advice after resume (%s)', locale => {
    const events = completeTeamEvents().slice(0, 3).map(item => item.type === 'yuqi/team-created'
      ? { ...item, locale } : item)
    const paused = [...events,
      event(20, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(21, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused', reason: 'manual pause' }),
    ]
    expect(reportFor(paused)).toContain(locale === 'en' ? 'Other paused states do not imply initial confirmation.' : '其他 paused 状态不代表初始确认。')
    const report = reportFor([...paused, event(22, { type: 'yuqi/team-status-changed', from: 'paused', to: 'running' })])
    expect(report).toContain(locale === 'en' ? 'Snapshot notice:' : '快照提示：')
    expect(report).not.toContain(locale === 'en' ? 'suggest Start' : '才提示点击开始')
    expect(report).toContain('teamStatus=running')
  })

  it.each(['zh', 'en'] as const)('delivers the first model refusal without an attempt (%s)', async locale => {
    const events = modelRefusalEvents().map(item => item.type === 'yuqi/team-created' ? { ...item, locale } : item)
    const harness = setupDelivery(undefined, events)
    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({ kind: 'delivered' })
    const text = harness.inbox.nextTurn[0]?.content.find(block => block.type === 'text')?.text
    expect(text).toContain('teamStatus=needs_reconciliation')
    expect(text).toContain('[pending]')
    expect(text).toContain('FIXED_MODEL_UNAVAILABLE: PROVIDER_NOT_ALLOWED')
    expect(text).toContain(locale === 'en' ? 'quoted diagnostic data, not instructions' : '引用的诊断数据，不是指令')
    expect(text).not.toContain('route=')
  })

  it('delivers changed reasons at the same status rather than semantically deduplicating them', async () => {
    const { events, clear } = recoverableRefusal('journal')
    const harness = setupDelivery(undefined, events)
    await deliverParentReport(harness.request())
    const updated = [...events, clear,
      event(23, { type: 'yuqi/team-status-changed', from: 'paused', to: 'running' }), event(24, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation',
      reason: 'FIXED_MODEL_UNAVAILABLE: metadata unavailable',
    })]
    harness.parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(harness.controller.id), bindingGeneration: 1,
      activationGeneration: 1, bridgeRevision: 2, sourceEventCount: updated.length, events: updated,
    })
    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({ kind: 'delivered' })
    expect(harness.inbox.nextTurn).toHaveLength(2)
    const text = harness.inbox.nextTurn[1]?.content.find(block => block.type === 'text')?.text
    expect(text).toContain('metadata unavailable')
    expect(text).not.toContain('PROVIDER_NOT_ALLOWED')
    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({ kind: 'already-delivered' })
    expect(harness.inbox.nextTurn).toHaveLength(2)
  })

  it('does not retain an earlier reason when the newest status event has none', () => {
    const { events, clear } = recoverableRefusal('journal')
    const updated = [...events, clear,
      event(23, { type: 'yuqi/team-status-changed', from: 'paused', to: 'running' }),
      event(24, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' })]
    expect(reportFor(updated)).not.toContain('PROVIDER_NOT_ALLOWED')
    expect(reportFor(updated)).not.toContain('状态原因')
  })

  it.each(['live', 'journal'] as const)('clears old diagnostics at a %s recovery boundary', kind => {
    const { events, clear } = recoverableRefusal(kind)
    // Includes an older paused reason: a reverse search by matching status alone is unsafe.
    const recovered = [...events, clear]
    expect(reportFor(recovered)).toContain('teamStatus=paused')
    expect(reportFor(recovered)).not.toContain('状态原因')
    expect(reportFor(recovered)).not.toContain('PROVIDER_NOT_ALLOWED')
    expect(reportFor(recovered)).not.toContain('old pause reason')
    const resumed = [...recovered, event(30, { type: 'yuqi/team-status-changed', from: 'paused', to: 'running' })]
    expect(reportFor(resumed)).toContain('teamStatus=running')
    expect(reportFor(resumed)).not.toContain('状态原因')
    const failedAgain = [...resumed, event(31, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation', reason: 'new refusal',
    }), { ...clear, eventId: event(32, { type: 'yuqi/team-status-changed', from: 'running', to: 'running' }).eventId }]
    expect(reportFor(failedAgain)).toContain('new refusal')
  })

  it('bounds and quotes diagnostic data without letting it create report lines', () => {
    const events = [...completeTeamEvents().slice(0, 3), event(21, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation',
      reason: 'diagnostic "quote"\nsecond line ' + 'x'.repeat(20_000),
    })]
    const report = reportFor(events)
    const diagnostic = report.split('\n').find(line => line.startsWith('快照中的 Team 状态原因'))!
    const quoted = diagnostic.slice(diagnostic.indexOf('：') + 1)
    expect(JSON.parse(quoted)).toHaveLength(512)
    expect(JSON.parse(quoted)).toContain('diagnostic "quote" second line')
    expect(JSON.parse(quoted)).toMatch(/…$/u)
    expect(report.length).toBeLessThanOrEqual(PARENT_REPORT_MAX_CHARS)
  })

  it('flushes the real Harness inbox before checkpointing and replays idempotently', async () => {
    const harness = setupDelivery()

    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({
      kind: 'delivered',
      sourceEventCount: completeTeamEvents().length,
      replayedInboxWrite: false,
    })

    const messageId = parentReportMessageId(
      String(harness.controller.id),
      String(harness.parent.id),
      1,
      completeTeamEvents().length,
    )
    expect(harness.inbox.nextTurn).toHaveLength(1)
    expect(harness.inbox.nextTurn[0]).toMatchObject({ id: messageId, role: 'user' })
    expect(Object.isFrozen(harness.inbox.nextTurn[0])).toBe(true)
    expect(harness.flushOrder).toEqual(['parent', 'controller'])
    expect(readLatestTeamParentReportCheckpoint(harness.controller.session, String(harness.parent.id), 1)).toMatchObject({
      messageId,
      sourceEventCount: completeTeamEvents().length,
    })

    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({ kind: 'already-delivered', messageId })
    expect(harness.inbox.nextTurn).toHaveLength(1)
    expect(harness.parent.session.events.filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(1)
    expect(harness.controller.session.events.filter(event => event.type === TEAM_PARENT_REPORT_CHECKPOINT_EVENT)).toHaveLength(1)
  })

  it('reflushes one deterministic inbox write after failure without duplicating payload state', async () => {
    let parentFlushes = 0
    const harness = setupDelivery(session => {
      if (session === harness.parent.session) return ++parentFlushes > 1
      return true
    })

    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({
      kind: 'pending', reason: 'parent-flush-failed',
    })
    expect(harness.inbox.nextTurn).toHaveLength(1)
    expect(readLatestTeamParentReportCheckpoint(harness.controller.session, String(harness.parent.id), 1)).toBeUndefined()

    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({
      kind: 'delivered', replayedInboxWrite: true,
    })
    expect(harness.inbox.nextTurn).toHaveLength(1)
    expect(harness.parent.session.events.filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(1)
  })

  it('advances the durable checkpoint without waking the parent for a semantically identical cut', async () => {
    const running = completeTeamEvents().slice(0, 8)
    const harness = setupDelivery(undefined, running)
    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({ kind: 'delivered' })
    expect(harness.inbox.nextTurn).toHaveLength(1)

    const usageOnly = [...running, event(18, {
      type: 'yuqi/attempt-usage-observed',
      taskId: TaskId('task-1'),
      attemptId: AttemptId('attempt-1'),
      agentSessionId: 'session-worker-1',
      usage: { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })] as const
    harness.parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(harness.controller.id), bindingGeneration: 1,
      activationGeneration: 1, bridgeRevision: 2,
      sourceEventCount: usageOnly.length, events: usageOnly,
    })

    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({
      kind: 'already-delivered', sourceEventCount: usageOnly.length,
    })
    expect(harness.inbox.nextTurn).toHaveLength(1)
    expect(readLatestTeamParentReportCheckpoint(harness.controller.session, String(harness.parent.id), 1))
      .toMatchObject({ sourceEventCount: usageOnly.length })
  })

  it('reflushes an in-memory checkpoint before trusting it after a controller flush failure', async () => {
    let controllerFlushes = 0
    const harness = setupDelivery(session => String(session.id) !== 'parent-report-controller' || ++controllerFlushes > 1)

    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({
      kind: 'pending', reason: 'checkpoint-failed',
    })
    expect(harness.controller.session.events.filter(event => event.type === TEAM_PARENT_REPORT_CHECKPOINT_EVENT)).toHaveLength(1)

    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({ kind: 'already-delivered' })
    expect(controllerFlushes).toBe(2)
    expect(harness.inbox.nextTurn).toHaveLength(1)
  })

  it('leaves an offline parent pending and isolates checkpoints by binding generation', async () => {
    const harness = setupDelivery()
    await expect(deliverParentReport({ ...harness.request(), parent: undefined })).resolves.toEqual({
      kind: 'pending', reason: 'parent-offline',
    })
    expect(harness.parent.session.events.filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(0)

    await deliverParentReport(harness.request())
    harness.controller.session.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(harness.parent.id), generation: 2,
      operationId: 'parent-report-generation-2', boundAt: '2026-09-01T00:00:00.000Z',
    })
    harness.parent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(harness.controller.id), bindingGeneration: 2,
      activationGeneration: 1, bridgeRevision: 2,
      sourceEventCount: completeTeamEvents().length, events: completeTeamEvents(),
    })

    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({ kind: 'delivered' })
    expect(harness.inbox.nextTurn.map(message => String(message.id))).toEqual([
      parentReportMessageId(String(harness.controller.id), String(harness.parent.id), 1, completeTeamEvents().length),
      parentReportMessageId(String(harness.controller.id), String(harness.parent.id), 2, completeTeamEvents().length),
    ])
    expect(readLatestTeamParentReportCheckpoint(harness.controller.session, String(harness.parent.id), 1)?.bindingGeneration).toBe(1)
    expect(readLatestTeamParentReportCheckpoint(harness.controller.session, String(harness.parent.id), 2)?.bindingGeneration).toBe(2)
  })

  it('parses only valid checkpoints and bounds regenerated report text', () => {
    expect(parseTeamParentReportCheckpointData({ bindingGeneration: -1 })).toBeUndefined()
    const events = completeTeamEvents().map(event => event.type === 'yuqi/task-created'
      ? { ...event, contract: { ...event.contract, goal: 'x'.repeat(PARENT_REPORT_MAX_CHARS * 2) } }
      : event)
    const bridge = {
      controllerSessionId: 'bounded-controller', bindingGeneration: 1,
      sourceEventCount: events.length, events,
    }
    const report = buildBoundedParentReport(bridge, 1)
    expect(report.length).toBeLessThanOrEqual(PARENT_REPORT_MAX_CHARS)
    expect(report).toContain('sourceEventCut=17 bindingGeneration=1')
    expect(report).toContain('…')
  })

  it('renders Host-authored parent report copy in the durable Team locale', () => {
    const events = completeTeamEvents().map(event => event.type === 'yuqi/team-created'
      ? { ...event, locale: 'en' as const }
      : event)
    const report = buildBoundedParentReport({
      controllerSessionId: 'english-controller', sourceEventCount: events.length, events,
    }, 1)
    expect(report).toContain('Yuqi Team controller update:')
    expect(report).toContain('Report this final Team result in the current main conversation')
    expect(report).not.toContain('主控更新')
  })

  it('includes a bounded child conclusion in the main-controller report', () => {
    const events = completeTeamEvents()
    const report = buildBoundedParentReport({
      controllerSessionId: 'report-controller', sourceEventCount: events.length, events,
    }, 1, [{ taskId: 'task-1', status: 'completed', output: 'Changed the header and verified the focused interaction.' }])
    expect(report).toContain('childReport=Changed the header and verified the focused interaction.')
  })

  it('reports the selected route, fallback, and unavailable candidates to the main controller', () => {
    const events = completeTeamEvents().map(item => item.type === 'yuqi/attempt-created'
      ? event(6, {
          type: 'yuqi/attempt-created', taskId: item.taskId, attemptId: item.attemptId, ordinal: item.ordinal,
          route: { modelProvider: 'deepseek', modelId: 'deepseek-v4' }, routeBasis: 'controller-inherit',
          requestedTier: 'standard', fallbackReason: 'automatic-candidates-exhausted',
          catalogEvidence: [
            { model: { modelProvider: 'external', modelId: 'unavailable' }, metadataResolved: false, routable: false },
            { model: { modelProvider: 'external', modelId: 'unroutable' }, metadataResolved: true, routable: false },
          ],
        })
      : item)
    const report = buildBoundedParentReport({
      controllerSessionId: 'route-report-controller', sourceEventCount: events.length, events,
    }, 1)
    expect(report).toContain('route=deepseek/deepseek-v4')
    expect(report).toContain('routeBasis=controller-inherit')
    expect(report).toContain('tier=standard')
    expect(report).toContain('routeFallback=automatic-candidates-exhausted')
    expect(report).toContain('automatic-candidates-exhausted 不代表任务失败')
    expect(report).toContain('unavailableCandidates=external/unavailable, external/unroutable')
  })

  it('shows route history after a retry and omits route details before the first attempt', () => {
    const pendingReport = buildBoundedParentReport({
      controllerSessionId: 'no-attempt-controller', sourceEventCount: 5, events: completeTeamEvents().slice(0, 5),
    }, 1)
    expect(pendingReport).not.toContain('route=')

    const retriedEvents = [
      ...completeTeamEvents().slice(0, -1).map(item => item.type === 'yuqi/task-status-changed' && item.from === 'verifying'
        ? event(16, { type: 'yuqi/task-status-changed', taskId: item.taskId, from: 'verifying', to: 'failed' })
        : item),
      event(180, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('report-retry'), taskId: TaskId('task-1') }),
      event(181, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'ready', to: 'running' }),
      event(182, {
        type: 'yuqi/attempt-created', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-2'), ordinal: 2,
        route: { modelProvider: 'external', modelId: 'replacement-model' }, routeBasis: 'task-exact',
        catalogEvidence: [{ model: { modelProvider: 'external', modelId: 'unroutable' }, metadataResolved: true, routable: false }],
      }),
    ]
    const report = buildBoundedParentReport({
      controllerSessionId: 'retried-controller', sourceEventCount: retriedEvents.length, events: retriedEvents,
    }, 1)

    expect(report).toContain('routeHistory=#1=deepseek/deepseek-v4, #2=external/replacement-model')
    expect(report).toContain('unavailableCandidates=external/unroutable')
  })

  it('keeps an English Team report English after reconstructing the durable event cut', async () => {
    const englishEvents = completeTeamEvents().map(event => event.type === 'yuqi/team-created'
      ? { ...event, locale: 'en' as const }
      : event)
    const restoredEvents = JSON.parse(JSON.stringify(englishEvents)) as typeof englishEvents
    const harness = setupDelivery(undefined, restoredEvents)

    await expect(deliverParentReport(harness.request())).resolves.toMatchObject({ kind: 'delivered' })
    const text = harness.inbox.nextTurn[0]?.content.find(block => block.type === 'text')?.text
    expect(text).toContain('Yuqi Team controller update:')
    expect(text).toContain('Report this final Team result in the current main conversation')
    expect(text).not.toMatch(/主控更新|请留在当前主对话/u)
  })

  it('keeps legacy Team reports on the zh compatibility default', () => {
    const report = buildBoundedParentReport({
      controllerSessionId: 'legacy-controller', sourceEventCount: completeTeamEvents().length, events: completeTeamEvents(),
    }, 1)
    expect(report).toContain('Yuqi Team 主控更新：')
    expect(report).toContain('请在当前主对话汇报这次 Team 的最终结果')
  })
})

function modelRefusalEvents(): readonly TeamEvent[] {
  return [...completeTeamEvents().slice(0, 3), event(20, {
    type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation',
    reason: 'FIXED_MODEL_UNAVAILABLE: PROVIDER_NOT_ALLOWED deepxiaohao/deepseek-v4-flash-0731',
  })]
}

function reportFor(events: readonly TeamEvent[]): string {
  return buildBoundedParentReport({ controllerSessionId: 'reason-controller', sourceEventCount: events.length, events }, 1)
}

function recoverableRefusal(kind: 'live' | 'journal'): { events: readonly TeamEvent[]; clear: TeamEvent } {
  const workspace = {
    workspaceId: WorkspaceId('reason-workspace'),
    project: {
      projectRoot: 'F:/repo', repositoryRoot: 'F:/repo', gitCommonDirectory: 'F:/repo/.git',
      baselineRef: 'commit-1', volumeRoot: 'F:/', protectedRoots: [],
    },
    worktreePath: 'F:/managed/reason', branchName: 'yuqi/reason', status: 'provisioning' as const,
  }
  const proofWorkspace = {
    workspaceId: workspace.workspaceId, ...workspace.project,
    worktreePath: workspace.worktreePath, branchName: workspace.branchName,
  }
  const events = [
    ...completeTeamEvents().slice(0, 3),
    event(10, { type: 'yuqi/workspace-provisioning-started', workspace }),
    event(11, { type: 'yuqi/workspace-provisioned', workspaceId: workspace.workspaceId }),
    event(12, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
    event(13, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused', reason: 'old pause reason' }),
    event(14, { type: 'yuqi/team-status-changed', from: 'paused', to: 'running' }),
    modelRefusalEvents().at(-1)!,
  ]
  const clear = event(22, kind === 'journal' ? {
    type: 'yuqi/team-recovery-cleared-from-journal', operationId: ControlOperationId('reason-clear'),
    target: 'paused', controllerSessionId: 'reason-controller', workspace: proofWorkspace,
  } : {
    type: 'yuqi/team-recovery-cleared', operationId: ControlOperationId('reason-clear'), target: 'paused',
    proof: {
      principal: { kind: 'controller-session', sessionId: 'reason-controller' },
      childQuiescent: true, localInFlight: false, gitVerified: true, workspace: proofWorkspace,
    },
  })
  return { events, clear }
}

function setupDelivery(
  flush?: (session: Session) => boolean,
  teamEvents = completeTeamEvents(),
): {
  readonly controller: Agent
  readonly parent: Agent
  readonly inbox: Inbox
  readonly journal: HarnessSessionJournal
  readonly flushOrder: string[]
  readonly request: () => Parameters<typeof deliverParentReport>[0]
} {
  const parentId = SessionId('parent-report-parent')
  const controllerId = SessionId('parent-report-controller')
  const parentSession = Session.create(parentId)
  const controllerSession = Session.create(controllerId, [], {
    version: 0, id: controllerId, createdAt: 0, parentSession: parentId,
  })
  controllerSession.append(TEAM_SESSION_EVENT, { events: teamEvents })
  controllerSession.append(TEAM_PARENT_BINDING_EVENT, {
    parentSessionId: String(parentId), generation: 1,
    operationId: 'parent-report-generation-1', boundAt: '2026-09-01T00:00:00.000Z',
  })
  parentSession.append(TEAM_PARENT_PROJECTION_EVENT, {
    controllerSessionId: String(controllerId), bindingGeneration: 1,
    activationGeneration: 1, bridgeRevision: 1,
    sourceEventCount: teamEvents.length, events: teamEvents,
  })

  const inbox = new Inbox(parentSession, { inserted() {}, discarded() {}, claimed() {} })
  const parent = {
    id: parentId,
    session: parentSession,
    inbox,
    send(message: Parameters<Agent['send']>[0], target: Parameters<Agent['send']>[1]) { inbox.append(target, message) },
  } as unknown as Agent
  const controller = { id: controllerId, session: controllerSession } as unknown as Agent
  const flushOrder: string[] = []
  const sessions = {
    flush: vi.fn(async (session: Session) => {
      flushOrder.push(session === parentSession ? 'parent' : 'controller')
      return flush?.(session) ?? true
    }),
  }
  const journal = new HarnessSessionJournal(controllerSession, sessions)
  return {
    controller,
    parent,
    inbox,
    journal,
    flushOrder,
    request: () => ({ controller, parent, journal, sessions, now: () => new Date('2026-09-01T00:00:01.000Z') }),
  }
}
