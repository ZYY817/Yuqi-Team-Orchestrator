// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeamConsoleSummary, TeamConsoleTask } from '../../src/domain/team-console-contract.ts'
import { TeamControls } from '../../src/client/TeamControls.tsx'
import { TeamMessageComposer } from '../../src/client/TeamMessageComposer.tsx'
import { TeamPanel } from '../../src/client/TeamPanel.tsx'
import { TaskRow } from '../../src/client/TaskRow.tsx'
import { YuqiTeamDock } from '../../src/client/YuqiTeamDock.tsx'
import { TeamCenter } from '../../src/client/TeamCenter.tsx'
import { setChildSessionArchived, setTeamArchived } from '../../src/client/team-ui-preferences.ts'
import { taskNeedsAttention, taskStatusMeta, teamStatusMeta } from '../../src/client/status.ts'
import { presentDuration } from '../../src/client/usage-presentation.ts'
import { requestTeamPanelOpen } from '../../src/client/team-panel-events.ts'

function task(overrides: Partial<TeamConsoleTask> = {}): TeamConsoleTask {
  return {
    taskId: 'task-1', goal: '实现任务编排', status: 'running', modelRole: 'worker', model: 'deepseek/deepseek-v4', authorityMode: 'write-authorized',
    dependencyCount: 0, fileScope: ['src/**'], attemptCount: 1, attemptId: 'attempt-1', attemptOrdinal: 1,
    attemptStatus: 'running', childSessionId: 'child-1', evidenceRecorded: false, usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '正在执行。',
    ...overrides,
  }
}

function summary(overrides: Partial<TeamConsoleSummary> = {}): TeamConsoleSummary {
  const tasks = overrides.tasks ?? [task()]
  return {
    ...(overrides.controllerSessionId === undefined ? { controllerSessionId: 'controller-1' } : { controllerSessionId: overrides.controllerSessionId }),
    team: {
      id: 'team-1',
      title: 'Yuqi Team', objective: '用主控协调子代理完成高质量项目', status: 'running',
      completedTaskCount: tasks.filter(item => item.status === 'completed').length,
      runningTaskCount: tasks.filter(item => item.status === 'running' || item.status === 'verifying').length,
      waitingTaskCount: tasks.filter(item => item.status === 'pending' || item.status === 'ready').length,
      attentionTaskCount: tasks.filter(item => taskNeedsAttention(item, overrides.team?.status ?? 'running')).length,
      userDecisionCount: 0,
      controllerActionCount: 0,
      duration: { state: 'unavailable' },
      ...(overrides.team === undefined ? {} : overrides.team),
    },
    tasks,
    attention: overrides.attention ?? [],
    usage: overrides.usage ?? {
      state: 'partial', scope: '受管子 Agent', label: '用量：已记录 24600 tok（部分）', totalTokens: 24600,
      uncachedInputTokens: 20000, outputTokens: 3000, cacheReadTokens: 1500, cacheWriteTokens: 100,
      missingAttemptCount: 1, activeAttemptCount: 1,
    },
    ...(overrides.projectSummary === undefined ? {} : { projectSummary: overrides.projectSummary }),
    ...(overrides.review === undefined ? {} : { review: overrides.review }),
  }
}

type OpenChild = (controllerSessionId: string | undefined, childSessionId: string) => Promise<boolean>

function dock(value: TeamConsoleSummary | null | undefined, onOpenChild: OpenChild = vi.fn(async () => true), command?: (line: string) => Promise<boolean>) {
  const onArchiveChild = vi.fn(async (teamId: string, childSessionId: string) => {
    setChildSessionArchived(teamId, childSessionId, true)
    return true
  })
  return <YuqiTeamDock {...({ useProjection: () => value, onOpenChild, onArchiveChild, command } as unknown as ComponentProps<typeof YuqiTeamDock>)} />
}


/** Follow visible workbench navigation; never query hidden tab contents as a substitute. */
function openPanelPage(page: 'tasks' | 'review' | 'activity') {
  const names = { tasks: /^(Tasks|任务)$/, review: /^(Review & decisions|审查与确认)/, activity: /^(Progress & evidence|进展与证据)$/ }
  const button = screen.getByRole('button', { name: names[page] })
  if (button.getAttribute('aria-pressed') !== 'true') fireEvent.click(button)
  expect(button).toHaveAttribute('aria-pressed', 'true')
}
function expandTask(name: RegExp) {
  // Workbench master-detail: picking a task renders its inspector row already
  // expanded. Iterate picker items until the detail summary matches the regex.
  const picker = screen.queryByRole('navigation', { name: /^(Select a task|选择任务)$/ })
  if (picker !== null) {
    const list = picker.querySelector('.yuqi-task-picker-list')
    if (list === null) throw new Error(`task picker list is empty; cannot find ${name}`)
    const items = within(list as HTMLElement).getAllByRole('button')
    for (const item of items) {
      if (item.getAttribute('aria-pressed') !== 'true') fireEvent.click(item)
      const detail = document.querySelector('.yuqi-detail-task-inspector button.yuqi-task-summary')
      if (detail !== null && name.test(detail.textContent ?? '')) {
        expect(detail).toHaveAttribute('aria-expanded', 'true')
        return
      }
    }
    throw new Error(`no picker task matches ${name}`)
  }
  const technical = screen.queryByText(/^(Technical records and manual takeover|技术记录与人工接管|Technical details and task actions|技术详情与任务操作)$/, { selector: 'summary' })
  if (technical && !technical.hasAttribute('hidden') && !technical.closest('details')!.open) fireEvent.click(technical)
  const button = screen.getByRole('button', { name })
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button)
  expect(button).toHaveAttribute('aria-expanded', 'true')
}
function openSection(name: string) {
  if (name === 'Independent review (optional)' || name === '独立复核（可选）') {
    openPanelPage('review')
    return
  }
  if (name === 'Project summary' || name === '项目总览') {
    openPanelPage('activity')
    fireEvent.click(screen.getByRole('button', { name }))
    return
  }
  if (name === 'Find and filter tasks' || name === '查找与筛选任务') {
    const label = screen.getByText(/^(Filter|筛选)$/, { selector: 'summary span' })
    const summary = label.closest('summary')!
    if (!summary.closest('details')!.open) fireEvent.click(summary)
    return
  }
  const heading = screen.getByText(name, { selector: 'summary' })
  expect(heading).toBeVisible()
  if (!heading.closest('details')!.open) fireEvent.click(heading)
  expect(heading.closest('details')).toHaveAttribute('open')
}
function statusContaining(text: string | RegExp) {
  const matches = screen.getAllByRole('status').filter(element => typeof text === 'string'
    ? element.textContent?.includes(text) : text.test(element.textContent ?? ''))
  expect(matches).toHaveLength(1)
  return matches[0]!
}
function queryCommandStatus() {
  return screen.queryAllByRole('status').find(element => element.classList.contains('yuqi-command-notice')) ?? null
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.lang = ''
  vi.unstubAllGlobals()
})

