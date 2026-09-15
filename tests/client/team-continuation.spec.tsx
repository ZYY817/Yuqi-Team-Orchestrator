// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { continuationMessage, controllerRecoverySummary, createTeamContinuationAdapter, TeamContinuationContext, type TeamContinuationRequest } from '../../src/client/team-continuation.ts'
import { TeamMessageComposer } from '../../src/client/TeamMessageComposer.tsx'
import { TaskRow } from '../../src/client/TaskRow.tsx'
import { TeamPanel } from '../../src/client/TeamPanel.tsx'
import type { TeamConsoleSummary, TeamConsoleTask } from '../../src/domain/team-console-contract.ts'
import type { HostClientApi } from '../../src/client/host-client-api.ts'

const task = { taskId: 'done', goal: 'Original work', status: 'completed', modelRole: 'worker', model: 'm',
  authorityMode: 'read-only', dependencyCount: 0, fileScope: [], attemptCount: 1, evidenceRecorded: false,
  usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '' } satisfies TeamConsoleTask
const request: TeamContinuationRequest = { sourceTeamId: 'team', sourceControllerSessionId: 'controller',
  sourceTaskId: 'done', requestId: 'stable-id', message: '新的要求\nkeep history', locale: 'zh' }
function fixture(status: TeamConsoleSummary['team']['status'] = 'running') {
  const summary: TeamConsoleSummary = { team: { id: 'team', status, title: 'Team', objective: 'Work',
    completedTaskCount: 1, runningTaskCount: 0, waitingTaskCount: 0, attentionTaskCount: 0,
    userDecisionCount: 0, controllerActionCount: 0, duration: { state: 'unavailable' } },
    controllerSessionId: 'controller', tasks: [task], attention: [], usage: { state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' } }
  const prompt = vi.fn(async () => ({ result: { ok: true, value: {} } }))
  const source = { ready: () => true, summary: () => summary,
    resolveParent: vi.fn(async (): Promise<string | undefined> => 'user-parent'), openParent: vi.fn((_id: string) => {}) }
  const api = { sessions: { prompt } } as unknown as HostClientApi
  return { summary, prompt, source, api, send: createTeamContinuationAdapter(api, source, sessionStorage) }
}
beforeEach(() => { vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); document.documentElement.lang = ''; vi.useRealTimers(); vi.unstubAllGlobals() })

describe('bound continuation delivery', () => {
  it.each(['zh', 'en'] as const)('uses actual tool identity keys in each planning message (%s)', locale => {
    const revision = JSON.parse(continuationMessage({ ...request, locale }, false).split('\n')[1]!)
    expect(revision).toEqual({ teamId: 'team', controllerSessionId: 'controller', sourceTaskId: 'done',
      includeDependents: false, requestId: 'stable-id' })
    expect(revision).not.toHaveProperty('sourceTeamId')
    expect(revision).not.toHaveProperty('sourceControllerSessionId')

    const followup = JSON.parse(continuationMessage({ ...request, locale }, true).split('\n')[1]!)
    expect(followup).toMatchObject({ sourceTeamId: 'team', sourceControllerSessionId: 'controller', requestId: 'stable-id' })
    expect(followup).not.toHaveProperty('teamId')
    expect(followup).not.toHaveProperty('controllerSessionId')
    expect(followup).not.toHaveProperty('includeDependents')
  })
  it.each(['zh', 'en'] as const)('preserves the original requestId and downstream option in the tool-planning message (%s)', locale => {
    const original = { ...request, locale }
    expect(continuationMessage(original, false)).toContain('"includeDependents":false')
    const text = continuationMessage({ ...original, includeDependents: true }, false)
    expect(text).toContain('"includeDependents":true')
    expect(text).toContain('"requestId":"stable-id"')
    expect(text).toContain(locale === 'en' ? 'do not blindly retry' : '不得盲目重试')
    expect(continuationMessage({ ...original, includeDependents: true }, true)).not.toContain('"includeDependents"')
  })
  it('queues a linked revision once with stable source identity, not a command or task mutation', async () => {
    const { send, prompt } = fixture()
    expect(await send(request)).toBe('accepted')
    expect(await send(request)).toBe('accepted')
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'user-parent', requestId: 'stable-id', mode: 'queue',
      content: [{ type: 'text', text: expect.stringContaining('yuqi_team_revise') }] }))
    const text = prompt.mock.calls[0] as unknown as [{ content: { text: string }[] }]
    expect(JSON.parse(text[0].content[0]!.text.split('\n')[1]!)).toEqual({ teamId: 'team', controllerSessionId: 'controller',
      sourceTaskId: 'done', includeDependents: false, requestId: 'stable-id' })
    expect(text[0].content[0]!.text).toContain('"sourceTaskId":"done"')
    expect(text[0].content[0]!.text).toContain(request.message)
  })
  it.each(['completed', 'failed', 'cancelled'] as const)('plans a new Team for terminal %s', async status => {
    const { send, prompt } = fixture(status)
    await send({ ...request, locale: 'en' })
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ content: [{ type: 'text', text: expect.stringContaining('yuqi_team_start') }] }))
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ content: [{ type: 'text', text: expect.stringContaining('sourceControllerSessionId') }] }))
  })
  it('queues an explicit paused-Team recovery request to the verified user parent without issuing commands', async () => {
    const value = fixture('paused')
    const recoverySummary: TeamConsoleSummary = {
      ...value.summary,
      team: { ...value.summary.team, status: 'paused', resumeDisposition: 'decision-required' },
      tasks: [{ ...task, status: 'failed', nextAction: 'Retry after checking recorded evidence.' }],
    }
    value.source.summary = () => recoverySummary
    const recovery: TeamContinuationRequest = { intent: 'recovery', sourceTeamId: 'team', sourceControllerSessionId: 'controller',
      requestId: 'recover-stable', message: controllerRecoverySummary(recoverySummary), locale: 'en' }
    expect(await value.send(recovery)).toBe('accepted')
    expect(value.source.resolveParent).toHaveBeenCalledWith('controller', 'team')
    expect(value.prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'user-parent', requestId: 'recover-stable', mode: 'queue' }))
    const calls = value.prompt.mock.calls as unknown as [{ content: { text: string }[] }][]
    const text = calls[0]![0].content[0]!.text
    expect(text).toContain('This click is a new user request to continue handling the paused Team')
    expect(text).toContain('first verify existing artifacts and uncommitted differences')
    expect(text).toContain('"teamId":"team"')
    expect(text).toContain(recovery.message)
    expect(text).not.toContain('/yuqi retry')
    expect(text).not.toContain('/yuqi resume')
    expect(await value.send.openController?.(recovery)).toBe(true)
    expect(value.source.openParent).toHaveBeenCalledWith('user-parent')
    const reloaded = createTeamContinuationAdapter(value.api, value.source, sessionStorage)
    expect(await reloaded({ ...recovery, requestId: 'recover-after-remount' })).toBe('accepted')
    expect(await reloaded.acceptedRecovery?.({ intent: 'recovery', sourceTeamId: 'team',
      sourceControllerSessionId: 'controller', message: recovery.message, locale: 'en' })).toBe('recover-stable')
    expect(value.prompt).toHaveBeenCalledTimes(1)
  })
  it('rejects recovery delivery when authoritative Team state does not require a controller decision', async () => {
    const value = fixture('paused')
    value.source.summary = () => ({ ...value.summary, team: { ...value.summary.team, status: 'paused', resumeDisposition: 'runnable' } })
    expect(await value.send({ intent: 'recovery', sourceTeamId: 'team', sourceControllerSessionId: 'controller',
      requestId: 'not-needed', message: '{}', locale: 'en' })).toBe('rejected')
    expect(value.prompt).not.toHaveBeenCalled()
  })
  it('allows a recovery handoff when only volatile presentation facts drift', async () => {
    const value = fixture('paused')
    const initial: TeamConsoleSummary = { ...value.summary,
      team: { ...value.summary.team, status: 'paused', resumeDisposition: 'decision-required' },
      tasks: [{ ...task, status: 'failed', nextAction: 'Old next action' }] }
    const message = controllerRecoverySummary(initial)
    value.source.summary = () => ({ ...initial, tasks: [{ ...initial.tasks[0]!, nextAction: 'New current action', attemptStatus: 'failed' }] })
    expect(await value.send({ intent: 'recovery', sourceTeamId: 'team', sourceControllerSessionId: 'controller',
      requestId: 'presentation-drift', message, locale: 'en' })).toBe('accepted')
    expect(value.prompt).toHaveBeenCalledOnce()
  })
  it('rejects a stale recovery handoff after the affected task state changes', async () => {
    const value = fixture('paused')
    const initial: TeamConsoleSummary = { ...value.summary,
      team: { ...value.summary.team, status: 'paused', resumeDisposition: 'decision-required' },
      tasks: [{ ...task, status: 'failed', nextAction: 'Old next action' }] }
    const recovery = { intent: 'recovery' as const, sourceTeamId: 'team', sourceControllerSessionId: 'controller',
      requestId: 'stale-recovery', message: controllerRecoverySummary(initial), locale: 'en' as const }
    value.source.summary = () => ({ ...initial, tasks: [{ ...initial.tasks[0]!, status: 'blocked', nextAction: 'Dependency changed' }] })
    expect(await value.send(recovery)).toBe('rejected')
    expect(value.send.rejectionReason?.(recovery)).toBe('recovery-summary-stale')
    expect(value.prompt).not.toHaveBeenCalled()
  })
  it('rejects stale identity and unavailable sidecar without delivery', async () => {
    const { send, prompt, source } = fixture()
    expect(await send({ ...request, sourceTeamId: 'other' })).toBe('rejected')
    source.ready = () => false
    expect(await send(request)).toBe('rejected')
    expect(prompt).not.toHaveBeenCalled()
  })
  it('does not dispatch if receipt storage is unavailable', async () => {
    const { api, source, prompt } = fixture()
    const send = createTeamContinuationAdapter(api, source, { getItem: () => { throw new Error('denied') }, setItem: () => {}, removeItem: () => {} })
    expect(await send(request)).toBe('rejected')
    expect(prompt).not.toHaveBeenCalled()
  })
  it('enforces its own message length limit before any Host call', async () => {
    const { send, prompt } = fixture()
    expect(await send({ ...request, message: 'x'.repeat(16_385) })).toBe('rejected')
    expect(prompt).not.toHaveBeenCalled()
    expect(await send({ ...request, message: 'x'.repeat(16_384) })).toBe('accepted')
  })
  it('rejects changed payload for a used requestId, including after reload, without storing message text', async () => {
    const { send, prompt, source, api } = fixture()
    expect(await send(request)).toBe('accepted')
    expect(await send({ ...request, message: 'different' })).toBe('rejected')
    const reloaded = createTeamContinuationAdapter(api, source, sessionStorage)
    expect(await reloaded({ ...request, message: 'different' })).toBe('rejected')
    expect(prompt).toHaveBeenCalledTimes(1)
    for (let i = 0; i < sessionStorage.length; i++) expect(sessionStorage.getItem(sessionStorage.key(i)!)).not.toContain(request.message)
  })
  it('retries pre-admission rejection with the original ID after reconnect and accepts equivalent refreshed summaries', async () => {
    const { send, source, summary, prompt } = fixture()
    source.ready = () => false
    expect(await send(request)).toBe('rejected')
    source.ready = () => true
    source.summary = () => ({ ...summary, team: { ...summary.team }, tasks: [...summary.tasks] })
    expect(await send(request)).toBe('accepted')
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ requestId: request.requestId, sessionId: 'user-parent' }))
  })
  it('rejects unavailable parent or changed Team facts without prompting the background controller', async () => {
    const { send, source, prompt, summary } = fixture()
    source.resolveParent.mockResolvedValueOnce(undefined)
    expect(await send(request)).toBe('rejected')
    source.resolveParent.mockImplementationOnce(async () => {
      source.summary = () => ({ ...summary, team: { ...summary.team, status: 'cancelling' } })
      return 'user-parent'
    })
    expect(await send(request)).toBe('rejected')
    expect(prompt).not.toHaveBeenCalled()
  })
  it('releases a pending marker only after opening the verified parent and confirming receipt; never resends', async () => {
    const { send, source, api, prompt } = fixture()
    prompt.mockRejectedValueOnce(new Error('unknown'))
    expect(await send(request)).toBe('unknown')
    const reopened = createTeamContinuationAdapter(api, source, sessionStorage)
    expect(reopened.pending?.(request)).toBe(request.requestId)
    expect(await reopened.confirmReceived?.(request, request.requestId)).toBe(false)
    expect(await reopened.openPending?.(request, request.requestId)).toBe(true)
    expect(source.openParent).toHaveBeenCalledWith('user-parent')
    expect(await reopened.confirmReceived?.(request, request.requestId)).toBe(true)
    expect(reopened.pending?.(request)).toBeUndefined()
    expect(await reopened(request)).toBe('accepted')
    expect(await reopened({ ...request, message: 'conflict' })).toBe('rejected')
    expect(prompt).toHaveBeenCalledTimes(1)
  })
  it('locks unknown delivery across adapter recreation and different request IDs', async () => {
    const { send, prompt, api, source } = fixture()
    prompt.mockRejectedValueOnce(new Error('disconnected'))
    expect(await send(request)).toBe('unknown')
    expect(await createTeamContinuationAdapter(api, source, sessionStorage)({ ...request, requestId: 'another' })).toBe('unknown')
    expect(prompt).toHaveBeenCalledTimes(1)
  })
  it('bounds a hung prompt and does not clear the receipt on a late success', async () => {
    vi.useFakeTimers()
    const { send, prompt, api, source } = fixture()
    let finish!: (value: { result: { ok: boolean; value: object } }) => void
    prompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = send(request)
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await pending).toBe('unknown')
    finish({ result: { ok: true, value: {} } })
    expect(await createTeamContinuationAdapter(api, source, sessionStorage)({ ...request, requestId: 'another' })).toBe('unknown')
    expect(prompt).toHaveBeenCalledTimes(1)
  })
})

