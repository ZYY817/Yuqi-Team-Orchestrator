// @vitest-environment jsdom

import { createElement, Fragment } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { TeamCenter } from '../../src/client/TeamCenter.tsx'
import { GlobalTeamAttention } from '../../src/client/GlobalTeamAttention.tsx'
import type { TeamConsoleSummary } from '../../src/domain/team-console-contract.ts'
import { setChildSessionArchived, setTeamArchived, setTeamDockDismissed, setTeamDockHidden } from '../../src/client/team-ui-preferences.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
})

const summary: TeamConsoleSummary = {
  controllerSessionId: 'controller-1',
  team: { id: 'team-1', title: '视觉升级', objective: '升级页面', status: 'paused', completedTaskCount: 0, runningTaskCount: 0, waitingTaskCount: 1, attentionTaskCount: 0, userDecisionCount: 0, controllerActionCount: 0, duration: { state: 'known', elapsedMs: 0 } },
  tasks: [{ taskId: 'design', goal: '设计首页', status: 'ready', modelRole: 'worker', model: 'deepseek-v4', authorityMode: 'write-authorized', dependencyCount: 0, fileScope: ['src/**'], attemptCount: 1, childSessionId: 'child-1', evidenceRecorded: false, usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '等待调度。' }],
  attention: [], usage: { state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' },
}

function selectPage(name: string) {
  const page = within(screen.getByRole('navigation', { name: /管理页面|Management pages/ })).getByRole('button', { name: new RegExp(name) })
  fireEvent.click(page)
  expect(page).toHaveAttribute('aria-current', 'true')
}

function selectFilter(name: string) {
  const filter = within(screen.getByRole('group', { name: /团队状态|Team status/ })).getByRole('button', { name: new RegExp('^' + name + ' ') })
  fireEvent.click(filter)
  expect(filter).toHaveAttribute('aria-pressed', 'true')
}

async function expandChildren(card: Element = screen.getByRole('article')) {
  const details = card.querySelector('details')!
  if (!details.open) fireEvent.click(details.querySelector('summary')!)
  await waitFor(() => expect(card.querySelector('.yuqi-team-center-task-copy')).toBeVisible())
  expect(details).toHaveAttribute('open')
}

describe('TeamCenter', () => {
  it('follows official footer wide state without moving the dialog or losing its state', () => {
    const snapshot = { ids: [], byId: {} }
    const props = { sessions: { getSnapshot: () => snapshot, subscribe: () => () => {} }, openMain: () => true, openChild: async () => true }
    const view = render(<TeamCenter {...props} wide={false} />)
    const trigger = document.querySelector('.yuqi-team-center-trigger')!
    expect(trigger).toHaveAttribute('data-collapsed', 'true')
    expect(trigger).toHaveAttribute('title')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeVisible()
    view.rerender(<TeamCenter {...props} wide />)
    expect(trigger).toHaveAttribute('data-collapsed', 'false')
    expect(screen.getByRole('dialog')).toBeVisible()
  })
  it('keeps global management available without Teams and opens grouped main/child navigation when a Team exists', async () => {
    const openMain = vi.fn(() => true)
    const openChild = vi.fn(async () => true)
    const empty = { ids: [], byId: {} }
    const state = { current: empty as any }
    const sessions = { getSnapshot: () => state.current, subscribe: () => () => undefined }
    const renderSettings = () => <p>默认设置测试面板</p>
    const view = render(<TeamCenter sessions={sessions} openMain={openMain} openChild={openChild} renderSettings={renderSettings} />)
    expect(screen.getByRole('button', { name: '打开 Team 管理中心' })).toBeInTheDocument()
    state.current = { ids: ['main-1' as SessionId], byId: { ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: summary } } } }
    view.rerender(<TeamCenter sessions={sessions} openMain={openMain} openChild={openChild} renderSettings={renderSettings} />)
    const trigger = screen.getByRole('button', { name: '打开 Team 管理中心' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAttribute('title', '团队设置')
    expect(trigger.querySelector('.yuqi-team-center-trigger-label')).toHaveTextContent('团队设置')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: '团队默认设置' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByText('默认设置测试面板')).toBeVisible()
    selectPage('团队任务')
    expect(screen.getByText('默认设置测试面板')).not.toBeVisible()
    expect(screen.getByRole('dialog', { name: 'Team 管理中心' })).toHaveTextContent('视觉升级')
    await expandChildren()
    expect(screen.getAllByTitle('设计首页').find(node => node.tagName === 'STRONG')!.parentElement).toHaveClass('yuqi-team-center-task-copy')
    fireEvent.click(screen.getByRole('button', { name: '打开子代理' }))
    await waitFor(() => expect(openChild).toHaveBeenCalledWith('controller-1', 'child-1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    fireEvent.click(screen.getByRole('button', { name: /^打开主控$/u }))
    await waitFor(() => expect(openMain).toHaveBeenCalledWith('main-1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('does not present unavailable Team data as zero pending items or an empty history', () => {
    const snapshot = { ids: [], byId: {} }
    const refresh = vi.fn(async () => undefined)
    const unavailableSnapshot = { status: 'error' as const, error: 'sessionController is unavailable' }
    const teamData = {
      getSnapshot: () => unavailableSnapshot,
      subscribe: () => () => undefined,
      refresh,
    }
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} teamData={teamData}
      openMain={() => true} openChild={async () => true} />)

    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    const pages = within(screen.getByRole('navigation', { name: '管理页面' }))
    expect(pages.getByRole('button', { name: /待处理事项 数量暂不可用/u })).toBeInTheDocument()
    fireEvent.click(pages.getByRole('button', { name: /待处理事项 数量暂不可用/u }))
    expect(screen.getByRole('alert')).toHaveTextContent('无法读取团队数据')
    expect(screen.getAllByText(/当前无法确认团队历史和待处理事项/u)).toHaveLength(2)
    expect(screen.queryByText('当前没有需要你确认的事项。运行异常、重试和依赖调度由主控自动处理。')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    expect(refresh).toHaveBeenCalledOnce()

    fireEvent.click(pages.getByRole('button', { name: '团队任务' }))
    expect(screen.getByRole('alert')).toHaveTextContent('无法读取团队数据')
    expect(screen.queryByText('当前筛选下没有团队。')).not.toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toHaveTextContent('当前数量未知')
  })

  it('keeps readable Team records visible when only part of the catalog is unavailable', () => {
    const snapshot = { ids: ['main-1' as SessionId], byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: summary } },
    } }
    const partialSnapshot = { status: 'ready' as const, unavailable: new Set(['missing-session']) }
    const teamData = { getSnapshot: () => partialSnapshot, subscribe: () => () => undefined }
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} teamData={teamData}
      openMain={() => true} openChild={async () => true} />)

    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    const pages = within(screen.getByRole('navigation', { name: '管理页面' }))
    expect(pages.getByRole('button', { name: /待处理事项 数量暂不可用/u })).toBeInTheDocument()
    fireEvent.click(pages.getByRole('button', { name: '团队任务' }))
    expect(screen.getByRole('alert')).toHaveTextContent('部分团队数据不可用')
    expect(screen.getByRole('article')).toHaveTextContent('视觉升级')
    expect(screen.queryByText('当前筛选下没有团队。')).not.toBeInTheDocument()
  })

  it('switches the management surface between Chinese and English and persists the preference', async () => {
    const snapshot = { ids: [], byId: {} }
    const sessions = { getSnapshot: () => snapshot, subscribe: () => () => undefined }
    render(<TeamCenter sessions={sessions} openMain={() => true} openChild={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(screen.getByRole('dialog', { name: 'Team Management Center' })).toHaveTextContent('Team defaults')
    expect(screen.getByText('No Teams match this filter.')).toBeInTheDocument()
    expect(localStorage.getItem('yuqi-team-orchestrator.locale.v1')).toBe('en')
  })

  it('renders English active-Team decisions, archive controls, and planned conversations', async () => {
    localStorage.setItem('yuqi-team-orchestrator.locale.v1', 'en')
    const englishSummary = {
      ...summary,
      team: { ...summary.team, planConfirmationPending: true },
      tasks: [
        { ...summary.tasks[0]!, status: 'completed' as const },
        { ...summary.tasks[0]!, taskId: 'planned', goal: 'Plan documentation', childSessionId: undefined, attemptCount: 0, status: 'pending' as const },
      ],
    }
    const snapshot = { ids: ['main-1' as SessionId], byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: 'Controller', projectionValues: { yuqiTeam: englishSummary } },
    } }
    setChildSessionArchived('team-1', 'child-1', true)
    setTeamDockHidden('team-1', true)
    const openMain = vi.fn(() => true)
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={openMain} openChild={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Team management, 1 decision needed' }))
    selectPage('Needs attention')
    expect(screen.getByRole('region', { name: 'Decisions needed' })).toHaveTextContent('Confirm task graph')
    selectPage('Teams')
    const team = screen.getAllByText('视觉升级').map(node => node.closest('article')).find(Boolean)!
    expect(team).toHaveTextContent('Task graph confirmation')
    expect(team).toHaveTextContent('1 decision pending')
    await expandChildren(team)
    expect(screen.getByText('Conversation not created')).toBeInTheDocument()
    expect(team).toHaveTextContent('Archived')
    fireEvent.click(screen.getByRole('button', { name: 'Restore Team card' }))
    expect(screen.queryByRole('button', { name: 'Restore Team card' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Archived' })).toBeDisabled()
    selectPage('Needs attention')
    fireEvent.click(screen.getByRole('button', { name: 'View decision' }))
    await waitFor(() => expect(openMain).toHaveBeenCalledWith('main-1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('handles plural English decisions and archived child navigation without closing on a rejected address', async () => {
    localStorage.setItem('yuqi-team-orchestrator.locale.v1', 'en')
    const active = {
      ...summary,
      team: { ...summary.team, id: 'team-active', title: 'Active controller', userDecisionCount: 2, attentionTaskCount: 2 },
      attention: [
        { taskId: 'design', code: 'verification-inconclusive' as const, owner: 'user' as const, message: 'Confirm the visual evidence.' },
        { taskId: 'design', code: 'dependency-blocked' as const, owner: 'user' as const, message: 'Choose the dependency fallback.' },
      ],
    }
    const archived = {
      ...summary,
      team: { ...summary.team, id: 'team-archived', title: 'Archived controller', status: 'completed' as const },
      tasks: [{ ...summary.tasks[0]!, taskId: 'archived-child', goal: 'Archived child', status: 'completed' as const }],
    }
    setTeamArchived('team-archived', true)
    const snapshot = { ids: ['main-active' as SessionId, 'main-archived' as SessionId], byId: {
      ['main-active' as SessionId]: { id: 'main-active' as SessionId, displayTitle: 'Active', projectionValues: { yuqiTeam: active } },
      ['main-archived' as SessionId]: { id: 'main-archived' as SessionId, displayTitle: 'Archived', projectionValues: { yuqiTeam: archived } },
    } }
    const openChild = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }}
      openMain={() => true} openChild={openChild} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Team management, 2 decisions needed' }))
    selectPage('Needs attention')
    expect(screen.getByRole('button', { name: 'View pending 2' })).toHaveTextContent('2')
    expect(screen.getByRole('region', { name: 'Decisions needed' })).toHaveTextContent('Confirm the visual evidence.')
    expect(screen.getByRole('region', { name: 'Decisions needed' })).toHaveTextContent('Decision needed')
    expect(within(screen.getByRole('region', { name: 'Decisions needed' })).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('region', { name: 'Decisions needed' })).toHaveTextContent('Choose the dependency fallback.')
    selectPage('Teams')
    const activeDetails = screen.getAllByText('Active controller').map(node => node.closest('article')).find(Boolean)!
    expect(activeDetails).toHaveTextContent('2 decisions pending')

    selectFilter('Archived')
    const archivedDetails = screen.getByText('Archived controller').closest('article')!
    await expandChildren(archivedDetails)
    fireEvent.click(screen.getAllByRole('button', { name: 'Open child Agent' }).at(-1)!)
    await waitFor(() => expect(openChild).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('alert')).toHaveTextContent('The child Agent conversation could not be opened.')
    expect(openChild).toHaveBeenCalledWith('controller-1', 'child-1')
    expect(screen.getByRole('dialog', { name: 'Team Management Center' })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Open child Agent' }).at(-1)!)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Team Management Center' })).not.toBeInTheDocument())
  })

  it('archives and restores a completed Team through the English management surface', async () => {
    localStorage.setItem('yuqi-team-orchestrator.locale.v1', 'en')
    const terminal = { ...summary, team: { ...summary.team, status: 'completed' as const } }
    const snapshot = { ids: ['main-1' as SessionId], byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: 'Controller', projectionValues: { yuqiTeam: terminal } },
    } }
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={() => true} openChild={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Team management' }))
    selectFilter('History')
    const team = screen.getByText('视觉升级').closest('article')!
    await expandChildren(team)
    fireEvent.click(screen.getByRole('button', { name: 'Archive Team and controller entry' }))
    expect(screen.getByText('No Teams match this filter.')).toBeInTheDocument()
    selectFilter('Archived')
    fireEvent.click(screen.getByRole('button', { name: 'Restore Team' }))
    selectFilter('History')
    expect(screen.getByText('视觉升级')).toBeInTheDocument()
  })

  it('keeps the manager open when a child address is not ready and supports explicit dismissal', async () => {
    const snapshot = { ids: ['main-1' as SessionId], byId: { ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: summary } } } }
    const sessions = { getSnapshot: () => snapshot, subscribe: () => () => undefined }
    render(<TeamCenter sessions={sessions} openMain={() => true} openChild={async () => false} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    await expandChildren()
    fireEvent.click(screen.getByRole('button', { name: '打开子代理' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('子代理会话未能打开')
    expect(screen.getByRole('dialog', { name: 'Team 管理中心' })).toBeVisible()
    fireEvent.click(screen.getAllByRole('button', { name: '关闭' }).at(-1)!)
    expect(screen.queryByRole('dialog', { name: 'Team 管理中心' })).not.toBeInTheDocument()
  })

  it('deduplicates bridged Team projections and labels tasks without child sessions', async () => {
    const withoutChild = { ...summary, tasks: [{ ...summary.tasks[0]!, childSessionId: undefined }] }
    const snapshot = { ids: ['main-1' as SessionId, 'bridge-1' as SessionId], byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: withoutChild } },
      ['bridge-1' as SessionId]: { id: 'bridge-1' as SessionId, displayTitle: '桥接', projectionValues: { yuqiTeam: withoutChild } },
    } }
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={() => true} openChild={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    expect(screen.getAllByText('视觉升级')).toHaveLength(1)
    await expandChildren()
    expect(screen.getByText('尚未创建会话')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭 Team 管理中心' }))
    expect(screen.queryByRole('dialog', { name: 'Team 管理中心' })).not.toBeInTheDocument()
  })

  it('omits the attention badge and keeps terminal Teams collapsed by default', async () => {
    const terminal = { ...summary, team: { ...summary.team, status: 'completed' as const, userDecisionCount: 0 } }
    const snapshot = { ids: ['main-1' as SessionId], byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: terminal } },
    } }
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={() => true} openChild={async () => true} />)
    const trigger = screen.getByRole('button', { name: '打开 Team 管理中心' })
    expect(trigger.querySelector('b')).toBeNull()
    fireEvent.click(trigger)
    selectFilter('历史记录')
    expect(screen.getByText('视觉升级').closest('article')!.querySelector('details')).not.toHaveAttribute('open')
  })

  it('restores a dismissed Team card and archived child conversations', async () => {
    const terminal = {
      ...summary,
      team: { ...summary.team, status: 'cancelled' as const, userDecisionCount: 0 },
      tasks: [{ ...summary.tasks[0]!, status: 'cancelled' as const, attemptStatus: 'cancelled' as const }],
    }
    const snapshot = { ids: ['main-1' as SessionId], byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: terminal } },
    } }
    setTeamDockDismissed('team-1', true)
    setChildSessionArchived('team-1', 'child-1', true)
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={() => true} openChild={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    selectFilter('历史记录')
    const team = screen.getByText('视觉升级').closest('article')!
    await expandChildren(team)
    expect(team).toHaveTextContent('已归档 1')
    fireEvent.click(screen.getByRole('button', { name: '恢复 Team 卡片' }))
    expect(screen.queryByRole('button', { name: '恢复 Team 卡片' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已归档' })).toBeDisabled()
    expect(team).toHaveTextContent('已归档 1')
  })

  it('restores a minimized Team card from the stable management entry', async () => {
    const snapshot = { ids: ['main-1' as SessionId], byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: summary } },
    } }
    setTeamDockHidden('team-1', true)
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={() => true} openChild={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复 Team 卡片' }))
    expect(screen.queryByRole('button', { name: '恢复 Team 卡片' })).not.toBeInTheDocument()
  })

  it('archives and restores a terminal Team as one recoverable management entry', async () => {
    const terminal = { ...summary, team: { ...summary.team, status: 'completed' as const, userDecisionCount: 0 } }
    const snapshot = { ids: ['main-1' as SessionId], byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: terminal } },
    } }
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={() => true} openChild={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    selectFilter('历史记录')
    const team = screen.getByText('视觉升级').closest('article')!
    await expandChildren(team)
    fireEvent.click(screen.getByRole('button', { name: '归档 Team 与主控入口' }))
    expect(screen.getByText('当前筛选下没有团队。')).toBeInTheDocument()
    selectFilter('已归档')
    fireEvent.click(screen.getByRole('button', { name: '恢复 Team' }))
    selectFilter('历史记录')
    expect(screen.queryByText('当前筛选下没有团队。')).not.toBeInTheDocument()
    expect(screen.getByText('视觉升级')).toBeInTheDocument()
  })

  it('allows a safely paused Team to be archived and restored', async () => {
    const paused = { ...summary, team: { ...summary.team, status: 'paused' as const, userDecisionCount: 0 } }
    const snapshot = { ids: ['main-1' as SessionId], byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: paused } },
    } }
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={() => true} openChild={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    fireEvent.click(screen.getByRole('button', { name: '归档 Team 与主控入口' }))
    expect(screen.getByText('当前筛选下没有团队。')).toBeInTheDocument()
    selectFilter('已归档')
    fireEvent.click(screen.getByRole('button', { name: '恢复 Team' }))
    selectFilter('进行中')
    expect(screen.getByText('视觉升级')).toBeInTheDocument()
  })

  it('prevents hiding a non-terminal Team that can still consume resources', async () => {
    const running = { ...summary, team: { ...summary.team, status: 'running' as const, runningTaskCount: 1, waitingTaskCount: 0 } }
    const snapshot = { ids: ['main-1' as SessionId], byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: running } },
    } }
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={() => true} openChild={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    expect(screen.getByRole('button', { name: '归档 Team 与主控入口' })).toBeDisabled()
  })

  it('does not include archived Teams in the global attention badge', async () => {
    const snapshot = { ids: ['main-1' as SessionId], byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: { ...summary, team: { ...summary.team, status: 'cancelled' as const } } } },
    } }
    setTeamArchived('team-1', true)
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={() => true} openChild={async () => true} />)
    expect(screen.getByRole('button', { name: '打开 Team 管理中心' }).querySelector('b')).toBeNull()
  })

  it('does not count stale decisions from a terminal unarchived Team', async () => {
    const terminalWithOldDecision = {
      ...summary,
      team: { ...summary.team, status: 'completed' as const, userDecisionCount: 1, attentionTaskCount: 1 },
      attention: [{ taskId: 'design', code: 'verification-inconclusive' as const, owner: 'user' as const, message: '旧决定' }],
    }
    const snapshot = { ids: ['main-terminal' as SessionId], byId: {
      ['main-terminal' as SessionId]: { id: 'main-terminal' as SessionId, displayTitle: '已完成主控', projectionValues: { yuqiTeam: terminalWithOldDecision } },
    } }
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={() => true} openChild={async () => true} />)
    expect(screen.getByRole('button', { name: '打开 Team 管理中心' }).querySelector('b')).toBeNull()
  })

  it('does not let legacy floating-card dismissal suppress an unresolved management decision', async () => {
    const attentionSummary = {
      ...summary,
      team: { ...summary.team, userDecisionCount: 1, attentionTaskCount: 1 },
      attention: [{ taskId: 'design', code: 'verification-inconclusive' as const, owner: 'user' as const, message: '需要用户确认结果' }],
    }
    const snapshot = { ids: ['main-1' as SessionId], current: 'main-1' as SessionId, byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: attentionSummary } },
    } }
    const sessions = { getSnapshot: () => snapshot, subscribe: () => () => undefined }
    const renderSurfaces = () => createElement(Fragment, {},
      createElement(GlobalTeamAttention, { sessions, openSession: () => undefined, attachToCurrent: async () => true }),
      createElement(TeamCenter, { sessions, openMain: () => true, openChild: async () => true }),
    )
    const view = render(renderSurfaces())
    expect(screen.getByRole('button', { name: '打开 Team 管理中心，1 项需要你决定' }).querySelector('b')).toHaveTextContent('1')

    fireEvent.click(screen.getByRole('button', { name: '关闭 视觉升级 提醒' }))

    expect(screen.queryByLabelText('Yuqi Team 全局待确认提醒')).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: '打开 Team 管理中心，1 项需要你决定' })
    expect(trigger.querySelector('b')).toHaveTextContent('1')
    fireEvent.click(trigger)
    selectPage('待处理事项')
    expect(screen.getByRole('region', { name: '需要你决定的事项' })).toHaveTextContent('需要用户确认结果')
    expect(screen.getByRole('region', { name: '需要你决定的事项' })).toHaveTextContent('设计首页')
    view.unmount()
    render(renderSurfaces())
    expect(screen.getByRole('button', { name: '打开 Team 管理中心，1 项需要你决定' }).querySelector('b')).toHaveTextContent('1')
  })

  it('counts and explains a pending plan confirmation even before child sessions exist', async () => {
    const planSummary = { ...summary, team: { ...summary.team, planConfirmationPending: true } }
    const snapshot = { ids: ['main-1' as SessionId], byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: planSummary } },
    } }
    const openMain = vi.fn(() => true)
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={openMain} openChild={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心，1 项需要你决定' }))
    selectPage('待处理事项')
    expect(screen.getByText('需要确认任务计划')).toBeInTheDocument()
    expect(screen.getByText(/检查任务、模型与权限/u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看并处理' }))
    await waitFor(() => expect(openMain).toHaveBeenCalledWith('main-1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('always opens the public main conversation when the hidden controller projection appears first', async () => {
    const snapshot = { ids: ['controller-1' as SessionId, 'main-1' as SessionId], byId: {
      ['controller-1' as SessionId]: { id: 'controller-1' as SessionId, displayTitle: '隐藏 controller', projectionValues: { yuqiTeam: summary } },
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '公开主对话', projectionValues: { yuqiTeam: summary } },
    } }
    const openMain = vi.fn(() => true)
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={openMain} openChild={async () => true} />)

    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    fireEvent.click(screen.getByRole('button', { name: /^打开主控$/u }))

    await waitFor(() => expect(openMain).toHaveBeenCalledWith('main-1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps the center open and reports child navigation false/rejection', async () => {
    const snapshot = { ids: ['main-1' as SessionId], byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: summary } },
    } }
    const openChild = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('offline'))
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={() => true} openChild={openChild} />)

    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    await expandChildren()
    fireEvent.click(screen.getByRole('button', { name: '打开子代理' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('子代理会话未能打开')
    fireEvent.click(screen.getByRole('button', { name: '打开子代理' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('打开子代理会话失败')
    expect(screen.getByRole('dialog', { name: 'Team 管理中心' })).toBeInTheDocument()
  })

  it('traps focus in the center and restores the trigger after Escape', async () => {
    const snapshot = { ids: [], byId: {} }
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }} openMain={() => true} openChild={async () => true} />)
    const trigger = screen.getByRole('button', { name: '打开 Team 管理中心' })
    trigger.focus()
    fireEvent.click(trigger)
    const first = within(screen.getByRole('navigation', { name: '管理页面' })).getByRole('button', { name: '团队默认设置' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(screen.getAllByRole('button', { name: '关闭' }).at(-1)).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(trigger).toHaveFocus()
  })

  it('allows marking decisions as read in TeamCenter and restoring them', async () => {
    const attentionSummary = {
      ...summary,
      team: { ...summary.team, userDecisionCount: 1, attentionTaskCount: 1 },
      attention: [{ taskId: 'design', code: 'verification-inconclusive' as const, owner: 'user' as const, message: '需要用户确认结果' }],
    }
    const snapshot = { ids: ['main-1' as SessionId], current: 'main-1' as SessionId, byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: attentionSummary } },
    } }
    const sessions = { getSnapshot: () => snapshot, subscribe: () => () => undefined }
    render(<TeamCenter sessions={sessions} openMain={() => true} openChild={async () => true} />)

    const trigger = screen.getByRole('button', { name: '打开 Team 管理中心，1 项需要你决定' })
    fireEvent.click(trigger)
    selectPage('待处理事项')
    expect(screen.getByRole('region', { name: '需要你决定的事项' })).toHaveTextContent('需要用户确认结果')

    // Click "标为已读"
    const markReadBtn = screen.getByRole('button', { name: '标为已读' })
    fireEvent.click(markReadBtn)

    // The pending region remains mounted but contains no unresolved decision cards.
    expect(screen.getByRole('region', { name: '需要你决定的事项' })).not.toHaveTextContent('需要用户确认结果')
    expect(screen.getByText('当前没有需要你确认的事项。运行异常、重试和依赖调度由主控自动处理。')).toBeInTheDocument()

    // The read decision remains available through the Read filter.
    expect(screen.getByRole('button', { name: '已读 1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '已读 1' }))
    expect(screen.getByRole('region', { name: '需要你决定的事项' })).toHaveTextContent('需要用户确认结果')

    // Click "重新标为待处理"
    const unreadBtn = screen.getByRole('button', { name: '重新标为待处理' })
    fireEvent.click(unreadBtn)

    fireEvent.click(screen.getByRole('button', { name: '待决定 1' }))
    // Active decision is restored
    expect(screen.getByRole('region', { name: '需要你决定的事项' })).toHaveTextContent('需要用户确认结果')
  })

  it('marks decisions as read from global attention and synchronizes with TeamCenter', async () => {
    const attentionSummary = {
      ...summary,
      team: { ...summary.team, userDecisionCount: 1, attentionTaskCount: 1 },
      attention: [{ taskId: 'design', code: 'verification-inconclusive' as const, owner: 'user' as const, message: '需要用户确认结果' }],
    }
    const snapshot = { ids: ['main-1' as SessionId], current: 'main-1' as SessionId, byId: {
      ['main-1' as SessionId]: { id: 'main-1' as SessionId, displayTitle: '主控', projectionValues: { yuqiTeam: attentionSummary } },
    } }
    const sessions = { getSnapshot: () => snapshot, subscribe: () => () => undefined }
    const renderSurfaces = () => createElement(Fragment, {},
      createElement(GlobalTeamAttention, { sessions, openSession: () => undefined, attachToCurrent: async () => true }),
      createElement(TeamCenter, { sessions, openMain: () => true, openChild: async () => true }),
    )
    render(renderSurfaces())

    // Click "标为已读" on the global floating attention card
    fireEvent.click(screen.getByRole('button', { name: '将 视觉升级 决定标为已读' }))

    // Global card disappears
    expect(screen.queryByLabelText('Yuqi Team 全局待确认提醒')).not.toBeInTheDocument()

    // Trigger badge is cleared
    const trigger = screen.getByRole('button', { name: '打开 Team 管理中心' })
    expect(trigger.querySelector('b')).toBeNull()

    // Open TeamCenter -> it does NOT show active decisions needed!
    fireEvent.click(trigger)
    selectPage('待处理事项')
    expect(screen.getByRole('region', { name: '需要你决定的事项' })).not.toHaveTextContent('需要用户确认结果')
    expect(screen.getByText('当前没有需要你确认的事项。运行异常、重试和依赖调度由主控自动处理。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已读 1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '已读 1' }))
    expect(screen.getByRole('region', { name: '需要你决定的事项' })).toHaveTextContent('需要用户确认结果')
  })
})
