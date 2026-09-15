// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeamConsoleProjectSummary } from '../../src/domain/team-console-contract.ts'
import { ProjectSummarySection } from '../../src/client/ProjectSummarySection.tsx'
import { projectSummarySectionStyles } from '../../src/client/project-summary-section-styles.ts'

afterEach(cleanup)

function summary(patch: Partial<TeamConsoleProjectSummary> = {}): TeamConsoleProjectSummary {
  return { schemaVersion: 1, overallProgress: '', architectureDecisions: [], pitfalls: [], conventions: [], documentLinks: [], updatedAt: '2026-09-12T00:00:00Z', ...patch }
}

const props = { locale: 'zh' as const, teamId: 'team-a', controllerSessionId: 'controller-a', command: vi.fn().mockResolvedValue(true) }

describe('ProjectSummarySection', () => {
  it('uses one empty state for a missing or entirely empty summary', () => {
    const view = render(<ProjectSummarySection {...props} summary={undefined} />)
    expect(screen.getByRole('region', { name: '项目总览' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('暂无项目总览记录')
    view.rerender(<ProjectSummarySection {...props} summary={summary({ overallProgress: '   ' })} />)
    expect(screen.getByRole('status')).toHaveTextContent('暂无项目总览记录')
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('only renders populated categories and keeps real cleanup actions', async () => {
    render(<ProjectSummarySection {...props} summary={summary({
      overallProgress: '已完成入口梳理',
      architectureDecisions: [{ id: 'arch-1', text: '使用稳定契约', links: [] }],
      documentLinks: ['https://example.test/a/path/with-a-very-long-document-name'],
    })} />)
    expect(screen.getByText('项目总览')).toBeInTheDocument()
    expect(screen.getByText('总体进度')).toBeInTheDocument()
    expect(screen.getByText('架构决定')).toBeInTheDocument()
    expect(screen.getByText('文档链接')).toBeInTheDocument()
    expect(screen.queryByText('约定与明确偏好')).not.toBeInTheDocument()
    expect(screen.queryByText('踩坑与解决方法')).not.toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.test/a/path/with-a-very-long-document-name')
    fireEvent.click(screen.getByRole('button', { name: '删除记录' }))
    fireEvent.click(screen.getByRole('button', { name: '确认清理' }))
    await waitFor(() => expect(props.command).toHaveBeenCalledWith(expect.stringMatching(/^\/yuqi knowledge-delete architectureDecisions arch-1 team-a controller-a /u), expect.anything()))
  })

  it('keeps English labels, refresh, and accessible link semantics', () => {
    render(<ProjectSummarySection {...props} locale="en" summary={summary({ overallProgress: 'Progress' })} />)
    expect(screen.getByRole('region', { name: 'Project overview' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh project memory' })).toBeEnabled()
    expect(screen.getByText('Overall progress')).toBeInTheDocument()
    expect(projectSummarySectionStyles).toMatch(/\.yuqi-activity-aligned \.yuqi-project-summary-section/u)
    expect(projectSummarySectionStyles).toContain('.yuqi-activity-aligned .yuqi-project-summary-section .yuqi-insight-links a')
  })
})
