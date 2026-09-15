// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamControls } from '../../src/client/TeamControls.tsx'
import { YuqiCommandOutcomeError } from '../../src/client/command-outcome.ts'

function deferred() {
  let resolve!: (value: boolean) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function finish(pending: ReturnType<typeof deferred>, result: boolean | Error) {
  await act(async () => {
    if (result instanceof Error) pending.reject(result)
    else pending.resolve(result)
    await pending.promise.catch(() => undefined)
  })
}
const base = { teamId: 'team-a', controllerSessionId: 'controller-a', status: 'paused', planConfirmationPending: true } as const
it('offers a non-resuming recheck instead of repeated cancellation after durable stop intent', async () => {
  vi.useFakeTimers()
  const command = vi.fn(async () => true)
  render(<TeamControls teamId="team-a" controllerSessionId="controller-a" status="needs_reconciliation" cancellationRequested command={command} />)
  expect(screen.queryByRole('button', { name: '取消团队' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '恢复并继续' })).not.toBeInTheDocument()
  expect(screen.getByText(/确认停止前暂不能归档/)).toBeVisible()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新核对停止结果' })) })
  expect(command).toHaveBeenCalledWith(expect.stringMatching(/^\/yuqi reconcile /), { teamId: 'team-a', controllerSessionId: 'controller-a' })
  await act(async () => { vi.advanceTimersByTime(16_000) })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText(/停止核对已完成/)).toBeVisible()
})
it('shows an immediate Host recovery rejection instead of waiting for a state transition', async () => {
  const command = vi.fn(async () => {
    throw new YuqiCommandOutcomeError('rejected', '主控已重新检查现场，但仍有 Host 无法安全判定的运行状态；现场已保留，Team 仍为 needs_reconciliation，未重派或继续调度。')
  })
  render(<TeamControls teamId="team-a" controllerSessionId="controller-a" status="needs_reconciliation" command={command} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '恢复并继续' })) })
  expect(command).toHaveBeenCalledWith(expect.stringMatching(/^\/yuqi recover-continue /), { teamId: 'team-a', controllerSessionId: 'controller-a' })
  expect(screen.getByRole('alert')).toHaveTextContent('仍有 Host 无法安全判定')
  expect(screen.queryByText(/等待持久化状态更新/)).not.toBeInTheDocument()
})
afterEach(() => { cleanup(); localStorage.clear(); document.documentElement.lang = ''; vi.useRealTimers() })

