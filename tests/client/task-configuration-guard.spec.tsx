// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskRow } from '../../src/client/TaskRow.tsx'
import type { TeamConsoleTask } from '../../src/domain/team-console-contract.ts'

afterEach(cleanup)
const task: TeamConsoleTask = {
  taskId: 'worker', goal: 'Read a file', status: 'cancelled', childSessionId: 'child',
  modelRole: 'worker', model: 'model', authorityMode: 'read-only', dependencyCount: 0,
  dependencies: [], fileScope: ['a.txt'], attemptCount: 1, evidenceRecorded: false,
  usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '',
}
it.each(['cancelled','completed','failed','cancelling','needs_reconciliation'] as const)('keeps records visible but disables task configuration for Team %s', teamStatus => {
  const command = vi.fn(async () => true)
  render(<TaskRow index={0} teamId="team" teamStatus={teamStatus} task={task} controllerSessionId="controller"
    onOpenChild={async () => true} command={command} nowMs={0} models={[{id:'model',name:'Model'},{id:'other',name:'Other'}]} initiallyExpanded workbenchDetail />)
    fireEvent.click(screen.getByText('文件范围与执行设置'))
  expect(screen.getByRole('combobox', {name:'任务模型'})).toBeDisabled()
  expect(screen.getByRole('combobox', {name:'任务权限'})).toBeDisabled()
  expect(screen.getByText(/团队已结束、正在停止或等待核对/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', {name:'应用模型并重试'}))
  expect(command).not.toHaveBeenCalled()
  expect(screen.getByRole('button', {name:'查看子代理对话'})).toBeDisabled()
  expect(screen.getByText(/任务已取消，可在上方查看保留记录/)).toBeVisible()
})