describe.each(['zh', 'en'] as const)('continuation composer %s', locale => {
  it('uses a new requestId for an identical new draft after success while suppressing in-flight duplicate clicks', async () => {
    document.documentElement.lang = locale
    const send = vi.fn(async (_request: TeamContinuationRequest) => 'accepted' as const)
    render(<TeamContinuationContext.Provider value={send}><TeamMessageComposer teamId="team" controllerSessionId="controller"
      teamStatus="completed" cancellationRequested={false} tasks={[task]} /></TeamContinuationContext.Provider>)
    const textbox = screen.getByRole('textbox')
    const button = screen.getByRole('button')
    fireEvent.change(textbox, { target: { value: 'Same new requirement' } })
    await act(async () => { fireEvent.click(button); fireEvent.click(button) })
    expect(send).toHaveBeenCalledTimes(1)
    expect(textbox).toHaveValue('')
    const firstRequest = send.mock.calls[0]![0]

    fireEvent.change(textbox, { target: { value: 'Same new requirement' } })
    await act(async () => { fireEvent.click(button); fireEvent.click(button) })
    expect(send).toHaveBeenCalledTimes(2)
    const secondRequest = send.mock.calls[1]![0]
    expect(secondRequest).toEqual({ ...firstRequest, requestId: expect.any(String) })
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId)
    expect(textbox).toHaveValue('')
  })
  it('keeps receipt confirmation available after navigation unmounts and recreates the composer', async () => {
    document.documentElement.lang = locale
    const { send, prompt, source } = fixture('completed')
    prompt.mockRejectedValueOnce(new Error('uncertain delivery'))
    await send({ ...request, locale })
    const composer = <TeamContinuationContext.Provider value={send}><TeamMessageComposer teamId="team" controllerSessionId="controller"
      teamStatus="completed" cancellationRequested={false} tasks={[task]} /></TeamContinuationContext.Provider>
    const first = render(composer)
    source.openParent.mockImplementationOnce(() => { first.unmount() })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Open verified main conversation' : '打开已核验的主控对话' }))
    })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(source.openParent).toHaveBeenCalledWith('user-parent')
    expect(send.wasOpened?.(request, request.requestId)).toBe(true)

    // A new component instance has no openedReceipt state; reuse the installed adapter.
    render(composer)
    const checkbox = screen.getByRole('checkbox')
    const confirm = screen.getByRole('button', { name: locale === 'en' ? 'Confirm received; do not resend' : '确认已收到，不重发' })
    expect(checkbox).toBeEnabled()
    expect(checkbox).not.toBeChecked()
    expect(confirm).toBeDisabled()
    fireEvent.click(checkbox)
    expect(confirm).toBeEnabled()
    await act(async () => { fireEvent.click(confirm) })
    expect(send.pending?.(request)).toBeUndefined()
    expect(send.wasOpened?.(request, request.requestId)).toBe(false)
    expect(screen.getByRole('textbox')).toBeEnabled()
    expect(prompt).toHaveBeenCalledTimes(1)
  })
  it('offers an explicit received-message reconciliation path after reopening', async () => {
    document.documentElement.lang = locale
    const { send, prompt } = fixture('completed')
    prompt.mockRejectedValueOnce(new Error('uncertain'))
    await send({ ...request, locale })
    render(<TeamContinuationContext.Provider value={send}><TeamMessageComposer teamId="team" controllerSessionId="controller"
      teamStatus="completed" cancellationRequested={false} tasks={[task]} /></TeamContinuationContext.Provider>)
    const confirm = screen.getByRole('button', { name: locale === 'en' ? 'Confirm received; do not resend' : '确认已收到，不重发' })
    expect(confirm).toBeDisabled()
    expect(screen.getByRole('textbox')).toBeDisabled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Open verified main conversation' : '打开已核验的主控对话' })) })
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => { fireEvent.click(confirm) })
    expect(screen.getByRole('textbox')).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent(locale === 'en' ? 'Marked received' : '已按你的核对')
    expect(prompt).toHaveBeenCalledTimes(1)
  })
  it('keeps the ordinary running-message draft usable after an unknown outcome', async () => {
    document.documentElement.lang = locale
    const command = vi.fn(async () => { throw new Error('unknown transport') })
    render(<TeamMessageComposer teamId="team" controllerSessionId="controller" teamStatus="running" cancellationRequested={false}
      tasks={[{ ...task, status: 'running', childSessionId: 'child' }]} command={command} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Existing worker message' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Send instruction' : '发送补充要求' })) })
    expect(screen.getByRole('textbox')).toHaveValue('Existing worker message')
    // Unknown delivery locks resubmission until the user closes the receipt review.
    expect(screen.getByRole('button', { name: locale === 'en' ? 'Send instruction' : '发送补充要求' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(locale === 'en' ? 'Check the main conversation' : '请先核对主控对话')
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Close this review' : '结束本次核对' })) })
    expect(screen.getByRole('textbox')).toBeEnabled()
    expect(screen.getByRole('textbox')).toHaveValue('')
  })
  it('allows paused completed-task revision and preserves unknown drafts without resending', async () => {
    document.documentElement.lang = locale
    const send = vi.fn(async () => 'unknown' as const)
    const command = vi.fn()
    render(<TeamContinuationContext.Provider value={send}><TeamMessageComposer teamId="team" controllerSessionId="controller"
      teamStatus="paused" cancellationRequested={false} tasks={[task]} command={command} /></TeamContinuationContext.Provider>)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'completed:done' } })
    const input = screen.getByRole('textbox')
    expect(input).toBeEnabled()
    const downstream = screen.getByRole('checkbox')
    expect(downstream).not.toBeChecked()
    fireEvent.click(downstream)
    fireEvent.change(input, { target: { value: 'New requirement' } })
    const button = screen.getByRole('button')
    await act(async () => { fireEvent.click(button); fireEvent.click(button) })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sourceTeamId: 'team', sourceTaskId: 'done', sourceControllerSessionId: 'controller', requestId: expect.any(String), includeDependents: true, locale }))
    expect(command).not.toHaveBeenCalled()
    expect(input).toHaveValue('New requirement')
    expect(button).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(locale === 'en' ? 'Delivery unknown' : '投递结果未知')
  })
  it('supports terminal followup despite the old cancellation flag', async () => {
    document.documentElement.lang = locale
    const send = vi.fn(async () => 'accepted' as const)
    render(<TeamContinuationContext.Provider value={send}><TeamMessageComposer teamId="team" controllerSessionId="controller"
      teamStatus="cancelled" cancellationRequested tasks={[task]} /></TeamContinuationContext.Provider>)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Follow up' } })
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(send).toHaveBeenCalledOnce()
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByRole('status')).toHaveTextContent(locale === 'en' ? 'Accepted by the controller' : '主控已受理')
  })
})