describe('Yuqi Team Client surface', () => {
  it('runs the complete English controller panel flow across tasks, usage, decisions, controls, and messaging', async () => {
    document.documentElement.lang = 'en-US'
    const command = vi.fn(async () => true)
    const openChild = vi.fn(async () => true)
    const knownUsage = {
      state: 'known' as const, uncachedInputTokens: 1200, outputTokens: 300,
      cacheReadTokens: 50, cacheWriteTokens: 25, totalTokens: 1575, label: 'Token：1575 tok',
    }
    const tasks = [
      task({
        taskId: 'build-shell', goal: 'Build the application shell', usage: knownUsage,
        duration: { state: 'known', elapsedMs: 62_000 }, reportedChangedFiles: ['src/App.tsx'],
        dependencies: [{ taskId: 'foundation', goal: 'Establish the shared design foundation', index: 1 }],
        dependencyCount: 1, verificationStatus: 'running',
      }),
      task({
        taskId: 'failed-check', goal: 'Repair the failed visual check', status: 'failed', attemptStatus: 'failed',
        childSessionId: 'child-2', usage: { state: 'unavailable', label: 'Token：提供方未上报' },
        duration: { state: 'known', elapsedMs: 3_600_000 }, reportedChangedFiles: [], evidenceRecorded: true,
      }),
      task({
        taskId: 'completed-copy', goal: 'Complete English copy', status: 'completed', attemptStatus: 'completed',
        childSessionId: 'child-3', usage: knownUsage, duration: { state: 'known', elapsedMs: 5_400_000 }, evidenceRecorded: true,
      }),
      task({
        taskId: 'planned-mobile', goal: 'Plan the mobile follow-up', status: 'ready', attemptCount: 0,
        attemptId: undefined, attemptOrdinal: undefined, attemptStatus: undefined, childSessionId: undefined,
        usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' },
        fileScope: [], dependencyCount: 2, dependencies: [{ taskId: 'build-shell', goal: 'Build the application shell' }],
      }),
    ]
    const value = summary({
      team: { ...summary().team, workspaceMode: 'direct', duration: { state: 'known', elapsedMs: 3_661_000 }, userDecisionCount: 2, attentionTaskCount: 2 },
      tasks,
      attention: [
        { taskId: 'failed-check', code: 'verification-inconclusive', owner: 'user', message: 'Choose whether to accept the visual variance.' },
        { taskId: 'missing-task', code: 'dependency-blocked', owner: 'user', message: 'Choose the product fallback.' },
      ],
      projectSummary: {
        schemaVersion: 1, overallProgress: 'The English shell is ready for review.',
        architectureDecisions: [{ id: 'decision-1', text: 'Keep controller-owned recovery.', links: ['docs/architecture.md'] }],
        pitfalls: [{ id: 'pitfall-1', text: 'Do not infer missing usage.', links: [] }],
        conventions: [{ id: 'convention-1', text: 'Use accessible control names.', links: [] }],
        documentLinks: ['https://example.test/guide'], updatedAt: '2026-08-30T00:00:00Z',
      },
      review: {
        reviewId: 'review-english', trigger: 'user-request', reviewerSessionId: 'reviewer-1', decision: 'changes_required',
        findings: [{ severity: 'medium', evidence: ['panel screenshot'], impact: 'One state needs refinement.', recommendation: 'Keep the controller path visible.' }],
        unverified: ['Mobile viewport'],
      },
    })
    render(<TeamPanel summary={value} onClose={vi.fn()} onOpenChild={openChild} command={command} nowMs={Date.now()}
      models={[{ id: 'deepseek-v4', name: 'DeepSeek V4' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }]} />)

    const panel = screen.getByRole('dialog', { name: 'Yuqi Team task panel' })
    expect(panel).toHaveTextContent('Team tasks')
    expect(panel).toHaveTextContent('Yuqi Team')
    openPanelPage('review')
    expect(screen.getByRole('region', { name: 'Controller decisions' })).toHaveTextContent('2 decisions needed')
    openPanelPage('activity')
    fireEvent.click(screen.getByRole('button', { name: /^(Usage|用量统计)$/ }))
    fireEvent.click(screen.getByText(/^(Usage details|用量详情)$/))
    expect(screen.getByRole('region', { name: 'Team usage summary' })).toHaveTextContent('Total')
    expect(screen.getByRole('region', { name: 'Team usage summary' })).toHaveTextContent('24.6K')

    openPanelPage('tasks')
    expandTask(/Build the application shell.*Details/u)
    expect(panel).toHaveTextContent('Planned change scope')
    expect(panel).toHaveTextContent('File change evidence')
    expect(screen.getByRole('button', { name: 'Stop child Agent: Build the application shell' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop child Agent: Build the application shell' }))
    expect(screen.getByRole('alertdialog', { name: 'Confirm stopping child Agent: Build the application shell' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }))

    const composer = screen.getByRole('region', { name: 'Add Team instruction' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Instruction recipient' }), { target: { value: 'all' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Team instruction content' }), { target: { value: 'Report completion to the controller.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send instruction' }))
    await waitFor(() => expect(composer).toHaveTextContent('request record was saved'))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Team' }))
    expect(screen.getByRole('alertdialog', { name: 'Confirm Team cancellation' })).toHaveTextContent('completed records are preserved')
    fireEvent.click(screen.getByRole('button', { name: 'Keep Team' }))

    openSection('Find and filter tasks')
    fireEvent.click(screen.getByRole('button', { name: /Task plans \(no conversation\)/u }))
    expect(panel).toHaveTextContent('These are task plans, not child Agent conversations')
    expect(screen.getByRole('button', { name: /Task plan.*Plan the mobile follow-up.*Details/u })).toBeInTheDocument()
    openPanelPage('activity')
    openSection('Project summary')
    expect(panel).toHaveTextContent('Architecture decisions')
    openPanelPage('review')
    openSection('Independent review (optional)')
    expect(panel).toHaveTextContent('Changes required')
  })

  it('keeps English Team controls actionable across confirmation, recovery, cancellation, and view-only states', async () => {
    document.documentElement.lang = 'en'
    const rejected = vi.fn(async () => false)
    const plan = render(<TeamControls teamId="team-plan" controllerSessionId="controller-plan" status="paused"
      planConfirmationPending command={rejected} disablePlanConfirmation={async () => false} />)
    expect(screen.getByLabelText('Choose how to start')).toHaveTextContent('Plan verification pending')
    fireEvent.click(screen.getByRole('button', { name: 'Always start automatically' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save'))

    plan.rerender(<TeamControls teamId="team-recovery" controllerSessionId="controller-recovery" status="needs_reconciliation"
      userDecisionCount={0} command={rejected} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recover and continue' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Controller recovery rejected'))

    plan.rerender(<TeamControls teamId="team-running" controllerSessionId="controller-running" status="running"
      command={vi.fn(async () => { throw new Error('offline') })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('transport failed'))

    plan.rerender(<TeamControls teamId="team-cancelled" status="cancelled" />)
    expect(screen.getByLabelText('Team controls')).toHaveTextContent('The Team is cancelled')
    expect(screen.getByText('This conversation is view-only')).toBeInTheDocument()
  })

  it('covers successful remembered start, recovery admission, and durable-update timeout copy', async () => {
    document.documentElement.lang = 'en-US'
    vi.useFakeTimers()
    try {
      const command = vi.fn<(line: string) => Promise<boolean>>(async () => true)
      const view = render(<TeamControls teamId="team-plan-success" controllerSessionId="controller-plan-success" status="paused"
        planConfirmationPending command={command} disablePlanConfirmation={async () => true} />)
      fireEvent.click(screen.getByRole('button', { name: 'Always start automatically' }))
      await act(async () => { await Promise.resolve() })
      expect(command).toHaveBeenCalledOnce()
      expect(command.mock.calls[0]![0]).toMatch(/^\/yuqi resume team-plan-success controller-plan-success /u)

      view.rerender(<TeamControls teamId="team-recovery-success" controllerSessionId="controller-recovery-success"
        status="needs_reconciliation" command={command} />)
      fireEvent.click(screen.getByRole('button', { name: 'Recover and continue' }))
      await act(async () => { await Promise.resolve() })
      expect(statusContaining('Controller recovery submitted')).toHaveTextContent('Controller recovery submitted')
      await act(async () => { vi.advanceTimersByTime(15_000) })
      expect(screen.getByRole('alert')).toHaveTextContent('has no durable state update yet')

      view.rerender(<TeamControls teamId="team-pausing-copy" controllerSessionId="controller-pausing-copy"
        status="pausing" command={command} />)
      expect(statusContaining('Pause is already in progress')).toHaveTextContent('Pause is already in progress')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports English task action failures without losing the selected task context', async () => {
    document.documentElement.lang = 'en'
    const rejected = vi.fn(async () => false)
    const openChild = vi.fn(async () => false)
    const failed = task({
      taskId: 'failed-english', goal: 'Repair failed English task', status: 'failed', attemptStatus: 'failed',
      childSessionId: 'child-failed', reportedChangedFiles: [], evidenceRecorded: true,
      usage: { state: 'unavailable', label: 'Token：提供方未上报' }, duration: { state: 'known', elapsedMs: 125_000 },
    })
    const view = render(<TaskRow index={0} teamId="team-english" task={failed} controllerSessionId="controller-english"
      onOpenChild={openChild} command={rejected} nowMs={0} teamStatus="running"
      models={[{ id: 'deepseek-v4', name: 'DeepSeek V4' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }]} />)
    expandTask(/Repair failed English task.*Details/u)

    fireEvent.change(screen.getByLabelText('Task model'), { target: { value: 'deepseek-v4-pro' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply model and retry' }))
    await waitFor(() => expect(screen.getAllByText(/Model change rejected/u)).toHaveLength(2))

    fireEvent.change(screen.getByLabelText('Task permission'), { target: { value: 'read-only' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply permission' }))
    await waitFor(() => expect(screen.getByText(/Permission change rejected/u)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Retry task' }))
    await waitFor(() => expect(screen.getAllByText(/Command rejected/u)).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: /Open child Agent conversation/u }))
    await waitFor(() => expect(screen.getByText(/conversation address is not ready/u)).toBeInTheDocument())

    const running = task({ taskId: 'running-english', goal: 'Stop one English worker' })
    view.rerender(<TaskRow index={0} teamId="team-english" task={running} controllerSessionId="controller-english"
      onOpenChild={openChild} command={vi.fn(async () => { throw new Error('offline') })} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop child Agent: Stop one English worker' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }))
    await waitFor(() => expect(screen.getByText(/Stop transport failed/u)).toBeInTheDocument())
  })

  it('reports bilingual child archive failures', async () => {
    document.documentElement.lang = 'en-US'
    const rejected = task({
      taskId: 'archive-rejected', goal: 'Archive rejected child', status: 'completed', attemptStatus: 'completed',
      childSessionId: 'archive-rejected-child', evidenceRecorded: true,
    })
    const view = render(<TaskRow index={0} teamId="team-archive-errors" task={rejected}
      controllerSessionId="controller-archive-errors" onOpenChild={async () => true}
      onArchiveChild={async () => false} nowMs={0} />)
    expandTask(/Archive rejected child.*Details/u)
    fireEvent.click(screen.getByRole('button', { name: 'Archive child Agent: Archive rejected child' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Archiving failed')
    view.unmount()

    document.documentElement.lang = 'zh-CN'
    const failed = task({
      taskId: 'archive-failed', goal: '归档异常子代理', status: 'failed', attemptStatus: 'failed',
      childSessionId: 'archive-failed-child', evidenceRecorded: true,
    })
    render(<TaskRow index={0} teamId="team-archive-failure" task={failed}
      controllerSessionId="controller-archive-failure" onOpenChild={async () => true}
      onArchiveChild={async () => { throw new Error('offline') }} nowMs={0} />)
    expandTask(/归档异常子代理.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: '归档子代理：归档异常子代理' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('归档失败')

    cleanup()
    const rejectedZh = { ...rejected, taskId: 'archive-rejected-zh', goal: '归档被拒绝子代理' }
    render(<TaskRow index={0} teamId="team-archive-rejected-zh" task={rejectedZh}
      controllerSessionId="controller-archive-rejected-zh" onOpenChild={async () => true}
      onArchiveChild={async () => false} nowMs={0} />)
    expandTask(/归档被拒绝子代理.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: '归档子代理：归档被拒绝子代理' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('归档失败')

    cleanup()
    document.documentElement.lang = 'en-US'
    const failedEn = { ...failed, taskId: 'archive-failed-en', goal: 'Archive failed child' }
    render(<TaskRow index={0} teamId="team-archive-failed-en" task={failedEn}
      controllerSessionId="controller-archive-failed-en" onOpenChild={async () => true}
      onArchiveChild={async () => { throw new Error('offline') }} nowMs={0} />)
    expandTask(/Archive failed child.*Details/u)
    fireEvent.click(screen.getByRole('button', { name: 'Archive child Agent: Archive failed child' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Archiving failed')
  })

  it('reports Chinese task-control transport failures', async () => {
    const transportFailure = vi.fn(async (): Promise<boolean> => { throw new Error('offline') })
    const models = [{ id: 'deepseek-v4', name: 'DeepSeek V4' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }]
    const view = render(<TaskRow index={0} teamId="team-control-failure" task={task({
      taskId: 'control-failure', goal: '处理控制传输失败', status: 'failed', attemptStatus: 'failed',
    })} controllerSessionId="controller-control-failure" onOpenChild={async () => { throw new Error('offline') }}
      command={transportFailure} nowMs={0} models={models} teamStatus="running" />)
    expandTask(/处理控制传输失败.*详情/u)
    fireEvent.change(screen.getByLabelText('任务模型'), { target: { value: 'deepseek-v4-pro' } })
    fireEvent.click(screen.getByRole('button', { name: '应用模型并重试' }))
    expect((await screen.findAllByText(/模型切换传输失败/u))).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('任务权限'), { target: { value: 'read-only' } })
    fireEvent.click(screen.getByRole('button', { name: '应用权限' }))
    expect(await screen.findByText(/权限切换传输失败/u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试任务' }))
    expect((await screen.findAllByText(/命令传输失败/u))).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /打开子代理会话/u }))
    expect(await screen.findByText(/子代理会话打开失败/u)).toBeInTheDocument()

    view.rerender(<TaskRow index={0} teamId="team-control-failure" task={task({
      taskId: 'stop-control-failure', goal: '停止传输失败任务', status: 'running', attemptStatus: 'running',
    })} controllerSessionId="controller-control-failure" onOpenChild={async () => true}
      command={transportFailure} nowMs={0} models={models} />)
    fireEvent.click(screen.getByRole('button', { name: '停止子代理：停止传输失败任务' }))
    fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
    expect(await screen.findByText(/停止请求传输失败/u)).toBeInTheDocument()
  })

  it('renders complete routed-task details in both locales', () => {
    const routed = task({
      taskId: 'routed-details', goal: 'Inspect routed details', status: 'ready', attemptStatus: undefined,
      attemptId: undefined, attemptOrdinal: undefined, childSessionId: undefined, attemptCount: 0,
      fileScope: [], reportedChangedFiles: undefined, evidenceRecorded: false,
      route: { providerId: 'deepseek', modelId: 'deepseek-v4', basis: 'automatic', fallbackReason: 'automatic-candidates-exhausted' },
    })
    document.documentElement.lang = 'en-US'
    const view = render(<TaskRow index={0} teamId="team-routed-details" task={routed}
      controllerSessionId="controller-routed-details" onOpenChild={async () => true} nowMs={0} />)
    expandTask(/Inspect routed details.*Details/u)
    expect(screen.getByText('Actual route')).toBeInTheDocument()
    expect(screen.getByText('Route basis')).toBeInTheDocument()
    expect(screen.getByText('Fallback')).toBeInTheDocument()
    expect(screen.getByText('An execution record exists, but no child-session record is available in this view. This does not mean the task produced no files.')).toBeVisible()
    view.unmount()

    document.documentElement.lang = 'zh-CN'
    render(<TaskRow index={0} teamId="team-routed-details-zh" task={{ ...routed, taskId: 'routed-details-zh', goal: '检查路由详情' }}
      controllerSessionId="controller-routed-details-zh" onOpenChild={async () => true} nowMs={0} />)
    expandTask(/检查路由详情.*详情/u)
    expect(screen.getByText('实际路由')).toBeInTheDocument()
    expect(screen.getByText('路由依据')).toBeInTheDocument()
    expect(screen.getByText('回退')).toBeInTheDocument()
    expect(screen.getByText('已有执行记录，但此视图缺少子会话记录；这不代表任务没有产生文件。')).toBeVisible()
  })

  it('confirms accepted English task actions before durable state catches up', async () => {
    document.documentElement.lang = 'en'
    const command = vi.fn(async () => true)
    const failed = task({ taskId: 'accepted-english', goal: 'Retry accepted English task', status: 'failed', attemptStatus: 'failed' })
    const view = render(<TaskRow index={0} teamId="team-accepted" task={failed} controllerSessionId="controller-accepted"
      onOpenChild={async () => true} command={command} nowMs={0} teamStatus="running"
      models={[{ id: 'deepseek-v4', name: 'DeepSeek V4' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }]} />)
    expandTask(/Retry accepted English task.*Details/u)
    fireEvent.change(screen.getByLabelText('Task model'), { target: { value: 'deepseek-v4-pro' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply model and retry' }))
    await waitFor(() => expect(screen.getAllByText(/Task model submitted/u)).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Task permission'), { target: { value: 'read-only' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply permission' }))
    await waitFor(() => expect(screen.getByText(/Task permission submitted/u)).toBeInTheDocument())
    view.rerender(<TaskRow index={0} teamId="team-accepted" task={task({
      taskId: 'accepted-english', goal: 'Retry accepted English task', status: 'failed', attemptStatus: 'failed',
      attemptOrdinal: 2, attemptId: 'attempt-2', attemptCount: 2,
    })} controllerSessionId="controller-accepted" onOpenChild={async () => true} command={command} nowMs={0} teamStatus="running"
      models={[{ id: 'deepseek-v4', name: 'DeepSeek V4' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry task' }))
    await waitFor(() => expect(screen.getAllByText(/Retry submitted/u)).toHaveLength(2))

    view.rerender(<TaskRow index={0} teamId="team-accepted" task={task({ taskId: 'stop-accepted', goal: 'Stop accepted worker' })}
      controllerSessionId="controller-accepted" onOpenChild={async () => true} command={command} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop child Agent: Stop accepted worker' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }))
    await waitFor(() => expect(screen.getByText(/Stop submitted/u)).toBeInTheDocument())
  })

  it('surfaces English durable-update timeouts and transport failures for task actions', async () => {
    localStorage.setItem('yuqi-team-orchestrator.locale.v1', 'en')
    vi.useFakeTimers()
    try {
      const accepted = vi.fn(async () => true)
      const running = task({ taskId: 'running-timeout', goal: 'Observe durable updates' })
      const view = render(<TaskRow index={0} teamId="team-timeout" task={running} controllerSessionId="controller-timeout"
        onOpenChild={async () => true} command={accepted} nowMs={0} teamStatus="running"
        models={[{ id: 'deepseek-v4', name: 'DeepSeek V4' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }]} />)
      expandTask(/Observe durable updates.*Details/u)

      fireEvent.change(screen.getByLabelText('Task model'), { target: { value: 'deepseek-v4-pro' } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop and restart with model' })) })
      expect(screen.getByText(/current attempt will stop safely/u)).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(screen.getByText(/retry has no durable state update/u)).toBeInTheDocument()

      fireEvent.change(screen.getByLabelText('Task permission'), { target: { value: 'read-only' } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop and switch permission' })) })
      expect(screen.getByText(/Permission change submitted/u)).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(screen.getByText(/permission change has no durable state update/u)).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Stop child Agent: Observe durable updates' }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' })) })
      expect(screen.getByText(/Stop submitted/u)).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(screen.getByText(/stop request has no durable state update/u)).toBeInTheDocument()

      const transportFailure = vi.fn(async () => { throw new Error('offline') })
      view.unmount()
      render(<TaskRow index={0} teamId="team-timeout" task={task({
        taskId: 'failed-transport', goal: 'Recover transport errors', status: 'failed', attemptStatus: 'failed',
      })} controllerSessionId="controller-timeout" onOpenChild={async () => { throw new Error('offline') }}
        command={transportFailure} nowMs={0} teamStatus="running"
        models={[{ id: 'deepseek-v4', name: 'DeepSeek V4' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }]} />)
      expandTask(/Recover transport errors.*Details/u)
      fireEvent.change(screen.getByLabelText('Task model'), { target: { value: 'deepseek-v4-pro' } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply model and retry' })) })
      expect(screen.getAllByText(/Model change transport failed/u)).toHaveLength(2)
      fireEvent.change(screen.getByLabelText('Task permission'), { target: { value: 'read-only' } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply permission' })) })
      expect(screen.getByText(/Permission change transport failed/u)).toBeInTheDocument()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry task' })) })
      expect(screen.getAllByText(/Command transport failed/u)).toHaveLength(2)
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Open child Agent conversation/u })) })
      expect(screen.getByText(/Failed to open the child Agent conversation/u)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('presents the complete English archived-task state and dependency fallback', () => {
    localStorage.setItem('yuqi-team-orchestrator.locale.v1', 'en')
    setChildSessionArchived('team-archive-copy', 'child-archive-copy', true)
    const archived = task({
      taskId: 'archived-copy', goal: 'Inspect archived task', status: 'completed', attemptStatus: 'completed',
      childSessionId: 'child-archive-copy', fileScope: [], reportedChangedFiles: [], dependencyCount: 2,
      dependencies: undefined, evidenceRecorded: true,
    })
    render(<TaskRow index={0} teamId="team-archive-copy" task={archived} controllerSessionId="controller-archive-copy"
      onOpenChild={async () => true} nowMs={0} />)

    expect(screen.getByRole('button', { name: 'Archive child Agent: Inspect archived task' })).toHaveAttribute('title', 'Child Agent conversation is archived')
    expandTask(/Inspect archived task.*Details/u)
    expect(screen.getByText('Not declared')).toBeInTheDocument()
    expect(screen.getByText('No attributable file evidence in the available records.')).toBeVisible()
    expect(screen.getByTitle('2 prerequisite(s) must finish first')).toHaveTextContent('Prerequisites: 2')
    expect(screen.getByRole('button', { name: 'Child Agent conversation archived' })).toBeDisabled()
  })

  it('forwards an English instruction to one child and preserves rejected text for retry', async () => {
    document.documentElement.lang = 'en'
    const running = [task({ taskId: 'worker-one', goal: 'Worker one' }), task({ taskId: 'worker-two', goal: 'Worker two', childSessionId: 'child-2' })]
    const accepted = vi.fn(async () => true)
    const view = render(<TeamMessageComposer teamId="team-message" teamStatus="running" cancellationRequested={false} controllerSessionId="controller-message" tasks={running} command={accepted} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Instruction recipient' }), { target: { value: 'worker-two' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Team instruction content' }), { target: { value: 'Return evidence to the controller.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send instruction' }))
    await waitFor(() => expect(statusContaining('request record was saved')).toHaveTextContent('request record was saved'))

    view.rerender(<TeamMessageComposer teamId="team-message" teamStatus="running" cancellationRequested={false} controllerSessionId="controller-message" tasks={running} command={vi.fn(async () => false)} />)
    const textbox = screen.getByRole('textbox', { name: 'Team instruction content' })
    fireEvent.change(textbox, { target: { value: 'Keep this instruction for retry.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send instruction' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('instruction was rejected'))
    expect(textbox).toHaveValue('Keep this instruction for retry.')

    view.rerender(<TeamMessageComposer teamId="team-empty" teamStatus="running" cancellationRequested={false} controllerSessionId="controller-message" tasks={[]} command={accepted} />)
    expect(screen.getByRole('textbox', { name: 'Team instruction content' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send instruction' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('No active recipient selected')
  })

  it('explains English plan confirmation and controller recovery from the same main panel', async () => {
    document.documentElement.lang = 'en'
    const planned = task({
      status: 'ready', attemptCount: 0, attemptId: undefined, attemptOrdinal: undefined,
      attemptStatus: undefined, childSessionId: undefined, evidenceRecorded: false,
    })
    const command = vi.fn(async () => true)
    const view = render(<TeamPanel summary={summary({
      team: { ...summary().team, status: 'paused', planConfirmationPending: true, runningTaskCount: 0, waitingTaskCount: 1 }, tasks: [planned],
    })} onClose={vi.fn()} onOpenChild={async () => true} command={command} nowMs={0} />)
    expect(screen.getByText('Task execution plan generated')).toBeInTheDocument()

    const recovering = task({ status: 'running', attemptStatus: 'unknown' })
    view.rerender(<TeamPanel summary={summary({
      team: { ...summary().team, status: 'needs_reconciliation', userDecisionCount: 0 }, tasks: [recovering], attention: [],
    })} onClose={vi.fn()} onOpenChild={async () => true} command={command} nowMs={0} />)
    expect(screen.getByText(/Task status needs checking/u).closest('[role="status"]')).toBeInTheDocument()
    openPanelPage('review')
    expect(screen.getByRole('button', { name: 'Check current results' })).toBeDisabled()
    expect(screen.getByText('This Team is not safe for reviewer admission.')).toBeInTheDocument()
  })

  it('runs the complete English re-review path across accepted, rejected, transport, exhausted, inconclusive, and view-only states', async () => {
    document.documentElement.lang = 'en'
    const accepted = vi.fn(async () => true)
    const baseProps = { onClose: vi.fn(), onOpenChild: async () => true, nowMs: 0 }
    const eligible = summary({ tasks: [task({ status: 'completed', attemptStatus: 'completed' })] })
    const view = render(<TeamPanel summary={eligible} {...baseProps} command={accepted} />)

    openPanelPage('review')
    openSection('Independent review (optional)')
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: 'Check current results' }))
    await waitFor(() => expect(statusContaining('Independent review submitted')).toHaveTextContent('Independent review submitted'))
    expect(accepted).toHaveBeenCalledWith(expect.stringMatching(/^\/yuqi review user-request team-1 controller-1 [0-9a-z-]+$/u), {
      teamId: 'team-1', controllerSessionId: 'controller-1',
    })

    const exhausted = {
      ...summary({ review: {
        reviewId: 'review-exhausted-en', trigger: 'rework-verification', reviewerSessionId: 'reviewer-en', decision: 'changes_required',
        findings: [{ severity: 'high', evidence: ['failing regression'], impact: 'Release remains unsafe.', recommendation: 'Fix and rerun review.' }], unverified: [],
      } }),
      qualityGate: { active: true, phase: 'awaiting-user', cycle: 2, round: 3, latestDecision: 'changes_required', hostVerification: 'passed', exhausted: true },
    } as TeamConsoleSummary & { readonly qualityGate: Readonly<Record<string, unknown>> }
    const rejected = vi.fn(async () => false)
    view.rerender(<TeamPanel summary={exhausted} {...baseProps} command={rejected} />)
    openPanelPage('review')
    const gate = screen.getByRole('region', { name: 'Quality gate control' })
    expect(gate).toHaveTextContent('Your decision needed')
    expect(gate).toHaveTextContent('The reviewer still requires changes after the configured automatic rework budget was used')
    expect(gate).toHaveTextContent('Next step')
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: 'Request another review' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The controller rejected the review request')

    const inconclusive = {
      ...summary({ review: {
        reviewId: 'review-inconclusive-en', trigger: 'quality-gate', reviewerSessionId: 'reviewer-en', decision: 'inconclusive',
        findings: [], unverified: ['Browser evidence is unavailable'],
      } }),
      qualityGate: { active: true, phase: 'awaiting-user', cycle: 3, round: 0, latestDecision: 'inconclusive', hostVerification: 'inconclusive', exhausted: false },
    } as TeamConsoleSummary & { readonly qualityGate: Readonly<Record<string, unknown>> }
    const transportFailure = vi.fn(async (): Promise<boolean> => { throw new Error('offline') })
    view.rerender(<TeamPanel summary={inconclusive} {...baseProps} command={transportFailure} />)
    openPanelPage('review')
    expect(screen.getByRole('region', { name: 'Quality gate control' })).toHaveTextContent('The reviewer could not establish a pass from the available evidence')
    openPanelPage('review')
    expect(screen.getByRole('region', { name: 'Quality gate control' })).toHaveTextContent('Browser evidence is unavailable')
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: 'Request another review' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The review request could not reach the controller')

    view.rerender(<TeamPanel summary={inconclusive} {...baseProps} />)
    openPanelPage('review')
    const viewOnlyGate = within(screen.getByRole('region', { name: 'Quality gate control' }))
    expect(viewOnlyGate.getByRole('button', { name: 'Request another review' })).toBeDisabled()
    expect(viewOnlyGate.getByRole('button', { name: 'Accept risk…' })).toBeDisabled()
    expect(viewOnlyGate.getByRole('button', { name: 'Fail Team' })).toBeDisabled()
    expect(viewOnlyGate.getByRole('button', { name: 'Cancel Team' })).toBeDisabled()
    expect(screen.getByText('This panel is view-only.')).toBeInTheDocument()
  })

  it('opens the current Team panel when the global reminder requests its exact Team', () => {
    render(dock(summary()))
    expect(screen.queryByRole('dialog', { name: 'Yuqi Team 任务面板' })).not.toBeInTheDocument()

    act(() => requestTeamPanelOpen('team-1'))

    expect(screen.getByRole('dialog', { name: 'Yuqi Team 任务面板' })).toBeInTheDocument()
  })

  it('does not reconcile a running Team while tasks are still waiting for dispatch', async () => {
    vi.useFakeTimers()
    try {
      const command = vi.fn(async () => true)
      const stale = summary({
        tasks: [task({ status: 'pending', attemptStatus: undefined, childSessionId: undefined })],
        team: { ...summary().team, runningTaskCount: 0, waitingTaskCount: 1 },
      })
      render(dock(stale, undefined, command))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(command).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders with the locale observer unavailable in a constrained client host', () => {
    vi.stubGlobal('MutationObserver', undefined)
    render(dock(summary()))
    expect(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' })).toBeInTheDocument()
  })
  it('shows one flat pre-dispatch bar and starts only this Team without changing the preference', async () => {
    const command = vi.fn(async () => true)
    const disablePlanConfirmation = vi.fn(async () => true)
    const value = summary({
      team: {
        ...summary().team, status: 'paused', runningTaskCount: 0, waitingTaskCount: 1,
        planConfirmationPending: true,
      },
      tasks: [task({
        status: 'pending', attemptCount: 0, attemptId: undefined, attemptOrdinal: undefined,
        attemptStatus: undefined, childSessionId: undefined,
      })],
    })
    render(<YuqiTeamDock {...({
      useProjection: () => value, onOpenChild: async () => true, command, disablePlanConfirmation,
    } as unknown as ComponentProps<typeof YuqiTeamDock>)} />)

    expect(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始执行' })).toBeInTheDocument()
    expect(screen.queryByLabelText('启动方式待选择')).not.toBeInTheDocument()
    expect(screen.queryByText('团队已创建，尚未开始执行')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('待核对任务图')
    fireEvent.click(screen.getByRole('button', { name: '关闭团队面板' }))
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(disablePlanConfirmation).not.toHaveBeenCalled())
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.stringMatching(/^\/yuqi resume team-1 controller-1 /u), {
      teamId: 'team-1', controllerSessionId: 'controller-1',
    }))
  })

  it('keeps dock start pending until the durable projection changes and reports rejection or timeout in place', async () => {
    vi.useFakeTimers()
    try {
      const pending = summary({ team: { ...summary().team, status: 'paused', planConfirmationPending: true, runningTaskCount: 0, waitingTaskCount: 1 } })
      const rejected = vi.fn(async () => false)
      const view = render(dock(pending, vi.fn(async () => true), rejected))
      fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
      await act(async () => { await Promise.resolve() })
      expect(screen.getByRole('alert')).toHaveTextContent('启动未受理')

      view.rerender(dock(pending, vi.fn(async () => true), vi.fn(async () => true)))
      fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
      await act(async () => { await Promise.resolve() })
      expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled()
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(screen.getByRole('alert')).toHaveTextContent('启动请求尚未出现持久化状态更新')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let a stale A start response overwrite a newer A projection generation after A→B→A', async () => {
    let resolveFirst!: (accepted: boolean) => void
    let resolveSecond!: (accepted: boolean) => void
    const command = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveSecond = resolve }))
    const planned = (id: string) => summary({ team: { ...summary().team, id, status: 'paused', planConfirmationPending: true, runningTaskCount: 0, waitingTaskCount: 1 } })
    const view = render(dock(planned('team-a'), vi.fn(async () => true), command))
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
    view.rerender(dock(planned('team-b'), vi.fn(async () => true), command))
    await act(async () => { await Promise.resolve() })
    view.rerender(dock(planned('team-a'), vi.fn(async () => true), command))
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '开始执行' }))
    await act(async () => { resolveFirst(true); await Promise.resolve() })
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDisabled()
    await act(async () => { resolveSecond(true); await Promise.resolve() })
  })

  it('does not resume when remembering the direct-start preference fails', async () => {
    const command = vi.fn(async () => true)
    render(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="paused"
      planConfirmationPending command={command} disablePlanConfirmation={async () => false} />)
    fireEvent.click(screen.getByRole('button', { name: '以后免确认直接启动' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存')
    expect(command).not.toHaveBeenCalled()
  })
  it('labels every task permission, including the legacy missing-value fallback', () => {
    const view = render(<TaskRow index={0} teamId="team-1" task={task({ authorityMode: 'read-only' })}
      controllerSessionId="controller-1" onOpenChild={async () => true} nowMs={0} />)
    expect(screen.getByText('权限：只读')).toBeInTheDocument()
    view.rerender(<TaskRow index={0} teamId="team-1" task={task({ authorityMode: 'full-access' })}
      controllerSessionId="controller-1" onOpenChild={async () => true} nowMs={0} />)
    expect(screen.getByText('权限：完全访问')).toBeInTheDocument()
    view.rerender(<TaskRow index={0} teamId="team-1" task={{ ...task(), authorityMode: undefined } as never}
      controllerSessionId="controller-1" onOpenChild={async () => true} nowMs={0} />)
    expect(screen.getByText('权限：工作区写入')).toBeInTheDocument()
  })
  it('shows and changes each task permission from the task detail surface', async () => {
    const command = vi.fn(async () => true)
    render(<TaskRow index={0} teamId="team-1" task={task({ status: 'ready', attemptCount: 0, childSessionId: undefined })}
      controllerSessionId="controller-1" onOpenChild={async () => true} command={command} nowMs={0} />)
    expect(screen.getByText('权限：工作区写入')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /详情/ }))
    fireEvent.change(screen.getByLabelText('任务权限'), { target: { value: 'full-access' } })
    fireEvent.click(screen.getByRole('button', { name: '应用权限' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.stringMatching(/^\/yuqi authority task-1 full-access /), {
      teamId: 'team-1', controllerSessionId: 'controller-1',
    }))
  })

  it.each([
    ['rejected', async (): Promise<boolean> => false, '权限切换未受理'],
    ['transport failure', async (): Promise<boolean> => { throw new Error('offline') }, '权限切换传输失败'],
  ] as const)('reports a %s permission switch without claiming completion', async (_case, transport, message) => {
    const command = vi.fn(async () => transport())
    render(<TaskRow index={0} teamId="team-1" task={task({ status: 'ready', attemptCount: 0, attemptId: undefined, attemptOrdinal: undefined, attemptStatus: undefined, childSessionId: undefined })} controllerSessionId="controller-1"
      onOpenChild={async () => true} command={command} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: /详情/ }))
    fireEvent.change(screen.getByLabelText('任务权限'), { target: { value: 'full-access' } })
    fireEvent.click(screen.getByRole('button', { name: '应用权限' }))
    await waitFor(() => expect(command).toHaveBeenCalledOnce())
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('shows the complete quality-gate state and explains an exhausted review in the controller panel', async () => {
    const command = vi.fn(async () => false)
    const gated = {
      ...summary({
        team: { ...summary().team, runningTaskCount: 0, userDecisionCount: 1, attentionTaskCount: 1 },
        tasks: [task({ status: 'completed', attemptStatus: 'completed', verificationStatus: 'passed' })],
        attention: [{ owner: 'user', code: 'verification-inconclusive', taskId: 'task-1', message: 'Reviewer 返工预算已耗尽，需要决定剩余风险。' }],
        review: {
          reviewId: 'review-gate-3', trigger: 'rework-verification', reviewerSessionId: 'reviewer-3', decision: 'changes_required',
          findings: [{ severity: 'high', evidence: ['tests failed'], impact: '发布风险', recommendation: '修复后重试' }], unverified: [],
        },
      }),
      qualityGate: {
        active: true, phase: 'awaiting-user', cycle: 2, round: 3, latestDecision: 'changes_required',
        hostVerification: { status: 'passed' }, awaitingUserReason: '自动返工预算已耗尽。', exhausted: true,
      },
    } as TeamConsoleSummary & { readonly qualityGate: Readonly<Record<string, unknown>> }
    render(<TeamPanel summary={gated} onClose={vi.fn()} onOpenChild={async () => true} command={command} nowMs={0} />)
    openPanelPage('review')
    const gate = screen.getByRole('region', { name: '质量门主控' })
    expect(gate).toHaveTextContent('需要你决定')
    expect(gate).toHaveTextContent('轮次3')
    expect(gate).toHaveTextContent('最新结论需要修改')
    expect(gate).toHaveTextContent('Host 验证通过')
    expect(gate).toHaveTextContent('发生了什么')
    expect(gate).toHaveTextContent('下一步')
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: '再次请求独立审查' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('主控未受理审查请求')
  })

  it('explains an inconclusive gate without requiring the reviewer conversation', () => {
    const gated = {
      ...summary({ review: {
        reviewId: 'review-inconclusive', trigger: 'quality-gate', reviewerSessionId: 'hidden-reviewer', decision: 'inconclusive',
        findings: [], unverified: ['缺少可验证截图'],
      } }),
      qualityGate: { active: true, phase: 'awaiting-user', cycle: 1, round: 0, latestDecision: 'inconclusive', hostVerification: 'inconclusive' },
    } as TeamConsoleSummary & { readonly qualityGate: Readonly<Record<string, unknown>> }
    render(<TeamPanel summary={gated} onClose={vi.fn()} onOpenChild={async () => true} nowMs={0} />)
    openPanelPage('review')
    expect(screen.getByRole('region', { name: '质量门主控' })).toHaveTextContent('缺少可验证截图')
    expect(screen.getByRole('heading', { name: '最新审查结果' })).toBeInTheDocument()
    expect(screen.queryByText('hidden-reviewer')).not.toBeInTheDocument()
  })

  it('explains that an accepted running-task permission switch performs a safe restart', async () => {
    const command = vi.fn(async () => true)
    render(<TaskRow index={0} teamId="team-1" task={task()} controllerSessionId="controller-1"
      onOpenChild={async () => true} command={command} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: /详情/ }))
    fireEvent.change(screen.getByLabelText('任务权限'), { target: { value: 'full-access' } })
    fireEvent.click(screen.getByRole('button', { name: '停止并切换权限' }))
    await waitFor(() => expect(statusContaining('当前 attempt 将安全停止并重启')).toHaveTextContent('当前 attempt 将安全停止并重启'))
  })

  it('does not submit a duplicate permission switch while the first request is pending', () => {
    const command = vi.fn<() => Promise<boolean>>(() => new Promise(() => undefined))
    render(<TaskRow index={0} teamId="team-1" task={task()} controllerSessionId="controller-1"
      onOpenChild={async () => true} command={command} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: /详情/ }))
    fireEvent.change(screen.getByLabelText('任务权限'), { target: { value: 'full-access' } })
    const apply = screen.getByRole('button', { name: '停止并切换权限' })
    fireEvent.click(apply)
    fireEvent.click(apply)
    expect(command).toHaveBeenCalledOnce()
  })

  it('expires a permission admission notice when no durable task update arrives', async () => {
    vi.useFakeTimers()
    try {
      const command = vi.fn(async () => true)
      render(<TaskRow index={0} teamId="team-1" task={task({ status: 'ready', attemptCount: 0, attemptId: undefined, attemptOrdinal: undefined, attemptStatus: undefined, childSessionId: undefined })}
        controllerSessionId="controller-1" onOpenChild={async () => true} command={command} nowMs={0} />)
      fireEvent.click(screen.getByRole('button', { name: /详情/ }))
      fireEvent.change(screen.getByLabelText('任务权限'), { target: { value: 'full-access' } })
      fireEvent.click(screen.getByRole('button', { name: '应用权限' }))
      await act(async () => { await Promise.resolve() })
      expect(statusContaining('任务权限已提交')).toHaveTextContent('任务权限已提交')
      await vi.advanceTimersByTimeAsync(15_000)
      expect(screen.getByRole('alert')).toHaveTextContent('权限切换请求尚未出现持久化状态更新')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['accepted', (settle: (value: boolean) => void) => settle(true)],
    ['transport rejection', (_settle: (value: boolean) => void, reject: (cause: Error) => void) => reject(new Error('offline'))],
  ] as const)('drops a stale permission switch %s after task identity changes', async (_case, finish) => {
    let settle!: (value: boolean) => void
    let reject!: (cause: Error) => void
    const command = vi.fn<() => Promise<boolean>>(() => new Promise((resolve, rejectPromise) => {
      settle = resolve
      reject = rejectPromise
    }))
    const rendered = render(<TaskRow index={0} teamId="team-a" task={task()} controllerSessionId="controller-a"
      onOpenChild={async () => true} command={command} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: /详情/ }))
    fireEvent.change(screen.getByLabelText('任务权限'), { target: { value: 'full-access' } })
    fireEvent.click(screen.getByRole('button', { name: '停止并切换权限' }))
    rendered.rerender(<TaskRow index={0} teamId="team-b" task={{ ...task(), attemptCount: 2 }} controllerSessionId="controller-b"
      onOpenChild={async () => true} command={command} nowMs={0} />)
    finish(settle, reject)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(queryCommandStatus()).not.toBeInTheDocument()
  })
  it('lets an operator select a pending task model and requests a safe restart for a running task', async () => {
    const command = vi.fn(async () => true)
    const models = [{ id: 'deepseek/deepseek-v4', name: 'V4' }, { id: 'deepseek/deepseek-v4-pro', name: 'V4 Pro' }]
    const view = render(<TaskRow index={0} teamId="team-1" task={task({ status: 'ready', attemptCount: 0, attemptId: undefined, attemptOrdinal: undefined, attemptStatus: undefined, childSessionId: undefined, model: 'deepseek-v4' })}
      controllerSessionId="controller-1" onOpenChild={async () => true} command={command} nowMs={0} models={models} />)
    fireEvent.click(screen.getByRole('button', { name: /详情/ }))
    fireEvent.change(screen.getByLabelText('任务模型'), { target: { value: 'deepseek/deepseek-v4-pro' } })
    fireEvent.click(screen.getByRole('button', { name: '应用模型' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.stringMatching(/^\/yuqi model task-1 deepseek\/deepseek-v4-pro /), { teamId: 'team-1', controllerSessionId: 'controller-1' }))
    await screen.findByText('任务模型已提交，等待持久化状态更新。')

    view.rerender(<TaskRow index={0} teamId="team-1" task={task({ status: 'ready', attemptCount: 0, attemptId: undefined, attemptOrdinal: undefined, attemptStatus: undefined, childSessionId: undefined, model: 'deepseek/deepseek-v4-pro' })}
      controllerSessionId="controller-1" onOpenChild={async () => true} command={command} nowMs={0} models={models} />)
    expect(screen.queryByText('任务模型已提交，等待持久化状态更新。')).not.toBeInTheDocument()

    view.rerender(<TaskRow index={0} teamId="team-1" task={task()} controllerSessionId="controller-1" onOpenChild={async () => true} command={command} nowMs={0} models={models} />)
    fireEvent.change(screen.getByLabelText('任务模型'), { target: { value: 'deepseek/deepseek-v4-pro' } })
    fireEvent.click(screen.getByRole('button', { name: '停止并换模重启' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))

    view.rerender(<TaskRow index={0} teamId="team-1" task={task({ status: 'failed', attemptStatus: 'failed' })} controllerSessionId="controller-1" onOpenChild={async () => true} command={command} nowMs={0} models={models} />)
    fireEvent.change(screen.getByLabelText('任务模型'), { target: { value: 'deepseek/deepseek-v4-pro' } })
    fireEvent.click(screen.getByRole('button', { name: '应用模型并重试' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(3))

    view.rerender(<TaskRow index={0} teamId="team-1" task={task({ status: 'cancelled', attemptStatus: 'cancelled', model: 'deepseek/deepseek-v4-pro' })} controllerSessionId="controller-1" onOpenChild={async () => true} command={command} nowMs={0} models={models} />)
    fireEvent.change(screen.getByLabelText('任务模型'), { target: { value: 'deepseek/deepseek-v4' } })
    fireEvent.click(screen.getByRole('button', { name: '应用模型并重试' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(4))
  })

  it('submits the complete Provider and Model route without stripping or guessing a Provider prefix', async () => {
    const command = vi.fn(async () => true)
    const models = [
      { providerId: 'provider-a', providerName: 'Provider A', id: 'shared-model', name: 'Shared A' },
      { providerId: 'provider-b', providerName: 'Provider B', id: 'shared-model', name: 'Shared B' },
    ]
    render(<TaskRow index={0} teamId="team-route" task={task({ model: 'provider-a/shared-model' })}
      controllerSessionId="controller-route" onOpenChild={async () => true} command={command} nowMs={0} models={models} />)
    expandTask(/实现任务编排.*详情/u)
    fireEvent.change(screen.getByLabelText('任务模型'), { target: { value: JSON.stringify(['provider-b', 'shared-model']) } })
    fireEvent.click(screen.getByRole('button', { name: '停止并换模重启' }))

    await waitFor(() => expect(command).toHaveBeenCalledWith(
      expect.stringMatching(/^\/yuqi model task-1 provider-b shared-model /u),
      { teamId: 'team-route', controllerSessionId: 'controller-route' },
    ))
  })

  it('renders optional actual route, basis, and fallback facts from the console contract', () => {
    render(<TaskRow index={0} teamId="team-route-facts" task={task({
      route: { providerId: 'provider-b', modelId: 'model-2', basis: 'automatic', requestedTier: 'critical', fallbackReason: 'automatic-candidates-exhausted' },
    })} controllerSessionId="controller-route" onOpenChild={async () => true} nowMs={0} />)
    expandTask(/实现任务编排.*详情/u)
    expect(screen.getByText('provider-b / model-2')).toBeInTheDocument()
    expect(screen.getByText('自动路由')).toBeInTheDocument()
    expect(screen.getByText('关键')).toBeInTheDocument()
    expect(screen.getByText('自动候选已耗尽')).toBeInTheDocument()
  })

  it('announces an unavailable model catalog in both locales and disables model changes', () => {
    const view = render(<TaskRow index={0} teamId="team-no-models" task={task({ status: 'ready', attemptStatus: undefined })}
      controllerSessionId="controller-no-models" onOpenChild={async () => true} nowMs={0} models={[]} />)
    expandTask(/实现任务编排.*详情/u)
    expect(screen.getByRole('option', { name: '暂无可用模型' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '任务模型' })).toBeDisabled()
    view.unmount()

    document.documentElement.lang = 'en'
    render(<TaskRow index={0} teamId="team-no-models-en" task={task({ taskId: 'task-no-models-en', status: 'ready', attemptStatus: undefined })}
      controllerSessionId="controller-no-models-en" onOpenChild={async () => true} nowMs={0} models={[]} />)
    expandTask(/实现任务编排.*Details/u)
    expect(screen.getByRole('option', { name: 'No models available' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Task model' })).toBeDisabled()
  })

  it.each([
    ['rejected', async (): Promise<boolean> => false, '模型切换未受理'],
    ['transport failure', async (): Promise<boolean> => { throw new Error('offline') }, '模型切换传输失败'],
  ] as const)('reports a %s model switch without claiming that it completed', async (_case, transport, message) => {
    const models = [{ id: 'deepseek/deepseek-v4', name: 'V4' }, { id: 'deepseek/deepseek-v4-pro', name: 'V4 Pro' }]
    render(<TaskRow index={0} teamId="team-1" task={task()} controllerSessionId="controller-1"
      onOpenChild={async () => true} command={vi.fn(transport)} nowMs={0} models={models} />)
    fireEvent.click(screen.getByRole('button', { name: /详情/ }))
    fireEvent.change(screen.getByLabelText('任务模型'), { target: { value: 'deepseek/deepseek-v4-pro' } })
    fireEvent.click(screen.getByRole('button', { name: '停止并换模重启' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it.each([
    ['rejected', async (): Promise<boolean> => false, '主控恢复未受理'],
    ['transport failure', async (): Promise<boolean> => { throw new Error('offline') }, '主控恢复传输失败'],
  ] as const)('reports a %s safe recovery without claiming that it completed', async (_case, transport, message) => {
    render(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="needs_reconciliation"
      userDecisionCount={0} command={vi.fn(transport)} />)
    fireEvent.click(screen.getByRole('button', { name: '恢复并继续' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('expires an accepted Team command when no durable projection update arrives', async () => {
    vi.useFakeTimers()
    try {
      render(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="paused" command={vi.fn(async () => true)} />)
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '继续' }))
        await Promise.resolve()
      })
      expect(statusContaining('请求已提交')).toHaveTextContent('请求已提交')
      act(() => vi.advanceTimersByTime(15_000))
      expect(screen.getByRole('alert')).toHaveTextContent('尚未出现持久化状态更新')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a stale command response after the Team projection identity changes', async () => {
    let settle!: (accepted: boolean) => void
    const command = vi.fn(() => new Promise<boolean>(resolve => { settle = resolve }))
    const view = render(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="running" command={command} />)
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    view.rerender(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="paused" command={command} />)
    await act(async () => { settle(true); await Promise.resolve() })
    expect(screen.queryByText('请求已提交，等待持久化状态更新。')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续' })).not.toBeDisabled()
  })

  it('ignores a stale safe-recovery transport failure after reconciliation state changes', async () => {
    let rejectCommand!: (cause: Error) => void
    const command = vi.fn(() => new Promise<boolean>((_resolve, reject) => { rejectCommand = reject }))
    const view = render(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="needs_reconciliation"
      userDecisionCount={0} command={command} />)
    fireEvent.click(screen.getByRole('button', { name: '恢复并继续' }))
    view.rerender(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="paused" command={command} />)
    await act(async () => { rejectCommand(new Error('stale transport')); await Promise.resolve() })
    expect(screen.queryByText(/主控恢复传输失败/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续' })).not.toBeDisabled()
  })

  it('ignores stale task mutation responses after a newer attempt projection arrives', async () => {
    const models = [{ id: 'deepseek/deepseek-v4', name: 'V4' }, { id: 'deepseek/deepseek-v4-pro', name: 'V4 Pro' }]

    let settleModel!: (accepted: boolean) => void
    const modelCommand = vi.fn(() => new Promise<boolean>(resolve => { settleModel = resolve }))
    const modelView = render(<TaskRow index={0} teamId="team-1" task={task()} controllerSessionId="controller-1"
      onOpenChild={async () => true} command={modelCommand} nowMs={0} models={models} />)
    fireEvent.click(screen.getByRole('button', { name: /详情/ }))
    fireEvent.change(screen.getByLabelText('任务模型'), { target: { value: 'deepseek/deepseek-v4-pro' } })
    fireEvent.click(screen.getByRole('button', { name: '停止并换模重启' }))
    modelView.rerender(<TaskRow index={0} teamId="team-1" task={task({ attemptCount: 2, attemptOrdinal: 2 })} controllerSessionId="controller-1"
      onOpenChild={async () => true} command={modelCommand} nowMs={0} models={models} />)
    await act(async () => { settleModel(true); await Promise.resolve() })
    expect(screen.queryByText(/换模请求已提交/)).not.toBeInTheDocument()
    modelView.unmount()

    let settleRetry!: (accepted: boolean) => void
    const retryCommand = vi.fn(() => new Promise<boolean>(resolve => { settleRetry = resolve }))
    const failed = task({ status: 'failed', attemptStatus: 'failed' })
    const retryView = render(<TaskRow index={0} teamId="team-1" task={failed} controllerSessionId="controller-1"
      onOpenChild={async () => true} command={retryCommand} nowMs={0} teamStatus="running" />)
    fireEvent.click(screen.getByRole('button', { name: /详情/ }))
    fireEvent.click(screen.getByRole('button', { name: '重试任务' }))
    retryView.rerender(<TaskRow index={0} teamId="team-1" task={{ ...failed, attemptCount: 2, attemptOrdinal: 2 }} controllerSessionId="controller-1"
      onOpenChild={async () => true} command={retryCommand} nowMs={0} teamStatus="running" />)
    await act(async () => { settleRetry(true); await Promise.resolve() })
    expect(screen.queryByText(/重试请求已提交/)).not.toBeInTheDocument()
    retryView.unmount()

    const unknown = task({ status: 'blocked', attemptStatus: 'unknown' })
    render(<TaskRow index={0} teamId="team-1" task={unknown} controllerSessionId="controller-1"
      onOpenChild={async () => true} command={vi.fn()} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: /详情/ }))
    expect(screen.getByText('该任务结果尚未确认；现场记录已保留，需主控核对。无需进入子代理对话或人工判定失败。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认已取消' })).not.toBeInTheDocument()
  })

  it('ignores stale child-navigation results after the task attempt changes', async () => {
    let settleOpen!: (opened: boolean) => void
    const openChild = vi.fn(() => new Promise<boolean>(resolve => { settleOpen = resolve }))
    const view = render(<TaskRow index={0} teamId="team-1" task={task()} controllerSessionId="controller-1"
      onOpenChild={openChild} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: /详情/ }))
    fireEvent.click(screen.getByRole('button', { name: '打开子代理会话 ↗' }))
    view.rerender(<TaskRow index={0} teamId="team-1" task={task({ attemptCount: 2, attemptOrdinal: 2, childSessionId: 'child-2' })} controllerSessionId="controller-1"
      onOpenChild={openChild} nowMs={0} />)
    await act(async () => { settleOpen(false); await Promise.resolve() })
    expect(screen.queryByText('子代理会话地址尚未就绪，请稍后刷新。')).not.toBeInTheDocument()
    view.unmount()

    let rejectOpen!: (cause: Error) => void
    const failingOpen = vi.fn(() => new Promise<boolean>((_resolve, reject) => { rejectOpen = reject }))
    const failingView = render(<TaskRow index={0} teamId="team-1" task={task()} controllerSessionId="controller-1"
      onOpenChild={failingOpen} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: /详情/ }))
    fireEvent.click(screen.getByRole('button', { name: '打开子代理会话 ↗' }))
    failingView.rerender(<TaskRow index={0} teamId="team-1" task={task({ attemptCount: 2, attemptOrdinal: 2, childSessionId: 'child-2' })} controllerSessionId="controller-1"
      onOpenChild={failingOpen} nowMs={0} />)
    await act(async () => { rejectOpen(new Error('stale route')); await Promise.resolve() })
    expect(screen.queryByText('子代理会话打开失败，请稍后刷新。')).not.toBeInTheDocument()
  })
  it('renders nothing while the capability is absent or the Session has no Team', () => {
    const { container, rerender } = render(dock(undefined))
    expect(container).toBeEmptyDOMElement()
    rerender(dock(null))
    expect(container).toBeEmptyDOMElement()
  })

  it('falls back to the bound Session projection face when the slot baseline omitted the custom key', () => {
    const value = summary({ tasks: [task({ taskId: 'direct-1' }), task({ taskId: 'direct-2' })] })
    const face = {
      getSnapshot: () => value,
      subscribe: () => () => undefined,
    }
    render(<YuqiTeamDock {...({
      useProjection: () => undefined,
      teamProjection: face,
      onOpenChild: async () => true,
    } as unknown as ComponentProps<typeof YuqiTeamDock>)} />)

    expect(screen.getByLabelText('Yuqi Team 状态与操作')).toHaveTextContent('0/2 已完成')
  })

  it('does not leak a stale slot projection into a newly selected Session without a Team', () => {
    const face = {
      getSnapshot: () => undefined,
      subscribe: () => () => undefined,
    }
    const { container } = render(<YuqiTeamDock {...({
      useProjection: () => summary(),
      teamProjection: face,
      onOpenChild: async () => true,
    } as unknown as ComponentProps<typeof YuqiTeamDock>)} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('renders a compact summary that opens the task panel', () => {
    render(dock(summary({ tasks: [task({ verificationStatus: 'running' })] })))
    const bar = screen.getByLabelText('Yuqi Team 状态与操作')
    expect(bar).toHaveTextContent('团队执行')
    expect(bar).toHaveTextContent('运行中')
    expect(bar).toHaveTextContent('0/1 已完成')
    expect(bar).toHaveTextContent('1 执行中')
    expect(bar).not.toHaveTextContent('0 等待')
    expect(bar).not.toHaveTextContent('需要用户确认')
    expect(bar).not.toHaveTextContent('主控处理中')
    expect(bar).toHaveTextContent('已用 2.5万 Token（部分记录）')
    expect(bar).toHaveTextContent('部分记录')
    expect(bar).toHaveTextContent('查看任务')
    expect(bar).not.toHaveTextContent('⌄')
    expect(screen.getByRole('button', { name: '最小化 Team 卡片' })).toHaveTextContent('隐藏')
    const open = screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' })
    expect(open).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(open)
    expect(screen.getByRole('dialog', { name: 'Yuqi Team 任务面板' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '团队用量摘要' })).not.toBeInTheDocument()
    openPanelPage('activity')
    fireEvent.click(screen.getByRole('button', { name: /^(Usage|用量统计)$/ }))
    fireEvent.click(screen.getByText(/^(Usage details|用量详情)$/))
    expect(screen.getByRole('region', { name: '团队用量摘要' })).toHaveTextContent('总量24.6K')
    expect(screen.getByRole('region', { name: '团队用量摘要' })).toHaveTextContent('暂无可靠数据')
    expect(screen.getByRole('button', { name: '关闭团队面板' })).toBeInTheDocument()
  })

  it('hides a Team card per Team and restores it from the recovery chip', () => {
    render(dock(summary()))
    fireEvent.click(screen.getByRole('button', { name: '最小化 Team 卡片' }))
    expect(screen.queryByRole('button', { name: '打开 Yuqi Team 任务面板' })).not.toBeInTheDocument()
    const restore = screen.getByRole('button', { name: /显示 Team/u })
    expect(restore).toHaveTextContent('运行中 · 0/1')
    fireEvent.click(restore)
    expect(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' })).toBeInTheDocument()
  })

  it('removes a minimized Team card without deleting the recoverable Team entry', () => {
    render(dock(summary()))
    fireEvent.click(screen.getByRole('button', { name: '最小化 Team 卡片' }))
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(screen.queryByRole('button', { name: /显示 Team/u })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开 Yuqi Team 任务面板' })).not.toBeInTheDocument()
  })

  it('localizes the running Team minimize and remove recovery actions in English', () => {
    document.documentElement.lang = 'en'
    render(dock(summary()))
    const hide = screen.getByRole('button', { name: 'Minimize Team card' })
    expect(hide).toHaveAttribute('title', 'Minimize the running Team')
    expect(hide).toHaveTextContent('Hide')
    fireEvent.click(hide)
    expect(screen.getByRole('button', { name: /Show Team/u })).toHaveTextContent('Running · 0/1')
    const remove = screen.getByRole('button', { name: 'Remove' })
    expect(remove).toHaveAttribute('title', 'Remove this card; restore it later from Team management')
    fireEvent.click(remove)
    expect(screen.queryByRole('button', { name: /Show Team/u })).not.toBeInTheDocument()
  })

  it('localizes terminal Team dismissal in English without leaving a recovery chip', () => {
    document.documentElement.lang = 'en'
    render(dock(summary({ team: { ...summary().team, status: 'completed' } })))
    const hide = screen.getByRole('button', { name: 'Close Team card' })
    expect(hide).toHaveAttribute('title', 'Close this finished Team card')
    expect(hide).toHaveTextContent('Close')
    expect(screen.getByRole('button', { name: 'Open Yuqi Team task panel' })).toHaveTextContent('View')
    fireEvent.click(hide)
    expect(screen.queryByRole('button', { name: /Show Team/u })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开 Yuqi Team 任务面板' })).not.toBeInTheDocument()
  })

  it('keeps an open Team panel visible for unrelated keyboard input', () => {
    render(dock(summary()))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(screen.getByRole('dialog', { name: 'Yuqi Team 任务面板' })).toBeInTheDocument()
  })

  it('removes the Team bar when every child conversation is archived', () => {
    const terminalTasks = [
      task({ taskId: 'task-1', goal: '任务一', status: 'cancelled', attemptStatus: 'cancelled', childSessionId: 'child-1' }),
      task({ taskId: 'task-2', goal: '任务二', status: 'completed', attemptStatus: 'completed', childSessionId: 'child-2' }),
    ]
    render(dock(summary({
      team: { ...summary().team, status: 'cancelled' },
      tasks: terminalTasks,
    })))
    expect(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expect(screen.getByRole('dialog', { name: 'Yuqi Team 任务面板' })).toBeInTheDocument()
    act(() => setChildSessionArchived('team-1', 'child-1', true))
    expect(screen.getByRole('button', { name: '关闭团队面板' })).toBeInTheDocument()
    act(() => setChildSessionArchived('team-1', 'child-2', true))
    expect(screen.queryByRole('button', { name: '打开 Yuqi Team 任务面板' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /显示 Team/u })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Yuqi Team 任务面板' })).not.toBeInTheDocument()
    act(() => {
      setChildSessionArchived('team-1', 'child-1', false)
      setChildSessionArchived('team-1', 'child-2', false)
    })
    expect(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Yuqi Team 任务面板' })).not.toBeInTheDocument()
  })

  it('removes and restores the Team bar when the whole Team entry is archived', () => {
    render(dock(summary({ team: { ...summary().team, status: 'completed' } })))
    expect(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' })).toBeInTheDocument()
    act(() => setTeamArchived('team-1', true))
    expect(screen.queryByRole('button', { name: '打开 Yuqi Team 任务面板' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /显示 Team/u })).not.toBeInTheDocument()
    act(() => setTeamArchived('team-1', false))
    expect(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' })).toBeInTheDocument()
  })

  it('restores an archived Team card from management without unarchiving its children, including after remount', () => {
    const completed = summary({
      team: { ...summary().team, status: 'completed', completedTaskCount: 1 },
      tasks: [task({ status: 'completed', attemptStatus: 'completed' })],
    })
    const snapshot = { ids: ['parent-1'], byId: {
      'parent-1': { id: 'parent-1', displayTitle: 'Parent', projectionValues: { yuqiTeam: completed } },
    } }
    const sessions = { getSnapshot: () => snapshot, subscribe: () => () => undefined } as unknown as ComponentProps<typeof TeamCenter>['sessions']
    const openMain = vi.fn()
    const view = render(<>{dock(completed)}<TeamCenter sessions={sessions} openMain={openMain} openChild={async () => true} /></>)
    act(() => setChildSessionArchived('team-1', 'child-1', true))
    expect(screen.queryByRole('button', { name: '打开 Yuqi Team 任务面板' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    fireEvent.click(screen.getByRole('button', { name: '团队任务' }))
    fireEvent.click(screen.getByRole('button', { name: /历史记录 1/ }))
    fireEvent.click(screen.getByRole('button', { name: '归档 Team 与主控入口' }))
    fireEvent.click(screen.getByRole('button', { name: /已归档 1/ }))
    fireEvent.click(screen.getByRole('button', { name: '恢复 Team' }))
    const stored = JSON.parse(localStorage.getItem('yuqi-team-orchestrator.ui.v1')!)['team-1']
    expect(stored).toMatchObject({ teamArchived: false, dockHidden: false, dockDismissed: false, dockRestored: true, archivedChildIds: ['child-1'] })
    view.unmount()
    // Force a storage parse, not only reuse of the in-memory preference snapshot.
    localStorage.setItem('yuqi-team-orchestrator.ui.v1', localStorage.getItem('yuqi-team-orchestrator.ui.v1')! + ' ')
    render(dock(completed))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expect(screen.getByRole('dialog', { name: 'Yuqi Team 任务面板' })).toBeInTheDocument()
  })

  it('opens an explicitly requested panel even when all children remain archived', () => {
    act(() => setChildSessionArchived('team-1', 'child-1', true))
    render(dock(summary({ team: { ...summary().team, status: 'completed' }, tasks: [task({ status: 'completed' })] })))
    act(() => requestTeamPanelOpen('team-1'))
    expect(screen.getByRole('dialog', { name: 'Yuqi Team 任务面板' })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('yuqi-team-orchestrator.ui.v1')!)['team-1'].archivedChildIds).toEqual(['child-1'])
  })

  it('archives a terminal child from task details through the Host bridge', async () => {
    const terminalTasks = [
      task({ taskId: 'task-1', goal: '任务一', status: 'cancelled', attemptStatus: 'cancelled', childSessionId: 'child-1' }),
      task({ taskId: 'task-2', goal: '任务二', status: 'completed', attemptStatus: 'completed', childSessionId: 'child-2' }),
    ]
    render(<TeamPanel summary={summary({ team: { ...summary().team, status: 'cancelled' }, tasks: terminalTasks })}
      onClose={() => undefined} onOpenChild={async () => true} onArchiveChild={async (teamId, childSessionId) => {
        setChildSessionArchived(teamId, childSessionId, true)
        return true
      }} nowMs={0} />)
    expandTask(/已取消.*任务一.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: '归档子代理会话' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '子代理会话已归档' })).toBeDisabled())
  })

  it('archives a terminal child directly from the task row', async () => {
    render(<TaskRow index={0} teamId="team-1"
      task={task({ goal: '任务一', status: 'completed', attemptStatus: 'completed' })}
      controllerSessionId="controller-1" onOpenChild={async () => true} onArchiveChild={async (teamId, childSessionId) => {
        setChildSessionArchived(teamId, childSessionId, true)
        return true
      }} nowMs={0} />)
    const details = screen.getByRole('button', { name: /已完成.*任务一.*详情/u })
    expect(details).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: '归档子代理：任务一' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '归档子代理：任务一' })).toHaveTextContent('已归档'))
    expect(details).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: '归档子代理：任务一' })).toBeDisabled()
  })

  it('offers a confirmed single-child stop instead of a disabled archive action while running', () => {
    render(<TaskRow index={0} teamId="team-1" task={task({ goal: '运行任务' })}
      controllerSessionId="controller-1" onOpenChild={async () => true} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: '停止子代理：运行任务' }))
    expect(screen.getByRole('alertdialog', { name: '确认停止子代理：运行任务' })).toHaveTextContent('不会取消整个 Team')
    expect(screen.getByRole('button', { name: '确认停止' })).toBeDisabled()
  })

  it('explains that a cancelled Team cannot be cancelled again', () => {
    render(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="cancelled" command={vi.fn(async () => true)} />)
    expect(statusContaining('Team 已取消，无需再次取消。')).toHaveTextContent('Team 已取消，无需再次取消。')
    expect(screen.queryByRole('button', { name: '取消团队' })).not.toBeInTheDocument()
  })

  it('distinguishes user decisions from work retained by the controller', () => {
    const { rerender } = render(dock(summary({ team: { ...summary().team, userDecisionCount: 1, attentionTaskCount: 1 } })))
    expect(screen.getByLabelText('Yuqi Team 状态与操作')).toHaveTextContent('1 需用户决策')
    rerender(dock(summary({ team: { ...summary().team, controllerActionCount: 1, attentionTaskCount: 1 } })))
    expect(screen.getByLabelText('Yuqi Team 状态与操作')).toHaveTextContent('1 待主控处理')
  })

  it('renders task facts without inventing an attempt, scope, verification, usage, or child link', () => {
    const edge = task({
      status: 'failed', attemptStatus: 'failed', attemptOrdinal: undefined, fileScope: [], evidenceRecorded: true,
      verificationStatus: 'failed', childSessionId: undefined,
      usage: {
        state: 'known', uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1,
        totalTokens: 18, label: 'Token：18',
      },
    })
    render(dock(summary({ tasks: [edge] })))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/失败.*实现任务编排.*详情/u)
    const row = screen.getByRole('article')
    expect(row).toHaveTextContent('尚未创建')
    expect(row).toHaveTextContent('未声明')
    expect(row).toHaveTextContent('已记录子代理结算证据')
    expect(row).toHaveTextContent('总计 18 Token')
    expect(row).toHaveTextContent('验证状态失败')
    expect(screen.queryByRole('button', { name: '打开子代理会话 ↗' })).not.toBeInTheDocument()
  })

  it('renders the durable project summary and structured review inside the same panel', () => {
    render(dock({
      ...summary(),
      projectSummary: {
        schemaVersion: 1, overallProgress: '已完成 parent projection 接线',
        architectureDecisions: [{ id: 'source', text: 'Team event stream 是唯一事实源', links: [] }],
        pitfalls: [{ id: 'cache', text: '刷新不能依赖旧缓存', links: [] }],
        conventions: [{ id: 'docs', text: '文档链接使用项目相对路径', links: ['./README.md'] }],
        documentLinks: ['./README.md'], updatedAt: '2026-08-16T00:00:00.000Z',
      },
      review: {
        reviewId: 'review-ui', trigger: 'user-request', reviewerSessionId: 'reviewer-ui', decision: 'changes_required',
        findings: [{ severity: 'high', evidence: ['src/host/harness/team-projection.ts'], impact: '刷新后面板可能为空', recommendation: '保留 durable bridge 回归' }],
        unverified: ['真实 Harness 重启'],
      },
    }))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    openPanelPage('review')
    expect(screen.getByRole('heading', { name: '最新审查结果' })).toBeInTheDocument()
    expect(screen.getByText(/结论：需要修改/u)).toBeVisible()
    expect(screen.getByText('证据：src/host/harness/team-projection.ts')).toBeInTheDocument()
    expect(screen.getByText('刷新后面板可能为空')).toBeInTheDocument()
    expect(screen.getByText('建议：保留 durable bridge 回归')).toBeVisible()
    expect(screen.getByText('真实 Harness 重启')).toBeVisible()
  })

  it.each([
    ['pass', '通过'],
    ['inconclusive', '结论不足'],
  ] as const)('renders a %s review without inventing findings', (_decision, label) => {
    render(<TeamPanel
      summary={{ ...summary(), projectSummary: {
        schemaVersion: 1, overallProgress: '暂无细项', architectureDecisions: [], pitfalls: [], conventions: [], documentLinks: [], updatedAt: '2026-08-16T00:00:00.000Z',
      }, review: {
        reviewId: `review-${_decision}`, trigger: 'user-request', reviewerSessionId: 'reviewer', decision: _decision,
        findings: [], unverified: [],
      } }}
      onClose={vi.fn()} onOpenChild={async () => true}
      nowMs={0}
    />)
    openPanelPage('review')
    expect(screen.getByText(new RegExp(`结论：${label}`, 'u'))).toBeVisible()
    expect(screen.getByText('没有结构化发现项。')).toBeInTheDocument()
  })

  it('requests an independent review through the exact rendered Team identity', async () => {
    const command = vi.fn(async () => true)
    render(<TeamPanel summary={summary({ tasks: [task({ status: 'completed', attemptStatus: 'completed' })] })} onClose={vi.fn()} onOpenChild={async () => true} command={command} nowMs={0} />)
    openPanelPage('review')
    openSection('独立复核（可选）')
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: '检查当前结果' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith(
      expect.stringMatching(/^\/yuqi review user-request team-1 controller-1 [0-9a-z-]+$/u),
      { teamId: 'team-1', controllerSessionId: 'controller-1' },
    ))
    await waitFor(() => expect(statusContaining('独立审查请求已发送')).toHaveTextContent('独立审查请求已发送'))
  })

  it('submits manual notes and a quick template together through the review request', async () => {
    const command = vi.fn(async () => true)
    render(<TeamPanel summary={summary({ tasks: [task({ status: 'completed', attemptStatus: 'completed' })] })} onClose={vi.fn()} onOpenChild={async () => true} command={command} nowMs={0} />)
    openPanelPage('review')
    expect(screen.getByText('自定义检查内容（选填）', { selector: 'summary' }).closest('details')).toHaveAttribute('open')
    const notes = screen.getByRole('textbox', { name: '自定义检查内容' }) as HTMLTextAreaElement
    fireEvent.change(notes, { target: { value: '重点核对中文输入与异常恢复。' } })
    fireEvent.click(screen.getByRole('button', { name: /目标与约束核对/u }))
    expect(notes.value).toContain('重点核对中文输入与异常恢复。')
    expect(notes.value).toContain('对照用户目标')
    fireEvent.click(screen.getByRole('button', { name: '检查当前结果' }))
    await waitFor(() => expect(command).toHaveBeenCalledOnce())
    const callArgs = command.mock.calls[0] as unknown as [string]
    const line = callArgs[0]
    const focus = line.match(/\sfocus:([A-Za-z0-9_-]+)\s/u)?.[1]
    expect(focus).toBeDefined()
    const decoded = Buffer.from(focus!, 'base64url').toString('utf8')
    expect(decoded).toContain('重点核对中文输入与异常恢复。')
    expect(decoded).toContain('对照用户目标')
  })

  it('ignores a stale independent-review response after switching Teams', async () => {
    let settle!: (accepted: boolean) => void
    const command = vi.fn(() => new Promise<boolean>(resolve => { settle = resolve }))
    const eligible = summary({ tasks: [task({ status: 'completed', attemptStatus: 'completed' })] })
    const view = render(<TeamPanel summary={eligible} onClose={vi.fn()} onOpenChild={async () => true} command={command} nowMs={0} />)
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: '检查当前结果' }))
    await waitFor(() => expect(command).toHaveBeenCalledOnce())

    view.rerender(<TeamPanel summary={summary({
      controllerSessionId: 'controller-2',
      team: { ...eligible.team, id: 'team-2' },
      tasks: [task({ taskId: 'task-2', status: 'completed', attemptStatus: 'completed' })],
    })} onClose={vi.fn()} onOpenChild={async () => true} command={command} nowMs={0} />)
    await act(async () => { settle(true) })
    expect(screen.queryByText('独立审查请求已发送；最终以消息流和面板结果为准。')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '检查当前结果' })).toBeEnabled()
  })

  it('sends a free-form follow-up to running children without opening their conversations', async () => {
    const command = vi.fn(async () => true)
    const openChild = vi.fn(async () => true)
    render(<TeamPanel summary={summary()} onClose={vi.fn()} onOpenChild={openChild} command={command} nowMs={0} />)
    fireEvent.change(screen.getByRole('combobox', { name: '补充要求接收方' }), { target: { value: 'all' } })
    fireEvent.change(screen.getByRole('textbox', { name: '补充团队要求内容' }), { target: { value: '完成后只向主控汇报。' } })
    fireEvent.click(screen.getByRole('button', { name: '发送补充要求' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith(
      expect.stringMatching(/^\/yuqi message all [A-Za-z0-9_-]+ [0-9a-z-]+$/u),
      { teamId: 'team-1', controllerSessionId: 'controller-1' },
    ))
    expect(openChild).not.toHaveBeenCalled()
    await waitFor(() => expect(statusContaining('请求记录已保存')).toHaveTextContent('请求记录已保存'))
    expect(screen.getByRole('textbox', { name: '补充团队要求内容' })).toHaveValue('')
  })

  it('keeps an unsent follow-up when the controller rejects it', async () => {
    render(<TeamPanel summary={summary()} onClose={vi.fn()} onOpenChild={async () => true} command={vi.fn(async () => false)} nowMs={0} />)
    const textbox = screen.getByRole('textbox', { name: '补充团队要求内容' })
    fireEvent.change(textbox, { target: { value: '保留这条要求' } })
    fireEvent.click(screen.getByRole('button', { name: '发送补充要求' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('未受理')
    expect(textbox).toHaveValue('保留这条要求')
  })

  it.each(['zh', 'en'] as const)('retains the ordinary instruction region and usable draft after unknown delivery (%s)', async locale => {
    document.documentElement.lang = locale
    const en = locale === 'en'
    const command = vi.fn(async (): Promise<boolean> => { throw new Error('transport unknown') })
    render(<TeamPanel summary={summary()} onClose={vi.fn()} onOpenChild={async () => true} command={command} nowMs={0} />)
    const composer = within(screen.getByRole('region', { name: en ? 'Add Team instruction' : '补充团队要求' }))
    const textbox = composer.getByRole('textbox', { name: en ? 'Team instruction content' : '补充团队要求内容' })
    const send = composer.getByRole('button', { name: en ? 'Send instruction' : '发送补充要求' })
    fireEvent.change(textbox, { target: { value: 'Keep this worker instruction' } })
    fireEvent.click(send)
    expect(await composer.findByRole('alert')).toHaveTextContent(en ? 'Delivery unknown. Check the main conversation' : '投递结果未知，请先核对主控对话')
    expect(textbox).toHaveValue('Keep this worker instruction')
    expect(textbox).toBeDisabled()
    expect(send).toBeDisabled()
    expect(composer.getByText(en ? 'Unresolved worker message request:' : '待核对的子代理消息请求：')).toBeInTheDocument()
    expect(composer.getByRole('button', { name: en ? 'Close this review' : '结束本次核对' })).toBeDisabled()
    expect(composer.queryByRole('button', { name: en ? 'Confirm received; do not resend' : '确认已收到，不重发' })).not.toBeInTheDocument()
    expect(command).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['rejected', async (): Promise<boolean> => false, '独立审查未受理'],
    ['transport failure', async (): Promise<boolean> => { throw new Error('offline') }, '独立审查传输失败'],
  ] as const)('reports a %s independent review request', async (_case, transport, message) => {
    render(<TeamPanel summary={summary({ tasks: [task({ status: 'completed', attemptStatus: 'completed' })] })} onClose={vi.fn()} onOpenChild={async () => true} command={vi.fn(transport)} nowMs={0} />)
    openPanelPage('review')
    openSection('独立复核（可选）')
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: '检查当前结果' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('closes the panel with its close button, backdrop, or Escape', () => {
    render(dock(summary()))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭团队面板' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭团队面板（点击背景）' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('traps keyboard focus inside the Team controller panel', () => {
    render(<TeamPanel summary={summary()} onClose={vi.fn()} onOpenChild={async () => true} nowMs={0} />)
    const panel = screen.getByRole('dialog', { name: 'Yuqi Team 任务面板' })
    const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')].filter(element => {
      if (element.closest('[hidden]')) return false
      for (let parent = element.parentElement; parent !== null && parent !== panel; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false
      }
      return true
    })
    const first = focusable[0]!
    const last = focusable.at(-1)!
    expect(first).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()
  })

  it('opens a bound child session only from its expanded task details', () => {
    const onOpenChild = vi.fn(async () => true)
    render(dock(summary({ controllerSessionId: 'controller-1' }), onOpenChild))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/实现任务编排.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: /打开子代理会话/u }))
    expect(onOpenChild).toHaveBeenCalledWith('controller-1', 'child-1')
  })

  it('keeps durable attempt Token visible when the child Session link is gone', () => {
    const durableUsage = {
      state: 'known' as const, uncachedInputTokens: 10, outputTokens: 3, cacheReadTokens: 4,
      cacheWriteTokens: 2, totalTokens: 19, label: 'Token：19 tok',
    }
    render(dock(summary({ tasks: [task({ childSessionId: undefined, evidenceRecorded: true, usage: durableUsage })] })))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expect(screen.getByText('Token：19')).toBeInTheDocument()
    expandTask(/实现任务编排.*详情/u)
    expect(screen.getByText('总计 19 Token')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /打开子代理会话/u })).not.toBeInTheDocument()
  })

  it('renders durable ended Team and attempt durations without using a live clock', () => {
    const knownTask = task({ duration: { state: 'known', elapsedMs: 2_000 } })
    render(dock(summary({
      tasks: [knownTask],
      team: {
        ...summary().team,
        title: 'Yuqi Team', objective: '用主控协调子代理完成高质量项目', status: 'completed',
        completedTaskCount: 1, runningTaskCount: 0, waitingTaskCount: 0, attentionTaskCount: 0,
        duration: { state: 'known', elapsedMs: 14_000 },
      },
    })))
    expect(screen.getByLabelText('Yuqi Team 状态与操作')).toHaveTextContent('耗时 14 秒')
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    openPanelPage('activity')
    fireEvent.click(screen.getByRole('button', { name: /^(Usage|用量统计)$/ }))
    fireEvent.click(screen.getByText(/^(Usage details|用量详情)$/))
    expect(screen.getByRole('region', { name: '团队用量摘要' })).toHaveTextContent('累计执行')
    expect(screen.getByRole('region', { name: '团队用量摘要' })).toHaveTextContent('14 秒')
    openPanelPage('tasks')
    expect(screen.getByText('耗时：2 秒')).toBeInTheDocument()
  })

  it('refreshes a running duration and cleans up its live clock', () => {
    vi.useFakeTimers()
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-16T00:00:05Z'))
    try {
      render(dock(summary({
        team: {
          ...summary().team,
          title: 'Yuqi Team', objective: '用主控协调子代理完成高质量项目', status: 'running',
          completedTaskCount: 0, runningTaskCount: 1, waitingTaskCount: 0, attentionTaskCount: 0,
          duration: { state: 'running', startedAt: '2026-08-16T00:00:00Z' },
        },
      })))
      expect(screen.getByLabelText('Yuqi Team 状态与操作')).toHaveTextContent('耗时 运行中 5 秒')
      now.mockReturnValue(Date.parse('2026-08-16T00:00:06Z'))
      vi.advanceTimersByTime(1_000)
      cleanup()
      vi.advanceTimersByTime(1_000)
    } finally {
      now.mockRestore()
      vi.useRealTimers()
    }
  })

  it.each([
    ['pending', { state: 'pending', label: 'Token：暂无数据' }],
    ['unavailable', { state: 'unavailable', label: 'Token：提供方未上报' }],
    ['known', {
      state: 'known', uncachedInputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 2,
      totalTokens: 19, label: 'Token：19 tok',
    }],
  ] as const)('shows %s task Token usage after expansion', (_state, usage) => {
    render(dock(summary({ tasks: [task({ usage })] })))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    if (usage.state === 'known') {
      expect(screen.getByText('Token：19')).toBeInTheDocument()
    } else if (usage.state === 'pending') {
      expect(screen.getByText('Token：暂无数据')).toBeInTheDocument()
    } else {
      expect(screen.getByText('Token：不可用')).toBeInTheDocument()
    }
    expandTask(/实现任务编排.*详情/u)
    expect(screen.getByText('Token 用量')).toBeInTheDocument()
    if (usage.state === 'known') {
      expect(screen.getByText('总计 19 Token')).toBeInTheDocument()
      expect(screen.getByText('输入 10')).toBeInTheDocument()
      expect(screen.getByText('输出 3')).toBeInTheDocument()
      expect(screen.getByText('缓存读 4')).toBeInTheDocument()
      expect(screen.getByText('缓存写 2')).toBeInTheDocument()
    } else if (usage.state === 'pending') {
      expect(screen.getByText('尚未产生可用 Token 数据')).toBeInTheDocument()
    } else {
      expect(screen.getByText('提供方未上报 Token')).toBeInTheDocument()
    }
  })

  it('explains pending and unavailable usage without inventing zero tokens', () => {
    const { rerender } = render(dock(summary({ usage: { state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' } })))
    expect(screen.getByLabelText('Yuqi Team 状态与操作')).not.toHaveTextContent('Token：暂无数据')
    expect(screen.getByLabelText('Yuqi Team 状态与操作')).not.toHaveTextContent('已用 0 Token')
    rerender(dock(summary({ usage: { state: 'unavailable', scope: '受管子 Agent', label: '用量：提供方未上报' } })))
    expect(screen.getByLabelText('Yuqi Team 状态与操作')).not.toHaveTextContent('Token：提供方未上报')
    expect(screen.getByLabelText('Yuqi Team 状态与操作')).not.toHaveTextContent('受管子 Agent')
  })

  it('separates created agents from uncreated plans and filters their runtime states', () => {
    const tasks = [
      task({ taskId: 'active', goal: '活动任务' }),
      task({ taskId: 'waiting', goal: '等待任务', status: 'ready', attemptCount: 0, attemptId: undefined, attemptOrdinal: undefined, attemptStatus: undefined, childSessionId: undefined }),
      task({ taskId: 'attention', goal: '异常任务', status: 'failed', attemptStatus: 'failed' }),
      task({ taskId: 'done', goal: '完成任务', status: 'completed', attemptStatus: 'completed', evidenceRecorded: true, childSessionId: undefined }),
    ]
    const { rerender } = render(<TeamPanel summary={summary({ tasks })} onClose={vi.fn()} onOpenChild={async () => true} nowMs={0} />)
    openSection('查找与筛选任务')
    fireEvent.click(screen.getByRole('button', { name: /进行中 1/u }))
    expect(within(screen.getByRole('navigation', { name: /^(Select a task|选择任务)$/ })).getByText('活动任务')).toBeVisible()
    expect(screen.queryByText('等待任务')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /任务计划（未创建会话） 1/u }))
    expect(within(screen.getByRole('navigation', { name: /^(Select a task|选择任务)$/ })).getByText('等待任务')).toBeVisible()
    expect(screen.getByRole('note')).toHaveTextContent('以下是任务计划，不是子代理对话')
    expect(screen.getByRole('article')).toHaveTextContent('任务计划')
    expect(screen.getByRole('article')).toHaveTextContent('尚未创建子代理会话；这只是调度计划')
    expect(screen.getByRole('article')).toHaveTextContent('会话：尚未创建')
    fireEvent.click(screen.getByRole('button', { name: /问题任务 1/u }))
    expect(within(screen.getByRole('navigation', { name: /^(Select a task|选择任务)$/ })).getByText('异常任务')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /已完成 1/u }))
    expect(within(screen.getByRole('navigation', { name: /^(Select a task|选择任务)$/ })).getByText('完成任务')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /已创建会话 3/u }))
    const pickerList = screen.getByRole('navigation', { name: '选择任务' }).querySelector('.yuqi-task-picker-list')
    expect(pickerList).not.toBeNull()
    expect(within(pickerList as HTMLElement).getAllByRole('button')).toHaveLength(3)
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(within(pickerList as HTMLElement).queryByText('等待任务')).not.toBeInTheDocument()

    rerender(<TeamPanel summary={summary({ tasks: [] })} onClose={vi.fn()} onOpenChild={async () => true} nowMs={0} />)
    expect(screen.getByText('尚未创建子代理；可在“任务计划（未创建会话）”查看任务图。')).toBeInTheDocument()
  })

  it('submits one exact stop command only after confirmation', async () => {
    const command = vi.fn(async () => true)
    render(<TaskRow index={0} teamId="team-1" task={task({ goal: '运行任务' })}
      controllerSessionId="controller-1" onOpenChild={async () => true} command={command} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: '停止子代理：运行任务' }))
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.stringMatching(/^\/yuqi stop task-1 /u), {
      teamId: 'team-1', controllerSessionId: 'controller-1',
    }))
    await waitFor(() => expect(statusContaining('其他可运行任务随后继续调度')).toHaveTextContent('其他可运行任务随后继续调度'))
  })

  it.each([
    ['not admitted', async (): Promise<boolean> => false, '停止请求未受理'],
    ['transport failure', async (): Promise<boolean> => { throw new Error('offline') }, '停止请求传输失败'],
  ] as const)('reports a single-child stop %s without claiming completion', async (_label, transport, expected) => {
    const command = vi.fn(async () => transport())
    render(<TaskRow index={0} teamId="team-1" task={task({ goal: '运行任务' })}
      controllerSessionId="controller-1" onOpenChild={async () => true} command={command} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: '停止子代理：运行任务' }))
    fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(expected)
  })

  it('can dismiss a child stop confirmation without sending a command', () => {
    const command = vi.fn(async () => true)
    render(<TaskRow index={0} teamId="team-1" task={task({ goal: '运行任务' })}
      controllerSessionId="controller-1" onOpenChild={async () => true} command={command} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: '停止子代理：运行任务' }))
    fireEvent.click(screen.getByRole('button', { name: '暂不停止' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(command).not.toHaveBeenCalled()
  })

  it('expires an admitted stop when no durable task update arrives', async () => {
    vi.useFakeTimers()
    try {
      const command = vi.fn(async () => true)
      render(<TaskRow index={0} teamId="team-1" task={task({ goal: '运行任务' })}
        controllerSessionId="controller-1" onOpenChild={async () => true} command={command} nowMs={0} />)
      fireEvent.click(screen.getByRole('button', { name: '停止子代理：运行任务' }))
      fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
      await act(async () => { await Promise.resolve() })
      expect(statusContaining('停止请求已提交')).toHaveTextContent('停止请求已提交')
      await vi.advanceTimersByTimeAsync(15_000)
      expect(screen.getByRole('alert')).toHaveTextContent('停止请求尚未出现持久化状态更新')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['accepted', (settle: (value: boolean) => void) => settle(true)],
    ['transport failure', (_settle: (value: boolean) => void, reject: (cause: Error) => void) => reject(new Error('offline'))],
  ] as const)('drops a stale child-stop %s after task identity changes', async (_label, finish) => {
    let settle!: (value: boolean) => void
    let reject!: (cause: Error) => void
    const command = vi.fn<() => Promise<boolean>>(() => new Promise((resolve, rejectPromise) => {
      settle = resolve
      reject = rejectPromise
    }))
    const view = render(<TaskRow index={0} teamId="team-a" task={task()} controllerSessionId="controller-a"
      onOpenChild={async () => true} command={command} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: /停止子代理/u }))
    fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
    view.rerender(<TaskRow index={0} teamId="team-b" task={task({ attemptCount: 2, attemptOrdinal: 2 })} controllerSessionId="controller-b"
      onOpenChild={async () => true} command={command} nowMs={0} />)
    finish(settle, reject)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(queryCommandStatus()).not.toBeInTheDocument()
  })

  it('falls back to a prerequisite count for an older Host projection', () => {
    render(<TaskRow index={1} teamId="team-1" task={task({ dependencies: undefined, dependencyCount: 2 })}
      controllerSessionId="controller-1" onOpenChild={async () => true} nowMs={0} />)
    expect(screen.getByText('前置任务：2 项')).toBeInTheDocument()
  })

  it('shows prerequisite task names instead of an unexplained dependency count', () => {
    render(<TaskRow index={1} teamId="team-1" task={task({
      dependencies: [{ taskId: 'task-0', goal: '先完成设计令牌' }], dependencyCount: 1,
    })} controllerSessionId="controller-1" onOpenChild={async () => true} nowMs={0} />)
    expect(screen.getByText('需等待：task-0「先完成设计令牌」')).toHaveAttribute('title', '前置任务完成后才会调度：先完成设计令牌')
  })

  it('truncates long prerequisite titles while retaining the full explanation', () => {
    const longGoal = '这是一个超过二十四个字符并且不应该挤满整个右侧面板的前置任务名称'
    render(<TaskRow index={1} teamId="team-1" task={task({
      dependencies: [{ taskId: 'task-0', goal: longGoal, index: 1 }], dependencyCount: 1,
    })} controllerSessionId="controller-1" onOpenChild={async () => true} nowMs={0} />)
    expect(screen.getByText(/需等待：任务 1「这是一个超过二十四个字符/)).toHaveAttribute('title', `前置任务完成后才会调度：${longGoal}`)
  })

  it('renders reconciliation explicitly and closes from the backdrop', () => {
    render(<TeamPanel summary={summary({ team: {
      ...summary().team,
      title: 'Yuqi Team', objective: '恢复任务', status: 'needs_reconciliation',
      completedTaskCount: 0, runningTaskCount: 1, waitingTaskCount: 0, attentionTaskCount: 1,
    }, tasks: [task({ attemptStatus: 'unknown' })] })} onClose={vi.fn()} onOpenChild={async () => true} nowMs={0} />)
    expect(screen.getByRole('dialog')).toHaveTextContent('任务状态尚待核实，尚未恢复执行。')
    expect(screen.getByRole('dialog')).toHaveTextContent('无需进入子代理对话')
  })

  it('explains a genuine user-owned decision directly in the main controller', () => {
    const review = task({ status: 'verifying', attemptStatus: 'settled', duration: { state: 'unavailable' } })
    render(<TeamPanel summary={summary({
      team: { ...summary().team, runningTaskCount: 0, attentionTaskCount: 1, userDecisionCount: 1 },
      tasks: [review],
      attention: [{
        owner: 'user', code: 'verification-inconclusive', taskId: review.taskId,
        message: 'Host 无法完成视觉验收，需要你确认是否接受当前结果。',
      }],
    })} onClose={vi.fn()} onOpenChild={async () => true} nowMs={0} />)
    expect(screen.getByText('需要你决定 1 项')).toBeInTheDocument()
    expect(screen.getByText(/Host 无法完成视觉验收/u)).toBeInTheDocument()
    expect(screen.getByText(/请直接在当前主对话回复/u)).toBeInTheDocument()
  })

  it('does not expose an interrupted attempt as a user decision', () => {
    const unknown = task({ status: 'running', attemptStatus: 'unknown', duration: { state: 'unavailable' } })
    render(<TeamPanel summary={summary({
      team: { ...summary().team, status: 'needs_reconciliation', runningTaskCount: 1, attentionTaskCount: 1, userDecisionCount: 0 },
      tasks: [unknown],
      attention: [{
        owner: 'controller', code: 'attempt-outcome-unknown', taskId: unknown.taskId,
        message: '子代理执行被中断；主控正在恢复。',
      }],
    })} onClose={vi.fn()} onOpenChild={async () => true} nowMs={0} />)
    expect(screen.queryByRole('region', { name: '主控待处理事项' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /标记失败|按失败处理|确认任务已取消/u })).not.toBeInTheDocument()
    // Whole-Team cancellation is intentionally available during recovery;
    // it is not a request to fabricate an interrupted attempt's outcome.
    expect(screen.getByRole('button', { name: '取消团队' })).toBeDisabled()
  })

  it('offers fail-closed recovery after every unknown attempt has been resolved', async () => {
    const command = vi.fn<(line: string) => Promise<boolean>>(async () => true)
    render(<TeamPanel summary={summary({ team: {
      ...summary().team, status: 'needs_reconciliation', runningTaskCount: 0, attentionTaskCount: 1, userDecisionCount: 0,
    }, tasks: [task({ status: 'cancelled', attemptStatus: 'cancelled', duration: { state: 'unavailable' } })] })}
      onClose={vi.fn()} onOpenChild={async () => true} command={command} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: '恢复并继续' }))
    expect(command.mock.calls[0]![0]).toMatch(/^\/yuqi recover-continue [0-9a-z-]+$/u)
    await screen.findByText('主控恢复已提交：将安全核对中断现场，只有可恢复工作才会重派；若没有可派发工作，团队会保持暂停，等待任务决策。')
  })

  it('keeps recovery available before a persisted user decision can be handled', async () => {
    const command = vi.fn<(line: string) => Promise<boolean>>(async () => true)
    const gated = Object.assign(summary({ team: {
      ...summary().team, status: 'needs_reconciliation', runningTaskCount: 0,
      attentionTaskCount: 1, userDecisionCount: 1,
    } }), {
      qualityGate: { active: true, phase: 'plan-confirmation', cycle: 0, round: 0, latestDecision: 'inconclusive', awaitingUserReason: 'Review needs a decision' },
    }) as TeamConsoleSummary
    render(<TeamPanel summary={gated} onClose={vi.fn()} onOpenChild={async () => true} command={command} nowMs={0} />)

    expect(screen.getByRole('button', { name: '恢复并继续' })).toBeInTheDocument()
    expect(screen.getByText(/任务状态尚待核实，尚未恢复执行。/u)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '质量门主控' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '主控待处理事项' })).not.toBeInTheDocument()
  })

  it('handles a recovered review decision before offering plan confirmation start actions', () => {
    const gated = Object.assign(summary({ team: {
      ...summary().team, status: 'paused', runningTaskCount: 0,
      attentionTaskCount: 1, userDecisionCount: 1, planConfirmationPending: true,
    } }), {
      qualityGate: { active: true, phase: 'plan-confirmation', cycle: 0, round: 0, latestDecision: 'inconclusive', awaitingUserReason: 'Review needs a decision' },
    }) as TeamConsoleSummary
    render(<TeamPanel summary={gated} onClose={vi.fn()} onOpenChild={async () => true} command={vi.fn(async () => true)} nowMs={0} />)

    openPanelPage('review')
    expect(screen.getByRole('region', { name: '质量门主控' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '开始本次' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '以后直接启动' })).not.toBeInTheDocument()
  })

  it('does not expose plan start actions in the compact dock while a user decision is pending', () => {
    render(dock(summary({ team: {
      ...summary().team, status: 'paused', runningTaskCount: 0,
      attentionTaskCount: 1, userDecisionCount: 1, planConfirmationPending: true,
    } }), vi.fn(async () => true), vi.fn(async () => true)))

    expect(screen.queryByRole('button', { name: '开始本次' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '以后直接启动' })).not.toBeInTheDocument()
  })

  it('keeps unknown-attempt recovery owned by the controller instead of exposing failure adjudication', () => {
    const unknown = task({ status: 'running', attemptStatus: 'unknown', duration: { state: 'unavailable' } })
    render(dock(summary({ team: { ...summary().team, status: 'needs_reconciliation' }, tasks: [unknown] }), vi.fn(async () => true), vi.fn()))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/结果待核验.*实现任务编排.*详情/u)
    expect(screen.getByText(/该任务结果尚未确认/u)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '标记失败' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认已取消' })).not.toBeInTheDocument()
  })

  it('submits the status action once with a request id and does not optimistically change state', async () => {
    const command = vi.fn<(line: string) => Promise<boolean>>(async () => true)
    render(dock(summary({ controllerSessionId: 'controller-once', team: { ...summary().team, id: 'team-once' } }), vi.fn(async () => true), command))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    expect(command).toHaveBeenCalledTimes(1)
    expect(command.mock.calls[0]![0]).toMatch(/^\/yuqi pause team-once controller-once [0-9a-z-]+$/u)
    expect(screen.getByRole('button', { name: '正在暂停…' })).toBeDisabled()
    expect(statusContaining('正在暂停（等待执行收尾）')).toHaveTextContent('正在暂停（等待执行收尾）')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears an admission notice when the durable Team status changes', async () => {
    const command = vi.fn<(line: string) => Promise<boolean>>(async () => true)
    const rendered = render(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="running" command={command} />)
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    await screen.findByText('正在暂停（等待执行收尾）')

    rendered.rerender(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="paused" command={command} />)
    await waitFor(() => expect(screen.queryByText('正在暂停（等待执行收尾）')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument()
  })

  it('requires confirmation before cancelling and surfaces a rejected command', async () => {
    const command = vi.fn<(line: string) => Promise<boolean>>(async () => false)
    render(dock(summary(), vi.fn(async () => true), command))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    fireEvent.click(screen.getByRole('button', { name: '取消团队' }))
    expect(command).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog', { name: '确认取消团队' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认取消团队' }))
    expect(command).toHaveBeenCalledTimes(1)
    expect(command.mock.calls[0]![0]).toMatch(/^\/yuqi cancel team-1 controller-1 [0-9a-z-]+$/u)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('操作未受理：Team team-1')
  })

  it('surfaces an uncertain Team command transport failure', async () => {
    const command = vi.fn<(line: string) => Promise<boolean>>(async () => { throw new Error('offline') })
    render(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="paused" command={command} />)
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('操作传输失败：Team team-1，controller controller-1')
  })

  it('keeps actions read-only when the host command bridge is absent', () => {
    render(dock(summary()))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expect(screen.getByRole('button', { name: '暂停' })).toBeDisabled()
    expect(screen.getAllByText('当前会话仅支持查看，暂不能暂停。').length).toBeGreaterThan(0)
    expect(screen.getAllByText('当前会话仅支持查看，暂不可操作').length).toBeGreaterThan(0)
  })

  it('clears a prior command error when the projection identity changes', async () => {
    const command = vi.fn<(line: string) => Promise<boolean>>(async () => false)
    const terminal = render(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="completed" command={command} />)
    expect(terminal.container).toHaveTextContent('执行已结束，无需暂停。')
    terminal.unmount()

    const active = render(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="running" command={command} />)
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    await screen.findByRole('alert')
    active.rerender(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="completed" command={command} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(active.container).toHaveTextContent('执行已结束，无需暂停。')
  })

  it('does not submit a second command while the first command is pending', () => {
    const command = vi.fn<(line: string) => Promise<boolean>>(() => new Promise(() => undefined))
    render(<TeamControls teamId="team-pending" controllerSessionId="controller-pending" status="running" command={command} />)
    const pause = screen.getByRole('button', { name: '暂停' })
    fireEvent.click(pause)
    fireEvent.click(pause)
    expect(command).toHaveBeenCalledOnce()
  })

  it('does not offer a second pause while the durable state is pausing', () => {
    const command = vi.fn(async () => true)
    render(<TeamControls teamId="team-1" controllerSessionId="controller-1" status="pausing" command={command} />)

    expect(screen.queryByRole('button', { name: '暂停' })).not.toBeInTheDocument()
    expect(statusContaining('正在暂停中')).toHaveTextContent('正在暂停中')
    expect(command).not.toHaveBeenCalled()
  })

  it('does not leak a pending Team command result into a replacement projection', async () => {
    let settle!: (accepted: boolean) => void
    const command = vi.fn<(line: string) => Promise<boolean>>(() => new Promise(resolve => { settle = resolve }))
    const rendered = render(<TeamControls teamId="team-a" controllerSessionId="controller-a" status="running" command={command} />)
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    rendered.rerender(<TeamControls teamId="team-b" controllerSessionId="controller-b" status="running" command={command} />)
    await waitFor(() => expect(screen.getByRole('button', { name: '暂停' })).not.toBeDisabled())
    settle(false)
    await Promise.resolve()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/Team team-a/u)).not.toBeInTheDocument()
  })

  it('retries a failed task with its task id and fresh request id', () => {
    const command = vi.fn<(line: string) => Promise<boolean>>(async () => true)
    const failed = task({ taskId: 'failed-task', status: 'failed', attemptStatus: 'failed' })
    render(dock(summary({ tasks: [failed] }), vi.fn(async () => true), command))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/失败.*实现任务编排.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: '重试任务' }))
    expect(command).toHaveBeenCalledTimes(1)
    expect(command.mock.calls[0]![0]).toMatch(/^\/yuqi retry failed-task [0-9a-z-]+$/u)
  })

  it.each([
    ['rejected', async (): Promise<boolean> => false, '命令未受理，请检查连接后重试。'],
    ['transport failure', async (): Promise<boolean> => { throw new Error('offline') }, '命令传输失败，结果未知；请刷新状态。'],
  ] as const)('shows the current task retry %s', async (label, implementation, message) => {
    const command = vi.fn<(line: string) => Promise<boolean>>(implementation)
    const failed = task({ taskId: 'failed-task', status: 'failed', attemptStatus: 'failed' })
    render(dock(summary({ tasks: [failed] }), vi.fn(async () => true), command))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/失败.*实现任务编排.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: '重试任务' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    // A transport failure leaves the result unknown, so re-submission stays locked;
    // a clear rejection can be retried immediately.
    if (label === 'transport failure') expect(screen.getByRole('button', { name: '重试任务' })).toBeDisabled()
    else expect(screen.getByRole('button', { name: '重试任务' })).not.toBeDisabled()
  })

  it.each(['rejected', 'transport'] as const)('shows the upper inspector child navigation %s failure outside technical details', async (kind) => {
    const open = vi.fn(async () => { if (kind === 'transport') throw new Error('offline'); return false })
    render(dock(summary(), open))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/运行中.*实现任务编排.*详情/u)
    const technical = screen.getByText('技术记录与人工接管', { selector: 'summary' }).closest('details')!
    expect(technical).not.toHaveAttribute('open')
    fireEvent.click(screen.getByRole('button', { name: '查看子代理对话' }))
    await waitFor(() => expect(document.querySelector('.yuqi-inline-error')).toHaveTextContent(kind === 'transport' ? '子代理会话打开失败' : '子代理会话地址尚未就绪'))
    expect(document.querySelector('.yuqi-inline-error')).toBeVisible()
    expect(technical).not.toHaveAttribute('open')
  })

  it('reports a child address that is not ready for the current task', async () => {
    render(dock(summary(), vi.fn(async () => false)))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/运行中.*实现任务编排.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: '查看子代理对话' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('子代理会话地址尚未就绪'))
  })

  it('does not retain a retry result when the Dock switches to another Team with the same task id', async () => {
    let settle!: (accepted: boolean) => void
    const command = vi.fn<(line: string) => Promise<boolean>>(() => new Promise(resolve => { settle = resolve }))
    const failed = task({ taskId: 'shared-task', status: 'failed', attemptStatus: 'failed' })
    const teamA = summary({ tasks: [failed], team: { ...summary().team, id: 'team-a' } })
    const teamB = summary({ controllerSessionId: 'controller-b', tasks: [failed], team: { ...summary().team, id: 'team-b' } })
    const rendered = render(dock(teamA, vi.fn(async () => true), command))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/失败.*实现任务编排.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: '重试任务' }))
    rendered.rerender(dock(teamB, vi.fn(async () => true), command))
    expandTask(/失败.*实现任务编排.*详情/u)
    settle(true)
    await Promise.resolve()
    expect(screen.queryByText('重试请求已提交，等待持久化状态更新。')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试任务' })).not.toBeDisabled()
  })

  it.each([
    ['accepted', (settle: (value: boolean) => void) => settle(true)],
    ['transport rejection', (_settle: (value: boolean) => void, reject: (cause: Error) => void) => reject(new Error('offline'))],
  ] as const)('drops a stale direct TaskRow retry %s after its identity changes', async (_label, finish) => {
    let settle!: (value: boolean) => void
    let reject!: (cause: Error) => void
    const command = vi.fn<() => Promise<boolean>>(() => new Promise((resolve, rejectPromise) => {
      settle = resolve
      reject = rejectPromise
    }))
    const failed = task({ taskId: 'direct-stale', status: 'failed', attemptStatus: 'failed' })
    const rendered = render(<TaskRow index={0} teamId="team-a" task={failed} controllerSessionId="controller-a"
      onOpenChild={async () => true} command={command} nowMs={0} teamStatus="running" />)
    expandTask(/失败.*实现任务编排.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: '重试任务' }))
    rendered.rerender(<TaskRow index={0} teamId="team-b" task={{ ...failed, attemptCount: 2 }} controllerSessionId="controller-b"
      onOpenChild={async () => true} command={command} nowMs={0} teamStatus="running" />)
    finish(settle, reject)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(queryCommandStatus()).not.toBeInTheDocument()
  })

  it('does not leak a rejected retry transport into a replacement Team', async () => {
    let reject!: (cause: Error) => void
    const command = vi.fn<(line: string) => Promise<boolean>>(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise }))
    const failed = task({ taskId: 'shared-task', status: 'failed', attemptStatus: 'failed' })
    const teamA = summary({ tasks: [failed], team: { ...summary().team, id: 'team-a' } })
    const teamB = summary({ controllerSessionId: 'controller-b', tasks: [failed], team: { ...summary().team, id: 'team-b' } })
    const rendered = render(dock(teamA, vi.fn(async () => true), command))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/失败.*实现任务编排.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: '重试任务' }))
    rendered.rerender(dock(teamB, vi.fn(async () => true), command))
    reject(new Error('old transport failed'))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps retry read-only when a command exists without a controller identity', () => {
    const command = vi.fn(async () => true)
    const failed = task({ status: 'failed', attemptStatus: 'failed' })
    const { controllerSessionId: _omitted, ...withoutController } = summary({ tasks: [failed] })
    render(dock(withoutController, vi.fn(async () => true), command))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/失败.*实现任务编排.*详情/u)
    expect(screen.getByRole('button', { name: '重试任务' })).toBeDisabled()
    expect(screen.getByText('当前缺少准确的 Team 主控连接，仅可查看。')).toBeInTheDocument()
  })

  it('does not leak a pending child-open result into a changed task projection', async () => {
    let settle!: (opened: boolean) => void
    const openChild = vi.fn<(_controllerSessionId: string | undefined, _childSessionId: string) => Promise<boolean>>(
      () => new Promise(resolve => { settle = resolve }),
    )
    const initial = summary({ tasks: [task({ status: 'running', attemptStatus: 'running' })] })
    const rendered = render(dock(initial, openChild))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/运行中.*实现任务编排.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: '打开子代理会话 ↗' }))

    const changed = summary({ tasks: [task({ status: 'verifying', attemptStatus: 'running' })] })
    rendered.rerender(dock(changed, openChild))
    settle(false)
    await act(async () => { await Promise.resolve() })

    expect(screen.queryByText(/子代理会话地址尚未就绪/u)).not.toBeInTheDocument()
  })

  it('does not leak a rejected child-open transport into a changed task projection', async () => {
    let reject!: (cause: Error) => void
    const openChild = vi.fn<(_controllerSessionId: string | undefined, _childSessionId: string) => Promise<boolean>>(
      () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise }),
    )
    const initial = summary({ tasks: [task({ status: 'running', attemptStatus: 'running' })] })
    const rendered = render(dock(initial, openChild))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/运行中.*实现任务编排.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: '打开子代理会话 ↗' }))
    rendered.rerender(dock(summary({ tasks: [task({ status: 'verifying', attemptStatus: 'running' })] }), openChild))
    reject(new Error('old transport failed'))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('surfaces a child-open transport failure for the current projection', async () => {
    const openChild = vi.fn(async () => { throw new Error('transport unavailable') })
    render(dock(summary(), openChild))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/运行中.*实现任务编排.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: '查看子代理对话' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('子代理会话打开失败，请稍后刷新。'))
  })

  it('expires a retry admission notice when no durable task update arrives', async () => {
    vi.useFakeTimers()
    try {
      const command = vi.fn<(line: string) => Promise<boolean>>(async () => true)
      const failed = task({ taskId: 'timeout-task', status: 'failed', attemptStatus: 'failed' })
      render(dock(summary({ tasks: [failed] }), vi.fn(async () => true), command))
      fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
      expandTask(/失败.*实现任务编排.*详情/u)
      fireEvent.click(screen.getByRole('button', { name: '重试任务' }))
      await act(async () => { await Promise.resolve() })
      expect(screen.getByText('重试请求已提交，等待持久化状态更新。')).toBeInTheDocument()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(screen.getByRole('alert')).toHaveTextContent('重试请求尚未出现持久化状态更新')
    } finally {
      vi.useRealTimers()
    }
  })

  it('archives a projection-proven terminal controller once without removing child navigation', async () => {
    const archive = vi.fn(async () => true)
    const openChild = vi.fn(async () => true)
    const completedTask = task({ status: 'completed', attemptStatus: 'completed' })
    const terminal = summary({ tasks: [completedTask], team: {
      ...summary().team, status: 'completed', completedTaskCount: 1, runningTaskCount: 0,
    } })
    const view = <YuqiTeamDock {...({
      useProjection: () => terminal,
      onOpenChild: openChild,
      onArchiveController: archive,
    } as unknown as ComponentProps<typeof YuqiTeamDock>)} />
    const rendered = render(view)
    await waitFor(() => expect(archive).toHaveBeenCalledExactlyOnceWith('controller-1'))
    rendered.rerender(view)
    expect(archive).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    expandTask(/已完成.*实现任务编排.*详情/u)
    fireEvent.click(screen.getByRole('button', { name: '打开子代理会话 ↗' }))
    await waitFor(() => expect(openChild).toHaveBeenCalledWith('controller-1', 'child-1'))
  })

  it('retries transient terminal controller archive failures before recording success', async () => {
    const archive = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const terminal = summary({ team: { ...summary().team, status: 'completed' } })
    render(<YuqiTeamDock {...({
      useProjection: () => terminal,
      onOpenChild: async () => true,
      onArchiveController: archive,
    } as unknown as ComponentProps<typeof YuqiTeamDock>)} />)

    await waitFor(() => expect(archive).toHaveBeenCalledTimes(2), { timeout: 2_000 })
    expect(screen.queryByText(/主控会话归档失败/u)).not.toBeInTheDocument()
  })

  it('clears a terminal archive failure when the active Team/controller changes', async () => {
    vi.useFakeTimers()
    try {
      const archive = vi.fn(async () => false)
      const terminal = summary({ team: { ...summary().team, status: 'completed' } })
      const rendered = render(<YuqiTeamDock {...({
        useProjection: () => terminal,
        onOpenChild: async () => true,
        onArchiveController: archive,
      } as unknown as ComponentProps<typeof YuqiTeamDock>)} />)
      await vi.advanceTimersByTimeAsync(1_500)
      expect(screen.getByText(/主控会话归档失败/u)).toBeInTheDocument()

      const replacement = summary({ controllerSessionId: 'controller-b', team: { ...summary().team, id: 'team-b', status: 'running' } })
      rendered.rerender(<YuqiTeamDock {...({
        useProjection: () => replacement,
        onOpenChild: async () => true,
        onArchiveController: archive,
      } as unknown as ComponentProps<typeof YuqiTeamDock>)} />)
      await Promise.resolve()
    expect(screen.queryByText(/主控会话归档失败/u)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears and retries a terminal archive failure when only the Team identity changes', async () => {
    vi.useFakeTimers()
    try {
      const archive = vi.fn(async () => false)
      const terminalA = summary({ team: { ...summary().team, id: 'team-a', status: 'completed' } })
      const rendered = render(<YuqiTeamDock {...({
        useProjection: () => terminalA,
        onOpenChild: async () => true,
        onArchiveController: archive,
      } as unknown as ComponentProps<typeof YuqiTeamDock>)} />)
      await vi.advanceTimersByTimeAsync(1_500)
      expect(screen.getByText(/主控会话归档失败/u)).toBeInTheDocument()
      expect(archive).toHaveBeenCalledTimes(3)

      const terminalB = summary({ team: { ...summary().team, id: 'team-b', status: 'completed' } })
      rendered.rerender(<YuqiTeamDock {...({
        useProjection: () => terminalB,
        onOpenChild: async () => true,
        onArchiveController: archive,
      } as unknown as ComponentProps<typeof YuqiTeamDock>)} />)
    expect(screen.queryByText(/主控会话归档失败/u)).not.toBeInTheDocument()
      await vi.advanceTimersByTimeAsync(1_500)
      expect(archive).toHaveBeenCalledTimes(6)
    expect(screen.getByText(/主控会话归档失败/u)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('TeamPanel branch-complete public flows', () => {
  it('closes on Escape, wraps focus in both directions, and tolerates an empty focus list', () => {
    const onClose = vi.fn()
    const before = document.createElement('button')
    document.body.append(before)
    before.focus()
    const view = render(<TeamPanel summary={summary()} onClose={onClose} onOpenChild={async () => true} nowMs={0} />)
    const panel = screen.getByRole('dialog', { name: 'Yuqi Team 任务面板' })
    const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')].filter(element => {
      if (element.closest('[hidden]')) return false
      for (let parent = element.parentElement; parent !== null && parent !== panel; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false
      }
      return true
    })
    focusable[0]!.focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(focusable.at(-1)).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(focusable[0]).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    view.unmount()
    expect(before).toHaveFocus()
    before.remove()

    const original = HTMLElement.prototype.querySelectorAll
    vi.spyOn(HTMLElement.prototype, 'querySelectorAll').mockImplementation(function (this: HTMLElement, selectors: string) {
      if (this.id === 'yuqi-team-panel' && selectors.includes('button:not(:disabled)')) return [] as unknown as NodeListOf<Element>
      return original.call(this, selectors)
    })
    render(<TeamPanel summary={summary()} onClose={() => undefined} onOpenChild={async () => true} nowMs={0} />)
    expect(() => fireEvent.keyDown(window, { key: 'Tab' })).not.toThrow()
  })

  it('submits all durable checkpoint decisions and respects destructive confirmation', async () => {
    document.documentElement.lang = 'en-US'
    const checkpoint = {
      reviewId: 'checkpoint-review', trigger: 'quality-gate' as const, subject: 'task-attempt' as const,
      phase: 'awaiting-user', candidateEventId: 'candidate-1', round: 2,
      independence: 'model-diverse' as const, nextOwner: 'user' as const,
      automaticRework: {
        checkpointUsed: 0, checkpointLimit: 2, checkpointRemaining: 2,
        teamUsed: 0, teamLimit: 6, teamRemaining: 6, history: [],
      },
    }
    const gated = {
      ...summary({
      review: {
        reviewId: 'checkpoint-review', trigger: 'quality-gate', reviewerSessionId: 'reviewer', decision: 'changes_required',
        findings: [], unverified: [], candidateEventId: 'candidate-1', round: 2, status: 'awaiting_user',
      },
      }),
      reviewCheckpoint: checkpoint,
    } as unknown as TeamConsoleSummary
    const command = vi.fn(async (_value: string) => true)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true)
    render(<TeamPanel summary={gated} onClose={() => undefined} onOpenChild={async () => true} command={command} nowMs={0} />)
    openPanelPage('review')
    const gate = within(screen.getByRole('region', { name: 'Quality gate control' }))

    expect(screen.getByText('Task attempt')).toBeInTheDocument()
    expect(screen.getByText('No automatic rework has been created.')).toBeInTheDocument()
    fireEvent.click(gate.getByRole('button', { name: 'Fail Team' }))
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(gate.getByRole('button', { name: 'Fail Team' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(command.mock.calls[0]![0]).toContain('/yuqi review-decision fail checkpoint-review candidate-1 2 - team-1 controller-1')

    fireEvent.click(gate.getByRole('button', { name: 'Cancel Team' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    expect(command.mock.calls[1]![0]).toContain('/yuqi cancel team-1 controller-1')

    fireEvent.click(gate.getByRole('button', { name: 'Accept risk…' }))
    fireEvent.change(gate.getByRole('textbox', { name: 'Waiver reason (required)' }), { target: { value: ' bounded risk ' } })
    fireEvent.click(gate.getByRole('button', { name: 'Waive with reason' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(3))
    expect(command.mock.calls[2]![0]).toMatch(/^\/yuqi review-decision waive checkpoint-review candidate-1 2 [A-Za-z0-9_-]+ team-1 controller-1/u)
    expect(confirm).toHaveBeenCalledTimes(3)
  })

  it('reports rejected and failed durable checkpoint decisions without optimistic state', async () => {
    document.documentElement.lang = 'en-US'
    const checkpoint = {
      reviewId: 'checkpoint-errors', trigger: 'quality-gate' as const, subject: 'failure-escalation' as const,
      phase: 'awaiting-user', candidateEventId: 'candidate-errors', round: 0,
      independence: 'same-model' as const, nextOwner: 'user' as const,
      automaticRework: {
        checkpointUsed: 1, checkpointLimit: 1, checkpointRemaining: 0,
        teamUsed: 1, teamLimit: 1, teamRemaining: 0,
        history: [{ taskId: 'rework', sourceReviewId: 'source', round: 1, status: 'failed' as const }],
      },
    }
    const gated = {
      ...summary({
      review: {
        reviewId: 'checkpoint-errors', trigger: 'quality-gate', reviewerSessionId: 'reviewer', decision: 'inconclusive',
        findings: [], unverified: ['missing'], candidateEventId: 'candidate-errors', round: 0, status: 'awaiting_user',
      },
      }),
      reviewCheckpoint: checkpoint,
    } as unknown as TeamConsoleSummary
    const rejected = vi.fn(async () => false)
    const view = render(<TeamPanel summary={gated} onClose={() => undefined} onOpenChild={async () => true} command={rejected} nowMs={0} />)
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: 'Re-review' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('controller rejected this decision')

    const failed = vi.fn(async (): Promise<boolean> => { throw new Error('offline') })
    view.rerender(<TeamPanel summary={{ ...gated, reviewCheckpoint: { ...checkpoint, round: 1 } } as unknown as TeamConsoleSummary} onClose={() => undefined} onOpenChild={async () => true} command={failed} nowMs={0} />)
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: 'Accept risk…' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Waiver reason (required)' }), { target: { value: 'risk' } })
    fireEvent.click(screen.getByRole('button', { name: 'Waive with reason' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('decision could not reach the controller')
  })

  it('localizes rejected and failed review actions in Chinese without optimistic state', async () => {
    const checkpoint = {
      reviewId: 'checkpoint-zh-errors', trigger: 'quality-gate' as const, subject: 'team-plan' as const,
      phase: 'awaiting-user', candidateEventId: 'candidate-zh-errors', round: 1,
      independence: 'model-diverse' as const, nextOwner: 'user' as const,
      automaticRework: {
        checkpointUsed: 0, checkpointLimit: 1, checkpointRemaining: 1,
        teamUsed: 0, teamLimit: 3, teamRemaining: 3, history: [],
      },
    }
    const gated = {
      ...summary({
        review: {
          reviewId: 'checkpoint-zh-errors', trigger: 'quality-gate', reviewerSessionId: 'reviewer-zh-errors',
          decision: 'inconclusive', findings: [], unverified: ['缺少证据'], candidateEventId: 'candidate-zh-errors',
          round: 1, status: 'awaiting_user',
        },
      }),
      reviewCheckpoint: checkpoint,
    } as TeamConsoleSummary
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    confirm.mockClear()
    const rejected = vi.fn(async () => false)
    const view = render(<TeamPanel summary={gated} onClose={() => undefined} onOpenChild={async () => true}
      command={rejected} nowMs={0} />)
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: '标记失败' }))
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: '取消 Team' }))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(rejected).not.toHaveBeenCalled()

    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: '重新审查' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('主控未受理此决定')

    const transportFailure = vi.fn(async (): Promise<boolean> => { throw new Error('offline') })
    view.rerender(<TeamPanel summary={{ ...gated, reviewCheckpoint: { ...checkpoint, round: 2 } } as TeamConsoleSummary}
      onClose={() => undefined} onOpenChild={async () => true} command={transportFailure} nowMs={0} />)
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: '接受风险…' }))
    fireEvent.change(screen.getByRole('textbox', { name: '豁免原因（必填）' }), { target: { value: '已知且可接受的风险' } })
    fireEvent.click(screen.getByRole('button', { name: '填写原因并豁免' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('决定未能送达主控')

    const legacy = summary({
      review: {
        reviewId: 'legacy-zh-errors', trigger: 'quality-gate', reviewerSessionId: 'legacy-reviewer',
        decision: 'inconclusive', findings: [], unverified: ['旧格式'],
      },
    })
    view.rerender(<TeamPanel summary={legacy} onClose={() => undefined} onOpenChild={async () => true}
      command={rejected} nowMs={0} />)
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: '再次请求独立审查' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('主控未受理审查请求')
  })

  it('renders and accepts the complete Chinese checkpoint vocabulary and rework history', async () => {
    const checkpoint = {
      reviewId: 'checkpoint-zh', trigger: 'quality-gate' as const, subject: 'team-plan' as const,
      phase: 'awaiting-user', candidateEventId: 'candidate-zh', round: 3,
      independence: 'model-diverse' as const, nextOwner: 'user' as const,
      automaticRework: {
        checkpointUsed: 1, checkpointLimit: 2, checkpointRemaining: 1,
        teamUsed: 2, teamLimit: 6, teamRemaining: 4,
        history: [{ taskId: 'rework-zh', sourceReviewId: 'source-zh', round: 1, status: 'completed' as const }],
      },
    }
    const gated = {
      ...summary({
        review: {
          reviewId: 'checkpoint-zh', trigger: 'quality-gate', reviewerSessionId: 'reviewer-zh', decision: 'inconclusive',
          findings: [], unverified: ['缺少证据'], candidateEventId: 'candidate-zh', round: 3, status: 'awaiting_user',
        },
      }),
      reviewCheckpoint: checkpoint,
    } as TeamConsoleSummary
    const command = vi.fn(async () => true)
    render(<TeamPanel summary={gated} onClose={() => undefined} onOpenChild={async () => true} command={command} nowMs={0} />)
    openPanelPage('review')
    const gate = within(screen.getByRole('region', { name: '质量门主控' }))
    expect(gate.getByText('Team 计划')).toBeInTheDocument()
    expect(gate.getByText('用户')).toBeInTheDocument()
    expect(gate.getByText(/rework-zh/u)).toBeInTheDocument()
    fireEvent.click(gate.getByRole('button', { name: '重新审查' }))
    expect(await gate.findByRole('status')).toHaveTextContent('决定请求已发送，尚未确认结果')
  })

  it('renders a planned task without controller ownership using fallback key facts', () => {
    const planned = task({
      status: 'ready', attemptCount: 0, attemptId: undefined, attemptOrdinal: undefined,
      attemptStatus: undefined, childSessionId: undefined, evidenceRecorded: false,
    })
    render(<TeamPanel summary={summary({ controllerSessionId: undefined, tasks: [planned] })}
      onClose={() => undefined} onOpenChild={async () => true} nowMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: /任务计划（未创建会话）/u }))
    expect(screen.getByText(/^以下是任务计划，不是子代理对话/u)).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: /^(Select a task|选择任务)$/ })).getByText('实现任务编排')).toBeVisible()
  })

  it('derives every quality-gate phase and Host verification state from public summary facts', () => {
    document.documentElement.lang = 'en-US'
    const onClose = vi.fn()
    const initial = Object.assign(summary({
      controllerSessionId: undefined,
      tasks: [task({ verificationStatus: 'pending' })],
    }), { qualityGate: { active: true, phase: 'custom-phase', cycle: -1, round: 1.5, latestDecision: 'unknown', hostVerification: { status: 'pending' }, awaitingUserReason: 'Need evidence' } })
    const view = render(<TeamPanel summary={initial} onClose={onClose} onOpenChild={async () => true} nowMs={0} />)

    openPanelPage('review')
    expect(screen.getByRole('region', { name: 'Quality gate control' })).toHaveTextContent('custom-phase')
    expect(screen.getByLabelText('Quality gate control')).toHaveTextContent('Pending')
    expect(screen.queryByText('This panel is view-only.')).not.toBeInTheDocument()
    expect(screen.getByText('This conversation is view-only.')).toBeInTheDocument()
    const cases = [
      { value: Object.assign(summary({ team: { ...summary().team, status: 'completed' }, tasks: [task({ status: 'completed', verificationStatus: 'passed' })] }), { qualityGate: { active: true } }), phase: 'Complete', verification: 'Passed' },
      { value: summary({ review: { reviewId: 'pass', trigger: 'quality-gate', reviewerSessionId: 'reviewer-pass', decision: 'pass', findings: [], unverified: [] }, tasks: [task({ verificationStatus: 'running' })] }), phase: 'Passed', verification: 'Running' },
      { value: summary({ review: { reviewId: 'inc', trigger: 'quality-gate', reviewerSessionId: 'reviewer-inc', decision: 'inconclusive', findings: [], unverified: ['missing proof'] }, tasks: [task({ verificationStatus: 'failed' })] }), phase: 'Your decision needed', verification: 'Failed' },
      { value: summary({ review: { reviewId: 'rework', trigger: 'quality-gate', reviewerSessionId: 'reviewer-rework', decision: 'changes_required', findings: [], unverified: [] }, tasks: [task({ verificationStatus: undefined })] }), phase: 'Rework', verification: 'No verification evidence' },
      { value: Object.assign(summary({ tasks: [task({ status: 'verifying' })] }), { qualityGate: { active: true } }), phase: 'Host verification', verification: 'No verification evidence' },
      { value: Object.assign(summary({ tasks: [task({ status: 'completed', verificationStatus: undefined })] }), { qualityGate: { active: true } }), phase: 'Review pending', verification: 'No verification evidence' },
    ]
    for (const item of cases) {
      view.rerender(<TeamPanel summary={item.value} onClose={onClose} onOpenChild={async () => true} nowMs={0} />)
      openPanelPage('review')
      expect(screen.getByLabelText('Quality gate control')).toHaveTextContent(item.phase)
      expect(screen.getByLabelText('Quality gate control')).toHaveTextContent(item.verification)
    }
  })

  it('submits successful quality-gate and optional review requests from the controller panel', async () => {
    document.documentElement.lang = 'en-US'
    const command = vi.fn(async () => true)
    const gateSummary = summary({
      review: { reviewId: 'review-1', trigger: 'quality-gate', reviewerSessionId: 'reviewer-1', decision: 'inconclusive', findings: [], unverified: ['missing proof'] },
    })
    const view = render(<TeamPanel summary={gateSummary} onClose={() => undefined} onOpenChild={async () => true} command={command} nowMs={0} />)
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: 'Request another review' }))
    await waitFor(() => expect(statusContaining('Review request sent, not yet confirmed')).toHaveTextContent('Review request sent, not yet confirmed'))

    view.rerender(<TeamPanel summary={summary({ tasks: [task({ status: 'completed', attemptStatus: 'completed' })] })} onClose={() => undefined} onOpenChild={async () => true} command={command} nowMs={0} />)
    openPanelPage('review')
    openSection('Independent review (optional)')
    openPanelPage('review')
    fireEvent.click(screen.getByRole('button', { name: 'Check current results' }))
    await waitFor(() => expect(statusContaining('Independent review submitted')).toHaveTextContent('Independent review submitted'))
    expect(command).toHaveBeenCalledTimes(2)
  })

  it('renders complete project handoff content, review evidence, and Git workspace facts', () => {
    document.documentElement.lang = 'en-US'
    render(<TeamPanel summary={summary({
      team: { ...summary().team, workspaceMode: 'git-worktree' },
      projectSummary: {
        schemaVersion: 1,
        overallProgress: 'Ready to hand off',
        architectureDecisions: [{ id: 'a', text: 'One controller', links: ['docs/a.md'] }],
        pitfalls: [{ id: 'p', text: 'Avoid stale facts', links: [] }],
        conventions: [{ id: 'c', text: 'Durable events', links: [] }],
        documentLinks: ['https://example.com/guide'], updatedAt: '2026-08-31T00:00:00Z',
      },
      review: {
        reviewId: 'review-2', trigger: 'manual', reviewerSessionId: 'reviewer-2', decision: 'pass',
        findings: [{ severity: 'low', evidence: ['test'], impact: 'none', recommendation: 'ship' }],
        unverified: ['mobile'],
      },
    })} onClose={() => undefined} onOpenChild={async () => true} nowMs={0} />)

    openPanelPage('activity')
    openSection('Project summary')
    expect(screen.getByText('Ready to hand off')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://example.com/guide' })).toBeInTheDocument()
    openPanelPage('review')
    openSection('Independent review (optional)')
    expect(screen.getByText(/Decision: Pass/u)).toBeVisible()
    expect(screen.getByText(/Evidence.*test/u)).toBeInTheDocument()
    expect(screen.getByText('mobile')).toBeVisible()
  })
})