describe.each(['zh', 'en'] as const)('Startup controls (%s)', locale => {
  const en = locale === 'en'
  const start = en ? 'Confirm plan & start' : '确认任务图并开始'
  const remember = en ? 'Always start automatically' : '以后免确认直接启动'

  it('holds startup during manual ownership and restores it after handback', () => {
    document.documentElement.lang = locale
    const command = vi.fn(async () => true)
    const view = render(<TeamControls {...base} manualOwnershipHeld command={command} />)
    expect(screen.queryByRole('button', { name: start })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(en ? 'under manual control' : '人工接管中')
    expect(command).not.toHaveBeenCalled()
    view.rerender(<TeamControls {...base} manualOwnershipHeld={false} command={command} />)
    expect(screen.getByRole('button', { name: start })).toBeEnabled()
    expect(screen.queryByText(en ? /under manual control/u : /有任务正在人工接管中/u)).not.toBeInTheDocument()
  })

  it('keeps both choices visible, described, keyboard focusable and view-only disabled', () => {
    document.documentElement.lang = locale
    const view = render(<TeamControls {...base} command={async () => true} disablePlanConfirmation={async () => true} />)
    const button = screen.getByRole('button', { name: start })
    expect(button.closest('.yuqi-start-choice')).toBeInTheDocument()
    expect(button).toHaveAccessibleDescription(en ? /Confirm plan & start/u : /确认任务图并开始/u)
    button.focus()
    expect(button).toHaveFocus()
    const automatic = screen.getByRole('button', { name: remember })
    automatic.focus()
    expect(automatic).toHaveFocus()
    view.rerender(<TeamControls {...base} />)
    expect(screen.getByRole('button', { name: start })).toBeDisabled()
    expect(screen.getByRole('button', { name: remember })).toBeDisabled()
  })

  it('starts only this Team without saving and blocks repeats while pending or awaiting projection', async () => {
    document.documentElement.lang = locale
    const pending = deferred()
    const command = vi.fn(() => pending.promise)
    const save = vi.fn(async () => true)
    render(<TeamControls {...base} command={command} disablePlanConfirmation={save} />)
    const button = screen.getByRole('button', { name: start })
    act(() => { fireEvent.click(button); fireEvent.click(button) })
    expect(command).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
    await finish(pending, true)
    expect(screen.getByRole('button', { name: start })).toBeDisabled()
    expect(screen.getByRole('button', { name: remember })).toBeDisabled()
    fireEvent.click(button)
    expect(command).toHaveBeenCalledTimes(1)
  })

  it.each(['rejected', 'throw'] as const)('does not start if saving is %s', async outcome => {
    document.documentElement.lang = locale
    const pending = deferred()
    const command = vi.fn(async () => true)
    const save = vi.fn(() => pending.promise)
    render(<TeamControls {...base} command={command} disablePlanConfirmation={save} />)
    const button = screen.getByRole('button', { name: remember })
    act(() => { fireEvent.click(button); fireEvent.click(button) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(command).not.toHaveBeenCalled()
    expect(button).toHaveTextContent(en ? 'Saving…' : '保存中…')
    await finish(pending, outcome === 'throw' ? new Error('offline') : false)
    expect(screen.getByRole('alert')).toHaveTextContent(en ? 'Could not save' : '无法保存')
    expect(screen.getByRole('button', { name: start })).toBeEnabled()
    expect(command).not.toHaveBeenCalled()
  })

  it.each(['success', 'rejected', 'throw'] as const)('retains saved-preference feedback when startup returns %s', async outcome => {
    document.documentElement.lang = locale
    const pending = deferred()
    const command = vi.fn(() => pending.promise)
    const save = vi.fn(async () => true)
    render(<TeamControls {...base} command={command} disablePlanConfirmation={save} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: remember })) })
    expect(command).toHaveBeenCalledWith(expect.stringMatching(/^\/yuqi resume team-a controller-a /u), { teamId: 'team-a', controllerSessionId: 'controller-a' })
    expect(screen.getByRole('button', { name: en ? 'Submitting…' : '提交中…' })).toBeDisabled()
    await finish(pending, outcome === 'throw' ? new Error('transport') : outcome === 'success')
    expect(screen.getByText(en ? /Automatic start preference saved/u : /已保存后续 Team 自动启动偏好/u))
      .toHaveTextContent(en ? 'not rolled back' : '不会因此回滚')
    if (outcome === 'success') expect(screen.getByRole('button', { name: start })).toBeDisabled()
    else {
      expect(screen.getByRole('alert')).toHaveTextContent(en ? /Operation (rejected|transport failed)/u : /操作(未受理|传输失败)/u)
      expect(screen.getByRole('button', { name: start })).toBeEnabled()
    }
    expect(save).toHaveBeenCalledTimes(1)
    expect(command).toHaveBeenCalledTimes(1)
  })

  it.each(['team', 'controller', 'status', 'confirmation', 'cancel', 'decision', 'unmount', 'round-trip'] as const)('never starts from an old save after %s changes', async change => {
    document.documentElement.lang = locale
    const pending = deferred()
    const command = vi.fn(async () => true)
    const save = vi.fn(() => pending.promise)
    const view = render(<TeamControls {...base} command={command} disablePlanConfirmation={save} />)
    fireEvent.click(screen.getByRole('button', { name: remember }))
    if (change === 'unmount') view.unmount()
    else {
      view.rerender(<TeamControls {...base}
        teamId={change === 'team' || change === 'round-trip' ? 'team-b' : base.teamId}
        controllerSessionId={change === 'controller' ? 'controller-b' : base.controllerSessionId}
        status={change === 'status' ? 'running' : 'paused'}
        planConfirmationPending={change !== 'confirmation'} cancellationRequested={change === 'cancel'}
        userDecisionCount={change === 'decision' ? 1 : 0} command={command} disablePlanConfirmation={save} />)
      if (change === 'round-trip') view.rerender(<TeamControls {...base} command={command} disablePlanConfirmation={save} />)
    }
    await finish(pending, true)
    expect(command).not.toHaveBeenCalled()
    expect(screen.queryByText(en ? /Automatic start preference saved/u : /已保存后续 Team 自动启动偏好/u)).not.toBeInTheDocument()
  })

  it.each(['save', 'command'] as const)('does not let an old %s failure overwrite a new request', async stage => {
    document.documentElement.lang = locale
    const old = deferred()
    const current = deferred()
    const oldCommand = vi.fn(() => old.promise)
    const view = render(<TeamControls {...base} command={oldCommand}
      disablePlanConfirmation={() => stage === 'save' ? old.promise : Promise.resolve(true)} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: remember })) })
    const newCommand = vi.fn(() => current.promise)
    view.rerender(<TeamControls {...base} teamId="team-b" command={newCommand} disablePlanConfirmation={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: start }))
    await finish(old, new Error('old failure'))
    expect(screen.getByRole('button', { name: en ? 'Submitting…' : '提交中…' })).toBeDisabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await finish(current, false)
    expect(screen.getByRole('alert')).toHaveTextContent('team-b')
    expect(newCommand).toHaveBeenCalledTimes(1)
  })
})
