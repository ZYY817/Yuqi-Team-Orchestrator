// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamSessionNavigator } from '../../src/client/TeamSessionNavigator.tsx'
import { setChildSessionArchived } from '../../src/client/team-ui-preferences.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.lang = ''
})

function props(openChild = vi.fn(async () => true), projection: unknown = teamProjection()) {
  return {
    sessionId: 'parent',
    useSessions: (selector: (state: unknown) => unknown) => selector({ byId: { parent: { projectionValues: { yuqiTeam: projection } } } }),
    openChild,
    openMain: vi.fn(async () => true),
    archiveChild: async (teamId: string, childSessionId: string) => { setChildSessionArchived(teamId, childSessionId, true); return true },
  } as unknown as ComponentProps<typeof TeamSessionNavigator>
}

function teamProjection() {
  return {
    controllerSessionId: 'controller',
    team: { id: 'team-1' },
    tasks: [
      { taskId: 'one', goal: '检查页面结构', status: 'running', model: 'deepseek-v4', childSessionId: 'child-1' },
      { taskId: 'two', goal: '检查视觉层级', status: 'completed', model: 'deepseek-v4', childSessionId: 'child-2' },
      { taskId: 'waiting', goal: '尚未派发', status: 'pending', model: 'deepseek-v4' },
    ],
  }
}

function childProps(sessionId: string, openChild = vi.fn(async () => true), openMain = vi.fn(async () => true)) {
  const projection = teamProjection()
  const byId = {
    parent: { id: 'parent', agentPreset: 'yuqi-team', projectionValues: { yuqiTeam: projection } },
    controller: { id: 'controller', parentId: 'parent' },
    'child-1': { id: 'child-1', parentId: 'controller' },
    'child-2': { id: 'child-2', parentId: 'controller' },
  }
  return {
    sessionId,
    useSessions: (selector: (state: unknown) => unknown) => selector({ byId }),
    openChild,
    openMain,
    archiveChild: async (teamId: string, childSessionId: string) => { setChildSessionArchived(teamId, childSessionId, true); return true },
  } as unknown as ComponentProps<typeof TeamSessionNavigator>
}

