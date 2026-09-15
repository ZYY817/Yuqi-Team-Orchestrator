// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it } from 'vitest'
import { TeamPanel } from '../../src/client/TeamPanel.tsx'
import type { TeamConsoleSummary } from '../../src/domain/team-console-contract.ts'

afterEach(cleanup)
const summary: TeamConsoleSummary = {
  controllerSessionId:'controller',
  team:{id:'layout',title:'布局回归测试',objective:'布局回归测试',status:'running',completedTaskCount:0,runningTaskCount:1,waitingTaskCount:0,attentionTaskCount:0,userDecisionCount:0,controllerActionCount:0,duration:{state:'unavailable'}},
  attention:[], usage:{state:'pending',scope:'受管子 Agent',label:'用量：暂无数据'},
  tasks:[{taskId:'worker',goal:'核对业务地图：检查实际入口和调用关系。',status:'running',childSessionId:'child',modelRole:'worker',model:'model',authorityMode:'read-only',dependencyCount:0,dependencies:[],fileScope:['a.txt'],attemptCount:1,evidenceRecorded:false,usage:{state:'pending',label:'Token：暂无数据'},duration:{state:'unavailable'},nextAction:'完成后提交核验。'}],
}

it('keeps filters in the task rail and the collapsed composer in the detail pane', () => {
  const {container} = render(<TeamPanel summary={summary} nowMs={0} onClose={()=>undefined} onOpenChild={async()=>true} />)
  const rail=screen.getByRole('navigation',{name:'选择任务'})
  expect(within(rail).getByText('筛选')).toBeInTheDocument()
  const composer=container.querySelector('.yuqi-task-composer-disclosure')!
  expect(composer.closest('.yuqi-task-list')).not.toBeNull()
  expect(composer).not.toHaveAttribute('open')
  expect(screen.getByText('完成后提交核验。')).toBeVisible()
})

it('shows the recovery failure once without losing its explanation', () => {
  render(<TeamPanel summary={{...summary,team:{...summary.team,status:'needs_reconciliation'}}} recoveryFailed nowMs={0} onClose={()=>undefined} onOpenChild={async()=>true} />)
  expect(screen.getAllByText(/任务状态核对失败/)).toHaveLength(1)
  const failure=screen.getByText(/任务状态核对失败/)
  expect(failure.closest('[role="alert"]')).not.toBeNull()
  expect(screen.getByText(/尚未恢复执行/)).toBeVisible()
})
