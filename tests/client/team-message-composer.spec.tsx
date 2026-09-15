// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamMessageComposer, type TeamMessageComposerProps } from '../../src/client/TeamMessageComposer.tsx'
import { teamStatusMeta } from '../../src/client/status.ts'

const tasks: TeamMessageComposerProps['tasks'] = [{
  taskId: 'worker', goal: 'Work', status: 'running', childSessionId: 'child',
  modelRole: 'worker', model: 'model', authorityMode: 'read-only', dependencyCount: 0,
  fileScope: [], attemptCount: 1, evidenceRecorded: false,
  usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '',
}]

function deferred() {
  let resolve!: (value: boolean) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

type Outcome = 'success' | 'rejected' | 'throw'
async function settle(pending: ReturnType<typeof deferred>, outcome: Outcome) {
  await act(async () => {
    if (outcome === 'throw') pending.reject(new Error('transport failed'))
    else pending.resolve(outcome === 'success')
    await pending.promise.catch(() => undefined)
  })
}

const base = { teamId: 'team-old', controllerSessionId: 'controller-old', teamStatus: 'running', cancellationRequested: false, tasks } as const

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.lang = ''
})

describe.each(['zh', 'en'] as const)('Composer asynchronous replies (%s)', locale => {
  const en = locale === 'en'
  const contentName = en ? 'Team instruction content' : '补充团队要求内容'
  const recipientName = en ? 'Instruction recipient' : '补充要求接收方'
  const sendName = en ? 'Send instruction' : '发送补充要求'
  const rejectedText = en ? 'The instruction was rejected; the task may have just ended. Refresh and retry.' : '补充要求未受理；任务可能刚刚结束，请刷新状态后重试。'

  for (const status of ['pausing', 'cancelling', 'completed', 'failed', 'cancelled'] as const) {
    it.each(['success', 'rejected', 'throw'] as const)(`keeps sending blocked after ${status} and %s`, async outcome => {
      document.documentElement.lang = locale
      const pending = deferred()
      const command = vi.fn(() => pending.promise)
      const view = render(<TeamMessageComposer {...base} command={command} />)
      const textbox = screen.getByRole('textbox', { name: contentName })
      const recipient = screen.getByRole('combobox', { name: recipientName })
      const send = screen.getByRole('button', { name: sendName })
      fireEvent.change(recipient, { target: { value: 'worker' } })
      fireEvent.change(textbox, { target: { value: 'Submitted draft' } })
      fireEvent.click(send)
      view.rerender(<TeamMessageComposer {...base} teamStatus={status} cancellationRequested={status === 'cancelling'} command={command} />)
      const terminal = ['completed', 'failed', 'cancelled'].includes(status)
      const reason = status === 'cancelling'
        ? (en ? 'Stop has been requested; instructions are disabled. Your draft is preserved.' : '已请求停止，暂不可发送补充要求；草稿已保留。')
        : (en ? `Instructions require a running Team (state: ${teamStatusMeta(status, locale).label}). Your draft is preserved.` : `仅运行中的团队可接收补充要求（状态：${teamStatusMeta(status, locale).label}）；草稿已保留。`)
      expect(textbox).toHaveValue('Submitted draft')
      for (const control of [textbox, recipient, send]) expect(control).toBeDisabled()
      expect(send).toHaveTextContent(en ? 'Sending…' : '发送中…')
      await settle(pending, outcome)
      const settledReason = outcome === 'success'
        ? reason.replace(en ? ' Your draft is preserved.' : '；草稿已保留。', en ? '' : '。')
        : reason
      for (const control of [textbox, send]) {
        expect(control).toBeDisabled()
        if (terminal) expect(control).not.toHaveAttribute('aria-describedby')
        else expect(control).toHaveAccessibleDescription(settledReason)
      }
      if (terminal) {
        if (outcome === 'throw') {
          expect(recipient).toBeDisabled()
        } else {
          expect(recipient).toBeEnabled()
          expect(recipient).not.toHaveAttribute('aria-describedby')
        }
        expect(screen.getByText(en ? 'This panel is view-only and cannot forward instructions to the controller.' : '当前面板仅支持查看，无法向主控转发要求。')).toBeInTheDocument()
        expect(screen.queryByText(settledReason)).not.toBeInTheDocument()
      } else {
        expect(recipient).toBeDisabled()
        expect(recipient).toHaveAccessibleDescription(settledReason)
      }
      if (outcome === 'success') expect(screen.queryByText(en ? /Your draft is preserved/u : /草稿已保留/u)).not.toBeInTheDocument()
      expect(send).toHaveTextContent(sendName)
      expect(recipient).toHaveValue(terminal ? 'all' : 'worker')
      expect(textbox).toHaveValue(outcome === 'success' ? '' : 'Submitted draft')
      const feedback = outcome === 'success'
        ? (en ? 'The request record was saved. Check the team message record in the conversation for each target receipt; interface acceptance does not mean delivery, processing, or a reply.' : '请求记录已保存，请在对话中的团队消息记录核对每个目标的回执；接口受理不代表送达、处理或回复。')
        : outcome === 'rejected' ? rejectedText
          : (en ? 'Delivery unknown. Check the main conversation before sending again; your draft is preserved.' : '投递结果未知，请先核对主控对话，勿重复发送；草稿已保留。')
      expect(screen.getByText(feedback)).toHaveAttribute('role', outcome === 'success' ? 'status' : 'alert')
      fireEvent.click(send)
      expect(command).toHaveBeenCalledTimes(1)
    })
  }

  for (const identity of ['team', 'controller'] as const) {
    it.each(['success', 'rejected', 'throw'] as const)(`ignores old %s after ${identity} changes without replacing new feedback`, async outcome => {
      document.documentElement.lang = locale
      const pending = deferred()
      const command = vi.fn<() => Promise<boolean>>()
        .mockImplementationOnce(() => pending.promise).mockResolvedValue(false)
      const view = render(<TeamMessageComposer {...base} command={command} />)
      const textbox = screen.getByRole('textbox', { name: contentName })
      fireEvent.change(textbox, { target: { value: 'Old draft' } })
      fireEvent.click(screen.getByRole('button', { name: sendName }))
      view.rerender(<TeamMessageComposer {...base}
        teamId={identity === 'team' ? 'team-new' : base.teamId}
        controllerSessionId={identity === 'controller' ? 'controller-new' : base.controllerSessionId} command={command} />)
      expect(textbox).toHaveValue('')
      expect(textbox).toBeEnabled()
      fireEvent.change(textbox, { target: { value: 'New draft' } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: sendName })) })
      expect(screen.getByRole('alert')).toHaveTextContent(rejectedText)
      fireEvent.change(textbox, { target: { value: 'New edited draft' } })
      await settle(pending, outcome)
      expect(textbox).toHaveValue('New edited draft')
      expect(screen.getByRole('alert')).toHaveTextContent(rejectedText)
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: sendName })).toBeEnabled()
      expect(command).toHaveBeenCalledTimes(2)
    })

    it.each(['success', 'rejected', 'throw'] as const)(`does not let old %s clear a new pending send after ${identity} changes`, async outcome => {
      document.documentElement.lang = locale
      const old = deferred()
      const current = deferred()
      const command = vi.fn<() => Promise<boolean>>()
        .mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise)
      const view = render(<TeamMessageComposer {...base} command={command} />)
      const textbox = screen.getByRole('textbox', { name: contentName })
      fireEvent.change(textbox, { target: { value: 'Old draft' } })
      fireEvent.click(screen.getByRole('button', { name: sendName }))
      view.rerender(<TeamMessageComposer {...base}
        teamId={identity === 'team' ? 'team-new' : base.teamId}
        controllerSessionId={identity === 'controller' ? 'controller-new' : base.controllerSessionId} command={command} />)
      fireEvent.change(textbox, { target: { value: 'New pending draft' } })
      fireEvent.click(screen.getByRole('button', { name: sendName }))
      await settle(old, outcome)
      expect(textbox).toHaveValue('New pending draft')
      expect(textbox).toBeDisabled()
      expect(screen.getByRole('combobox', { name: recipientName })).toBeDisabled()
      const sending = screen.getByRole('button', { name: en ? 'Sending…' : '发送中…' })
      expect(sending).toBeDisabled()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      fireEvent.click(sending)
      expect(command).toHaveBeenCalledTimes(2)
      await settle(current, 'rejected')
      expect(textbox).toBeEnabled()
      expect(textbox).toHaveValue('New pending draft')
      expect(screen.getByRole('alert')).toHaveTextContent(rejectedText)
    })
  }

  it('persists an uncertain ordinary delivery and keeps it locked across remount and selection changes', async () => {
    document.documentElement.lang = locale
    const pending = deferred()
    const command = vi.fn(() => pending.promise)
    const view = render(<TeamMessageComposer {...base} command={command} selectedTaskId="worker" />)
    const textbox = screen.getByRole('textbox', { name: contentName })
    fireEvent.change(textbox, { target: { value: 'Keep this exact draft' } })
    fireEvent.click(screen.getByRole('button', { name: sendName }))
    await settle(pending, 'throw')
    expect(textbox).toBeDisabled()
    expect(localStorage.getItem('yuqi:team-message-pending:v1:["team-old","controller-old"]')).toContain('Keep this exact draft')
    view.unmount()
    const reopenedCommand = vi.fn().mockResolvedValue(true)
    const reopened = render(<TeamMessageComposer {...base} command={reopenedCommand} selectedTaskId="worker" />)
    expect(screen.getByRole('textbox', { name: contentName })).toHaveValue('Keep this exact draft')
    expect(screen.getByRole('textbox', { name: contentName })).toBeDisabled()
    reopened.rerender(<TeamMessageComposer {...base} command={reopenedCommand} selectedTaskId="other" />)
    expect(screen.getByRole('textbox', { name: contentName })).toBeDisabled()
    expect(reopened.container.querySelector('code')).toHaveTextContent(/\w+-\w+/)
    const reviewCheckbox = screen.getByRole('checkbox', { name: en ? 'I checked this request and will not resend the old message.' : '我已核对该请求，不重发旧消息。' })
    const closeReview = screen.getByRole('button', { name: en ? 'Close this review' : '结束本次核对' })
    expect(closeReview).toBeDisabled()
    fireEvent.click(reviewCheckbox)
    expect(closeReview).toBeEnabled()
    fireEvent.click(closeReview)
    expect(localStorage.getItem('yuqi:team-message-pending:v1:["team-old","controller-old"]')).toBeNull()
    expect(screen.getByRole('textbox', { name: contentName })).toHaveValue('')
    expect(screen.getByText(en ? 'This review is closed without resending. It does not confirm delivery, processing, or a reply.' : '本次核对已结束，未重发旧消息；这不代表消息已送达、已处理或已有回复。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: sendName }))
    expect(reopenedCommand).not.toHaveBeenCalled()
  })

  it('does not send when the delivery guard cannot be persisted', () => {
    document.documentElement.lang = locale
    const command = vi.fn().mockResolvedValue(true)
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    render(<TeamMessageComposer {...base} command={command} />)
    const textbox = screen.getByRole('textbox', { name: contentName })
    fireEvent.change(textbox, { target: { value: 'Must not send' } })
    fireEvent.click(screen.getByRole('button', { name: sendName }))
    expect(command).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(en ? 'Could not save the delivery guard' : '无法保存投递保护')
    setItem.mockRestore()
  })

  it('rechecks storage at submit time when another panel already owns the draft', () => {
    document.documentElement.lang = locale
    const first = vi.fn(() => new Promise<boolean>(() => undefined))
    const second = vi.fn().mockResolvedValue(true)
    const view = render(<TeamMessageComposer {...base} command={first} />)
    const secondView = render(<TeamMessageComposer {...base} command={second} />)
    const firstBox = screen.getAllByRole('textbox', { name: contentName })[0]!
    const secondBox = secondView.container.querySelector('textarea')!
    fireEvent.change(firstBox, { target: { value: 'One owner only' } })
    fireEvent.click(screen.getAllByRole('button', { name: sendName })[0]!)
    fireEvent.change(secondBox, { target: { value: 'Competing draft' } })
    fireEvent.click(secondView.container.querySelector('button')!)
    expect(second).not.toHaveBeenCalled()
    view.unmount()
    secondView.unmount()
  })
})
