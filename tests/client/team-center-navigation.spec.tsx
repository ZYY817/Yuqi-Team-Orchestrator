// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { TeamConsoleSummary } from '../../src/domain/team-console-contract.ts'
import { openTeamCenterSession, openTeamChild } from '../../src/client/index.ts'
import { TeamCenter } from '../../src/client/TeamCenter.tsx'
import { YuqiTeamDock } from '../../src/client/YuqiTeamDock.tsx'
import { TeamSessionNavigator } from '../../src/client/TeamSessionNavigator.tsx'
import { FileAuditHistoryContext, type FileAuditHistoryLoader } from '../../src/client/TaskFileAudit.tsx'
import { consumeTeamPanelOpen, OPEN_TEAM_PANEL_EVENT } from '../../src/client/team-panel-events.ts'

const mainId = 'session-929bf6a1-339d-434b-9d00-2fac6b758110' as SessionId
const controllerId = 'yuqi-team-00mtpl0b5j-0000-c9988970-5139-414c-a6d8-dbdd5ac5e167' as SessionId
const oldTeamId = 'yuqi-team-c9d4156b-fe70-4da9-a277-b4a001ca3fa0'
const oldSummary: TeamConsoleSummary = {
  controllerSessionId: controllerId,
  team: { id: oldTeamId, title: 'C17', objective: 'Old completed Team', status: 'completed', completedTaskCount: 0, runningTaskCount: 0, waitingTaskCount: 0, attentionTaskCount: 0, userDecisionCount: 0, controllerActionCount: 0, duration: { state: 'known', elapsedMs: 1000 } },
  tasks: [], attention: [], usage: { state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' },
}

function fixture() {
  const currentSummary = { ...oldSummary, controllerSessionId: 'new-controller', team: { ...oldSummary.team, id: 'new-team', title: 'C18' } }
  const snapshot = { ids: [controllerId, mainId], byId: {
    [controllerId]: { id: controllerId, parentId: mainId, displayTitle: 'Hidden C17 controller', projectionValues: { yuqiTeam: oldSummary } },
    [mainId]: { id: mainId, displayTitle: 'Main conversation', projectionValues: { yuqiTeam: currentSummary } },
  } }
  const address = { parentSessionId: mainId, childSessionId: controllerId, mode: 'continuable' }
  const subagentAddress = vi.fn((_id: SessionId): typeof address | undefined => undefined)
  const refreshSubagents = vi.fn(async (_id: SessionId) => { subagentAddress.mockReturnValue(address) })
  const sessions = { list: { getSnapshot: () => snapshot, subscribe: () => () => undefined },
    open: vi.fn(), openSubagent: vi.fn(), subagentAddress, refreshSubagents }
  const ctx = { sessions } as unknown as Pick<ClientContext, 'sessions'>
  return { ctx, sessions, snapshot, address, currentSummary }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.lang = ''
  consumeTeamPanelOpen(oldTeamId)
  vi.restoreAllMocks()
})

