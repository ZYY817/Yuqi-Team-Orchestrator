// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManualTaskControl } from '../../src/client/ManualTaskControl.tsx'
import { manualReturnCommandLine } from '../../src/client/command-actions.ts'
import { YuqiCommandOutcomeError } from '../../src/client/command-outcome.ts'
import type { TeamConsoleTask } from '../../src/domain/team-console-contract.ts'

const task: TeamConsoleTask = {
  taskId: 'worker', goal: 'Work', status: 'failed', modelRole: 'worker', model: 'model',
  authorityMode: 'read-only', dependencyCount: 0, fileScope: [], attemptCount: 0,
  evidenceRecorded: false, usage: { state: 'pending', label: 'Token：暂无数据' },
  duration: { state: 'unavailable' }, nextAction: '',
  manualControl: { teamStatus: 'paused', canAcquire: true, workspacePath: 'F:/test' },
}
const ownership = { state: 'human-owned', taskId: 'worker', acquisitionId: 'acquire-1', workspacePath: 'F:/test', acquiredAt: '2026-09-05T00:00:00Z' } as const
afterEach(() => { cleanup(); localStorage.clear(); document.documentElement.lang = '' })

describe('manual ownership UI', () => {
  it.each(['accepted', 'rejected', 'unknown'] as const)('ignores late %s after Team/controller changes and preserves the new draft/feedback', async outcome => {
    let resolve!: (value: boolean) => void
    let reject!: (error: Error) => void
    const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no })
    const command = vi.fn().mockImplementationOnce(() => promise).mockResolvedValue(false)
    const held = { ...task, manualControl: { teamStatus: 'paused' as const, canAcquire: false, ownership } }
    const view = render(<ManualTaskControl teamId="old" controllerSessionId="old-controller" task={held} command={command} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'old draft' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '交还主控' }))
    fireEvent.click(screen.getByRole('button', { name: '交还主控' }))
    expect(command).toHaveBeenCalledTimes(1)
    view.rerender(<ManualTaskControl teamId="new" controllerSessionId="new-controller" task={{ ...held, manualControl: { ...held.manualControl, ownership: { ...ownership, acquisitionId: 'new-owner' } } }} command={command} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new draft' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '交还主控' }))
    await waitFor(() => expect(screen.getByText(/请求未受理/)).toBeInTheDocument())
    await act(async () => {
      if (outcome === 'accepted') resolve(true)
      else reject(new YuqiCommandOutcomeError(outcome, 'old error'))
      await promise.catch(() => undefined)
    })
    expect(screen.getByRole('textbox')).toHaveValue('new draft')
    expect(screen.getByText(/请求未受理/)).toBeInTheDocument()
    expect(screen.queryByText(/old error/)).toBeNull()
    expect(screen.getByRole('button', { name: '交还主控' })).toBeEnabled()
  })
  it('encodes return context without command substitution or argument injection', () => {
    const summary = '中文 /yuqi cancel\n"quote" request-id'
    const parts = manualReturnCommandLine('worker', 'team', 'controller', 'acquire-1', summary, 'request-id').split(' ')
    expect(parts.slice(0, 3)).toEqual(['/yuqi', 'manual-return', 'worker'])
    expect(parts.slice(4)).toEqual(['team', 'controller', 'request-id'])
    expect(JSON.parse(Buffer.from(parts[3]!, 'base64url').toString('utf8'))).toEqual({ acquisitionId: 'acquire-1', summary })
  })
  it.each(['zh', 'en'] as const)('cancelled ownership is history without return controls (%s)', locale => {
    document.documentElement.lang = locale
    const command = vi.fn(async () => true)
    render(<ManualTaskControl teamId="team" controllerSessionId={undefined} task={{ ...task, manualControl: { teamStatus: 'cancelled', canAcquire: false, ownership } }} command={command} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(locale === 'en' ? /no return action is required/ : /无需再交还/)).toBeInTheDocument()
    expect(command).not.toHaveBeenCalled()
  })
  it.each(['accepted', 'rejected', 'unknown'] as const)('handles %s without inventing ownership', async outcome => {
    const command = vi.fn(async () => {
      if (outcome !== 'accepted') throw new YuqiCommandOutcomeError(outcome, 'host result')
      return true
    })
    render(<ManualTaskControl teamId="team" controllerSessionId="controller" task={task} command={command} />)
    fireEvent.click(screen.getByRole('checkbox'))
    const button = screen.getByRole('button', { name: '确认人工接管' })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(outcome === 'accepted' ? '刷新页面' : outcome === 'rejected' ? '请求被拒绝' : '结果未知'))
    if (outcome === 'rejected') expect(button).toBeEnabled()
    else expect(button).toBeDisabled()
    expect(command).toHaveBeenCalledTimes(1)
  })
  it.each(['failed', 'cancelled'] as const)('requires retry after returning a %s task', status => {
    render(<ManualTaskControl teamId="team" controllerSessionId="controller" task={{ ...task, status, manualControl: { teamStatus: 'paused', canAcquire: true, ownership: { ...ownership, state: 'returned', summary: 'changed a file' } } }} command={vi.fn(async () => true)} />)
    expect(screen.getByText(/仅继续 Team 不会重试此任务/)).toBeInTheDocument()
    expect(screen.getByText(/尝试次数已用完时，需要主控调整任务计划或新建任务/)).toBeInTheDocument()
    expect(screen.getByText(/交还不代表验收通过或任务完成/)).toBeInTheDocument()
  })
})
