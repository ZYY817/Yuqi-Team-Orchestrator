// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectKnowledgeActions, ProjectKnowledgeRefresh } from '../../src/client/ProjectKnowledgeActions.tsx'
afterEach(cleanup)
it('confirms the entire scope, blocks double submit, and allows retry after failure', async () => {
  let finish!: (ok: boolean) => void
  const command = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve })).mockResolvedValue(true)
  render(<ProjectKnowledgeActions teamId="t" controllerSessionId="c" topic="all" command={command} en={false} />)
  fireEvent.click(screen.getByRole('button', { name: '清空整个项目总览记忆' }))
  expect(screen.getByRole('group')).toHaveTextContent('所有分类、总体进度和文档链接')
  fireEvent.click(screen.getByRole('button', { name: '确认清理' }))
  fireEvent.click(screen.getByRole('button', { name: '正在清理…' }))
  expect(command).toHaveBeenCalledTimes(1)
  finish(false)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('未确认清理成功'))
  fireEvent.click(screen.getByRole('button', { name: '确认清理' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已保存'))
  expect(command).toHaveBeenLastCalledWith(expect.stringMatching(/^\/yuqi knowledge-clear all confirm t c /u), { teamId: 't', controllerSessionId: 'c' })
})
it('refreshes the exact Team without a deletion command', async () => {
  const command = vi.fn().mockResolvedValue(true)
  render(<ProjectKnowledgeRefresh teamId="t" controllerSessionId="c" command={command} en={false} />)
  fireEvent.click(screen.getByRole('button', { name: '刷新项目记忆' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('项目记忆已刷新'))
  expect(command).toHaveBeenCalledWith(expect.stringMatching(/^\/yuqi knowledge-refresh t c /u), { teamId: 't', controllerSessionId: 'c' })
})
it('keeps refresh failure distinct from success', async () => {
  render(<ProjectKnowledgeRefresh teamId="t" controllerSessionId="c" command={vi.fn().mockResolvedValue(false)} en />)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh project memory' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Refresh failed'))
})
it('requires explicit confirmation and passes exact Team identity', async () => {
  const command = vi.fn().mockResolvedValue(true)
  render(<ProjectKnowledgeActions teamId="team-a" controllerSessionId="controller-a" topic="pitfalls" itemId="lesson-a" command={command} en={false} />)
  fireEvent.click(screen.getByRole('button', { name: '删除记录' }))
  expect(command).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认清理' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已保存'))
  expect(command).toHaveBeenCalledWith(expect.stringMatching(/^\/yuqi knowledge-delete pitfalls lesson-a team-a controller-a /u), { teamId: 'team-a', controllerSessionId: 'controller-a' })
})
it('can abandon cleanup without a write', () => {
  const command = vi.fn()
  render(<ProjectKnowledgeActions teamId="t" controllerSessionId="c" topic="conventions" command={command} en />)
  fireEvent.click(screen.getByRole('button', { name: 'Clear this category' }))
  fireEvent.click(screen.getByRole('button', { name: 'Keep records' }))
  expect(command).not.toHaveBeenCalled()
  expect(screen.queryByRole('group')).not.toBeInTheDocument()
})
it('does not claim success on a rejected command', async () => {
  const command = vi.fn().mockResolvedValue(false)
  render(<ProjectKnowledgeActions teamId="t" controllerSessionId="c" topic="conventions" command={command} en />)
  fireEvent.click(screen.getByRole('button', { name: 'Clear this category' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm cleanup' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('not confirmed'))
  expect(command).toHaveBeenCalledWith(expect.stringMatching(/^\/yuqi knowledge-clear conventions confirm t c /u), expect.anything())
})
it('has no write action without an exact controller', () => {
  render(<ProjectKnowledgeActions teamId="t" controllerSessionId={undefined} topic="pitfalls" command={vi.fn()} en />)
  expect(screen.getByRole('button')).toBeDisabled()
})