describe('Team management controller navigation', () => {
  it('bounds a catalog wait and does not navigate on its late response', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      let finish!: () => void
      f.sessions.refreshSubagents.mockImplementation(() => new Promise<void>(resolve => {
        finish = () => { f.sessions.subagentAddress.mockReturnValue(f.address); resolve() }
      }))
      const opening = openTeamCenterSession(f.ctx, controllerId)
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(opening).resolves.toBe(false)
      finish()
      await Promise.resolve()
      expect(f.sessions.openSubagent).not.toHaveBeenCalled()
      await expect(openTeamCenterSession(f.ctx, controllerId)).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-wait on DSH\'s timed-out coalesced catalog read', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.sessions.refreshSubagents.mockImplementation(() => new Promise<void>(() => undefined))
      const first = openTeamCenterSession(f.ctx, controllerId)
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(first).resolves.toBe(false)
      await expect(openTeamCenterSession(f.ctx, controllerId)).resolves.toBe(false)
      expect(f.sessions.refreshSubagents).toHaveBeenCalledOnce()
      expect(f.sessions.openSubagent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('only opens the latest requested Team transcript when an older refresh resolves late', async () => {
    const f = fixture()
    const siblingId = 'sibling-controller' as SessionId
    const siblingAddress = { parentSessionId: mainId, childSessionId: siblingId, mode: 'continuable' as const }
    f.snapshot.byId[siblingId] = { id: siblingId, parentId: mainId, displayTitle: 'Sibling controller', projectionValues: { yuqiTeam: oldSummary } }
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    f.sessions.refreshSubagents.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const oldOpen = openTeamCenterSession(f.ctx, controllerId)
    const newOpen = openTeamCenterSession(f.ctx, siblingId)
    f.sessions.subagentAddress.mockReturnValue(siblingAddress)
    second.resolve()
    await expect(newOpen).resolves.toBe(true)
    first.resolve()
    await expect(oldOpen).resolves.toBe(false)
    expect(f.sessions.openSubagent).toHaveBeenCalledExactlyOnceWith(siblingAddress)
  })

  it('reuses a healthy ready catalog without waiting for a refresh', async () => {
    const f = fixture()
    f.sessions.list.getSnapshot = () => ({ ...f.snapshot, subagentsByParent: {
      [mainId]: { state: 'ready', error: null, entries: [{ kind: 'child', id: controllerId, mode: 'continuable' }] },
    } })
    await expect(openTeamCenterSession(f.ctx, controllerId)).resolves.toBe(true)
    expect(f.sessions.refreshSubagents).not.toHaveBeenCalled()
    expect(f.sessions.openSubagent).toHaveBeenCalledWith(f.address)
  })
  it('opens a retained legacy root even when it is its own Team controller', async () => {
    const f = fixture()
    f.currentSummary.controllerSessionId = mainId
    await expect(openTeamCenterSession(f.ctx, mainId)).resolves.toBe(true)
    expect(f.sessions.open).toHaveBeenCalledExactlyOnceWith(mainId)
    expect(f.sessions.openSubagent).not.toHaveBeenCalled()
    expect(f.sessions.refreshSubagents).not.toHaveBeenCalled()
  })

  it('also opens a hidden controller selected by the session navigator through the retained address', async () => {
    document.documentElement.lang = 'en'
    const f = fixture()
    const childId = 'old-worker' as SessionId
    const byId = { ...f.snapshot.byId,
      [controllerId]: { ...f.snapshot.byId[controllerId], agentPreset: 'yuqi-team', projectionValues: { yuqiTeam: {
        ...oldSummary, tasks: [{ taskId: 'old-task', goal: 'Old task', childSessionId: childId, status: 'completed', model: 'model' }],
      } } },
      [childId]: { id: childId, parentId: controllerId },
    }
    const openMain = vi.fn((id: SessionId) => openTeamCenterSession(f.ctx, id))
    const props = { sessionId: childId, useSessions: (selector: (state: unknown) => unknown) => selector({ byId }),
      openMain, openChild: async () => false } as unknown as ComponentProps<typeof TeamSessionNavigator>
    render(<TeamSessionNavigator {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Child 1/1' }))
    fireEvent.click(screen.getByRole('button', { name: /Team controller/u }))
    await waitFor(() => expect(f.sessions.openSubagent).toHaveBeenCalledExactlyOnceWith(f.address))
    expect(openMain).toHaveBeenCalledExactlyOnceWith(controllerId)
    expect(f.sessions.open).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('refreshes the real parent catalog and opens only its retained controller address', async () => {
    const f = fixture()
    await expect(openTeamCenterSession(f.ctx, controllerId)).resolves.toBe(true)
    expect(f.sessions.refreshSubagents).toHaveBeenCalledExactlyOnceWith(mainId)
    expect(f.sessions.openSubagent).toHaveBeenCalledExactlyOnceWith(f.address)
    expect(f.sessions.open).not.toHaveBeenCalled()
    expect(f.snapshot.byId[mainId]!.projectionValues.yuqiTeam).toBe(f.currentSummary)
  })

  it('materializes a hidden controller from its direct parent before opening its durable child', async () => {
    const f = fixture()
    const workerId = 'worker-child' as SessionId
    const controllerAddress = f.address
    const workerAddress = { parentSessionId: controllerId, childSessionId: workerId, mode: 'continuable' as const }
    f.snapshot.byId[workerId] = { id: workerId, parentId: controllerId, displayTitle: 'Running worker', projectionValues: { yuqiTeam: oldSummary } }
    f.sessions.refreshSubagents.mockImplementation(async parentId => {
      if (parentId === mainId) f.sessions.subagentAddress.mockImplementation(id => id === controllerId ? controllerAddress : undefined)
      if (parentId === controllerId) f.sessions.subagentAddress.mockImplementation(id => id === controllerId ? controllerAddress : id === workerId ? workerAddress : undefined)
    })

    await expect(openTeamCenterSession(f.ctx, workerId)).resolves.toBe(true)
    expect(f.sessions.refreshSubagents).toHaveBeenNthCalledWith(1, mainId)
    expect(f.sessions.refreshSubagents).toHaveBeenNthCalledWith(2, controllerId)
    expect(f.sessions.openSubagent).toHaveBeenCalledExactlyOnceWith(workerAddress)
  })

  it.each([
    ['missing controller', undefined, undefined, '未找到 Team 控制器身份'],
    ['controller parent catalog refresh rejected', controllerId, 'reject', '控制器父会话目录刷新失败'],
    ['child catalog remains unready after refresh', controllerId, 'empty', '子代理目录尚未就绪'],
  ] as const)('returns a controlled diagnostic when %s', async (_name, parentId, mode, expected) => {
    const f = fixture()
    if (mode === 'reject') f.sessions.refreshSubagents.mockRejectedValue(new Error('untrusted Host detail'))
    if (mode === 'empty') f.sessions.refreshSubagents.mockImplementation(async parent => {
      f.sessions.subagentAddress.mockImplementation(id => parent === mainId && id === controllerId ? f.address : undefined)
    })
    await expect(openTeamChild(f.ctx as ClientContext, parentId, 'missing-worker', true)).rejects.toMatchObject({
      name: 'YuqiTeamChildNavigationError', message: expect.stringContaining(expected),
    })
    expect(f.sessions.openSubagent).not.toHaveBeenCalled()
  })

  it('uses an existing address without refreshing and keeps public-main navigation intact', async () => {
    const f = fixture()
    f.sessions.subagentAddress.mockImplementation(id => id === controllerId ? f.address : undefined)
    await expect(openTeamCenterSession(f.ctx, controllerId)).resolves.toBe(true)
    expect(f.sessions.refreshSubagents).not.toHaveBeenCalled()
    await expect(openTeamCenterSession(f.ctx, mainId)).resolves.toBe(true)
    expect(f.sessions.open).toHaveBeenCalledExactlyOnceWith(mainId)
  })

  it.each(['missing', 'wrong parent', 'refresh rejected', 'open rejected'] as const)('does not fall back to a blank root conversation when %s', async mode => {
    const f = fixture()
    if (mode === 'missing') f.sessions.refreshSubagents.mockResolvedValue(undefined)
    if (mode === 'wrong parent') f.sessions.subagentAddress.mockReturnValue({ ...f.address, parentSessionId: 'other-parent' as SessionId })
    if (mode === 'refresh rejected') f.sessions.refreshSubagents.mockRejectedValue(new Error('offline'))
    if (mode === 'open rejected') f.sessions.openSubagent.mockImplementation(() => { throw new Error('not retained') })
    await expect(openTeamCenterSession(f.ctx, controllerId)).resolves.toBe(false)
    expect(f.sessions.open).not.toHaveBeenCalled()
  })

  it('searches old C17 while the main session projects C18, waits for navigation, then opens the exact old panel', async () => {
    document.documentElement.lang = 'en'
    const f = fixture()
    const ready = Promise.withResolvers<void>()
    f.sessions.refreshSubagents.mockImplementation(async () => { await ready.promise; f.sessions.subagentAddress.mockReturnValue(f.address) })
    const openMain = vi.fn((id: SessionId) => openTeamCenterSession(f.ctx, id))
    render(<TeamCenter sessions={f.sessions.list} openMain={openMain} openChild={async () => false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Team management' }))
    fireEvent.click(screen.getByRole('button', { name: /^History/u }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Teams' }), { target: { value: 'C17' } })
    const view = screen.getByRole('button', { name: 'View record' })
    fireEvent.click(view)
    fireEvent.click(view)
    expect(openMain).toHaveBeenCalledExactlyOnceWith(controllerId)
    expect(screen.getByRole('dialog', { name: 'Team Management Center' })).toBeVisible()
    expect(consumeTeamPanelOpen(oldTeamId)).toBe(false)
    await act(async () => { ready.resolve() })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Team Management Center' })).not.toBeInTheDocument())
    expect(f.sessions.openSubagent).toHaveBeenCalledExactlyOnceWith(f.address)
    const session: ComponentProps<typeof YuqiTeamDock>['session'] = {
      sessionId: controllerId, views: { get: () => undefined },
      chat: {
        order: [], nodes: { get: () => undefined, values: () => [] },
        locations: { getTurn: () => [], getStep: () => [] },
        timeline: { turnOrder: [], turns: new Map() },
        legacy: { nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
      },
      nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null,
      runningCalls: [], pending: [], queue: [], running: false, subagent: null,
      composerPhase: 'active', removed: false, openState: 'open', openError: null,
      hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null,
    }
    const input: ComponentProps<typeof YuqiTeamDock>['input'] = {
      draft: '', imageIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [],
    }
    const inputActions: ComponentProps<typeof YuqiTeamDock>['inputActions'] = {
      setDraft: vi.fn(), addImages: vi.fn(() => true), removeImage: vi.fn(), pruneImages: vi.fn(), submit: vi.fn(),
    }
    render(<YuqiTeamDock session={session} input={input} sessionId={controllerId}
      useSession={select => select(session)} useInput={select => select(input)} inputActions={inputActions}
      useSessions={select => select({ ids: [], byId: {}, current: controllerId, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })}
      useWorkspaces={select => select({ items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined })}
      useProjection={() => oldSummary} onOpenChild={async () => false} />)
    expect(await screen.findByRole('dialog', { name: 'Yuqi Team task panel' })).toHaveTextContent('C17')
    expect(f.snapshot.byId[mainId]!.projectionValues.yuqiTeam.team.title).toBe('C18')
    expect(f.sessions.open).not.toHaveBeenCalled()
  })

  it.each(['false', 'throw'] as const)('keeps an active Team visible with an error and no panel request on %s, then permits retry', async mode => {
    document.documentElement.lang = 'en'
    const f = fixture()
    f.snapshot.byId[controllerId]!.projectionValues.yuqiTeam = { ...oldSummary, team: { ...oldSummary.team, status: 'running' } }
    const openMain = vi.fn(async () => true)
    if (mode === 'false') openMain.mockResolvedValueOnce(false)
    else openMain.mockRejectedValueOnce(new Error('offline'))
    const requested = vi.fn()
    window.addEventListener(OPEN_TEAM_PANEL_EVENT, requested)
    try {
      render(<TeamCenter sessions={f.sessions.list} openMain={openMain} openChild={async () => false} />)
      fireEvent.click(screen.getByRole('button', { name: 'Open Team management' }))
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search Teams' }), { target: { value: 'C17' } })
      fireEvent.click(screen.getByRole('button', { name: 'View tasks' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Host has no retained address or navigation failed')
      expect(screen.getByRole('dialog', { name: 'Team Management Center' })).toBeVisible()
      expect(requested).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'View tasks' }))
      await waitFor(() => expect(requested).toHaveBeenCalledTimes(1))
      expect(screen.queryByRole('dialog', { name: 'Team Management Center' })).not.toBeInTheDocument()
    } finally { window.removeEventListener(OPEN_TEAM_PANEL_EVENT, requested) }
  })

  it.each(['completed', 'cancelled', 'failed'] as const)('opens real %s history without changing sessions and restores the search on close', async status => {
    document.documentElement.lang = 'en'
    const f = fixture()
    const childId = 'historic-worker'
    f.snapshot.byId[controllerId]!.projectionValues.yuqiTeam = {
      ...oldSummary, team: { ...oldSummary.team, status }, tasks: [{
        taskId: 'historic-task', goal: 'Real catalog task', status: 'completed', modelRole: 'worker', model: 'model',
        authorityMode: 'read-only', dependencyCount: 0, fileScope: ['src/**'], attemptCount: 1,
        childSessionId: childId, evidenceRecorded: false, usage: { state: 'pending', label: 'Token：暂无数据' },
        duration: { state: 'unavailable' }, nextAction: '',
      }],
    }
    const loader = vi.fn<FileAuditHistoryLoader>(async () => ({ events: [], hasMore: false }))
    const archive = vi.fn(async () => true)
    f.sessions.refreshSubagents.mockResolvedValue(undefined)
    render(<TeamCenter sessions={f.sessions.list} openMain={id => openTeamCenterSession(f.ctx, id)} openChild={async () => false}
      archiveChild={archive} wrapHistory={panel => <FileAuditHistoryContext.Provider value={loader}>{panel}</FileAuditHistoryContext.Provider>} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Team management' }))
    fireEvent.click(screen.getByRole('button', { name: /^History/u }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Teams' }), { target: { value: 'C17' } })
    fireEvent.click(screen.getByRole('button', { name: 'View record' }))
    const panel = await screen.findByRole('dialog', { name: 'Yuqi Team task panel' })
    const layer = panel.closest('.yuqi-settings-layer.yuqi-management-layer')
    expect(layer).toHaveAttribute('lang', 'en')
    expect(layer?.parentElement).toBe(document.body)
    const backdrop = screen.getByRole('button', { name: 'Close Team panel (click backdrop)' })
    expect(backdrop).toHaveClass('yuqi-settings-backdrop')
    expect(backdrop.parentElement).toBe(layer)
    expect(panel).toHaveTextContent('C17')
    expect(panel).toHaveTextContent('This conversation is view-only')
    expect(panel).toHaveTextContent('Real catalog task')
    expect(screen.queryByRole('button', { name: 'Open controller' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send instruction' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Archive child Agent: Real catalog task' })).toBeDisabled()
    await waitFor(() => expect(loader).toHaveBeenCalledWith(childId, undefined, expect.any(AbortSignal)))
    expect(f.sessions.open).not.toHaveBeenCalled()
    expect(f.sessions.openSubagent).not.toHaveBeenCalled()
    expect(archive).not.toHaveBeenCalled()
    expect(consumeTeamPanelOpen(oldTeamId)).toBe(false)
    if (status === 'failed') fireEvent.click(backdrop)
    else if (status === 'cancelled') fireEvent.keyDown(window, { key: 'Escape' })
    else fireEvent.click(screen.getAllByRole('button', { name: 'Back to history' })[0]!)
    expect(screen.queryByRole('dialog', { name: 'Yuqi Team task panel' })).not.toBeInTheDocument()
    expect(await screen.findByRole('dialog', { name: 'Team Management Center' })).toBeVisible()
    expect(screen.getByRole('searchbox', { name: 'Search Teams' })).toHaveValue('C17')
    expect(screen.getByRole('button', { name: /^History/u })).toHaveAttribute('aria-pressed', 'true')
    expect(f.snapshot.byId[mainId]!.projectionValues.yuqiTeam.team.title).toBe('C18')
  })
})
