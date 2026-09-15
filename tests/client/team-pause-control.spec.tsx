// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { TeamPauseControl } from '../../src/client/TeamPauseControl.tsx'
import { TeamDockBar } from '../../src/client/TeamDockBar.tsx'
import { TeamControls } from '../../src/client/TeamControls.tsx'
import { YuqiCommandOutcomeError } from '../../src/client/command-outcome.ts'
import type { TeamConsoleSummary } from '../../src/domain/team-console-contract.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })
const base = { teamId: 'pause-shared', controllerSessionId: 'controller', status: 'running' } as const
it('shares in-flight admission between dock and details, and waits for durable paused', async () => {
  let resolve!: (accepted: boolean) => void
  const command = vi.fn(() => new Promise<boolean>(yes => { resolve = yes }))
  const view = render(<><TeamPauseControl {...base} command={command}/><TeamControls {...base} command={command}/></>)
  fireEvent.click(screen.getAllByRole('button', { name: '暂停' })[0]!)
  screen.getAllByRole('button', { name: '正在暂停…' }).forEach(button => {
    expect(button).toBeDisabled(); fireEvent.click(button)
  })
  expect(command).toHaveBeenCalledOnce()
  expect(command).toHaveBeenCalledWith(expect.stringMatching(/^\/yuqi pause pause-shared controller /), { teamId: 'pause-shared', controllerSessionId: 'controller' })
  await act(async () => { resolve(true) })
  expect(screen.queryByText('已暂停')).not.toBeInTheDocument()
  expect(screen.getAllByText('正在暂停（等待执行收尾）')).toHaveLength(2)
  view.rerender(<TeamPauseControl {...base} status="pausing" command={command}/>)
  expect(screen.queryByRole('button', { name: '暂停' })).not.toBeInTheDocument()
  view.rerender(<TeamPauseControl {...base} status="paused" command={command}/>)
  expect(screen.getByText('已暂停')).toBeVisible()
})
it('reports delayed state confirmation with a retry and rejects late transport updates', async () => {
  vi.useFakeTimers()
  const command = vi.fn(async () => true)
  const view = render(<TeamPauseControl {...base} teamId="pause-timeout" command={command}/>)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '暂停' })) })
  await act(async () => { vi.advanceTimersByTime(15_000) })
  expect(screen.getByRole('alert')).toHaveTextContent('未收到暂停状态确认')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试暂停' })) })
  expect(command).toHaveBeenCalledTimes(2)
  view.rerender(<TeamPauseControl {...base} teamId="pause-timeout" status="paused" command={command}/>)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
