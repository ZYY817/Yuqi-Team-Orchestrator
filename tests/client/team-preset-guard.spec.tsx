// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { TeamPresetGuard } from '../../src/client/TeamPresetGuard.tsx'

afterEach(cleanup)

const sid = 'blank-1' as SessionId

function fixture(agentPreset = 'standard') {
  const state: { current: {
    current?: SessionId
    byId: Record<SessionId, { id: SessionId; blank: boolean; agentPreset: string; projectionValues?: { agentPreset: string } }>
  } } = { current: {
    current: sid,
    byId: { [sid]: { id: sid, blank: true, agentPreset } },
  } }
  return {
    state,
    sessions: { getSnapshot: () => state.current, subscribe: () => () => undefined },
  }
}

describe.each(['legacy', 'projection'] as const)('TeamPresetGuard (%s)', source => {
  it.each(['click', 'Enter', 'submit'])('sends once after durable readiness for %s without asking for a second action', async action => {
    const { state, sessions } = fixture()
    const sent = vi.fn()
    const content = () => <><button type="button">Yuqi Team 主控</button>
      <form aria-label="composer-form" onSubmit={event => { event.preventDefault(); sent() }}>
        <textarea aria-label="composer" defaultValue="keep this draft" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); sent() } }} />
        <button type="submit" aria-label="发送消息">send</button>
      </form><TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} /></>
    const view = render(content())
    const send = () => action === 'click' ? fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
      : action === 'Enter' ? fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
        : fireEvent.submit(screen.getByRole('form'))
    send()
    send()
    expect(sent).not.toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent('就绪后会自动发送')
    state.current = { ...state.current, byId: { [sid]: source === 'legacy'
      ? { id: sid, blank: true, agentPreset: 'yuqi-team' }
      : { id: sid, blank: true, agentPreset: 'standard', projectionValues: { agentPreset: 'yuqi-team' } } } }
    view.rerender(content())
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1))
    view.rerender(content())
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it.each(['edit', 'session', 'preset', 'unmount'])('discards a pending send on %s', async change => {
    const { state, sessions } = fixture()
    const sent = vi.fn()
    const content = () => <><button type="button">Yuqi Team 主控</button>
      <div role="menu"><button role="menuitem">标准模式</button></div>
      <textarea aria-label="composer" defaultValue="draft" />
      <button type="button" aria-label="发送消息" onClick={sent}>send</button>
      <TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} /></>
    const view = render(content())
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    if (change === 'edit') fireEvent.input(screen.getByRole('textbox'), { target: { value: 'edited' } })
    else if (change === 'preset') fireEvent.click(screen.getByRole('menuitem'))
    else if (change === 'session') {
      state.current = { byId: state.current.byId }
      view.rerender(content())
    } else view.unmount()
    state.current = { current: sid, byId: { [sid]: { id: sid, blank: true, agentPreset: 'yuqi-team' } } }
    if (change !== 'unmount') view.rerender(content())
    await waitFor(() => expect(sent).not.toHaveBeenCalled())
  })

  it('does not treat IME confirmation as a pending send', () => {
    const { sessions } = fixture()
    render(<><button type="button">Yuqi Team 主控</button><textarea aria-label="composer" />
      <TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} /></>)
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
    screen.getByRole('textbox').dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('tracks the official Team menu choice until the Host fact arrives', async () => {
    const { state, sessions } = fixture()
    const view = render(<><div role="menu"><button role="menuitem">Yuqi Team 主控 提供团队调度、监督和证据验收。</button></div>
      <TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} /></>)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /Yuqi Team 主控/u }))
    expect(await screen.findByRole('status')).toHaveTextContent('Team 模式准备中')
    state.current = { ...state.current, byId: { [sid]: { id: sid, blank: true, agentPreset: 'yuqi-team' } } }
    view.rerender(<><div role="menu"><button role="menuitem">Yuqi Team 主控 提供团队调度、监督和证据验收。</button></div>
      <TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} /></>)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('blocks Enter and submit clicks only while the picker visually leads its durable Session fact', async () => {
    const { sessions } = fixture()
    render(<>
      <button type="button">Yuqi Team 主控</button>
      <form><textarea aria-label="composer" /><button type="submit" aria-label="发送消息">send</button></form>
      <TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} />
    </>)
    const textarea = screen.getByRole('textbox', { name: 'composer' })
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    textarea.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    screen.getByRole('button', { name: '发送消息' }).dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Team 模式准备中'))
  })

  it('does not block another preset or Shift+Enter', () => {
    const standard = fixture()
    const view = render(<>
      <button type="button">标准模式</button><textarea aria-label="composer" />
      <TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={standard.sessions} />
    </>)
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    screen.getByRole('textbox', { name: 'composer' }).dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    view.unmount()

    const pending = fixture()
    render(<><button type="button">Yuqi Team 主控</button><textarea aria-label="composer-2" />
      <TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={pending.sessions} /></>)
    const newline = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
    screen.getByRole('textbox', { name: 'composer-2' }).dispatchEvent(newline)
    expect(newline.defaultPrevented).toBe(false)
  })

  it('limits submit interception to the composer form', async () => {
    const { sessions } = fixture()
    render(<>
      <button type="button">Yuqi Team 主控</button>
      <form aria-label="search"><input /></form>
      <form aria-label="composer-form"><textarea /></form>
      <TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} />
    </>)
    const search = new Event('submit', { bubbles: true, cancelable: true })
    screen.getByRole('form', { name: 'search' }).dispatchEvent(search)
    expect(search.defaultPrevented).toBe(false)
    const composer = new Event('submit', { bubbles: true, cancelable: true })
    screen.getByRole('form', { name: 'composer-form' }).dispatchEvent(composer)
    expect(composer.defaultPrevented).toBe(true)
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
  })

  it('ignores menu choices, unrelated clicks, and non-Enter keys', () => {
    const { sessions } = fixture()
    const view = render(<>
      <div role="menu"><button role="menuitem">Yuqi Team 主控</button></div>
      <textarea aria-label="composer" /><button type="button" aria-label="attach">attach</button>
      <TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} />
    </>)
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    screen.getByRole('textbox', { name: 'composer' }).dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    view.rerender(<>
      <button type="button">Yuqi Team 主控</button>
      <textarea aria-label="composer" /><button type="button" aria-label="attach">attach</button>
      <TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} />
    </>)
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    screen.getByRole('textbox', { name: 'composer' }).dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    screen.getByRole('button', { name: 'attach' }).dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
    const documentClick = new MouseEvent('click', { bubbles: true, cancelable: true })
    document.dispatchEvent(documentClick)
    expect(documentClick.defaultPrevented).toBe(false)
  })

  it('fails open when the live current session disappears or has no row', () => {
    const { state, sessions } = fixture()
    render(<>
      <button type="button">Yuqi Team 主控</button><textarea aria-label="composer" />
      <TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} />
    </>)
    state.current = { byId: state.current.byId }
    const withoutCurrent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    screen.getByRole('textbox', { name: 'composer' }).dispatchEvent(withoutCurrent)
    expect(withoutCurrent.defaultPrevented).toBe(false)
    state.current = { current: 'missing' as SessionId, byId: {} }
    const withoutRow = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    screen.getByRole('textbox', { name: 'composer' }).dispatchEvent(withoutRow)
    expect(withoutRow.defaultPrevented).toBe(false)
  })

  it('recognizes a contenteditable composer and an English titled send control', async () => {
    const { sessions } = fixture()
    render(<>
      <button type="button">Yuqi Team 主控</button>
      <div role="textbox" aria-label="rich-composer" />
      <button type="button" title="Send message"><span>arrow</span></button>
      <TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} />
    </>)
    const editor = screen.getByRole('textbox', { name: 'rich-composer' })
    Object.defineProperty(editor, 'isContentEditable', { configurable: true, value: true })
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    editor.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    screen.getByText('arrow').dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
  })

  it('clears a pending Team hint when another official preset is selected', async () => {
    const { sessions } = fixture()
    render(<><div role="menu"><button role="menuitem">Yuqi Team 主控</button><button role="menuitem">标准模式</button></div>
      <TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} /></>)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Yuqi Team 主控' }))
    expect(await screen.findByRole('status')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: '标准模式' }))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })

  it('renders nothing when already ready or without a current session', () => {
    const ready = fixture('yuqi-team')
    const view = render(<TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={ready.sessions} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    view.unmount()
    const emptySnapshot = { byId: {} }
    const noCurrent = {
      getSnapshot: () => emptySnapshot,
      subscribe: () => () => undefined,
    }
    render(<TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={noCurrent} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('stays absent outside a blank Session', () => {
    const { state, sessions } = fixture()
    const view = render(<TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} />)
    state.current = { ...state.current, byId: { [sid]: { id: sid, blank: false, agentPreset: 'standard' } } }
    view.rerender(<TeamPresetGuard presetId="yuqi-team" presetName="Yuqi Team 主控" sessions={sessions} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
