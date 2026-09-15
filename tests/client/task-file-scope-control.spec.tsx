// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskRow } from '../../src/client/TaskRow.tsx'
import { YuqiCommandOutcomeError } from '../../src/client/command-outcome.ts'
import type { TeamConsoleTask } from '../../src/domain/team-console-contract.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })
const task: TeamConsoleTask = {
  taskId: 'scope-task', goal: 'Scope editor', status: 'ready', modelRole: 'worker', model: 'model',
  authorityMode: 'read-only', dependencyCount: 0, dependencies: [], fileScope: ['src/**'],
  attemptCount: 0, evidenceRecorded: false, usage: { state: 'pending', label: 'Token：暂无数据' },
  duration: { state: 'unavailable' }, nextAction: '',
  manualControl: { teamStatus: 'paused', canAcquire: true, workspacePath: 'F:/repo' },
}
const base = { index: 0, teamId: 'team-1', controllerSessionId: 'controller-1', teamStatus: 'paused' as const,
  task, nowMs: 0, initiallyExpanded: true, onOpenChild: async () => true }
const editor = () => screen.getByRole('textbox', { name: '计划文件范围（每行一个路径或 glob）' })
const applyScope = () => screen.getByRole('button', { name: '应用文件范围' })

describe('TaskRow scope editor', () => {
  it.each([false, true])('submits complete scope with strict identity in workbench=%s and waits for persisted data', async workbenchDetail => {
    const command = vi.fn(async () => true)
    const view = render(<TaskRow {...base} command={command} workbenchDetail={workbenchDetail} />)
    if (workbenchDetail) fireEvent.click(screen.getByText('文件范围与执行设置', { selector: 'summary' }))
    expect(applyScope()).toBeDisabled()
    fireEvent.change(editor(), { target: { value: ' src/**\n公共 文件.ts\n\nsrc/**' } })
    fireEvent.click(applyScope())
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    const [line, target] = command.mock.calls[0] as unknown as [string, unknown]
    const tokens = line.split(' ')
    expect(tokens.slice(0, 3)).toEqual(['/yuqi', 'scope', 'scope-task'])
    expect(tokens.slice(4, 6)).toEqual(['team-1', 'controller-1'])
    expect(JSON.parse(Buffer.from(tokens[3]!, 'base64url').toString())).toEqual(['src/**', '公共 文件.ts'])
    expect(target).toEqual({ teamId: 'team-1', controllerSessionId: 'controller-1' })
    expect(await screen.findByText(/范围已提交，等待持久化更新/)).toBeVisible()
    expect(editor()).toBeDisabled()
    view.rerender(<TaskRow {...base} task={{ ...task, fileScope: ['src/**', '公共 文件.ts'] }} command={command} workbenchDetail={workbenchDetail} />)
    expect(await screen.findByText(/范围已持久化/)).toBeVisible()
    expect(applyScope()).toBeDisabled()
    expect(command).toHaveBeenCalledTimes(1)
  })

  it.each(['running', 'pausing', 'unsafe', 'missing-safety', 'missing-controller', 'cancel'])('disables unsafe submission: %s', state => {
    const command = vi.fn(async () => true)
    const configured = state === 'missing-safety' ? { ...task, manualControl: undefined }
      : state === 'unsafe' ? { ...task, manualControl: { ...task.manualControl!, canAcquire: false } } : task
    const { controllerSessionId, ...unbound } = base
    render(<TaskRow {...unbound} task={configured} command={command} cancellationRequested={state === 'cancel'}
      {...(state === 'missing-controller' ? {} : { controllerSessionId })}
      teamStatus={state === 'running' || state === 'pausing' ? state : 'paused'} />)
    expect(editor()).toBeDisabled()
    fireEvent.click(applyScope())
    expect(command).not.toHaveBeenCalled()
  })

  it('validates input and discards edits without a command', () => {
    const command = vi.fn(async () => true)
    render(<TaskRow {...base} command={command} />)
    for (const value of ['', '../secret', 'C:/secret']) {
      fireEvent.change(editor(), { target: { value } })
      expect(editor()).toHaveAttribute('aria-invalid', 'true')
      expect(applyScope()).toBeDisabled()
      expect(screen.getByRole('alert')).toBeVisible()
    }
    fireEvent.click(screen.getByRole('button', { name: '放弃范围修改' }))
    expect(editor()).toHaveValue('src/**')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(command).not.toHaveBeenCalled()
  })

  it('allows a safely paused blocked task to edit scope without enabling model controls', () => {
    render(<TaskRow {...base} task={{ ...task, status: 'blocked' }} command={vi.fn(async () => true)} />)
    expect(editor()).toBeEnabled()
    fireEvent.change(editor(), { target: { value: 'package.json' } })
    expect(applyScope()).toBeEnabled()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it.each([false, new Error('offline')])('shows transport rejection or unknown outcome %s without losing input', async outcome => {
    const command = vi.fn(async () => { if (outcome instanceof Error) throw outcome; return outcome })
    render(<TaskRow {...base} command={command} />)
    fireEvent.change(editor(), { target: { value: 'package.json' } })
    fireEvent.click(applyScope())
    expect(await screen.findByRole('alert')).toHaveTextContent(outcome === false ? '命令未受理' : '结果未知')
    expect(editor()).toHaveValue('package.json')
    expect(applyScope()).toBeEnabled()
  })

  it('keeps errors and drafts visible, retries with the same id, and blocks duplicate clicks', async () => {
    const command = vi.fn().mockRejectedValueOnce(new YuqiCommandOutcomeError('rejected', 'CONTROL_NOT_ALLOWED: 活跃租约')).mockResolvedValue(true)
    render(<TaskRow {...base} command={command} />)
    fireEvent.change(editor(), { target: { value: 'package.json' } })
    fireEvent.click(applyScope())
    expect(await screen.findByRole('alert')).toHaveTextContent('活跃租约')
    expect(editor()).toHaveValue('package.json')
    fireEvent.click(applyScope())
    await screen.findByText(/范围已提交/)
    expect(command.mock.calls[0]).toEqual(command.mock.calls[1])
    fireEvent.click(screen.getByRole('button', { name: '等待范围更新…' }))
    expect(command).toHaveBeenCalledTimes(2)
  })

  it('makes missing durable updates visible and ignores stale responses after switching tasks', async () => {
    vi.useFakeTimers()
    const command = vi.fn(async () => true)
    const view = render(<TaskRow {...base} command={command} />)
    fireEvent.change(editor(), { target: { value: 'package.json' } })
    await act(async () => { fireEvent.click(applyScope()) })
    await act(async () => { vi.advanceTimersByTime(15_001) })
    expect(screen.getByRole('alert')).toHaveTextContent('尚未收到持久化范围更新')
    let resolve!: (value: boolean) => void
    command.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done }))
    fireEvent.click(applyScope())
    view.rerender(<TaskRow {...base} task={{ ...task, taskId: 'other-task', fileScope: ['other.ts'] }} command={command} />)
    await act(async () => { resolve(true) })
    expect(editor()).toHaveValue('other.ts')
    expect(screen.queryByText(/范围已提交/)).not.toBeInTheDocument()
  })
})
