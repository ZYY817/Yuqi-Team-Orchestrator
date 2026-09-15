// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { TeamConsoleSummary } from '../../src/domain/team-console-contract.ts'
import { TeamCenter, type TeamCenterInjected } from '../../src/client/TeamCenter.tsx'
import { TeamDockBar } from '../../src/client/TeamDockBar.tsx'
import { requestTeamAttentionOpen } from '../../src/client/team-panel-events.ts'
import { dismissDecisionReminder, isDecisionDismissed, markTeamDecisionsAsRead, decisionReminderKey } from '../../src/client/attention-reminder-preferences.ts'

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks() })
const id = (value: string) => value as SessionId
const summary: TeamConsoleSummary = {
  controllerSessionId: 'controller',
  team: { id: 'team', title: '整理项目页面', objective: '整理项目页面', status: 'paused', completedTaskCount: 0, runningTaskCount: 0, waitingTaskCount: 1, attentionTaskCount: 1, userDecisionCount: 1, controllerActionCount: 0, duration: { state: 'known', elapsedMs: 0 } },
  tasks: [{ taskId: 'pages', goal: '整理所有页面', status: 'ready', modelRole: 'worker', model: 'deepseek-v4', authorityMode: 'write-authorized', dependencyCount: 0, fileScope: ['src/**'], attemptCount: 1, attemptId: 'attempt-1', evidenceRecorded: false, usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '等待调度' }],
  attention: [{ taskId: 'pages', code: 'verification-inconclusive', owner: 'user', message: '请确认是否保留现有布局' }],
  usage: { state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' },
}
function setup(current = 'other', value = summary, extra: Partial<TeamCenterInjected> = {}) {
  let snapshot: ReturnType<TeamCenterInjected['sessions']['getSnapshot']> = {
    ids: [id('main'), id('other')], current: id(current), byId: {
      [id('main')]: { id: id('main'), displayTitle: '主对话', cwd: 'F:/project', agentPreset: 'yuqi-team', projectionValues: { yuqiTeam: value } },
      [id('other')]: { id: id('other'), displayTitle: '另一个对话', cwd: 'F:/project', agentPreset: 'yuqi-team' },
    },
  }
  const listeners = new Set<() => void>()
  const props = { sessions: { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }, openMain: vi.fn(async () => true), openChild: vi.fn(async () => true), ...extra }
  const view = render(<TeamCenter {...props} />)
  return { ...view, props, update: (next: typeof snapshot) => act(() => { snapshot = next; listeners.forEach(listener => listener()) }), snapshot: () => snapshot }
}
const quick = () => screen.getByRole('dialog', { name: '其他团队待处理事项' })
const launch = () => screen.getByRole('button', { name: '查看待办 1' })

describe('contextual Team attention', () => {
  it('keeps the current Team out of the other-Team menu and opens its real attention page', () => {
    setup('main')
    expect(screen.queryByRole('button', { name: /查看待办/ })).not.toBeInTheDocument()
    act(() => requestTeamAttentionOpen('team'))
    expect(screen.getByRole('dialog', { name: 'Team 管理中心' })).toBeVisible()
    expect(screen.getByRole('region', { name: '需要你决定的事项' })).toHaveTextContent('请确认是否保留现有布局')
  })
  it('anchors a portal beside the trigger, restores focus, and closing never marks a decision read', () => {
    setup()
    const trigger = launch()
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ left: 12, right: 212, top: 600, bottom: 636, width: 200, height: 36, x: 12, y: 600, toJSON: () => ({}) })
    trigger.focus(); fireEvent.click(trigger)
    expect(quick().parentElement).toBe(document.body)
    expect(quick()).toHaveStyle({ left: '220px', visibility: 'visible' })
    expect(within(quick()).getByRole('button', { name: '关闭待处理事项' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(launch()).toBeInTheDocument()
    fireEvent.click(trigger); fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(sessionStorage.getItem('yuqi-team-orchestrator:dismissed-reminders:v1')).toBeNull()
  })
  it('routes a decision into management without auto-running or opening an unrelated task panel', () => {
    const { props } = setup()
    fireEvent.click(launch()); fireEvent.click(within(quick()).getByRole('button', { name: '查看问题' }))
    expect(screen.queryByRole('dialog', { name: '其他团队待处理事项' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '需要你决定的事项' })).toHaveTextContent('请确认是否保留现有布局')
    expect(props.openMain).not.toHaveBeenCalled()
  })
  it('keeps failed plan navigation visible and opens the task panel only after navigation succeeds', async () => {
    const openMain = vi.fn(async () => false)
    setup('other', { ...summary, team: { ...summary.team, planConfirmationPending: true, userDecisionCount: 0 }, attention: [] }, { openMain })
    fireEvent.click(launch()); fireEvent.click(within(quick()).getByRole('button', { name: '查看任务' }))
    expect(await within(quick()).findByRole('alert')).toHaveTextContent('无法打开')
    expect(openMain).toHaveBeenCalledWith('main')
  })
  it('serializes attachment, reports rejection, and ignores a late result after changing conversations', async () => {
    let finish!: (value: boolean) => void
    const attachToCurrent = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const view = setup('other', summary, { attachToCurrent })
    fireEvent.click(launch())
    const attach = within(quick()).getByRole('button', { name: '切换到当前对话' })
    fireEvent.click(attach); fireEvent.click(attach)
    expect(attachToCurrent).toHaveBeenCalledTimes(1)
    expect(attachToCurrent).toHaveBeenCalledWith(summary, 'other')
    await act(async () => finish(false))
    expect(within(quick()).getByRole('alert')).toHaveTextContent('未能切换')
    fireEvent.click(within(quick()).getByRole('button', { name: '切换到当前对话' }))
    view.update({ ...view.snapshot(), current: id('main') })
    await act(async () => finish(false))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('does not offer attachment across workspaces or non-Team presets', () => {
    const view = setup()
    view.update({ ...view.snapshot(), byId: { ...view.snapshot().byId, [id('other')]: { id: id('other'), displayTitle: '其他', cwd: 'F:/different', agentPreset: 'ordinary' } } })
    fireEvent.click(launch())
    expect(within(quick()).queryByRole('button', { name: '切换到当前对话' })).not.toBeInTheDocument()
  })
  it('retains a native question with no Team projection and never submits it just by opening', () => {
    const respond = vi.fn()
    const view = setup('other', { ...summary, team: { ...summary.team, userDecisionCount: 0 }, attention: [] }, { getNativeInteractions: () => [{ key: 'question-1', kind: 'question', questions: [{ id: 'q', question: '保留旧页面吗？' }], respond }] })
    view.update({ ...view.snapshot(), ids: [id('yuqi-team-native'), id('other')], byId: { [id('other')]: view.snapshot().byId[id('other')]!, [id('yuqi-team-native')]: { id: id('yuqi-team-native'), displayTitle: '整理旧页面', agentPreset: 'yuqi-team', pendingInteraction: 'question' } } })
    fireEvent.click(launch()); fireEvent.click(within(quick()).getByRole('button', { name: '查看问题' }))
    expect(screen.getByRole('region', { name: '需要你决定的事项' })).toHaveTextContent('保留旧页面吗？')
    expect(respond).not.toHaveBeenCalled()
  })
  it('keeps acknowledged decisions accessible and alerts again for a new attempt', () => {
    markTeamDecisionsAsRead(summary)
    const view = setup()
    expect(screen.queryByRole('button', { name: /查看待办/ })).not.toBeInTheDocument()
    view.update({ ...view.snapshot(), byId: { ...view.snapshot().byId, [id('main')]: { ...view.snapshot().byId[id('main')]!, projectionValues: { yuqiTeam: { ...summary, tasks: [{ ...summary.tasks[0]!, attemptId: 'attempt-2' }] } } } } })
    expect(launch()).toBeInTheDocument()
    expect(isDecisionDismissed(new Set(['team-read:team']), 'team', 'pages:verification-inconclusive:attempt-2')).toBe(false)
    dismissDecisionReminder('team', 'pages:verification-inconclusive:attempt-1')
    expect(isDecisionDismissed(new Set([decisionReminderKey('team', 'pages:verification-inconclusive:attempt-1')]), 'team', 'pages:verification-inconclusive:attempt-2')).toBe(false)
  })
  it('integrates native pending items into one Dock and does not offer Start until they clear', () => {
    const onOpen = vi.fn()
    render(<TeamDockBar summary={{ ...summary, team: { ...summary.team, userDecisionCount: 0, planConfirmationPending: true }, attention: [] }} nativeAttentionCount={1} nowMs={0} expanded={false} onOpen={onOpen} onHide={() => {}} hideLabel="隐藏" hideText="隐藏" hideTitle="隐藏" />)
    expect(screen.getAllByRole('region', { name: 'Yuqi Team 状态与操作' })).toHaveLength(1)
    expect(screen.getByText('有 1 项需要你确认')).toBeVisible()
    expect(screen.queryByRole('button', { name: '开始执行' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看 Team 待处理问题' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
  it('keeps compact Token text while exposing the exact total and coverage in its title', () => {
    const usage = { state: 'known' as const, scope: '受管子 Agent' as const, uncachedInputTokens: 7_368_653, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 7_368_653, label: 'Token' }
    render(<TeamDockBar summary={{ ...summary, team: { ...summary.team, status: 'running' }, usage }} nowMs={0} expanded={false} onOpen={() => {}} onHide={() => {}} hideLabel="隐藏" hideText="隐藏" hideTitle="隐藏" />)
    expect(screen.getByText('已用 736.9万 Token')).toHaveAttribute('title', '7,368,653 Token · 已结算 attempt 均有 Token 记录')
  })
})
