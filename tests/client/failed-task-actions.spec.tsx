// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskRow } from '../../src/client/TaskRow.tsx'
import { YuqiCommandOutcomeError } from '../../src/client/command-outcome.ts'
import type { TeamConsoleTask } from '../../src/domain/team-console-contract.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })
const task: TeamConsoleTask = {
  taskId: 'failed-worker', goal: '检查代码地图', status: 'failed', childSessionId: 'child',
  modelRole: 'worker', model: 'model', authorityMode: 'write-authorized', dependencyCount: 0, dependencies: [], fileScope: ['docs/map.md'],
  attemptCount: 1, evidenceRecorded: true, usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '需通过安全门禁',
}
const props = { index: 0, teamId: 'fixture-team', teamStatus: 'running' as const, task, controllerSessionId: 'fixture-controller', onOpenChild: async () => true, nowMs: 0, initiallyExpanded: true, workbenchDetail: true }

it('places retry above technical details and locks accepted requests until durable change', async () => {
  const command = vi.fn().mockResolvedValue(true)
  render(<TaskRow {...props} command={command} />)
  const button = screen.getByRole('button', { name: '重试任务' })
  expect(button.closest('.yuqi-detail-progress')).not.toBeNull()
  expect(button.closest('details')).toBeNull()
  fireEvent.click(button); fireEvent.click(button)
  await waitFor(() => expect(screen.getByText('重试请求已提交，等待持久化状态更新。')).toHaveAttribute('role', 'status'))
  expect(command).toHaveBeenCalledTimes(1)
  expect(button).toBeDisabled()
})
it('keeps an unknown submission locked after model options refresh', async () => {
  const command = vi.fn().mockRejectedValue(new YuqiCommandOutcomeError('unknown', 'delivery unknown'))
  const view = render(<TaskRow {...props} command={command} />)
  fireEvent.click(screen.getByRole('button', { name: '重试任务' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('delivery unknown'))
  view.rerender(<TaskRow {...props} command={command} models={[]} />)
  expect(screen.getByRole('button', { name: '重试任务' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '重试任务' }))
  expect(command).toHaveBeenCalledTimes(1)
})
it.each(['needs_reconciliation', 'pausing', 'failed', 'completed', 'cancelled'] as const)('shows the Team gate %s and retains exact handoff context', status => {
  const command = vi.fn()
  render(<TaskRow {...props} teamStatus={status} command={command} />)
  expect(screen.getByRole('button', { name: '重试任务' })).toBeDisabled()
  expect(screen.getByText(new RegExp(`团队状态为 ${status}`), { selector: 'p' })).toBeInTheDocument()
  fireEvent.click(screen.getByText('准备上下文交给主控处理'))
  expect((screen.getByRole('textbox', { name: '失败任务处理上下文' }) as HTMLTextAreaElement).value).toContain('failed-worker')
  expect(command).not.toHaveBeenCalled()
})
it('shows a concrete rejection and lets the user retry, without treating accepted as completed', async () => {
  const command = vi.fn().mockRejectedValueOnce(new YuqiCommandOutcomeError('rejected', 'RETRY_NOT_ALLOWED: attempt budget exhausted')).mockResolvedValue(true)
  render(<TaskRow {...props} command={command} />)
  fireEvent.click(screen.getByRole('button', { name: '重试任务' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('attempt budget exhausted'))
  expect(screen.getByRole('button', { name: '重试任务' })).toBeEnabled()
})
it('never retries a completed task and disables unsettled failed attempts', () => {
  const view = render(<TaskRow {...props} command={vi.fn()} task={{ ...task, status: 'completed' }} />)
  expect(screen.queryByRole('button', { name: '重试任务' })).not.toBeInTheDocument()
  view.rerender(<TaskRow {...props} command={vi.fn()} task={{ ...task, attemptStatus: 'unknown' }} />)
  expect(screen.getByRole('button', { name: '重试任务' })).toBeDisabled()
  expect(screen.getByText(/上次执行尚未收尾/, { selector: 'p' })).toBeInTheDocument()
})
it('opens existing recovery controls without issuing a command and preserves clipboard fallback', async () => {
  const show = vi.fn()
  render(<TaskRow {...props} teamStatus="needs_reconciliation" onShowRecovery={show} command={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '查看团队恢复处理' }))
  expect(show).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByText('准备上下文交给主控处理'))
  fireEvent.click(screen.getByRole('button', { name: '复制任务上下文' }))
  await waitFor(() => expect(screen.getByText('剪贴板不可用，请选中下方文字手动复制。')).toHaveAttribute('role', 'status'))
})
