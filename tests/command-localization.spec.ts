import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { YuqiOrchestratorError } from '../src/application/errors.ts'
import { replayTeamEvents } from '../src/domain/projection.ts'
import type { TeamLocale } from '../src/domain/locale.ts'
import { createYuqiCommandDefinition, type YuqiCommandService } from '../src/host/harness/commands.ts'
import { TEAM_SESSION_EVENT, TEAM_PARENT_PROJECTION_EVENT, TEAM_PARENT_BINDING_EVENT, TEAM_PARENT_DETACHED_EVENT } from '../src/host/harness/session-journal.ts'
import { WorkspaceId } from '../src/domain/ids.ts'
import { createEmptyProjectSummary, updateProjectSummary, type ProjectSummaryPatch } from '../src/application/project-summary.ts'
import { copyFor, formatAttentionMessage, formatBlockedTaskOutcome, formatTaskStatus, formatTeamStatus, formatAuthorityMode, formatModelRouteBasis } from '../src/client/i18n.ts'
import { teamStatusMeta } from '../src/client/status.ts'
import { completeTeamEvents, event } from './fixtures.ts'

function fixture(locale: TeamLocale = 'zh', empty = false) {
  const events = completeTeamEvents().map(event => event.type === 'yuqi/team-created' ? { ...event, locale } : event)
  const id = SessionId(`localization-${locale}-${empty}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: process.cwd() })
  if (!empty) for (const event of events) session.append(TEAM_SESSION_EVENT, { event })
  const agent = { id, session } as unknown as Agent
  const projection = replayTeamEvents(events)
  const service = {
    pauseTeam: vi.fn(async () => projection), resumeTeam: vi.fn(async () => projection),
    cancelTeam: vi.fn(async () => projection), retryTask: vi.fn(async () => projection),
    reconcileTeam: vi.fn(async () => projection), resolveAttempt: vi.fn(async () => projection),
    rebindTeam: vi.fn(async () => undefined),
    sendTaskMessage: vi.fn(async () => ({ childSessionId: 'child', messageId: 'message' })),
    readProjectSummary: vi.fn(async () => { throw new Error('Project summary contains credential-like text') }),
    updateProjectSummary: vi.fn(async () => { throw new Error('unused') }),
  } satisfies YuqiCommandService
  const run = (rawInput: string, resolver?: () => Agent | undefined) => createYuqiCommandDefinition(service, resolver).handler({
    agent, rawInput, attachments: [], commandId: CommandId('localization'), signal: new AbortController().signal,
  })
  return { agent, service, run }
}

afterEach(() => vi.restoreAllMocks())

describe('command localization through the registered command handler', () => {
  it.each(['zh', 'en'] as const)('uses %s for normal, invalid and oversized input', async locale => {
    const { run, service } = fixture(locale)
    expect(await run('')).toMatchObject({ kind: 'success', text: expect.stringContaining(locale === 'en' ? 'Status:' : '状态：') })
    expect(await run('pause')).toMatchObject({ kind: 'success', text: expect.stringContaining(locale === 'en' ? 'pause request' : '暂停请求') })
    for (const input of ['unsupported', 'attach', 'x'.repeat(24577)]) {
      expect(await run(input)).toMatchObject({ kind: 'error', text: expect.stringContaining(locale === 'en' ? 'Usage:' : '用法：') })
    }
    expect(service.pauseTeam).toHaveBeenCalledTimes(1)
    expect(service.retryTask).not.toHaveBeenCalled()
  })

  it('localizes attach failures before and after the target is resolved', async () => {
    const parent = fixture('en')
    expect(await parent.run('attach team-1 missing req')).toMatchObject({ kind: 'error', text: expect.stringContaining('unavailable') })
    const target = fixture('en')
    parent.service.rebindTeam.mockRejectedValueOnce(new YuqiOrchestratorError('TEAM_MISMATCH', 'binding changed'))
    expect(await parent.run('attach team-1 target req', () => target.agent)).toMatchObject({ kind: 'error', text: expect.stringContaining('Yuqi TEAM_MISMATCH: The Team/controller binding') })
    parent.service.rebindTeam.mockRejectedValueOnce(new Error('private diagnostic'))
    expect(await parent.run('attach team-1 target req', () => target.agent)).toMatchObject({ kind: 'error', text: 'Yuqi UNEXPECTED_ERROR: The controller conversation switch did not complete.' })
  })

  it('translates local validation details and keeps error codes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { run, service } = fixture('en')
    for (const [input, code, detail] of [
      ['pause !', 'CONTROL_OPERATION_CONFLICT', 'Invalid requestId format'],
      ['message task-1 !', 'INVALID_BATCH', 'Invalid additional-instructions encoding'],
      ['pause team-1 missing req', 'TEAM_MISMATCH', 'no longer bound'],
    ]) {
      const result = await run(input!)
      expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining(code!) })
      expect(result).toHaveProperty('text', expect.stringContaining(detail!))
      expect(result).toHaveProperty('text', expect.not.stringMatching(/[\u3400-\u9fff]/u))
    }
    expect(service.pauseTeam).not.toHaveBeenCalled()
    expect(service.sendTaskMessage).not.toHaveBeenCalled()
  })

  it.each(['zh', 'en'] as const)('explains model and recovery errors in %s without retrying', async locale => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { run, service } = fixture(locale)
    for (const code of ['FIXED_MODEL_UNAVAILABLE', 'FIXED_MODEL_INVALID', 'RETRY_NOT_ALLOWED', 'CONTROL_RUNTIME_UNCERTAIN'] as const) {
      service.pauseTeam.mockRejectedValueOnce(new YuqiOrchestratorError(code, 'provider timeout E_429'))
      const result = await run('pause')
      expect(result).toHaveProperty('text', expect.stringContaining(code))
      expect(result).toHaveProperty('text', expect.stringContaining('E_429'))
      expect(result).toHaveProperty('text', expect.stringContaining(code === 'CONTROL_RUNTIME_UNCERTAIN' ? 'reconcile' : locale === 'en' ? 'model' : '模型'))
    }
    expect(service.retryTask).not.toHaveBeenCalled()
    expect(service.reconcileTeam).not.toHaveBeenCalled()
  })

  it('adds a Chinese explanation to summary errors while retaining diagnostics', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await fixture().run('summary read')
    expect(result).toHaveProperty('text', expect.stringContaining('项目摘要操作失败'))
    expect(result).toHaveProperty('text', expect.stringContaining('Project summary contains credential-like text'))
  })

  it('defaults to Chinese when there is no Team locale', async () => {
    expect(await fixture('zh', true).run('')).toMatchObject({ kind: 'error', text: '当前会话没有可用的 Yuqi Team。' })
    expect(await fixture('zh', true).run('attach')).toHaveProperty('text', expect.stringContaining('用法：'))
  })
})

describe('task feedback locale and recovery advice', () => {
  it.each(['zh', 'en'] as const)('preserves model diagnostics and offers bounded choices in %s', locale => {
    const message = formatAttentionMessage({ owner: 'controller', taskId: 'one', code: 'task-failed', message: 'provider timeout E_429 用户诊断' }, locale)
    expect(message).toContain('provider timeout E_429 用户诊断')
    expect(message).toContain(locale === 'en' ? 'choose another available model' : '选择其他可用模型')
    expect(message).toContain(locale === 'en' ? 'retry gates and budget' : '重试门禁和预算')
  })

  it('translates known recovery messages in both directions', () => {
    const attention = { owner: 'controller' as const, taskId: 'one', code: 'attempt-outcome-unknown' as const, message: '子代理上次执行结果待核对；需主控依据现有证据决定后续处理。' }
    const en = formatAttentionMessage(attention, 'en')
    expect(en).toContain('needs review')
    expect(formatAttentionMessage({ ...attention, message: en }, 'zh')).toBe(attention.message)
  })

  it('defaults unknown locales to Chinese and preserves unknown status values', () => {
    const locale = 'unknown' as TeamLocale
    expect(copyFor({ zh: '中文', en: 'English' }, locale)).toBe('中文')
    expect(formatTaskStatus('failed', locale)).toBe('失败')
    expect(formatTeamStatus('paused', locale)).toBe('已暂停')
    expect(formatAuthorityMode(undefined, locale)).toBe('工作区写入')
    expect(formatModelRouteBasis('automatic', locale)).toBe('自动路由')
    expect(formatBlockedTaskOutcome(undefined, locale)).toContain('缺少有效')
    expect(teamStatusMeta('future' as 'draft', locale)).toMatchObject({ label: 'future', tone: 'unknown' })
  })
})

function knowledgeFixture(ready = true) {
  const target = fixture('en')
  const parent = fixture('en', true)
  const root = `${process.cwd()}\\knowledge-workspace`
  const workspaceId = WorkspaceId('knowledge')
  const events = [
    event(31, { type: 'yuqi/workspace-provisioning-started', workspace: {
      workspaceId, project: { mode: 'direct', projectRoot: root, volumeRoot: root, protectedRoots: [] },
      worktreePath: root, branchName: 'direct', status: 'provisioning',
    } as never }),
    ...(ready ? [event(32, { type: 'yuqi/workspace-provisioned', workspaceId })] : []),
  ]
  for (const fact of events) target.agent.session.append(TEAM_SESSION_EVENT, { event: fact })
  parent.agent.session.append(TEAM_PARENT_PROJECTION_EVENT, {
    controllerSessionId: String(target.agent.id), sourceEventCount: 17,
    events: completeTeamEvents().map(fact => fact.type === 'yuqi/team-created' ? { ...fact, locale: 'en' } : fact),
  })
  let stored = { ...createEmptyProjectSummary('2026-09-06T00:00:00Z'), pitfalls: [{ id: 'one', text: 'lesson', links: [] }] }
  const update = vi.fn(async (_root: string, patch: ProjectSummaryPatch) => {
    stored = updateProjectSummary(stored, patch, '2026-09-06T00:00:01Z') as typeof stored
    return stored
  })
  const record = vi.fn(async (): Promise<void> => undefined)
  const service = { ...parent.service, updateProjectSummary: update, recordProjectSummary: record }
  const run = (input: string, controller: Agent | (() => Promise<Agent>) = target.agent, caller = parent.agent) => createYuqiCommandDefinition(service, () => typeof controller === 'function' ? controller() : controller).handler({
    agent: caller, rawInput: input, attachments: [], commandId: CommandId('knowledge'), signal: new AbortController().signal,
  })
  const identity = `team-1 ${target.agent.id} request`
  return { target, parent, root, update, record, run, identity }
}

describe('knowledge cleanup command wiring', () => {
  it('uses the exact controller workspace and exclusive memory patch, then records the saved summary', async () => {
    const { run, identity, root, target, update, record } = knowledgeFixture()
    const result = await run(`knowledge-delete pitfalls one ${identity}`)
    expect(result).toMatchObject({ kind: 'success' })
    expect(JSON.parse(result!.text!)).toMatchObject({ saved: true, panelSynced: true, teamId: 'team-1', controllerSessionId: String(target.agent.id) })
    expect(update).toHaveBeenCalledWith(root, { removeItem: { topic: 'pitfalls', id: 'one' } })
    expect(record).toHaveBeenCalledWith({ controller: target.agent, summary: expect.objectContaining({ pitfalls: [] }) })
    expect(record.mock.invocationCallOrder[0]).toBeGreaterThan(update.mock.invocationCallOrder[0]!)
    await run(`knowledge-delete pitfalls missing ${identity}`)
    expect(record).toHaveBeenCalledTimes(2)
  })

  it.each(['architectureDecisions', 'pitfalls', 'conventions', 'documentLinks', 'overallProgress', 'all'])('clears confirmed category %s and reports failed panel sync without undoing the save', async topic => {
    const { run, identity, root, update, record } = knowledgeFixture()
    record.mockRejectedValueOnce(new Error('panel offline'))
    const result = await run(`knowledge-clear ${topic} confirm ${identity}`)
    expect(result).toMatchObject({ kind: 'success' })
    expect(JSON.parse(result!.text!)).toMatchObject({ saved: true, panelSynced: false })
    expect(update).toHaveBeenCalledWith(root, { clearTopic: { topic, confirmed: true } })
  })

  it.each([
    'knowledge-clear pitfalls', 'knowledge-clear pitfalls true', 'knowledge-clear session confirm',
    'knowledge-delete documentLinks one', 'knowledge-delete pitfalls ../source.ts',
    'knowledge-delete pitfalls one extra',
  ])('rejects invalid input before mutation: %s', async input => {
    const { run, identity, update, record } = knowledgeFixture()
    expect(await run(`${input} ${identity}`)).toMatchObject({ kind: 'error', text: expect.stringContaining('Usage:') })
    expect(update).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  it('rejects stale binding, wrong controller, wrong Team, and unready workspace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const value = knowledgeFixture()
    for (const identity of ['team-2 localization-en-false request', 'team-1 other request', 'team-1 localization-en-false !']) {
      expect(await value.run(`knowledge-delete pitfalls one ${identity}`)).toMatchObject({ kind: 'error' })
    }
    const wrong = fixture('en').agent
    Object.assign(wrong, { id: SessionId('wrong-controller') })
    expect(await value.run(`knowledge-delete pitfalls one ${value.identity}`, wrong)).toMatchObject({ kind: 'error' })
    expect(value.update).not.toHaveBeenCalled()
    value.target.agent.session.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: 'another-parent', previousParentSessionId: String(value.parent.agent.id), generation: 1,
      operationId: 'ui-v1:rebind', boundAt: '2026-09-06T00:00:00.000Z',
    })
    expect(await value.run(`knowledge-delete pitfalls one ${value.identity}`)).toMatchObject({ kind: 'error', text: expect.stringContaining('history only') })
    expect(value.update).not.toHaveBeenCalled()
    const unready = knowledgeFixture(false)
    expect(await unready.run(`knowledge-clear pitfalls confirm ${unready.identity}`)).toMatchObject({ kind: 'error', text: expect.stringContaining('ready workspace') })
    expect(unready.update).not.toHaveBeenCalled()
  })

  it('supports the exact controller-local signature and does not record failed saves', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const value = knowledgeFixture()
    expect(await value.run(`knowledge-clear pitfalls confirm ${value.identity}`, value.target.agent, value.target.agent)).toMatchObject({ kind: 'success' })
    value.record.mockClear()
    value.update.mockRejectedValueOnce(new Error('disk failure'))
    expect(await value.run(`knowledge-clear pitfalls confirm ${value.identity}`)).toMatchObject({ kind: 'error' })
    expect(value.record).not.toHaveBeenCalled()
  })

  it('serializes saving and panel recording across concurrent cleanup commands', async () => {
    const value = knowledgeFixture()
    const recording = Promise.withResolvers<void>()
    value.record.mockImplementationOnce(() => recording.promise)
    const first = value.run(`knowledge-delete pitfalls one ${value.identity}`)
    await vi.waitFor(() => expect(value.record).toHaveBeenCalledTimes(1))
    const second = value.run(`knowledge-clear conventions confirm ${value.identity}`)
    await Promise.resolve()
    expect(value.update).toHaveBeenCalledTimes(1)
    recording.resolve()
    expect(await first).toMatchObject({ kind: 'success' })
    expect(await second).toMatchObject({ kind: 'success' })
    expect(value.update).toHaveBeenCalledTimes(2)
    expect(value.record).toHaveBeenCalledTimes(2)
  })

  it('rechecks current binding after the queue wait and rejects a formerly valid identity', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const value = knowledgeFixture()
    const recording = Promise.withResolvers<void>()
    value.record.mockImplementationOnce(() => recording.promise)
    const first = value.run(`knowledge-delete pitfalls one ${value.identity}`)
    await vi.waitFor(() => expect(value.record).toHaveBeenCalledTimes(1))
    const second = value.run(`knowledge-clear conventions confirm ${value.identity}`)
    value.target.agent.session.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: 'new-parent', previousParentSessionId: String(value.parent.agent.id), generation: 1,
      operationId: 'ui-v1:queued-rebind', boundAt: '2026-09-06T00:00:00.000Z',
    })
    recording.resolve()
    expect(await first).toMatchObject({ kind: 'success' })
    expect(await second).toMatchObject({ kind: 'error', text: expect.stringContaining('TEAM_MISMATCH') })
    expect(value.update).toHaveBeenCalledTimes(1)
    expect(value.record).toHaveBeenCalledTimes(1)
  })

  it('releases the queue after a failed save so subsequent commands can proceed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const value = knowledgeFixture()
    const saving = Promise.withResolvers<Awaited<ReturnType<typeof value.update>>>()
    value.update.mockImplementationOnce(() => saving.promise)
    const first = value.run(`knowledge-delete pitfalls one ${value.identity}`)
    await vi.waitFor(() => expect(value.update).toHaveBeenCalledTimes(1))
    const second = value.run(`knowledge-clear conventions confirm ${value.identity}`)
    saving.reject(new Error('disk failed'))
    expect(await first).toMatchObject({ kind: 'error' })
    expect(await second).toMatchObject({ kind: 'success' })
    expect(value.update).toHaveBeenCalledTimes(2)
    expect(value.record).toHaveBeenCalledTimes(1)
  })

  it('rejects detachment during asynchronous controller resolution before saving', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const value = knowledgeFixture()
    const resolving = Promise.withResolvers<Agent>()
    const resolver = vi.fn(() => resolving.promise)
    const result = value.run(`knowledge-clear pitfalls confirm ${value.identity}`, resolver)
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1))
    value.parent.agent.session.append(TEAM_PARENT_DETACHED_EVENT, {
      controllerSessionId: String(value.target.agent.id), bindingGeneration: 1,
    })
    resolving.resolve(value.target.agent)
    expect(await result).toMatchObject({ kind: 'error', text: expect.stringContaining('TEAM_MISMATCH') })
    expect(value.update).not.toHaveBeenCalled()
    expect(value.record).not.toHaveBeenCalled()
  })
})
