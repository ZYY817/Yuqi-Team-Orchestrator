// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { chromium } from 'playwright'
import path from 'node:path'
import { ProjectSummarySection } from '../../src/client/ProjectSummarySection.tsx'
import { TaskRow } from '../../src/client/TaskRow.tsx'
import { yuqiTeamStyles } from '../../src/client/styles.ts'

afterEach(cleanup)

it('keeps long memory, confirmation and failed-task actions in flow at desktop and narrow widths', async () => {
  const command = vi.fn().mockResolvedValue(false)
  const view = render(<div className="yuqi-detail-screen"><div className="yuqi-activity-aligned"><ProjectSummarySection locale="zh" teamId="fixture" controllerSessionId="fixture-controller" command={command}
    summary={{ schemaVersion: 1, overallProgress: '', architectureDecisions: [], conventions: [], documentLinks: [], updatedAt: '2026-09-14T00:00:00Z',
      pitfalls: Array.from({ length: 3 }, (_, i) => ({ id: `lesson-${i}`, text: `测试记录 ${i + 1}：${'长文本须自然换行，删除与确认操作应跟随各自记录。'.repeat(18)}`, links: ['docs/' + 'long-path-'.repeat(20) + '.md'] })) }} /></div></div>)
  fireEvent.click(screen.getAllByRole('button', { name: '删除记录' })[0]!)
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const html = () => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Yuqi source fixture</title><style>${yuqiTeamStyles}</style><style>body{margin:0;font-family:Arial,sans-serif}.yuqi-detail-screen{position:static;width:auto;max-width:none;height:auto;max-height:none;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}</style></head><body>${view.container.innerHTML}</body></html>`
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.setContent(html())
      expect(await page.title()).toBe('Yuqi source fixture')
      expect(await page.getByRole('button', { name: '确认清理' }).isVisible()).toBe(true)
      const geometry = await page.locator('.yuqi-insight-list li').evaluateAll(items => items.map(item => {
        const text = item.querySelector('span')!.getBoundingClientRect()
        const actions = item.querySelector('.yuqi-knowledge-actions')!.getBoundingClientRect()
        return { textBottom: text.bottom, actionsTop: actions.top, right: item.getBoundingClientRect().right }
      }))
      for (const item of geometry) { expect(item.actionsTop).toBeGreaterThanOrEqual(item.textBottom); expect(item.right).toBeLessThanOrEqual(width) }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      if (process.env.YUQI_QA_OUTPUT) await page.screenshot({ path: path.join(process.env.YUQI_QA_OUTPUT, `yuqi-memory-${width}.png`), fullPage: true })
    }
    fireEvent.click(screen.getByRole('button', { name: '保留记录' }))
    expect(command).not.toHaveBeenCalled()
    view.rerender(<div className="yuqi-detail-screen"><TaskRow index={0} teamId="fixture" teamStatus="needs_reconciliation" controllerSessionId="fixture-controller" command={command} nowMs={0} onOpenChild={async () => true} initiallyExpanded workbenchDetail task={{ taskId: 'failed', goal: '失败任务：核对代码地图', status: 'failed', modelRole: 'worker', model: 'model', authorityMode: 'write-authorized', dependencyCount: 0, dependencies: [], fileScope: ['docs/map.md'], attemptCount: 1, evidenceRecorded: false, usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '需通过安全门禁' }} /></div>)
    fireEvent.click(screen.getByText('准备上下文交给主控处理'))
    await page.setContent(html())
    expect(await page.getByRole('button', { name: '重试任务' }).isDisabled()).toBe(true)
    expect(await page.getByRole('textbox', { name: '失败任务处理上下文' }).isVisible()).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    if (process.env.YUQI_QA_OUTPUT) await page.screenshot({ path: path.join(process.env.YUQI_QA_OUTPUT, 'yuqi-failed-390.png'), fullPage: true })
    expect(errors).toEqual([])
  } finally { await browser.close() }
})
