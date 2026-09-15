// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeamConsoleSummary, TeamConsoleTask } from '../../src/domain/team-console-contract.ts'
import { TeamDockBar } from '../../src/client/TeamDockBar.tsx'
import { TeamPanel } from '../../src/client/TeamPanel.tsx'
import { TeamControllerRecovery } from '../../src/client/TeamControllerRecovery.tsx'
import { teamHasDispatchableWork, teamTaskActionTarget } from '../../src/client/team-execution-actions.ts'
import { TeamContinuationContext, type SendTeamContinuation, type TeamContinuationRequest } from '../../src/client/team-continuation.ts'

const task = (taskId: string, status: TeamConsoleTask['status']): TeamConsoleTask => ({
  taskId, goal: `Goal ${taskId}`, status, modelRole: 'worker', model: 'model', authorityMode: 'read-only',
  dependencyCount: 0, fileScope: [], attemptCount: status === 'failed' ? 1 : 0,
  evidenceRecorded: false, usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '',
})
const summary = (tasks: readonly TeamConsoleTask[]): TeamConsoleSummary => ({
  controllerSessionId: 'controller',
  team: { id: 'team', title: 'Team', objective: 'Test', status: 'paused', completedTaskCount: 0, runningTaskCount: 0,
    waitingTaskCount: tasks.filter(item => item.status === 'pending' || item.status === 'ready').length,
    attentionTaskCount: tasks.filter(item => item.status === 'failed' || item.status === 'blocked').length,
    userDecisionCount: 0, controllerActionCount: 0, duration: { state: 'unavailable' } },
  tasks, attention: [], usage: { state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' },
})

afterEach(() => { cleanup(); document.documentElement.lang = '' })

describe('paused Team action selection', () => {
  it('treats only pending or ready tasks as resumable scheduler work', () => {
    expect(teamHasDispatchableWork(summary([task('failed', 'failed'), task('blocked', 'blocked')]))).toBe(false)
    expect(teamTaskActionTarget(summary([task('blocked', 'blocked'), task('failed', 'failed')]))?.taskId).toBe('failed')
    expect(teamHasDispatchableWork(summary([task('ready', 'ready')]))).toBe(true)
    expect(teamHasDispatchableWork(summary([{ ...task('waiting', 'pending'), dependencyCount: 1,
      dependencies: [{ taskId: 'failed', goal: 'failed' }] }, task('failed', 'failed')]))).toBe(false)
    expect(teamHasDispatchableWork(summary([{ ...task('waiting', 'pending'), dependencyCount: 1,
      dependencies: [{ taskId: 'done', goal: 'done' }] }, task('done', 'completed')]))).toBe(true)
  })

  it('prefers the Host resume disposition over legacy task inference', () => {
    const withDisposition = (resumeDisposition: NonNullable<TeamConsoleSummary['team']['resumeDisposition']>, tasks: readonly TeamConsoleTask[]) => {
      const value = summary(tasks)
      return { ...value, team: { ...value.team, resumeDisposition } }
    }
    expect(teamHasDispatchableWork(withDisposition('runnable', [task('failed', 'failed')]))).toBe(true)
    expect(teamHasDispatchableWork(withDisposition('completion-ready', [task('blocked', 'blocked')]))).toBe(true)
    for (const disposition of ['decision-required', 'requires-reconciliation', 'inactive'] as const) {
      expect(teamHasDispatchableWork(withDisposition(disposition, [task('ready', 'ready')]))).toBe(false)
    }
  })

  it('shows continue for dispatchable work and a task-resolution shortcut for failed or blocked work', () => {
    document.documentElement.lang = 'zh'
    const onOpen = vi.fn()
    const base = { nativeAttentionCount: 0, command: vi.fn(async () => true), nowMs: 0, expanded: false,
      onOpen, onHide: vi.fn(), hideLabel: '隐藏', hideTitle: '隐藏', hideText: '隐藏' }
    const view = render(<TeamDockBar {...base} summary={summary([task('ready', 'ready')])} />)
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '处理失败任务' })).not.toBeInTheDocument()

    view.rerender(<TeamDockBar {...base} summary={summary([task('failed', 'failed'), task('blocked', 'blocked')])} />)
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '处理失败任务' }))
    expect(onOpen).toHaveBeenCalledOnce()

    const failedWithQuestion = summary([task('failed', 'failed')])
    view.rerender(<TeamDockBar {...base} nativeAttentionCount={1} summary={failedWithQuestion} />)
    expect(screen.getByRole('button', { name: '查看 Team 待处理问题' })).toHaveTextContent('查看问题')
    expect(screen.queryByRole('button', { name: '处理失败任务' })).not.toBeInTheDocument()
  })

  it('keeps the panel out of a false continue state and omits the empty instruction composer', () => {
    document.documentElement.lang = 'zh'
    render(<TeamPanel summary={summary([task('failed', 'failed'), task('blocked', 'blocked')])}
      onClose={vi.fn()} onOpenChild={vi.fn(async () => true)} command={vi.fn(async () => true)} nowMs={0} />)
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '处理失败任务' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '主控恢复处理' })).toHaveTextContent('交给主控统一检查并继续')
    expect(screen.queryByRole('region', { name: '补充团队要求' })).not.toBeInTheDocument()
  })

  it.each([
    ['accepted', 'status', '恢复请求已排队，请勿重复发送。'],
    ['rejected', 'alert', 'Team 绑定或状态已更新；请刷新后重新检查。'],
    ['unknown', 'alert', '投递结果不确定。请打开主控对话核对这条请求，确认前不要重复发送。'],
  ] as const)('reports controller recovery delivery as %s without sending on panel open', async (outcome, role, message) => {
    document.documentElement.lang = 'zh'
    const call = vi.fn(async (_request: TeamContinuationRequest) => outcome)
    const send = call as SendTeamContinuation
    send.openController = vi.fn(async () => true)
    const value = summary([task('failed', 'failed'), { ...task('blocked', 'blocked'), nextAction: '等待失败依赖处理。' }])
    const decision = { ...value, team: { ...value.team, resumeDisposition: 'decision-required' as const } }
    render(<TeamContinuationContext.Provider value={send}><TeamPanel summary={decision}
      onClose={vi.fn()} onOpenChild={vi.fn(async () => true)} command={vi.fn(async () => true)} nowMs={0} /></TeamContinuationContext.Provider>)
    expect(call).not.toHaveBeenCalled()
    const recovery = screen.getByRole('region', { name: '主控恢复处理' })
    expect(recovery).toHaveTextContent('1 个失败、1 个阻塞')
    const recoveryButton = await screen.findByRole('button', { name: '交给主控检查并继续' })
    await act(async () => { fireEvent.click(recoveryButton) })
    expect(call).toHaveBeenCalledOnce()
    expect(call.mock.calls[0]![0]).toMatchObject({ intent: 'recovery', sourceTeamId: 'team', sourceControllerSessionId: 'controller' })
    expect(call.mock.calls[0]![0].message).toContain('"taskId":"failed"')
    expect(call.mock.calls[0]![0].message).toContain('"taskId":"blocked"')
    expect(within(recovery).getByRole(role)).toHaveTextContent(message)
    expect(send.openController).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0)
  })
})