describe.each(['zh', 'en'] as const)('revision provenance %s', locale => {
  it.each([true, false])('labels downstream only when the source differs from root (downstream=%s)', downstream => {
    document.documentElement.lang = locale
    const locate = vi.fn()
    render(<TaskRow index={0} teamId="team" task={{ ...task, taskId: 'revision',
      revisionSource: { taskId: 'done', rootTaskId: downstream ? 'upstream' : 'done', operationId: 'operation' } }}
      workbenchDetail onOpenChild={async () => false} onLocateRevisionSource={locate} nowMs={0} />)
    expect(screen.getByText(downstream ? (locale === 'en' ? 'Downstream re-verification' : '下游复验') : (locale === 'en' ? 'Linked revision' : '关联修改'))).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Locate source task' : '定位来源任务' }))
    expect(locate).toHaveBeenCalledOnce()
  })
  it('locates the original task through the panel', () => {
    document.documentElement.lang = locale
    const { summary } = fixture()
    const original = { ...task, goal: 'Original source' }
    const revision = { ...task, taskId: 'revision', goal: 'New revision', revisionSource: { taskId: 'done', rootTaskId: 'done', operationId: 'operation' } }
    render(<TeamPanel summary={{ ...summary, team: { ...summary.team, continuedFrom: { sourceTeamId: 'old-team-123456789', sourceControllerSessionId: 'old-controller' } }, tasks: [revision, original] }}
      onClose={() => {}} onOpenChild={async () => false} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Locate source task' : '定位来源任务' }))
    expect(screen.getByRole('heading', { level: 3, name: 'Original source' })).toBeInTheDocument()
  })
})