describe('TeamSessionNavigator', () => {
  it.each(['false', 'throw'] as const)('keeps the controller menu available on %s and closes only after a successful retry', async mode => {
    const openMain = vi.fn(async () => true)
    if (mode === 'false') openMain.mockResolvedValueOnce(false)
    else openMain.mockRejectedValueOnce(new Error('offline'))
    render(<TeamSessionNavigator {...childProps('child-1', vi.fn(async () => true), openMain)} />)
    fireEvent.click(screen.getByRole('button', { name: '子代理 1/2' }))
    fireEvent.click(screen.getByRole('button', { name: /Team 主控/u }))
    expect(await screen.findByRole('alert')).toHaveTextContent('主控会话地址暂不可用或导航失败')
    expect(screen.getByRole('dialog')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Team 主控/u }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(openMain).toHaveBeenCalledTimes(2)
  })

  it('keeps the menu open if returning after archival fails', async () => {
    const openMain = vi.fn(async () => false)
    render(<TeamSessionNavigator {...childProps('child-2', vi.fn(async () => true), openMain)} />)
    fireEvent.click(screen.getByRole('button', { name: '子代理 2/2' }))
    fireEvent.click(screen.getByRole('button', { name: '归档：检查视觉层级' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('主控会话地址暂不可用或导航失败')
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(openMain).toHaveBeenCalledWith('parent')
  })

  it('renders outside clipping containers and dismisses on outside click or Escape', () => {
    const { container } = render(<div style={{ overflow: 'hidden' }}><TeamSessionNavigator {...props()} /></div>)
    const trigger = screen.getByRole('button', { name: '子代理会话 2' })
    fireEvent.click(trigger)
    const menu = screen.getByRole('dialog')
    expect(container.contains(menu)).toBe(false)
    expect(menu.parentElement).toBe(document.body)
    expect(menu).toHaveStyle({ position: 'fixed' })
    fireEvent.pointerDown(menu)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(trigger)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
  it('shows only materialized child sessions and opens one through the guarded route', async () => {
    const openChild = vi.fn(async () => true)
    render(<TeamSessionNavigator {...props(openChild)} />)
    expect(screen.getByRole('button', { name: '子代理会话 2' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '子代理会话 2' }))
    expect(screen.getByRole('dialog', { name: 'Team 会话导航' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Team 主控会话.*当前/u })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^01 检查页面结构/u }))
    await waitFor(() => expect(openChild).toHaveBeenCalledWith('controller', 'child-1', true))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps other navigation targets available while an open request is pending', async () => {
    const first = Promise.withResolvers<boolean>()
    const openMain = vi.fn(() => first.promise)
    render(<TeamSessionNavigator {...childProps('child-1', vi.fn(async () => true), openMain)} />)
    fireEvent.click(screen.getByRole('button', { name: '子代理 1/2' }))
    fireEvent.click(screen.getByRole('button', { name: /Team 主控/u }))
    expect(screen.getByRole('button', { name: /^02 检查视觉层级/u })).not.toBeDisabled()
    first.resolve(false)
    expect(await screen.findByRole('alert')).toHaveTextContent('主控会话地址暂不可用或导航失败')
  })

  it('stays hidden without a Team/child and keeps a failed child available for retry', async () => {
    const { rerender } = render(<TeamSessionNavigator {...props(vi.fn(), null)} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    const openChild = vi.fn(async () => false)
    rerender(<TeamSessionNavigator {...props(openChild)} />)
    fireEvent.click(screen.getByRole('button', { name: '子代理会话 2' }))
    fireEvent.click(screen.getByRole('button', { name: /^02 检查视觉层级/u }))
    expect(await screen.findByRole('alert')).toHaveTextContent('目录暂未就绪；这不表示任务已停止')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('preserves its Hook order as the Team projection arrives and disappears', () => {
    const { rerender } = render(<TeamSessionNavigator {...props(vi.fn(), null)} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    rerender(<TeamSessionNavigator {...props()} />)
    expect(screen.getByRole('button', { name: '子代理会话 2' })).toBeInTheDocument()

    rerender(<TeamSessionNavigator {...props(vi.fn(), null)} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('navigates from a child to a sibling or back to the Team controller', async () => {
    const openChild = vi.fn(async () => true)
    const openMain = vi.fn(async () => true)
    render(<TeamSessionNavigator {...childProps('child-1', openChild, openMain)} />)

    fireEvent.click(screen.getByRole('button', { name: '子代理 1/2' }))
    expect(screen.getByRole('button', { name: /^01 检查页面结构.*当前/u })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^02 检查视觉层级/u }))
    await waitFor(() => expect(openChild).toHaveBeenCalledWith('controller', 'child-2', true))

    fireEvent.click(screen.getByRole('button', { name: '子代理 1/2' }))
    fireEvent.click(screen.getByRole('button', { name: /Team 主控/u }))
    expect(openMain).toHaveBeenCalledWith('parent')
  })

  it('archives only terminal children through the Host bridge', async () => {
    render(<TeamSessionNavigator {...props(vi.fn(async () => false))} />)
    fireEvent.click(screen.getByRole('button', { name: '子代理会话 2' }))

    expect(screen.queryByRole('button', { name: '归档：检查页面结构' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^02 检查视觉层级/u }))
    expect(await screen.findByRole('alert')).toHaveTextContent('目录暂未就绪；这不表示任务已停止')
    fireEvent.click(screen.getByRole('button', { name: '归档：检查视觉层级' }))
    await waitFor(() => expect(screen.getByText('已归档 1')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('已归档 1'))
    expect(screen.getByRole('button', { name: '归档：检查视觉层级' })).toHaveTextContent('已归档')
    expect(screen.getByRole('button', { name: '归档：检查视觉层级' })).toBeDisabled()
  })

  it('explains the current controller when every child is archived instead of offering a no-op open action', () => {
    setChildSessionArchived('team-1', 'child-1', true)
    setChildSessionArchived('team-1', 'child-2', true)
    const openMain = vi.fn(async () => true)
    render(<TeamSessionNavigator {...props(vi.fn(async () => true))} openMain={openMain} />)
    fireEvent.click(screen.getByRole('button', { name: '子代理会话 2' }))
    const current = screen.getByRole('button', { name: /Team 主控会话.*当前/u })
    expect(current).toBeDisabled()
    fireEvent.click(current)
    expect(openMain).not.toHaveBeenCalled()
    expect(screen.getByText('已归档 2')).toBeInTheDocument()
    fireEvent.click(screen.getByText('已归档 2'))
    expect(screen.getAllByRole('button', { name: /^归档：/u })).toHaveLength(1)
    expect(screen.getByRole('button', { name: '归档：检查视觉层级' })).toBeDisabled()
  })

  it('returns to the Team controller when the currently open terminal child is archived', async () => {
    const openMain = vi.fn(async () => true)
    render(<TeamSessionNavigator {...childProps('child-2', vi.fn(async () => true), openMain)} />)
    fireEvent.click(screen.getByRole('button', { name: '子代理 2/2' }))
    fireEvent.click(screen.getByRole('button', { name: '归档：检查视觉层级' }))
    await waitFor(() => expect(openMain).toHaveBeenCalledWith('parent'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('uses English navigation labels when the host document language is English', () => {
    document.documentElement.lang = 'en-US'
    render(<TeamSessionNavigator {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Child sessions 2' }))
    expect(screen.getByRole('dialog', { name: 'Team session navigation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Archive: 检查视觉层级' })).toBeInTheDocument()
  })

  it('reacts to host locale changes and reports a rejected child-open transport', async () => {
    const openChild = vi.fn(async () => { throw new Error('offline') })
    render(<TeamSessionNavigator {...props(openChild)} />)
    document.documentElement.lang = 'en'
    await waitFor(() => expect(screen.getByRole('button', { name: 'Child sessions 2' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Child sessions 2' }))
    fireEvent.click(screen.getByRole('button', { name: /^01 检查页面结构/u }))
    expect(await screen.findByRole('alert')).toHaveTextContent('does not mean the task stopped')
    expect(screen.getByRole('button', { name: /^01 检查页面结构/u })).not.toBeDisabled()
  })

  it('shows a controlled catalog reason without exposing a raw Host error', async () => {
    const controlled = new Error('控制器尚未出现在其父会话目录中，暂不能定位子代理。')
    controlled.name = 'YuqiTeamChildNavigationError'
    const openChild = vi.fn(async () => { throw controlled })
    render(<TeamSessionNavigator {...props(openChild)} />)
    fireEvent.click(screen.getByRole('button', { name: '子代理会话 2' }))
    fireEvent.click(screen.getByRole('button', { name: /^01 检查页面结构/u }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('控制器尚未出现在其父会话目录中')
    expect(alert).toHaveTextContent('导航失败不证明任务停止；状态仅来自当前记录')
  })
})
