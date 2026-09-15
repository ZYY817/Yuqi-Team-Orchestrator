// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { YuqiCommandOutcomeError } from '../../src/client/command-outcome.ts'
import '@testing-library/jest-dom/vitest'
import { GlobalTeamAttention } from '../../src/client/GlobalTeamAttention.tsx'
import { summarizeTeamForConsole } from '../../src/application/team-console-summary.ts'
import { replayTeamEvents } from '../../src/domain/projection.ts'
import type { TeamConsoleSummary } from '../../src/domain/team-console-contract.ts'
import { ATTEMPT_ID, completeTeamEvents, event, TASK_ID } from '../fixtures.ts'
import { setTeamArchived } from '../../src/client/team-ui-preferences.ts'

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
  window.localStorage.clear()
  document.documentElement.lang = ''
  vi.restoreAllMocks()
})

function withUserDecision(summary: TeamConsoleSummary, message = '需要用户确认结果'): TeamConsoleSummary {
  const taskId = summary.tasks[0]?.taskId ?? String(TASK_ID)
  return {
    ...summary,
    team: { ...summary.team, userDecisionCount: 1, attentionTaskCount: 1 },
    attention: [{ taskId, code: 'verification-inconclusive', owner: 'user', message }],
  }
}

describe('GlobalTeamAttention', () => {
  it('does not keep stale decision reminders after a Team is terminal', () => {
    const completed = summarizeTeamForConsole(replayTeamEvents(completeTeamEvents()), { controllerSessionId: 'controller-terminal' })
    const summary = withUserDecision(completed, '旧的待确认内容')
    const snapshot = {
      ids: ['parent-terminal'], current: 'parent-terminal',
      byId: { 'parent-terminal': { id: 'parent-terminal', displayTitle: '已结束主控', projectionValues: { yuqiTeam: summary } } },
    }

    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
    }))

    expect(screen.queryByLabelText('Yuqi Team 全局待确认提醒')).not.toBeInTheDocument()
  })

  it('routes English controller decisions and native child interactions through the main conversation', async () => {
    document.documentElement.lang = 'en-US'
    const projection = replayTeamEvents([
      ...completeTeamEvents().slice(0, 8),
      event(990, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'unknown' }),
      event(991, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const summary = withUserDecision(summarizeTeamForConsole(projection, { controllerSessionId: 'yuqi-team-controller-en' }), 'Choose the safe recovery path.')
    const snapshot = {
      ids: ['parent-en', 'current-en', 'child-1', 'yuqi-team-controller-en', 'yuqi-team-orphan'], current: 'current-en',
      byId: {
        'parent-en': { id: 'parent-en', displayTitle: 'English controller', cwd: 'F:\\Project', projectionValues: { yuqiTeam: summary } },
        'current-en': { id: 'current-en', displayTitle: 'Current conversation', cwd: 'f:/project', agentPreset: 'yuqi-team' },
        'child-1': { id: 'child-1', displayTitle: 'Worker question', parentId: 'yuqi-team-controller-en', pendingInteraction: 'approval' },
        'yuqi-team-controller-en': { id: 'yuqi-team-controller-en', displayTitle: 'Controller plan', pendingInteraction: 'plan-review', projectionValues: { yuqiTeam: summary } },
        'yuqi-team-orphan': { id: 'yuqi-team-orphan', displayTitle: 'Orphan question', pendingInteraction: 'question' },
      },
    }
    const openSession = vi.fn()
    const attachToCurrent = vi.fn(async () => true)
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession, attachToCurrent,
    }))

    const reminder = screen.getByLabelText('Yuqi Team global attention')
    expect(reminder).toHaveTextContent('needs confirmation')
    expect(reminder).toHaveTextContent('This action needs a user decision about permissions or risk.')
    expect(reminder).toHaveTextContent('The execution plan is waiting for user review.')
    expect(reminder).toHaveTextContent('A child Agent asked a question')
    expect(reminder).toHaveTextContent('Handle it in the controller conversation')
    fireEvent.click(screen.getByRole('button', { name: 'Attach to current conversation' }))
    await waitFor(() => expect(attachToCurrent).toHaveBeenCalledWith(summary, 'current-en'))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Yuqi Team reminder' }))
    expect(screen.queryByText('Choose the safe recovery path.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open waiting conversation' }))
    expect(openSession).toHaveBeenCalledWith('yuqi-team-orphan')
  })

  it('shows only user-owned decisions globally and can open or rebind the Team', async () => {
    const projection = replayTeamEvents([
      ...completeTeamEvents().slice(0, 8),
      event(990, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'unknown' }),
      event(991, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const summary = withUserDecision(summarizeTeamForConsole(projection, { controllerSessionId: 'controller-1' }), '需要用户裁决')
    const snapshot = {
      ids: ['parent-1', 'current-1'], current: 'current-1',
      byId: {
        'parent-1': { id: 'parent-1', displayTitle: '原主控', cwd: 'F:\\Project', projectionValues: { yuqiTeam: summary } },
        'current-1': { id: 'current-1', displayTitle: '新主控', cwd: 'f:/project', agentPreset: 'yuqi-team' },
      },
    }
    const openSession = vi.fn()
    const attachToCurrent = vi.fn(async () => true)
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession,
      openCurrentTeam: vi.fn(),
      attachToCurrent,
    }))

    expect(screen.getByLabelText('Yuqi Team 全局待确认提醒')).toHaveTextContent('需要用户裁决')
    fireEvent.click(screen.getByRole('button', { name: '进入主控处理' }))
    expect(openSession).toHaveBeenCalledWith('parent-1')
    fireEvent.click(screen.getByRole('button', { name: '切换到当前对话' }))
    await waitFor(() => expect(attachToCurrent).toHaveBeenCalledWith(summary, 'current-1'))
  })

  it('de-duplicates the controller projection and prefers its public parent conversation', () => {
    const projection = replayTeamEvents([
      ...completeTeamEvents().slice(0, 8),
      event(990, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'unknown' }),
      event(991, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const controllerSummary = withUserDecision(summarizeTeamForConsole(projection))
    const parentSummary = withUserDecision(summarizeTeamForConsole(projection, { controllerSessionId: 'yuqi-team-controller-1' }))
    const snapshot = {
      ids: ['yuqi-team-controller-1', 'parent-1'], current: 'parent-1',
      byId: {
        'yuqi-team-controller-1': { id: 'yuqi-team-controller-1', displayTitle: '隐藏 controller', cwd: 'F:\\Project', projectionValues: { yuqiTeam: controllerSummary } },
        'parent-1': { id: 'parent-1', displayTitle: '公开主控', cwd: 'F:\\Project', projectionValues: { yuqiTeam: parentSummary } },
      },
    }
    const openSession = vi.fn()
    const openCurrentTeam = vi.fn()
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession, openCurrentTeam, attachToCurrent: vi.fn(async () => true),
    }))

    expect(screen.getAllByText(/需要确认/u)).toHaveLength(1)
    expect(screen.getByLabelText('Yuqi Team 全局待确认提醒')).toHaveTextContent('公开主控')
    fireEvent.click(screen.getByRole('button', { name: '查看主控处理项' }))
    expect(openCurrentTeam).toHaveBeenCalledWith(parentSummary)
    expect(openSession).not.toHaveBeenCalled()
  })

  it('lets the user dismiss a reminder without opening or mutating its Team', () => {
    const projection = replayTeamEvents([
      ...completeTeamEvents().slice(0, 8),
      event(990, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'unknown' }),
      event(991, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const summary = withUserDecision(summarizeTeamForConsole(projection, { controllerSessionId: 'controller-1' }))
    const snapshot = {
      ids: ['parent-1'], current: 'parent-1',
      byId: { 'parent-1': { id: 'parent-1', displayTitle: '公开主控', projectionValues: { yuqiTeam: summary } } },
    }
    const openSession = vi.fn()
    const openCurrentTeam = vi.fn()
    const attachToCurrent = vi.fn(async () => true)
    const { unmount } = render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession, openCurrentTeam, attachToCurrent,
    }))

    fireEvent.click(screen.getByRole('button', { name: /关闭 .*提醒/u }))

    expect(screen.queryByLabelText('Yuqi Team 全局待确认提醒')).not.toBeInTheDocument()
    expect(openSession).not.toHaveBeenCalled()
    expect(openCurrentTeam).not.toHaveBeenCalled()
    expect(attachToCurrent).not.toHaveBeenCalled()

    unmount()
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession, openCurrentTeam, attachToCurrent,
    }))
    expect(screen.queryByLabelText('Yuqi Team 全局待确认提醒')).not.toBeInTheDocument()
  })

  it('shows switching progress until the rebind command settles and falls back to the Team name', async () => {
    const projection = replayTeamEvents([
      ...completeTeamEvents().slice(0, 8),
      event(990, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'unknown' }),
      event(991, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const base = withUserDecision(summarizeTeamForConsole(projection, { controllerSessionId: 'controller-1' }))
    const summary = { ...base, team: { ...base.team, title: '' } }
    let settle!: () => void
    const pending = new Promise<boolean>(resolve => { settle = () => resolve(true) })
    const snapshot = {
      ids: ['parent-1', 'current-1'], current: 'current-1',
      byId: {
        'parent-1': { id: 'parent-1', displayTitle: '原主控', cwd: 'F:\\Project', projectionValues: { yuqiTeam: summary } },
        'current-1': { id: 'current-1', displayTitle: '新主控', cwd: 'F:\\Project', agentPreset: 'yuqi-team' },
      },
    }
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(() => pending),
    }))
    expect(screen.getByText(/Yuqi Team 需要确认/u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '切换到当前对话' }))
    expect(screen.getByRole('button', { name: '切换中…' })).toBeDisabled()
    settle()
    await waitFor(() => expect(screen.getByRole('button', { name: '切换到当前对话' })).toBeEnabled())
  })

  it('does not interrupt the user for controller-owned recovery work', () => {
    const projection = replayTeamEvents(completeTeamEvents())
    const task = projection.tasks[TASK_ID]!
    const summary = summarizeTeamForConsole({
      ...projection,
      tasks: { ...projection.tasks, [TASK_ID]: { ...task, status: 'failed', attemptIds: [] } },
    }, { controllerSessionId: 'controller-1' })
    const snapshot = {
      ids: ['parent-1'], current: 'parent-1',
      byId: { 'parent-1': { id: 'parent-1', displayTitle: '主控', cwd: 'F:\\Project', projectionValues: { yuqiTeam: summary } } },
    }
    const { container } = render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
    }))
    expect(container).toBeEmptyDOMElement()
  })

  it('routes a native worker interaction back to its public main controller', () => {
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 8))
    const summary = summarizeTeamForConsole(projection, { controllerSessionId: 'yuqi-team-controller-1' })
    const snapshot = {
      ids: ['parent-1', 'yuqi-team-controller-1', 'session-worker-1', 'current-1'], current: 'current-1',
      byId: {
        'parent-1': { id: 'parent-1', displayTitle: '公开主控', cwd: 'F:\\Project', projectionValues: { yuqiTeam: summary } },
        'yuqi-team-controller-1': { id: 'yuqi-team-controller-1', displayTitle: 'Team controller', cwd: 'F:\\Project' },
        'session-worker-1': { id: 'session-worker-1', parentId: 'yuqi-team-controller-1', displayTitle: '设计子代理', cwd: 'F:\\Project', pendingInteraction: 'question' },
        'current-1': { id: 'current-1', displayTitle: '其他对话', cwd: 'F:\\Project' },
      },
    }
    const openSession = vi.fn()
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession, attachToCurrent: vi.fn(async () => true),
    }))
    expect(screen.getByLabelText('Yuqi Team 全局待确认提醒')).toHaveTextContent('请在主控对话统一处理')
    expect(screen.getByLabelText('Yuqi Team 全局待确认提醒')).toHaveTextContent('任务 1')
    fireEvent.click(screen.getByRole('button', { name: '进入主控处理' }))
    expect(openSession).toHaveBeenCalledWith('parent-1')
  })

  it('shows a child question in the main controller reminder and answers it without opening the child', async () => {
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 8))
    const summary = summarizeTeamForConsole(projection, { controllerSessionId: 'yuqi-team-controller-1' })
    const snapshot = {
      ids: ['parent-1', 'child-1'], current: 'parent-1',
      byId: {
        'parent-1': { id: 'parent-1', displayTitle: '公开主控', projectionValues: { yuqiTeam: summary } },
        'child-1': { id: 'child-1', parentId: 'yuqi-team-controller-1', displayTitle: '设计子代理', pendingInteraction: 'question' },
      },
    }
    const respond = vi.fn(async () => ({ accepted: true as const }))
    const openSession = vi.fn()
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession,
      attachToCurrent: vi.fn(async () => true),
      getNativeInteractions: () => [{
        key: 'q:question-1', kind: 'question' as const, respond,
        questions: [{ id: 'layout', header: '布局方案', question: '主页采用哪一种布局？', options: [
          { label: '左右分栏', description: '信息密度更高。' },
          { label: '上下布局', description: '移动端更自然。' },
        ] }],
      }],
    }))

    expect(screen.getByText('主页采用哪一种布局？')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /左右分栏/u }))
    fireEvent.click(screen.getByRole('button', { name: '提交给子代理' }))

    await waitFor(() => expect(respond).toHaveBeenCalledWith({ answers: [{ id: 'layout', selected: ['左右分栏'] }] }))
    expect(openSession).not.toHaveBeenCalledWith('child-1')
  })

  it('lets the main controller approve a child permission request', async () => {
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 8))
    const summary = summarizeTeamForConsole(projection, { controllerSessionId: 'yuqi-team-controller-1' })
    const snapshot = { ids: ['parent-1', 'child-1'], current: 'parent-1', byId: {
      'parent-1': { id: 'parent-1', displayTitle: '公开主控', projectionValues: { yuqiTeam: summary } },
      'child-1': { id: 'child-1', parentId: 'yuqi-team-controller-1', displayTitle: '实现子代理', pendingInteraction: 'approval' as const },
    } }
    const respond = vi.fn(async () => ({ accepted: true as const }))
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
      getNativeInteractions: () => [{ key: 'a:approval-1', kind: 'approval' as const, toolName: 'write_file', reason: '需要修改组件文件', respond }],
    }))

    expect(screen.getByText('需要修改组件文件')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '仅本次允许' }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith('allowed-once'))
  })

  it.each([
    ['approve', '', '批准计划', ['执行']],
    ['revise', '请拆小任务', '要求修改', []],
  ] as const)('handles a complete plan-review %s decision in the controller', async (_case, feedback, button, selected) => {
    const snapshot = { ids: ['yuqi-team-plan'], current: 'yuqi-team-plan', byId: {
      'yuqi-team-plan': { id: 'yuqi-team-plan', displayTitle: '计划主控', pendingInteraction: 'plan-review' as const },
    } }
    const respond = vi.fn(async () => ({ accepted: true as const }))
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
      getNativeInteractions: () => [{
        key: `plan-${_case}`, kind: 'plan-review' as const, approveLabel: '执行', respond,
        questions: [{ id: 'plan', header: '任务图确认', question: '是否执行？', detail: '检查模型、权限和依赖。', options: [{ label: '执行' }, { label: '修改' }] }],
      }],
    }))
    if (feedback !== '') fireEvent.change(screen.getByRole('textbox'), { target: { value: feedback } })
    fireEvent.click(screen.getByRole('button', { name: button }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith({ answers: [{ id: 'plan', selected, ...(feedback === '' ? {} : { custom: feedback }) }] }))
    expect(await screen.findByRole('status')).toHaveTextContent('已提交')
  })

  it('supports multi-select, custom answers, toggling, and a rejected native receipt', async () => {
    const snapshot = { ids: ['yuqi-team-question-rich'], current: 'yuqi-team-question-rich', byId: {
      'yuqi-team-question-rich': { id: 'yuqi-team-question-rich', displayTitle: '问题主控', pendingInteraction: 'question' as const },
    } }
    const respond = vi.fn(async () => ({ accepted: false as const, reason: 'bad-response' as const }))
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
      getNativeInteractions: () => [{ key: 'rich', kind: 'question' as const, respond, questions: [
        { id: 'features', header: '功能', question: '选择功能', detail: '可以多选', multiSelect: true, options: [{ label: 'A' }, { label: 'B', description: '第二项' }] },
        { id: 'note', question: '补充说明' },
      ] }],
    }))
    const optionA = screen.getByRole('checkbox', { name: /A/u })
    fireEvent.click(optionA); fireEvent.click(optionA); fireEvent.click(optionA)
    const others = screen.getAllByRole('textbox')
    fireEvent.change(others[1]!, { target: { value: '自定义内容' } })
    fireEvent.click(screen.getByRole('button', { name: '提交给子代理' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('回答格式'))
    expect(respond).toHaveBeenCalledWith({ answers: [
      { id: 'features', selected: ['A'] }, { id: 'note', selected: [], custom: '自定义内容' },
    ] })
  })

  it.each([
    ['拒绝', 'rejected', { accepted: false as const, reason: 'not-pending' as const }, '已被处理'],
    ['仅本次允许', 'allowed-once', { accepted: false as const, reason: 'transport-error' as const }, '未能送达'],
  ] as const)('shows approval receipt failures for %s', async (button, answer, receipt, message) => {
    const snapshot = { ids: ['yuqi-team-approval-error'], byId: {
      'yuqi-team-approval-error': { id: 'yuqi-team-approval-error', displayTitle: '权限', pendingInteraction: 'approval' as const },
    } }
    const respond = vi.fn(async () => receipt)
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
      getNativeInteractions: () => [{ key: `approval-${answer}`, kind: 'approval' as const, respond }],
    }))
    fireEvent.click(screen.getByRole('button', { name: button }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message))
    expect(respond).toHaveBeenCalledWith(answer)
  })

  it('renders subscribed English interactions and updates through the native listener', async () => {
    document.documentElement.lang = 'en'
    const snapshot = { ids: ['yuqi-team-english'], current: 'yuqi-team-english', byId: {
      'yuqi-team-english': { id: 'yuqi-team-english', displayTitle: 'English controller', pendingInteraction: 'question' as const },
    } }
    const respond = vi.fn(async () => ({ accepted: true as const }))
    const interactions = [{ key: 'english', kind: 'question' as const, respond, questions: [{ id: 'answer', question: 'What should continue?', options: [{ label: 'Continue' }] }] }]
    let nativeListener: (() => void) | undefined
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
      getNativeInteractions: () => interactions,
      subscribeNativeInteractions: (_id, listener) => { nativeListener = listener; return () => { nativeListener = undefined } },
    }))
    expect(screen.getByLabelText('Yuqi Team global attention')).toHaveTextContent('awaits your response')
    nativeListener?.()
    fireEvent.click(screen.getByRole('radio', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit to Agent' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Response submitted')
  })

  it('keeps an incomplete plan review disabled and handles a rejected promise', async () => {
    const snapshot = { ids: ['yuqi-team-empty-plan'], byId: {
      'yuqi-team-empty-plan': { id: 'yuqi-team-empty-plan', displayTitle: '空计划', pendingInteraction: 'plan-review' as const },
    } }
    const respond = vi.fn(async () => { throw new Error('offline') })
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
      getNativeInteractions: () => [{ key: 'empty-plan', kind: 'plan-review' as const, respond }],
    }))
    expect(screen.getByRole('button', { name: '批准计划' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '要求修改' })).toBeDisabled()
  })

  it('does not submit an empty question form', () => {
    const snapshot = { ids: ['yuqi-team-empty-question'], byId: {
      'yuqi-team-empty-question': { id: 'yuqi-team-empty-question', displayTitle: '空问题', pendingInteraction: 'question' as const },
    } }
    const respond = vi.fn(async () => ({ accepted: true as const }))
    const { container } = render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
      getNativeInteractions: () => [{ key: 'empty-question', kind: 'question' as const, respond }],
    }))
    fireEvent.submit(container.querySelector('form')!)
    expect(respond).not.toHaveBeenCalled()
  })

  it('covers English plan rejection labels and transport feedback', async () => {
    document.documentElement.lang = 'en'
    const snapshot = { ids: ['yuqi-team-plan-en'], byId: {
      'yuqi-team-plan-en': { id: 'yuqi-team-plan-en', displayTitle: 'Plan', pendingInteraction: 'plan-review' as const },
    } }
    const respond = vi.fn(async () => ({ accepted: false as const, reason: 'not-pending' as const }))
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
      getNativeInteractions: () => [{ key: 'plan-en', kind: 'plan-review' as const, approveLabel: 'Run', respond,
        questions: [{ id: 'plan', question: 'Run this graph?', options: [{ label: 'Run' }, { label: 'Revise' }] }] }],
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith({ answers: [{ id: 'plan', selected: ['Revise'] }] }))
    expect(screen.getByRole('alert')).toHaveTextContent('already handled')
  })

  it('covers English approval labels, reason text, and rejected transport promises', async () => {
    document.documentElement.lang = 'en'
    const snapshot = { ids: ['yuqi-team-approval-en'], byId: {
      'yuqi-team-approval-en': { id: 'yuqi-team-approval-en', displayTitle: 'Approval', pendingInteraction: 'approval' as const },
    } }
    const respond = vi.fn(async () => { throw new Error('offline') })
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
      getNativeInteractions: () => [{ key: 'approval-en', kind: 'approval' as const, toolName: 'shell', reason: 'Needs permission', respond }],
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not be delivered'))
  })

  it('covers English projected reminder actions and successful attachment', async () => {
    document.documentElement.lang = 'en'
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 8))
    const summary = withUserDecision(summarizeTeamForConsole(projection, { controllerSessionId: 'controller-en' }))
    const snapshot = { ids: ['parent-en', 'current-en'], current: 'current-en', byId: {
      'parent-en': { id: 'parent-en', displayTitle: 'Original', cwd: 'F:\Project', projectionValues: { yuqiTeam: summary } },
      'current-en': { id: 'current-en', displayTitle: 'Current', cwd: 'f:\project', agentPreset: 'yuqi-team' },
    } }
    const attach = vi.fn(async () => true)
    const openSession = vi.fn()
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession, attachToCurrent: attach,
    }))
    expect(screen.getByRole('button', { name: 'Open controller' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Attach to current conversation' }))
    await waitFor(() => expect(attach).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Open controller' }))
    expect(openSession).toHaveBeenCalledWith('parent-en')
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/u }))
  })

  it('dismisses a native Team interaction reminder', () => {
    const snapshot = {
      ids: ['yuqi-team-question'], current: 'yuqi-team-question',
      byId: {
        'yuqi-team-question': { id: 'yuqi-team-question', displayTitle: '设计子代理', pendingInteraction: 'question' },
      },
    }
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
    }))

    fireEvent.click(screen.getByRole('button', { name: '关闭 设计子代理 提醒' }))

    expect(screen.queryByLabelText('Yuqi Team 全局待确认提醒')).not.toBeInTheDocument()
  })

  it('can still dismiss when session storage is unavailable', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked') })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })
    const snapshot = {
      ids: ['yuqi-team-question'], current: 'yuqi-team-question',
      byId: {
        'yuqi-team-question': { id: 'yuqi-team-question', displayTitle: '受限子代理', pendingInteraction: 'question' },
      },
    }
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
    }))

    fireEvent.click(screen.getByRole('button', { name: '关闭 受限子代理 提醒' }))

    expect(screen.queryByLabelText('Yuqi Team 全局待确认提醒')).not.toBeInTheDocument()
    expect(getItem).toHaveBeenCalled()
    expect(setItem).toHaveBeenCalled()
  })

  it('ignores malformed persisted reminder data', () => {
    window.sessionStorage.setItem('yuqi-team-orchestrator:dismissed-reminders:v1', JSON.stringify({ invalid: true }))
    const snapshot = {
      ids: ['yuqi-team-question'], current: 'yuqi-team-question',
      byId: {
        'yuqi-team-question': { id: 'yuqi-team-question', displayTitle: '设计子代理', pendingInteraction: 'question' },
      },
    }
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
    }))

    expect(screen.getByLabelText('Yuqi Team 全局待确认提醒')).toBeInTheDocument()
  })

  it.each([
    ['approval', '必须由用户决定'],
    ['plan-review', '等待用户审阅'],
  ] as const)('explains the native %s interaction without requiring a Team projection', (pendingInteraction, text) => {
    const id = `yuqi-team-${pendingInteraction}`
    const snapshot = {
      ids: [id], current: id,
      byId: { [id]: { id, displayTitle: 'Controller', cwd: 'F:\\Project', pendingInteraction } },
    }
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
    }))
    expect(screen.getByLabelText('Yuqi Team 全局待确认提醒')).toHaveTextContent(text)
  })

  it('prioritizes native approvals and the most urgent Team reconciliation reminder', () => {
    const projection = replayTeamEvents([
      ...completeTeamEvents().slice(0, 8),
      event(1990, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'unknown' }),
      event(1991, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const urgent = withUserDecision(summarizeTeamForConsole(projection, { controllerSessionId: 'controller-urgent' }))
    const lower = { ...urgent, team: { ...urgent.team, id: 'team-lower', title: '较低优先级' }, attention: [
      { taskId: 'task-lower', code: 'task-failed', owner: 'user', message: '失败待处理' },
    ] } as typeof urgent
    const snapshot = {
      ids: ['lower', 'urgent', 'question', 'plan', 'approval'], current: 'urgent',
      byId: {
        lower: { id: 'lower', displayTitle: '较低', projectionValues: { yuqiTeam: lower } },
        urgent: { id: 'urgent', displayTitle: '紧急', projectionValues: { yuqiTeam: urgent } },
        question: { id: 'yuqi-team-question', displayTitle: '问题', pendingInteraction: 'question' },
        plan: { id: 'yuqi-team-plan', displayTitle: '计划', pendingInteraction: 'plan-review' },
        approval: { id: 'yuqi-team-approval', displayTitle: '授权', pendingInteraction: 'approval' },
      },
    }
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
    }))
    const cards = screen.getByLabelText('Yuqi Team 全局待确认提醒').querySelectorAll('.yuqi-global-attention-card')
    expect(cards[0]).toHaveTextContent('紧急')
    expect(cards[1]).toHaveTextContent('较低')
    expect(cards[2]).toHaveTextContent('授权')
    expect(cards[3]).toHaveTextContent('问题')
    expect(cards[4]).toHaveTextContent('计划')
  })

  it('does not offer rebinding to an ordinary preset, another project, or the existing parent', () => {
    const projection = replayTeamEvents([
      ...completeTeamEvents().slice(0, 8),
      event(990, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'unknown' }),
      event(991, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const summary = withUserDecision(summarizeTeamForConsole(projection, { controllerSessionId: 'controller-1' }))
    const cases = [
      { id: 'ordinary', displayTitle: 'ordinary', cwd: 'F:\\Project', agentPreset: 'standard' },
      { id: 'other-project', displayTitle: 'other', cwd: 'F:\\Other', agentPreset: 'yuqi-team' },
      { id: 'missing-cwd', displayTitle: 'missing cwd', agentPreset: 'yuqi-team' },
      { id: 'parent-1', displayTitle: 'same', cwd: 'F:\\Project', agentPreset: 'yuqi-team' },
    ]
    for (const current of cases) {
      const snapshot = {
        ids: ['parent-1', current.id], current: current.id,
        byId: {
          'parent-1': { id: 'parent-1', displayTitle: '原主控', cwd: 'F:\\Project', projectionValues: { yuqiTeam: summary } },
          [current.id]: current,
        },
      }
      const { unmount } = render(createElement(GlobalTeamAttention, {
        sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
        openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
      }))
      expect(screen.queryByRole('button', { name: '切换到当前对话' })).not.toBeInTheDocument()
      unmount()
    }
    const noParentCwd = {
      ids: ['parent-1', 'current-1'], current: 'current-1',
      byId: {
        'parent-1': { id: 'parent-1', displayTitle: '原主控', projectionValues: { yuqiTeam: summary } },
        'current-1': { id: 'current-1', displayTitle: '新主控', cwd: 'F:\\Project', agentPreset: 'yuqi-team' },
      },
    }
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => noParentCwd as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
    }))
    expect(screen.queryByRole('button', { name: '切换到当前对话' })).not.toBeInTheDocument()
  })

  it('ignores native interactions outside Team lineage and malformed/empty projections', () => {
    const snapshot = {
      ids: ['normal', 'empty', 'missing'], current: 'normal',
      byId: {
        normal: { id: 'normal', displayTitle: '普通会话', pendingInteraction: 'question' },
        empty: { id: 'empty', displayTitle: '空投影', projectionValues: { yuqiTeam: null } },
      },
    }
    const { container } = render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
    }))
    expect(container).toBeEmptyDOMElement()
  })

  it('still reminds without a selected conversation but cannot offer a rebind', () => {
    const projection = replayTeamEvents([
      ...completeTeamEvents().slice(0, 8),
      event(990, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'unknown' }),
      event(991, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const summary = withUserDecision(summarizeTeamForConsole(projection, { controllerSessionId: 'controller-1' }))
    const snapshot = {
      ids: ['parent-1'],
      byId: { 'parent-1': { id: 'parent-1', displayTitle: '原主控', projectionValues: { yuqiTeam: summary } } },
    }
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
    }))
    expect(screen.getByLabelText('Yuqi Team 全局待确认提醒')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '切换到当前对话' })).not.toBeInTheDocument()
  })

  it('uses Team archive visibility for both projected and native interaction reminders', () => {
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 8))
    const summary = withUserDecision(summarizeTeamForConsole(projection, { controllerSessionId: 'yuqi-team-controller-1' }))
    const snapshot = { ids: ['main-1', 'child-1'], current: 'main-1', byId: {
      'main-1': { id: 'main-1', displayTitle: '公开主控', projectionValues: { yuqiTeam: summary } },
      'child-1': { id: 'child-1', parentId: 'yuqi-team-controller-1', displayTitle: '子代理', pendingInteraction: 'question' as const },
    } }
    setTeamArchived(summary.team.id, true)
    const { container } = render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
    }))

    expect(container).toBeEmptyDOMElement()
  })

  it('does not keep a child interaction reminder after its Team is terminal', () => {
    const summary = summarizeTeamForConsole(replayTeamEvents(completeTeamEvents()), { controllerSessionId: 'yuqi-team-controller-terminal' })
    const snapshot = { ids: ['main-terminal', 'child-terminal'], current: 'main-terminal', byId: {
      'main-terminal': { id: 'main-terminal', displayTitle: '主控', projectionValues: { yuqiTeam: summary } },
      'child-terminal': { id: 'child-terminal', parentId: 'yuqi-team-controller-terminal', displayTitle: '旧子代理', pendingInteraction: 'question' as const },
    } }
    const { container } = render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
    }))
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['false', async (): Promise<boolean> => false, '未能切换到当前对话'],
    ['rejection', async (): Promise<boolean> => { throw new Error('offline') }, '尚未确认切换 Team 的结果'],
    ['unknown', async (): Promise<boolean> => { throw new YuqiCommandOutcomeError('unknown', '命令结果未知，请刷新团队状态，不要重复提交。') }, '命令结果未知'],
  ] as const)('reports an attach %s and leaves the retry action available', async (_case, attachToCurrent, message) => {
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 8))
    const summary = withUserDecision(summarizeTeamForConsole(projection, { controllerSessionId: 'controller-1' }))
    const snapshot = { ids: ['main-1', 'current-1'], current: 'current-1', byId: {
      'main-1': { id: 'main-1', displayTitle: '原主控', cwd: 'F:\\Project', projectionValues: { yuqiTeam: summary } },
      'current-1': { id: 'current-1', displayTitle: '当前主控', cwd: 'F:\\Project', agentPreset: 'yuqi-team' },
    } }
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(attachToCurrent),
    }))

    fireEvent.click(screen.getByRole('button', { name: '切换到当前对话' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('button', { name: '切换到当前对话' })).toBeEnabled()
  })

  it('opens an already-visible English controller in place and counts its plan decision', () => {
    document.documentElement.lang = 'en'
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 8))
    const base = summarizeTeamForConsole(projection, { controllerSessionId: 'controller-open' })
    const summary = {
      ...base,
      team: { ...base.team, title: '', planConfirmationPending: true, userDecisionCount: 1 },
      attention: [],
    } as TeamConsoleSummary
    const snapshot = { ids: ['owner-open'], current: 'owner-open', byId: {
      'owner-open': { id: 'owner-open', displayTitle: 'Visible controller', projectionValues: { yuqiTeam: summary } },
    } }
    const openCurrentTeam = vi.fn()
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), openCurrentTeam, attachToCurrent: vi.fn(async () => true),
    }))

    fireEvent.click(screen.getByRole('button', { name: 'View controller decisions' }))
    expect(openCurrentTeam).toHaveBeenCalledWith(summary)
    expect(screen.getByRole('button', { name: 'Dismiss Yuqi Team reminder' })).toBeInTheDocument()
  })

  it.each([
    ['false', async (): Promise<boolean> => false, 'could not be attached'],
    ['rejection', async (): Promise<boolean> => { throw new Error('offline') }, 'The attachment result is unconfirmed'],
  ] as const)('reports an English attach %s without assuming its result', async (_case, attachToCurrent, message) => {
    document.documentElement.lang = 'en'
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 8))
    const summary = withUserDecision(summarizeTeamForConsole(projection, { controllerSessionId: 'controller-en-fail' }))
    const snapshot = { ids: ['owner-en-fail', 'current-en-fail'], current: 'current-en-fail', byId: {
      'owner-en-fail': { id: 'owner-en-fail', displayTitle: 'Owner', cwd: 'F:\\Project', projectionValues: { yuqiTeam: summary } },
      'current-en-fail': { id: 'current-en-fail', displayTitle: 'Current', cwd: 'F:\\Project', agentPreset: 'yuqi-team' },
    } }
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(attachToCurrent),
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Attach to current conversation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('maps an English child question to its task and keeps navigation in the visible controller', () => {
    document.documentElement.lang = 'en'
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 8))
    const base = summarizeTeamForConsole(projection, { controllerSessionId: 'yuqi-team-controller-mapped' })
    const summary = {
      ...base,
      team: { ...base.team, title: '' },
      tasks: base.tasks.map((task, index) => index === 0 ? { ...task, childSessionId: 'child-mapped' } : task),
    } as TeamConsoleSummary
    const snapshot = { ids: ['owner-mapped', 'child-mapped'], current: 'owner-mapped', byId: {
      'owner-mapped': { id: 'owner-mapped', displayTitle: 'Controller', projectionValues: { yuqiTeam: summary } },
      'child-mapped': { id: 'child-mapped', parentId: 'yuqi-team-controller-mapped', displayTitle: 'Worker', pendingInteraction: 'question' as const },
    } }
    const openCurrentTeam = vi.fn()
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), openCurrentTeam, attachToCurrent: vi.fn(async () => true),
    }))

    expect(screen.getByLabelText('Yuqi Team global attention')).toHaveTextContent('Task 1')
    fireEvent.click(screen.getByRole('button', { name: 'Open controller' }))
    expect(openCurrentTeam).toHaveBeenCalledWith(summary)
  })

  it('preserves custom text while toggling a multi-select answer', async () => {
    const snapshot = { ids: ['yuqi-team-multi-custom'], byId: {
      'yuqi-team-multi-custom': { id: 'yuqi-team-multi-custom', displayTitle: '多选主控', pendingInteraction: 'question' as const },
    } }
    const respond = vi.fn(async () => ({ accepted: true as const }))
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
      getNativeInteractions: () => [{ key: 'multi-custom', kind: 'question' as const, respond, questions: [{
        id: 'features', question: '选择功能', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }],
      }] }],
    }))

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '保留备注' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'A' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'A' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'B' }))
    fireEvent.click(screen.getByRole('button', { name: '提交给子代理' }))

    await waitFor(() => expect(respond).toHaveBeenCalledWith({ answers: [{ id: 'features', selected: ['B'], custom: '保留备注' }] }))
  })

  it('shows the default English approval title and bad-response guidance', async () => {
    document.documentElement.lang = 'en'
    const snapshot = { ids: ['yuqi-team-default-approval'], byId: {
      'yuqi-team-default-approval': { id: 'yuqi-team-default-approval', displayTitle: 'Approval', pendingInteraction: 'approval' as const },
    } }
    const respond = vi.fn(async () => ({ accepted: false as const, reason: 'bad-response' as const }))
    render(createElement(GlobalTeamAttention, {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
      getNativeInteractions: () => [{ key: 'approval-default', kind: 'approval' as const, respond }],
    }))

    expect(screen.getByText('Permission request')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('answer format was rejected')
  })

  it('announces missing native question data in both locales with a recovery path', () => {
    const snapshot = { ids: ['yuqi-team-empty-question'], byId: {
      'yuqi-team-empty-question': { id: 'yuqi-team-empty-question', displayTitle: 'Question', pendingInteraction: 'question' as const },
    } }
    const props = {
      sessions: { getSnapshot: () => snapshot as never, subscribe: () => () => undefined },
      openSession: vi.fn(), attachToCurrent: vi.fn(async () => true),
      getNativeInteractions: () => [{ key: 'empty-question', kind: 'question' as const, respond: vi.fn(async () => ({ accepted: true as const })), questions: [] }],
    }
    document.documentElement.lang = 'en'
    const view = render(createElement(GlobalTeamAttention, props))
    expect(screen.getByRole('status')).toHaveTextContent('No questions are available yet. Refresh the waiting conversation before responding.')
    view.unmount()

    document.documentElement.lang = 'zh-CN'
    render(createElement(GlobalTeamAttention, props))
    expect(screen.getByRole('status')).toHaveTextContent('暂时没有可回答的问题，请刷新待响应会话后再回复。')
  })
})
