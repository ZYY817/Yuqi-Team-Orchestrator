// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamConsoleSummary, TeamConsoleTask } from '../../src/domain/team-console-contract.ts'
import { TeamActivityView } from '../../src/client/TeamActivityView.tsx'
import { activityViewStyles } from '../../src/client/activity-view-styles.ts'

function task(taskId: string, dependencies: string[] = [], patch: Partial<TeamConsoleTask> = {}): TeamConsoleTask {
  return {
    taskId, goal: `Goal ${taskId}`, status: 'pending', modelRole: 'worker', model: 'model-current',
    authorityMode: 'read-only', dependencyCount: dependencies.length,
    dependencies: dependencies.map(id => ({ taskId: id, goal: `Goal ${id}` })),
    fileScope: [], attemptCount: 0, evidenceRecorded: false,
    usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '',
    ...patch,
  }
}

function summary(tasks: readonly TeamConsoleTask[], patch: Partial<TeamConsoleSummary> = {}): TeamConsoleSummary {
  return {
    team: {
      id: 'team-activity', title: 'Activity', objective: 'Read projection', status: 'running',
      completedTaskCount: 0, runningTaskCount: 0, waitingTaskCount: 0, attentionTaskCount: 0,
      userDecisionCount: 0, controllerActionCount: 0, duration: { state: 'unavailable' },
    }, tasks, attention: [], usage: { state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' }, ...patch,
  }
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.lang = 'en'
})
afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('TeamActivityView dependency graph', () => {
  it('layers a diamond graph independently of input order and selects the exact task', () => {
    const tasks = [task('D', ['B', 'C']), task('B', ['A']), task('A'), task('C', ['A'])]
    const before = JSON.stringify(tasks)
    const onSelectTask = vi.fn()
    render(<TeamActivityView summary={summary(tasks)} onSelectTask={onSelectTask} />)
    const first = [...document.querySelectorAll('summary')].find(element => element.textContent === 'No prerequisites')!.closest('details')!
    const second = screen.getByText('After prerequisites · stage 2').closest('details')!
    const third = screen.getByText('After prerequisites · stage 3').closest('details')!
    expect(within(first).getAllByRole('button')).toHaveLength(1)
    expect(within(first).getByRole('button', { name: 'Locate task A: Goal A' })).toBeEnabled()
    expect(within(second).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Locate task B: Goal B', 'Locate task C: Goal C'])
    expect(within(third).queryByText('Waiting for B, C')).not.toBeInTheDocument()
    const node = within(third).getByRole('button', { name: 'Locate task D: Goal D' })
    node.focus()
    expect(node).toHaveFocus()
    fireEvent.click(node)
    expect(onSelectTask).toHaveBeenCalledExactlyOnceWith('D')
    expect(JSON.stringify(tasks)).toBe(before)
    expect(screen.queryByText('Unresolved dependencies')).not.toBeInTheDocument()
  })

  it('distinguishes cycle members, self-cycles, missing nodes, incomplete legacy data and downstream tasks', () => {
    render(<TeamActivityView summary={summary([
      task('A', ['B', 'C']), task('B', ['A']), task('C', ['B']), task('downstream', ['A']),
      task('self', ['self']), task('missing', ['absent']), task('legacy', [], { dependencyCount: 2, dependencies: undefined }),
      task('legacy-child', ['legacy']), task('independent'),
    ])} />)
    expect(screen.getAllByText('Dependency cycle: this task belongs to a cycle.')).toHaveLength(4)
    const downstream = screen.getByRole('button', { name: 'Locate task downstream: Goal downstream' }).closest('li')!
    expect(downstream).toHaveTextContent('Depends on unresolved tasks')
    expect(downstream).not.toHaveTextContent('this task belongs to a cycle')
    expect(screen.getByText('Missing prerequisite node: absent')).toBeInTheDocument()
    expect(screen.getByText('Dependency details are incomplete in this projection.')).toBeInTheDocument()
    const layer = [...document.querySelectorAll('summary')].find(element => element.textContent === 'No prerequisites')!.closest('details')!
    expect(within(layer).getAllByRole('button')).toHaveLength(1)
    expect(layer).toHaveTextContent('independent')
    expect(screen.queryByRole('button', { name: /Locate task absent:/ })).not.toBeInTheDocument()
  })

  it('deduplicates dependency edges and refreshes from a new summary without stale layers', () => {
    const view = render(<TeamActivityView summary={summary([task('A'), task('B', ['A', 'A'], { dependencyCount: 1 })])} />)
    expect(screen.getByText('After prerequisites · stage 2')).toBeInTheDocument()
    expect(screen.queryByText('Waiting for A')).not.toBeInTheDocument()
    view.rerender(<TeamActivityView summary={summary([task('B')])} />)
    expect(screen.queryByText('After prerequisites · stage 2')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Locate task A: Goal A' })).not.toBeInTheDocument()
  })

  it('aligns aggregate and single-chain descendants from dependency positions without fixed task IDs', () => {
    render(<TeamActivityView summary={summary([
      task('A'), task('B'), task('C'), task('D'), task('E'),
      task('aggregate', ['A', 'B', 'C', 'D']), task('single', ['E']),
    ])} />)
    expect(document.querySelector<HTMLElement>('[data-task-id="aggregate"]')).toHaveStyle({ marginTop: '168px' })
    expect(document.querySelector<HTMLElement>('[data-task-id="single"]')).toHaveStyle({ marginTop: '184px' })
  })

  it('keeps the default node concise and exposes full goal and next action in task details', () => {
    const goal = 'A complete task goal that remains available without replacing the stored value'
    render(<TeamActivityView summary={summary([task('A', [], { goal, nextAction: 'Continue with the recorded next action' })])} />)
    const node = document.querySelector<HTMLElement>('[data-task-id="A"]')!
    expect(node.querySelector('.yuqi-route-node-shell')).toBeInTheDocument()
    expect(within(node).queryByText('No prerequisites')).not.toBeInTheDocument()
    const details = within(node).getByText('Task details').closest('details')!
    expect(details).not.toHaveAttribute('open')
    expect(within(details).getByText(goal)).toHaveAttribute('title', goal)
    expect(within(details).getByText(/Continue with the recorded next action/)).toBeInTheDocument()
    expect(activityViewStyles).toMatch(/\.yuqi-route-node-id \{ grid-row:auto;/u)
    expect(activityViewStyles).toMatch(/min-height:96px/u)
    expect(activityViewStyles).toMatch(/\.yuqi-route-node-details\[open\] \{ grid-column:1 \/ -1; grid-row:3; \}/u)
  })

  it('uses native details, a disabled read-only node without a callback, and pressed view buttons', () => {
    render(<TeamActivityView summary={summary([task('A')])} />)
    const details = [...document.querySelectorAll('summary')].find(element => element.textContent === 'No prerequisites')!.closest('details')!
    expect(details).toHaveAttribute('open')
    expect(screen.getByRole('button', { name: 'Locate task A: Goal A' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Task route' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('button').filter(button => button.closest('.yuqi-filters')).map(button => button.textContent)).toEqual([
      'Task route', 'Run records', 'Files & evidence', 'Usage', 'Project summary',
    ])
    expect(screen.queryByRole('button', { name: 'Timeline' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run records' }))
    expect(screen.getByRole('button', { name: 'Run records' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('No prerequisites')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Task route' }))
    expect(screen.getAllByText('No prerequisites').length).toBeGreaterThan(0)
  })

  it('opens the real dependency canvas full screen, pans blank space, and exits with Escape without breaking nodes', () => {
    const onSelectTask = vi.fn()
    render(<TeamActivityView summary={summary([task('A'), task('B', ['A'])])} onSelectTask={onSelectTask} />)
    const viewport = screen.getByRole('region', { name: 'Task route based on dependencies' })
    const canvas = viewport.querySelector<HTMLElement>('.yuqi-activity-graph-canvas')!
    const pointer = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true })
      Object.defineProperties(event, { pointerId: { value: 1 }, clientX: { value: x }, clientY: { value: y }, button: { value: 0 }, isPrimary: { value: true } })
      fireEvent(viewport, event)
    }
    pointer('pointerdown', 100, 100)
    pointer('pointermove', 70, 80)
    pointer('pointerup', 70, 80)
    expect(canvas).toHaveStyle({ transform: 'translate(-30px, -20px)' })

    fireEvent.click(screen.getByRole('button', { name: 'View full screen' }))
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toHaveAttribute('aria-pressed', 'true')
    expect(viewport.closest('.yuqi-route-viewer')).toHaveClass('is-fullscreen')
    fireEvent.click(screen.getByRole('button', { name: 'Locate task A: Goal A' }))
    expect(onSelectTask).toHaveBeenCalledWith('A')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'View full screen' })).toHaveAttribute('aria-pressed', 'false')
    expect(document.body.style.overflow).toBe('')
  })

  it('shows Chinese labels and empty states without persisting layout or view changes', () => {
    document.documentElement.lang = 'zh'
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    render(<TeamActivityView summary={summary([])} />)
    expect(screen.getByRole('region', { name: '团队活动' })).toHaveAttribute('lang', 'zh-CN')
    expect(screen.getByText('暂无任务。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '运行记录' }))
    expect(screen.getByText('暂无任务。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '时间线' })).not.toBeInTheDocument()
    expect(storage).not.toHaveBeenCalled()
  })
})

describe('TeamActivityView run records', () => {
  it.each(['zh', 'en'])('does not equate empty route history with no execution in %s', locale => {
    document.documentElement.lang = locale
    render(<TeamActivityView summary={summary([task('A', [], {
      status: 'completed', attemptCount: 2, routeHistory: [],
    })])} />)
    fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Run records' : '运行记录' }))
    fireEvent.click(screen.getByText(locale === 'en' ? 'Goal A' : 'Goal A'))
    expect(screen.getByText(locale === 'en'
      ? 'Attempt route details were not supplied; this does not mean the task did not run.'
      : '未提供尝试路由明细，不能据此判断任务没有运行。')).toBeInTheDocument()
    expect(screen.getByText(locale === 'en' ? 'Completed' : '已完成')).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('sorts attempts by ordinal, preserves model changes, and attaches status only to the current attempt ID', () => {
    const routeHistory = Object.freeze([
      { attemptId: 'run-3', attemptOrdinal: 3, providerId: 'provider-B', modelId: 'model-B' },
      { attemptId: 'run-1', attemptOrdinal: 1, providerId: 'provider-A', modelId: 'model-A' },
    ])
    render(<TeamActivityView summary={summary([task('A', [], {
      status: 'running', attemptId: 'run-3', attemptOrdinal: 3, attemptStatus: 'unknown', attemptCount: 3, routeHistory,
    })])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run records' }))
    fireEvent.click(screen.getByText('Goal A'))
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Attempt 1')
    expect(rows[0]).toHaveTextContent('provider-A / model-A')
    expect(rows[0]).toHaveTextContent('Historical status not supplied')
    expect(rows[0]).not.toHaveTextContent('Current attempt')
    expect(rows[1]).toHaveTextContent('Attempt 3')
    expect(rows[1]).toHaveTextContent('provider-B / model-B')
    expect(rows[1]).toHaveTextContent('Result unverified')
    expect(screen.queryByText('Attempt 2')).not.toBeInTheDocument()
    expect(document.querySelector('time')).toBeNull()
    expect(routeHistory[0]!.attemptOrdinal).toBe(3)
  })

  it('does not infer missing routes, status, attempt identity or times', () => {
    render(<TeamActivityView summary={summary([
      task('A', [], { attemptCount: 2, attemptId: 'missing-run', attemptOrdinal: 2 }),
      task('B', [], { routeHistory: [{ attemptId: 'old', attemptOrdinal: 1, providerId: 'P', modelId: 'M' }] }),
    ])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run records' }))
    fireEvent.click(screen.getByText('Goal A'))
    expect(screen.getByText('Attempt route details were not supplied; this does not mean the task did not run.')).toBeInTheDocument()
    expect(screen.getByText('Historical status not supplied')).toBeInTheDocument()
    expect(document.querySelector('time')).toBeNull()
  })

  it('renders Chinese attempt status and current model', () => {
    document.documentElement.lang = 'zh'
    render(<TeamActivityView summary={summary([task('A', [], {
      attemptId: 'run', attemptStatus: 'verification_failed',
      routeHistory: [{ attemptId: 'run', attemptOrdinal: 2, providerId: 'P', modelId: 'M' }],
    })])} />)
    fireEvent.click(screen.getByRole('button', { name: '运行记录' }))
    fireEvent.click(screen.getByText('Goal A'))
    expect(screen.getByText('第 2 次尝试')).toBeInTheDocument()
    expect(screen.getAllByText('验证失败').length).toBeGreaterThan(0)
    expect(screen.getAllByText('P / M').length).toBeGreaterThan(0)
  })

  it('keeps a tier request separate from an actual routed model', () => {
    document.documentElement.lang = 'zh'
    render(<TeamActivityView summary={summary([task('A', [], {
      model: 'tier:standard', modelRequest: { kind: 'tier', tier: 'standard' }, attemptId: 'run', attemptCount: 1,
      route: { providerId: 'deepseek', modelId: 'deepseek-v4.1-flash' },
    })])} />)
    fireEvent.click(screen.getByRole('button', { name: '运行记录' }))
    expect(screen.getAllByText('deepseek / deepseek-v4.1-flash').length).toBeGreaterThan(0)
    expect(screen.queryByText('tier:standard')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Goal A'))
    expect(screen.getByText('自动档位：standard')).toBeInTheDocument()
  })

  it('treats reported files as execution evidence and does not call a terminal legacy task unassigned', () => {
    render(<TeamActivityView summary={summary([
      task('A', [], { status: 'completed', reportedChangedFiles: ['src/a.ts'] }),
    ])} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run records' }))
    expect(screen.getAllByText('Not reported').length).toBeGreaterThan(0)
    expect(screen.queryByText('Not assigned')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Execution details for A')).toBeInTheDocument()
  })
})

describe('TeamActivityView usage table', () => {
  it('shows one accurate empty state before any usage exists', () => {
    document.documentElement.lang = 'zh'
    render(<TeamActivityView summary={summary([task('A')])} />)

    fireEvent.click(screen.getByRole('button', { name: '用量统计' }))
    expect(screen.getByText('任务尚未产生用量记录。')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Token 用量' })).not.toBeInTheDocument()
  })

  it('uses actual routes, dashes for unknown values and attempt details only with attempt identity', () => {
    document.documentElement.lang = 'zh'
    const known = { state: 'known' as const, uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 18, label: 'Token：18' }
    render(<TeamActivityView summary={summary([
      task('A', [], { model: 'tier:standard', modelRequest: { kind: 'tier', tier: 'standard' }, attemptId: 'run-A', attemptCount: 1,
        route: { providerId: 'deepseek', modelId: 'deepseek-v4.1-flash' }, usage: known }),
      task('B'),
    ], { usage: { ...known, scope: '受管子 Agent' } })} />)
    fireEvent.click(screen.getByRole('button', { name: '用量统计' }))
    const region = screen.getByRole('region', { name: 'Token 用量' })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(within(region).getAllByText('deepseek / deepseek-v4.1-flash').length).toBeGreaterThan(0)
    expect(within(region).queryByText('tier:standard')).not.toBeInTheDocument()
    expect(within(region).getAllByText('—').length).toBeGreaterThan(0)
    expect(within(region).getAllByText(/尝试明细/)).toHaveLength(1)
  })
})