it('bounds an unresolved transport and shows the Host rejection reason', async () => {
  vi.useFakeTimers()
  const command = vi.fn(() => new Promise<boolean>(() => {}))
  render(<TeamPauseControl {...base} teamId="pause-transport" command={command}/>)
  fireEvent.click(screen.getByRole('button', { name: '暂停' }))
  await act(async () => { vi.advanceTimersByTime(15_000) })
  expect(screen.getByRole('alert')).toHaveTextContent('尚未确认')
  command.mockImplementation(async () => { throw new YuqiCommandOutcomeError('rejected', 'Host：主控身份不匹配') })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试暂停' })) })
  expect(screen.getByRole('alert')).toHaveTextContent('主控身份不匹配')
})
it('ignores a response after a confirmed state change', async () => {
  let resolve!: (value: boolean) => void
  const command = () => new Promise<boolean>(yes => { resolve = yes })
  const view = render(<TeamPauseControl {...base} teamId="pause-late" command={command}/>)
  fireEvent.click(screen.getByRole('button', { name: '暂停' }))
  view.rerender(<TeamPauseControl {...base} teamId="pause-late" status="paused" command={command}/>)
  await act(async () => { resolve(true) })
  expect(screen.getByText('已暂停')).toBeVisible()
  expect(screen.queryByText(/等待执行收尾/)).not.toBeInTheDocument()
})
it('keeps a pause locked across hide/reopen and unrelated decision updates', async () => {
  const command = vi.fn(async () => true)
  const view = render(<TeamControls {...base} teamId="pause-reopen" command={command}/>)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '暂停' })) })
  view.rerender(<TeamControls {...base} teamId="pause-reopen" userDecisionCount={2} command={command}/>)
  expect(screen.getByRole('button', { name: '正在暂停…' })).toBeDisabled()
  view.unmount()
  const reopened = render(<TeamPauseControl {...base} teamId="pause-reopen" command={command}/>)
  expect(screen.getByRole('button', { name: '正在暂停…' })).toBeDisabled()
  expect(command).toHaveBeenCalledOnce()
  reopened.rerender(<TeamPauseControl {...base} teamId="pause-reopen" status="paused" command={command}/>)
  reopened.rerender(<TeamPauseControl {...base} teamId="pause-reopen" command={command}/>)
  expect(screen.getByRole('button', { name: '暂停' })).toBeEnabled()
})
it('explains cancellation, missing connection and rejected admission without pretending to pause', async () => {
  const command = vi.fn(async () => false)
  const view = render(<TeamPauseControl {...base} teamId="pause-rejected" cancellationRequested command={command}/>)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('取消正在进行')
  view.rerender(<TeamPauseControl {...base} teamId="pause-rejected" />)
  expect(screen.getByRole('button', { name: '暂停' })).toBeDisabled()
  view.rerender(<TeamPauseControl {...base} teamId="pause-rejected" command={command}/>)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '暂停' })) })
  expect(screen.getByRole('alert')).toHaveTextContent('未受理')
  expect(screen.getByRole('button', { name: '重试暂停' })).toBeEnabled()
})
const summary: TeamConsoleSummary = {
  controllerSessionId: 'controller',
  team: { id: 'pause-dock', title: '隔离测试', objective: '测试', status: 'running', completedTaskCount: 0, runningTaskCount: 1, waitingTaskCount: 0, attentionTaskCount: 0, userDecisionCount: 0, controllerActionCount: 0, duration: { state: 'unavailable' } },
  tasks: [{ taskId: 't', goal: '隔离任务', status: 'running', attemptStatus: 'running', modelRole: 'worker', model: 'test', authorityMode: 'read-only', dependencyCount: 0, fileScope: [], attemptCount: 1, evidenceRecorded: false, usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '' }],
  attention: [], usage: { state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' },
}
const dockProps = { nowMs: 0, expanded: false, onOpen: () => {}, onHide: () => {}, hideLabel: '隐藏', hideTitle: '隐藏', hideText: '隐藏', command: async () => true }
it('shows the direct pause and only animates explicitly recorded running attempts', () => {
  const view = render(<TeamDockBar {...dockProps} summary={summary}/>)
  expect(screen.getByRole('button', { name: '暂停' })).toBeVisible()
  expect(screen.getByRole('img', { name: /非实时存活检测/ })).toBeVisible()
  for (const status of ['paused', 'pausing', 'failed', 'completed', 'needs_reconciliation'] as const) {
    view.rerender(<TeamDockBar {...dockProps} summary={{ ...summary, team: { ...summary.team, status } }}/>)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  }
  for (const attemptStatus of ['unknown', 'dispatching', undefined] as const) {
    view.rerender(<TeamDockBar {...dockProps} summary={{ ...summary, tasks: [{ ...summary.tasks[0]!, attemptStatus }] }}/>)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  }
  view.rerender(<TeamDockBar {...dockProps} summary={{ ...summary, tasks: [{ ...summary.tasks[0]!, status: 'pending' }] }}/>)
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
it('retains Continue ownership and user-decision gates', () => {
  const paused = { ...summary, team: { ...summary.team, status: 'paused' as const, resumeDisposition: 'runnable' as const } }
  const view = render(<TeamDockBar {...dockProps} summary={paused}/>)
  expect(screen.getByRole('button', { name: '继续' })).toBeEnabled()
  view.rerender(<TeamDockBar {...dockProps} summary={{ ...paused, team: { ...paused.team, userDecisionCount: 1 } }}/>)
  expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument()
  view.rerender(<TeamDockBar {...dockProps} summary={{ ...paused, team: { ...paused.team, resumeDisposition: 'requires-reconciliation' } }}/>)
  expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument()
})

it('provides immediate stop option while pausing', async () => {
  const command = vi.fn(async () => true)
  render(<TeamPauseControl {...base} teamId="pause-stop-immediate" status="pausing" command={command} />)
  expect(screen.getByText('正在暂停（等待执行收尾）')).toBeVisible()
  const stopButton = screen.getByRole('button', { name: '立即停止' })
  const resumeButton = screen.getByRole('button', { name: '恢复运行' })
  expect(stopButton).toBeEnabled()
  expect(resumeButton).toBeEnabled()

  await act(async () => { fireEvent.click(stopButton) })
  expect(command).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\/yuqi pause pause-stop-immediate controller .* --immediate$/), { teamId: 'pause-stop-immediate', controllerSessionId: 'controller' })
})

it('provides resume option while pausing', async () => {
  const command = vi.fn(async () => true)
  render(<TeamPauseControl {...base} teamId="pause-resume" status="pausing" command={command} />)
  const resumeButton = screen.getByRole('button', { name: '恢复运行' })
  await act(async () => { fireEvent.click(resumeButton) })
  expect(command).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\/yuqi resume pause-resume controller /), { teamId: 'pause-resume', controllerSessionId: 'controller' })
})

it('provides resume button when paused', async () => {
  const command = vi.fn(async () => true)
  render(<TeamPauseControl {...base} teamId="paused-test" status="paused" command={command} />)
  expect(screen.getByText('已暂停')).toBeVisible()
  const resumeButton = screen.getByRole('button', { name: '继续任务' })
  expect(resumeButton).toBeEnabled()
  await act(async () => { fireEvent.click(resumeButton) })
  expect(command).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\/yuqi resume paused-test controller /), { teamId: 'paused-test', controllerSessionId: 'controller' })
})

it('hides resume button when hideResumeButton is true', () => {
  render(<TeamPauseControl {...base} teamId="paused-hide" status="paused" hideResumeButton />)
  expect(screen.getByText('已暂停')).toBeVisible()
  expect(screen.queryByRole('button', { name: '继续任务' })).not.toBeInTheDocument()
})
