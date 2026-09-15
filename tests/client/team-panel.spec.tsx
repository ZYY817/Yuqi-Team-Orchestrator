// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamPanel } from '../../src/client/TeamPanel.tsx'
import { YuqiCommandOutcomeError } from '../../src/client/command-outcome.ts'
import { teamStatusMeta } from '../../src/client/status.ts'
import type { TeamConsoleSummary, TeamConsoleTask } from '../../src/domain/team-console-contract.ts'

const summary: TeamConsoleSummary = {
  controllerSessionId: 'controller-1',
  team: {
    id: 'team-1', title: 'Reviewed Team', objective: 'Ship safely', status: 'running', completedTaskCount: 1,
    runningTaskCount: 0, waitingTaskCount: 0, attentionTaskCount: 1, userDecisionCount: 1, controllerActionCount: 0,
    duration: { state: 'known', elapsedMs: 1_000 },
  },
  tasks: [],
  attention: [{ owner: 'user', code: 'verification-inconclusive', taskId: 'team-1', message: 'Review needs a decision.' }],
  usage: { state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' },
  review: {
    reviewId: 'review-1', trigger: 'quality-gate', reviewerSessionId: 'reviewer-1', decision: 'inconclusive',
    findings: [{ severity: 'high', evidence: ['src/a.ts:10'], impact: 'Unsafe release', recommendation: 'Add verification' }],
    unverified: ['Release proof'], candidateEventId: 'event-16', round: 1, status: 'awaiting_user',
  },
  reviewCheckpoint: {
    reviewId: 'review-1', trigger: 'quality-gate', subject: 'team-completion', phase: 'awaiting-controller',
    candidateEventId: 'event-16', round: 1, independence: 'model-diverse', nextOwner: 'user',
    automaticRework: {
      checkpointUsed: 1, checkpointLimit: 2, checkpointRemaining: 1, teamUsed: 2, teamLimit: 6, teamRemaining: 4,
      history: [{ taskId: 'review-rework-1', sourceReviewId: 'review-0', round: 1, status: 'completed' }],
    },
  },
}

afterEach(() => {
  cleanup()
  document.documentElement.lang = ''
  vi.restoreAllMocks()
})

function openReviewPage(locale: 'en' | 'zh' = 'en') {
  const navigation = screen.getByRole('navigation', { name: locale === 'en' ? 'Team pages' : '团队页面' })
  const button = within(navigation).getByRole('button', { name: locale === 'en' ? /^Review & decisions/u : /^审查与确认/u })
  fireEvent.click(button)
  expect(button).toHaveAttribute('aria-pressed', 'true')
}

describe('TeamPanel review checkpoint', () => {
  it.each(['zh-CN', 'en'])('preserves drafts across worker gates and terminal view-only continuation (%s)', async locale => {
    document.documentElement.lang = locale
    const en = locale === 'en'
    const command = vi.fn(async () => true)
    const runningTask: TeamConsoleTask = {
      taskId: 'message-worker', goal: 'Keep working', status: 'running', childSessionId: 'message-child',
      modelRole: 'worker', model: 'model', authorityMode: 'read-only', dependencyCount: 0,
      dependencies: [], fileScope: [], attemptCount: 1, evidenceRecorded: false,
      usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '',
    }
    const renderPanel = (status: TeamConsoleSummary['team']['status'], cancellationRequested = false) => (
      <TeamPanel summary={{ ...summary, team: { ...summary.team, status, cancellationRequested }, tasks: [runningTask] }}
        onClose={() => undefined} onOpenChild={async () => true} command={command} nowMs={0} />
    )
    const view = render(renderPanel('running'))
    const recipient = screen.getByRole('combobox', { name: en ? 'Instruction recipient' : '补充要求接收方' })
    const textbox = screen.getByRole('textbox', { name: en ? 'Team instruction content' : '补充团队要求内容' })
    const send = screen.getByRole('button', { name: en ? 'Send instruction' : '发送补充要求' })
    fireEvent.change(recipient, { target: { value: 'message-worker' } })
    fireEvent.change(textbox, { target: { value: 'Keep this draft' } })
    expect(send).toBeEnabled()
    for (const status of ['pausing', 'cancelling', 'paused', 'needs_reconciliation', 'completed', 'failed', 'cancelled', 'draft', 'running'] as const) {
      // Even a lagging running projection must obey an explicit cancellation intent.
      const cancellationRequested = status === 'running'
      view.rerender(renderPanel(status, cancellationRequested))
      const terminal = ['completed', 'failed', 'cancelled'].includes(status)
      const statusLabel = teamStatusMeta(status, en ? 'en' : 'zh').label
      const reason = cancellationRequested
        ? (en ? 'Stop has been requested; instructions are disabled. Your draft is preserved.' : '已请求停止，暂不可发送补充要求；草稿已保留。')
        : (en ? `Instructions require a running Team (state: ${statusLabel}). Your draft is preserved.` : `仅运行中的团队可接收补充要求（状态：${statusLabel}）；草稿已保留。`)
      if (terminal) {
        expect(screen.getByText(en ? 'This panel is view-only and cannot forward instructions to the controller.' : '当前面板仅支持查看，无法向主控转发要求。')).toBeInTheDocument()
        expect(screen.queryByText(reason)).not.toBeInTheDocument()
      } else {
        expect(screen.getByText(reason)).toHaveAttribute('role', 'status')
        if (!cancellationRequested) expect(screen.getByText(reason)).not.toHaveTextContent(en ? `(state: ${status})` : `（状态：${status}）`)
      }
      for (const control of [textbox, send]) {
        expect(control).toBeDisabled()
        if (terminal) expect(control).not.toHaveAttribute('aria-describedby')
        else expect(control).toHaveAccessibleDescription(reason)
      }
      if (terminal || status === 'paused') expect(recipient).toBeEnabled()
      else expect(recipient).toBeDisabled()
      fireEvent.click(send)
      expect(command).not.toHaveBeenCalled()
      expect(textbox).toHaveValue('Keep this draft')
      expect(recipient).toHaveValue(terminal ? 'all' : 'message-worker')
    }
    view.rerender(renderPanel('running'))
    for (const control of [recipient, textbox, send]) expect(control).toBeEnabled()
    expect(textbox).toHaveValue('Keep this draft')
    expect(recipient).toHaveValue('message-worker')
    fireEvent.click(send)
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(textbox).toHaveValue(''))
    for (const status of ['pausing', 'cancelling', 'paused', 'needs_reconciliation', 'completed', 'failed', 'cancelled', 'draft', 'running'] as const) {
      view.rerender(renderPanel(status, status === 'running'))
      expect(textbox).toBeDisabled()
      expect(textbox).toHaveValue('')
      expect(screen.queryByText(en ? /Your draft is preserved/u : /草稿已保留/u)).not.toBeInTheDocument()
      const reason = status === 'running'
        ? (en ? 'Stop has been requested; instructions are disabled.' : '已请求停止，暂不可发送补充要求。')
        : (en ? `Instructions require a running Team (state: ${teamStatusMeta(status, 'en').label}).` : `仅运行中的团队可接收补充要求（状态：${teamStatusMeta(status, 'zh').label}）。`)
      if (['completed', 'failed', 'cancelled'].includes(status)) {
        expect(screen.getByText(en ? 'This panel is view-only and cannot forward instructions to the controller.' : '当前面板仅支持查看，无法向主控转发要求。')).toBeInTheDocument()
        for (const control of [recipient, textbox, send]) expect(control).not.toHaveAttribute('aria-describedby')
        expect(recipient).toBeEnabled()
      } else {
        for (const control of [recipient, textbox, send]) expect(control).toHaveAccessibleDescription(reason)
      }
    }
  })

  it.each(['created', 'planned'] as const)('locates a %s task from the activity page and supports repeat navigation', async kind => {
    document.documentElement.lang = 'en'
    const task: TeamConsoleTask = {
      taskId: 'task-"exact"', goal: 'Locate this task', status: 'pending', modelRole: 'worker', model: 'model',
      authorityMode: 'read-only', dependencyCount: 0, dependencies: [], fileScope: [], attemptCount: kind === 'created' ? 1 : 0,
      evidenceRecorded: false, usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '',
      ...(kind === 'created' ? { childSessionId: 'child-1', attemptOrdinal: 1 } : {}),
    }
    const scroll = vi.fn()
    const prior = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
    try {
      render(<TeamPanel summary={{ ...summary, tasks: [task] }} onClose={() => undefined} onOpenChild={async () => true} nowMs={0} />)
      const navigation = screen.getByRole('navigation', { name: 'Team pages' })
      const activityPage = within(navigation).getByRole('button', { name: 'Progress & evidence' })
      const tasksPage = within(navigation).getByRole('button', { name: 'Tasks' })
      expect(activityPage).toHaveAttribute('aria-pressed', 'false')
      expect(tasksPage).toHaveAttribute('aria-pressed', 'true')
      expect(screen.queryByRole('region', { name: 'Team activity' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByText('Filter').closest('summary')!)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        fireEvent.click(screen.getByRole('button', { name: /^Completed /u }))
        fireEvent.click(activityPage)
        expect(activityPage).toHaveAttribute('aria-pressed', 'true')
        expect(tasksPage).toHaveAttribute('aria-pressed', 'false')
        const node = await screen.findByRole('button', { name: `Locate task ${task.taskId}: ${task.goal}` })
        fireEvent.click(node)
        const row = screen.getByRole('article', { name: task.goal })
        await waitFor(() => expect(row).toHaveFocus())
        expect(row).toHaveAttribute('data-yuqi-task-id', task.taskId)
        expect(activityPage).toHaveAttribute('aria-pressed', 'false')
        expect(tasksPage).toHaveAttribute('aria-pressed', 'true')
        expect(screen.queryByRole('region', { name: 'Team activity' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: kind === 'created' ? /^Created conversations /u : /^Task plans \(no conversation\) /u })).toHaveAttribute('aria-pressed', 'true')
        expect(scroll).toHaveBeenCalledTimes(attempt + 1)
        expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest', behavior: 'auto' })
      }
    } finally {
      if (prior) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', prior)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }
  })

  it.each(['team', 'controller', 'review', 'round', 'status'] as const)('ignores a stale failure and finally after %s changes', async identity => {
    document.documentElement.lang = 'en'
    let rejectOld!: (error: Error) => void
    let finishNew!: (result: boolean) => void
    const command = vi.fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
    const props = { onClose: () => undefined, onOpenChild: async () => true, command, nowMs: 0 }
    const view = render(<TeamPanel summary={summary} {...props} />)
    openReviewPage()
    fireEvent.click(screen.getByRole('button', { name: 'Re-review' }))
    const next: TeamConsoleSummary = {
      ...summary,
      controllerSessionId: identity === 'controller' ? 'controller-2' : summary.controllerSessionId,
      team: { ...summary.team, id: identity === 'team' ? 'team-2' : summary.team.id, status: identity === 'status' ? 'paused' : summary.team.status },
      reviewCheckpoint: { ...summary.reviewCheckpoint!, reviewId: identity === 'review' ? 'review-2' : 'review-1', round: identity === 'round' ? 2 : 1 },
    }
    view.rerender(<TeamPanel summary={next} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Re-review' }))
    await act(async () => { rejectOld(new YuqiCommandOutcomeError('rejected', 'Obsolete failure')) })
    expect(screen.queryByText('Obsolete failure')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled()
    await act(async () => { finishNew(true) })
    expect(screen.getByRole('button', { name: 'Re-review' })).toBeEnabled()
  })

  it('does not show success from an old projection', async () => {
    document.documentElement.lang = 'en'
    let finish!: (value: boolean) => void
    const command = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const props = { onClose: () => undefined, onOpenChild: async () => true, command, nowMs: 0 }
    const view = render(<TeamPanel summary={summary} {...props} />)
    openReviewPage()
    fireEvent.click(screen.getByRole('button', { name: 'Re-review' }))
    view.rerender(<TeamPanel summary={{ ...summary, controllerSessionId: 'new-controller' }} {...props} />)
    await act(async () => { finish(true) })
    expect(screen.queryByText(/Decision request sent/u)).not.toBeInTheDocument()
  })

  it.each(['rejected', 'unknown'] as const)('preserves %s command outcomes across review and cancel entries', async disposition => {
    document.documentElement.lang = 'en'
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const message = disposition === 'rejected' ? 'Host refused: review checkpoint changed.' : 'Request sent; outcome unknown. Do not resubmit.'
    const command = vi.fn(async (): Promise<boolean> => { throw new YuqiCommandOutcomeError(disposition, message) })
    const props = { onClose: () => undefined, onOpenChild: async () => true, command, nowMs: 0 }
    const view = render(<TeamPanel summary={summary} {...props} />)
    openReviewPage()
    fireEvent.click(screen.getByRole('button', { name: 'Re-review' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    fireEvent.click(within(screen.getByRole('region', { name: 'Quality gate control' })).getByRole('button', { name: 'Cancel Team' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)

    const { reviewCheckpoint: _checkpoint, ...withoutCheckpoint } = summary
    const { candidateEventId: _candidate, round: _round, ...legacyReview } = summary.review!
    view.rerender(<TeamPanel summary={{ ...withoutCheckpoint, review: legacyReview }} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Request another review' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(3))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)

    const { review: _review, ...beforeIndependentReview } = withoutCheckpoint
    view.rerender(<TeamPanel summary={beforeIndependentReview} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check current results' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(4))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('shows structured checkpoint facts and submits reasoned review decisions', async () => {
    document.documentElement.lang = 'en'
    const command = vi.fn(async (_line: string) => true)
    render(<TeamPanel summary={summary} onClose={() => undefined} onOpenChild={async () => true} command={command} nowMs={0} />)
    openReviewPage()

    const gate = screen.getByRole('region', { name: 'Quality gate control' })
    expect(within(gate).getByText('Recommended handling')).toBeVisible()
    const details = within(gate).getByText('Review details and rework limits', { selector: 'summary' })
    expect(details.closest('details')).not.toHaveAttribute('open')
    fireEvent.click(details)
    expect(within(gate).getByText('Team completion')).toBeVisible()
    expect(within(gate).getByText('Model-diverse')).toBeVisible()
    expect(within(gate).getByText(/Checkpoint 1\/2 used \(1 remaining\); Team 2\/6 used \(4 remaining\)/u)).toBeVisible()
    const findings = screen.getByRole('heading', { name: 'Review results' }).closest('section')!
    expect(within(findings).getByText('High')).toBeVisible()
    fireEvent.click(details)

    expect(screen.queryByRole('textbox', { name: 'Waiver reason (required)' })).not.toBeInTheDocument()
    expect(screen.getByText('Review details and rework limits').closest('details')).not.toHaveAttribute('open')
    fireEvent.click(screen.getByRole('button', { name: 'Accept risk…' }))
    const waive = screen.getByRole('button', { name: 'Waive with reason' })
    expect(waive).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Waiver reason (required)' }), { target: { value: 'Accepted bounded risk' } })
    expect(waive).toBeEnabled()
    fireEvent.click(waive)

    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(command.mock.calls[0]?.[0]).toMatch(/^\/yuqi review-decision waive review-1 event-16 1 [A-Za-z0-9_-]+ team-1 controller-1 /u)
  })

  it('does not present a user-decision block while the reviewer owns the checkpoint', () => {
    document.documentElement.lang = 'en'
    render(<TeamPanel summary={{ ...summary, attention: [], team: { ...summary.team, userDecisionCount: 0 }, reviewCheckpoint: { ...summary.reviewCheckpoint!, phase: 'reviewing', nextOwner: 'reviewer' } }}
      onClose={() => undefined} onOpenChild={async () => true} nowMs={0} />)
    openReviewPage()
    expect(screen.queryByText('Decision required')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Re-review' })).not.toBeInTheDocument()
  })

  it('localizes recognized controller decision copy in both locales', () => {
    const localized = {
      ...summary,
      attention: [{ owner: 'user' as const, code: 'verification-inconclusive' as const, taskId: 'team-1', message: 'Host 无法完成所需验证，需要用户确认后续处理。' }],
    }
    document.documentElement.lang = 'en'
    const view = render(<TeamPanel summary={localized} onClose={() => undefined} onOpenChild={async () => true} nowMs={0} />)
    openReviewPage()
    expect(screen.queryByRole('region', { name: 'Controller decisions' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Quality gate control' })).toHaveTextContent('The Host could not complete the required verification. Choose how to proceed.')
    expect(screen.getByRole('dialog')).toHaveAttribute('lang', 'en')
    view.unmount()

    document.documentElement.lang = 'zh-CN'
    render(<TeamPanel summary={localized} onClose={() => undefined} onOpenChild={async () => true} nowMs={0} />)
    openReviewPage('zh')
    expect(screen.queryByRole('region', { name: '主控待处理事项' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '质量门主控' })).toHaveTextContent('Host 无法完成所需验证，需要用户确认后续处理。')
    expect(screen.getByRole('dialog')).toHaveAttribute('lang', 'zh-CN')
  })

  it('keeps the header outside one body containing review and tasks', () => {
    document.documentElement.lang = 'en'
    render(<TeamPanel summary={summary} onClose={() => undefined} onOpenChild={async () => true} nowMs={0} />)
    const body = screen.getByRole('region', { name: 'Team details and tasks' })
    openReviewPage()
    expect(body).toContainElement(screen.getByRole('region', { name: 'Quality gate control' }))
    expect(body.querySelector('.yuqi-task-list')).not.toBeNull()
    expect(body.querySelector('.yuqi-panel-header')).toBeNull()
    const reviewProcess = screen.getByRole('heading', { name: 'Review results' }).closest('section')!
    expect(within(reviewProcess).getByText('Release proof')).toBeVisible()
    expect(screen.getByText('Your decision needed')).toBeVisible()
  })

  it('uses normal cancellation while paused and never offers invalid fail', async () => {
    document.documentElement.lang = 'en'
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const command = vi.fn(async (_line: string) => true)
    render(<TeamPanel summary={{ ...summary, team: { ...summary.team, status: 'paused' } }} onClose={() => undefined} onOpenChild={async () => true} command={command} nowMs={0} />)
    openReviewPage()
    expect(screen.queryByRole('button', { name: 'Fail Team' })).not.toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('region', { name: 'Quality gate control' })).getByRole('button', { name: 'Cancel Team' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(command.mock.calls[0]?.[0]).toMatch(/^\/yuqi cancel team-1 controller-1 /u)
    expect(await screen.findByText(/Cancellation request sent/u)).toHaveTextContent('not yet confirmed stopped')
  })

  it('retains other user decisions when hiding the duplicate team review', () => {
    document.documentElement.lang = 'en'
    render(<TeamPanel summary={{ ...summary, attention: [...summary.attention, { owner: 'user', code: 'verification-inconclusive', taskId: 'other-task', message: 'Separate verification decision' }] }} onClose={() => undefined} onOpenChild={async () => true} nowMs={0} />)
    openReviewPage()
    expect(screen.getByRole('region', { name: 'Controller decisions' })).toHaveTextContent('1 decision needed')
    expect(screen.getByRole('region', { name: 'Controller decisions' })).toHaveTextContent('Separate verification decision')
  })

  it.each(['completed', 'cancelled', 'failed'] as const)('shows review history without actions for %s', status => {
    document.documentElement.lang = 'en'
    render(<TeamPanel summary={{ ...summary, team: { ...summary.team, status } }} onClose={() => undefined} onOpenChild={async () => true} command={async () => true} nowMs={0} />)
    openReviewPage()
    expect(screen.queryByRole('button', { name: 'Re-review' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept risk…' })).not.toBeInTheDocument()
    expect(screen.getByText('Review history')).toBeInTheDocument()
  })

  it('does not resume or request review after a durable cancellation intent', () => {
    document.documentElement.lang = 'en'
    render(<TeamPanel summary={{ ...summary, team: { ...summary.team, status: 'needs_reconciliation', cancellationRequested: true } }} onClose={() => undefined} onOpenChild={async () => true} command={async () => true} nowMs={0} />)
    openReviewPage()
    expect(screen.getByText('Stop requested; awaiting confirmation.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Re-review' })).not.toBeInTheDocument()
  })
})
