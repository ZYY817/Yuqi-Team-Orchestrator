// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamHandoffButton } from '../../src/client/TeamHandoffButton.tsx'
import { setYuqiLocale } from '../../src/client/client-locale.ts'
import type { TeamHandoffResult, TeamHandoffSource } from '../../src/client/team-handoff.ts'

let sequence = 0
const source = (): TeamHandoffSource => ({ sessionId: `handoff-ui-${++sequence}`, cwd: 'F:\\workspace\\new', isIdle: true, isTeam: false })
const openTarget = async () => true
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks() })

describe('TeamHandoffButton', () => {
  it('opens the retained target without resending and reports navigation failure', async () => {
    setYuqiLocale('en')
    const port = vi.fn(async () => ({ kind: 'created' as const }))
    const navigate = vi.fn(async () => false)
    render(<TeamHandoffButton source={source()} createHandoff={port} openTarget={navigate} />)
    fireEvent.click(screen.getByRole('button', { name: 'Turn into a Team task' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Task goal (required)' }), { target: { value: 'goal' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Team conversation' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open target conversation' })) })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not open')
    navigate.mockResolvedValue(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open target conversation' })) })
    expect(navigate.mock.calls[1]).toEqual(navigate.mock.calls[0])
    expect(port).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('unlocks the editor only after an explicitly retryable rejection', async () => {
    setYuqiLocale('zh')
    const port = vi.fn(async () => ({ kind: 'rejected' as const, retryable: true }))
    render(<TeamHandoffButton source={source()} createHandoff={port} openTarget={openTarget} />)
    fireEvent.click(screen.getByRole('button', { name: '转为团队任务' }))
    const goal = screen.getByRole('textbox', { name: '任务目标（必填）' })
    fireEvent.change(goal, { target: { value: '原目标' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认新建团队会话' })) })
    expect(goal).not.toHaveAttribute('readonly')
    fireEvent.change(goal, { target: { value: '修改后的目标' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试交接' })) })
    expect(port).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert')).toHaveTextContent('同一目标 ID')
  })

  it('hides when no adapter exists or source is ineligible', () => {
    const row = source()
    const view = render(<TeamHandoffButton source={row} openTarget={openTarget} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    for (const change of [{ isIdle: false }, { isTeam: true }, { parentSessionId: 'child' }, { agentPreset: 'yuqi-team' }]) {
      view.rerender(<TeamHandoffButton source={{ ...row, ...change }} openTarget={openTarget} createHandoff={async () => ({ kind: 'opened' })} />)
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    }
  })

  it('starts empty, traps focus, preserves a draft on close and requires a goal', () => {
    setYuqiLocale('zh')
    render(<TeamHandoffButton source={source()} openTarget={openTarget} createHandoff={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: '转为团队任务' })
    trigger.focus()
    fireEvent.click(trigger)
    const goal = screen.getByRole('textbox', { name: '任务目标（必填）' })
    expect(goal).toHaveValue('')
    expect(goal).toHaveFocus()
    expect(screen.getByRole('textbox', { name: '上下文摘要（可选）' })).toHaveValue('')
    expect(screen.getByRole('button', { name: '确认新建团队会话' })).toBeDisabled()
    fireEvent.change(goal, { target: { value: 'create one text file' } })
    const submit = screen.getByRole('button', { name: '确认新建团队会话' })
    submit.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(screen.getAllByRole('button', { name: /^关闭$/ })[0]).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    expect(screen.getByRole('textbox', { name: '任务目标（必填）' })).toHaveValue('create one text file')
  })

  it('does not create twice after double click or remount, and renders unknown distinctly', async () => {
    setYuqiLocale('en')
    const row = source()
    let finish!: (result: TeamHandoffResult) => void
    const port = vi.fn(() => new Promise<TeamHandoffResult>(resolve => { finish = resolve }))
    const view = render(<TeamHandoffButton source={row} openTarget={openTarget} createHandoff={port} />)
    fireEvent.click(screen.getByRole('button', { name: 'Turn into a Team task' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Task goal (required)' }), { target: { value: 'write a.txt' } })
    const submit = screen.getByRole('button', { name: 'Create Team conversation' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(port).toHaveBeenCalledTimes(1)
    await act(async () => { finish({ kind: 'unknown', message: 'Connection lost' }) })
    expect(screen.getByRole('alert')).toHaveTextContent('outcome is unknown')
    expect(submit).toBeDisabled()
    view.unmount()
    render(<TeamHandoffButton source={row} openTarget={openTarget} createHandoff={port} />)
    fireEvent.click(screen.getByRole('button', { name: 'Turn into a Team task' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Target conversation ID')
    expect(screen.getByRole('button', { name: 'Create Team conversation' })).toBeDisabled()
    expect(port).toHaveBeenCalledTimes(1)
  })

  it('does not leak the previous source draft or late result into a new session', async () => {
    setYuqiLocale('en')
    let finish!: (result: TeamHandoffResult) => void
    const port = vi.fn(() => new Promise<TeamHandoffResult>(resolve => { finish = resolve }))
    const view = render(<TeamHandoffButton source={source()} openTarget={openTarget} createHandoff={port} />)
    fireEvent.click(screen.getByRole('button', { name: 'Turn into a Team task' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Task goal (required)' }), { target: { value: 'private draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Team conversation' }))
    view.rerender(<TeamHandoffButton source={source()} openTarget={openTarget} createHandoff={port} />)
    await act(async () => { finish({ kind: 'created' }) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Turn into a Team task' }))
    expect(screen.getByRole('textbox', { name: 'Task goal (required)' })).toHaveValue('')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('closes when the source starts running before confirmation', () => {
    setYuqiLocale('en')
    const row = source()
    const port = vi.fn()
    const view = render(<TeamHandoffButton source={row} openTarget={openTarget} createHandoff={port} />)
    fireEvent.click(screen.getByRole('button', { name: 'Turn into a Team task' }))
    view.rerender(<TeamHandoffButton source={{ ...row, isIdle: false }} openTarget={openTarget} createHandoff={port} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(port).not.toHaveBeenCalled()
  })
})