describe('controller recovery receipt UI', () => {
  const decision = (teamId = 'team', controllerSessionId = 'controller') => {
    const value = summary(Array.from({ length: 7 }, (_, index) => ({
      ...task(`failed-${index + 1}`, index === 6 ? 'blocked' : 'failed'),
      nextAction: `Action ${index + 1}`,
    })))
    return { ...value, controllerSessionId, team: { ...value.team, id: teamId, resumeDisposition: 'decision-required' as const } }
  }

  it('shows a durable accepted receipt across remounts and allows a different Team to send', async () => {
    document.documentElement.lang = 'zh'
    let accepted: { teamId: string; controllerId: string; message: string; id: string } | undefined
    const call = vi.fn(async (request: TeamContinuationRequest) => {
      accepted = { teamId: request.sourceTeamId, controllerId: request.sourceControllerSessionId,
        message: request.message, id: request.requestId }
      return 'accepted' as const
    })
    const send = call as SendTeamContinuation
    send.acceptedRecovery = vi.fn(async request => accepted && accepted.teamId === request.sourceTeamId
      && accepted.controllerId === request.sourceControllerSessionId && accepted.message === request.message ? accepted.id : undefined)
    send.openController = vi.fn(async () => true)

    const first = render(<TeamContinuationContext.Provider value={send}><TeamControllerRecovery summary={decision()} /></TeamContinuationContext.Provider>)
    const region = screen.getByRole('region', { name: '主控恢复处理' })
    expect(region.querySelector('details')).not.toHaveAttribute('open')
    fireEvent.click(await screen.findByRole('button', { name: '交给主控检查并继续' }))
    expect(await screen.findByRole('status')).toHaveTextContent('恢复请求已排队，请勿重复发送。')
    expect(call).toHaveBeenCalledOnce()

    first.unmount()
    const second = render(<TeamContinuationContext.Provider value={send}><TeamControllerRecovery summary={decision()} /></TeamContinuationContext.Provider>)
    expect(await screen.findByRole('status')).toHaveTextContent('恢复请求已提交，请在主控查看结果；请勿重复发送。')
    expect(screen.queryByRole('button', { name: '交给主控检查并继续' })).not.toBeInTheDocument()
    expect(call).toHaveBeenCalledOnce()

    second.rerender(<TeamContinuationContext.Provider value={send}><TeamControllerRecovery summary={decision('team-2', 'controller-2')} /></TeamContinuationContext.Provider>)
    expect(await screen.findByRole('button', { name: '交给主控检查并继续' })).toBeEnabled()
    expect(screen.queryByText('恢复请求已提交，请在主控查看结果；请勿重复发送。')).not.toBeInTheDocument()
  })

  it('reports rejected delivery and always releases busy state when receipt helpers reject', async () => {
    document.documentElement.lang = 'zh'
    const rejected = vi.fn(async () => 'rejected' as const) as SendTeamContinuation
    const first = render(<TeamContinuationContext.Provider value={rejected}><TeamControllerRecovery summary={decision()} /></TeamContinuationContext.Provider>)
    fireEvent.click(await screen.findByRole('button', { name: '交给主控检查并继续' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Team 绑定或状态已更新；请刷新后重新检查。')
    expect(screen.getByRole('button', { name: '交给主控检查并继续' })).toBeEnabled()
    first.unmount()

    const pending = vi.fn(async () => 'unknown' as const) as SendTeamContinuation
    pending.pending = () => 'pending-id'
    pending.openPending = vi.fn().mockRejectedValueOnce(new Error('open failed')).mockResolvedValueOnce(true)
    pending.confirmReceived = vi.fn(async () => { throw new Error('confirm failed') })
    render(<TeamContinuationContext.Provider value={pending}><TeamControllerRecovery summary={decision()} /></TeamContinuationContext.Provider>)
    const open = screen.getByRole('button', { name: '打开主控并核对' })
    fireEvent.click(open)
    expect(await screen.findByRole('alert')).toHaveTextContent('无法打开已核验的主控对话')
    expect(open).toBeEnabled()
    fireEvent.click(open)
    const confirm = screen.getByRole('button', { name: '已找到这条请求' })
    await act(async () => {})
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(await screen.findByRole('alert')).toHaveTextContent('无法核实回执')
    expect(confirm).toBeEnabled()
  })
})