describe('status language', () => {
  it('maps the complete English Team and task state vocabulary', () => {
    const teamStates = ['draft', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'completed', 'failed', 'needs_reconciliation'] as const
    expect(teamStates.map(state => teamStatusMeta(state, 'en').label)).toEqual([
      'Draft', 'Running', 'Pausing', 'Paused', 'Cancelling', 'Cancelled', 'Completed', 'Failed', 'Safety check needed',
    ])
    expect([
      taskStatusMeta(task({ attemptStatus: 'unknown' }), 'en').label,
      taskStatusMeta(task({ status: 'running' }), 'en').label,
      taskStatusMeta(task({ status: 'verifying' }), 'en').label,
      taskStatusMeta(task({ status: 'completed' }), 'en').label,
      taskStatusMeta(task({ status: 'failed' }), 'en').label,
      taskStatusMeta(task({ status: 'blocked' }), 'en').label,
      taskStatusMeta(task({ status: 'cancelled' }), 'en').label,
      taskStatusMeta(task({ status: 'ready', attemptStatus: undefined }), 'en').label,
      taskStatusMeta(task({ status: 'pending', attemptStatus: undefined }), 'en').label,
    ]).toEqual(['Result unverified', 'Running', 'Verifying', 'Completed', 'Failed', 'Blocked', 'Cancelled', 'Awaiting dispatch', 'Not started'])
  })

  it('maps every Team state to text, icon, and tone', () => {
    const states = ['draft', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'completed', 'failed', 'needs_reconciliation'] as const
    expect(states.map(state => teamStatusMeta(state).label)).toEqual([
      '草稿', '运行中', '暂停中', '已暂停', '取消中', '已取消', '已完成', '失败', '待安全核对',
    ])
  })

  it('maps all task presentation branches and attention rules', () => {
    expect(taskStatusMeta(task({ attemptStatus: 'unknown' })).label).toBe('结果待核验')
    expect(taskStatusMeta(task({ status: 'verifying' })).label).toBe('验证中')
    expect(taskStatusMeta(task({ status: 'completed' })).label).toBe('已完成')
    expect(taskStatusMeta(task({ status: 'failed' })).label).toBe('失败')
    expect(taskStatusMeta(task({ status: 'blocked' })).label).toBe('阻塞')
    expect(taskStatusMeta(task({ status: 'cancelled' })).label).toBe('已取消')
    expect(taskStatusMeta(task({ status: 'ready', attemptStatus: undefined })).label).toBe('等待派发')
    expect(taskStatusMeta(task({ status: 'pending', attemptStatus: undefined })).label).toBe('未开始')
    expect(taskNeedsAttention(task({ status: 'blocked' }))).toBe(true)
    expect(taskNeedsAttention(task({ status: 'running' }))).toBe(false)
    expect(taskNeedsAttention(task({ status: 'blocked' }), 'paused')).toBe(false)
    expect(taskNeedsAttention(task({ status: 'blocked' }), 'pausing')).toBe(false)
    expect(taskNeedsAttention(task({ status: 'blocked', taskOutcome: { status: 'reported', outcome: { version: 1, kind: 'blocked', summary: 's', nextAction: 'n' } } }), 'paused')).toBe(true)
    expect(taskNeedsAttention(task({ status: 'blocked' }), 'running')).toBe(true)
    expect(taskStatusMeta(task({ status: 'blocked' }), 'zh', 'paused').label).toBe('已暂停')
    expect(taskStatusMeta(task({ status: 'blocked' }), 'zh', 'running').label).toBe('阻塞')
  })

  it('fails closed for an invalid active duration timestamp', () => {
    expect(presentDuration({ state: 'running', startedAt: 'not-a-date' }, Date.now())).toMatchObject({ stateLabel: '不可用' })
  })
})
