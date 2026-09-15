import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { registerProjectKnowledgeTool } from '../src/agent/project-knowledge-tool.ts'
import { createEmptyProjectSummary, updateProjectSummary, type ProjectSummaryPatch } from '../src/application/project-summary.ts'
import { TEAM_SESSION_EVENT } from '../src/host/harness/session-journal.ts'
import { event, TEAM_ID } from './fixtures.ts'
import { WorkspaceId } from '../src/domain/ids.ts'

function fixture() {
  const root = process.cwd()
  const workspaceId = WorkspaceId('knowledge-workspace')
  const session = Session.create(SessionId('knowledge-controller'), [], { version: 0, id: SessionId('knowledge-controller'), cwd: root, createdAt: 0 })
  const workspace = { workspaceId, project: { mode: 'direct', projectRoot: root, volumeRoot: root, protectedRoots: [] }, worktreePath: root, branchName: 'direct', status: 'provisioning' }
  for (const fact of [
    event(1, { type: 'yuqi/team-created', title: 'Knowledge', objective: 'Record lessons' }),
    event(2, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    event(3, { type: 'yuqi/workspace-provisioning-started', workspace: workspace as never }),
    event(4, { type: 'yuqi/workspace-provisioned', workspaceId }),
  ]) session.append(TEAM_SESSION_EVENT, { event: fact })
  const controller = { id: session.id, session } as Agent
  let stored = createEmptyProjectSummary('2026-09-05T00:00:00Z')
  const service = {
    readProjectSummary: vi.fn(async () => stored),
    updateProjectSummary: vi.fn(async (_root: string, patch: ProjectSummaryPatch) => {
      stored = updateProjectSummary(stored, patch, '2026-09-05T00:00:01Z')
      return stored
    }),
    recordProjectSummary: vi.fn(async () => undefined),
  }
  const context = new Context()
  let tool!: ToolDefinition
  context.provide('tools', { register(value: ToolDefinition) { tool = value } } as never)
  context.provide('yuqiTeamOrchestrator', service as never)
  registerProjectKnowledgeTool(context, async () => ({ controller, teamId: TEAM_ID }))
  const exec = { agent: controller, signal: new AbortController().signal } as ToolRunContext
  return { tool, service, exec, root }
}

describe('controller project knowledge tool', () => {
  it('exposes cleanup and explicit preference semantics in discovery', () => {
    const { tool } = fixture()
    expect(tool.description).toContain('explicitly stated by the user')
    expect(tool.description).toContain('explicitly confirms')
    expect(JSON.stringify(tool)).toContain('confirmed')
    expect(JSON.stringify(tool)).toContain('remove')
    expect(JSON.stringify(tool)).toContain('clear')
  })

  it('dispatches remove and confirmed clear through the service and synchronizes the result', async () => {
    const { tool, service, exec, root } = fixture()
    const item = { id: 'language', text: '用户明确偏好：默认中文', links: [] }
    await tool.execute({ action: 'record', topic: 'conventions', item }, exec)
    await expect(tool.execute({ action: 'remove', topic: 'conventions', id: item.id }, exec))
      .resolves.toMatchObject({ saved: true, panelSynced: true, markdown: expect.not.stringContaining(item.text) })
    expect(service.updateProjectSummary).toHaveBeenLastCalledWith(root, { removeItem: { topic: 'conventions', id: item.id } })
    await tool.execute({ action: 'record', topic: 'conventions', item }, exec)
    service.recordProjectSummary.mockRejectedValueOnce(new Error('panel unavailable'))
    await expect(tool.execute({ action: 'clear', topic: 'conventions', confirmed: true }, exec))
      .resolves.toMatchObject({ saved: true, panelSynced: false, markdown: expect.not.stringContaining(item.text) })
    expect(service.updateProjectSummary).toHaveBeenLastCalledWith(root, { clearTopic: { topic: 'conventions', confirmed: true } })
    await expect(tool.execute({ action: 'read' }, exec)).resolves.toMatchObject({ saved: false, markdown: expect.not.stringContaining(item.text) })
    await expect(tool.execute({ action: 'clear', topic: 'conventions', confirmed: true }, exec)).resolves.toMatchObject({ saved: true })
  })

  it.each([
    { action: 'clear', topic: 'conventions' },
    { action: 'clear', topic: 'conventions', confirmed: false },
    { action: 'clear', topic: 'conventions', confirmed: 'true' },
    { action: 'clear', topic: 'recovery', confirmed: true },
    { action: 'remove', topic: 'pitfalls' },
    { action: 'remove', topic: 'pitfalls', id: '../source.ts' },
    { action: 'remove', topic: 'pitfalls', id: 'entry', confirmed: true },
    { action: 'record', topic: 'documentLinks', item: { id: 'entry', text: 'text', links: [] } },
  ])('rejects invalid cleanup before service dispatch %#', async args => {
    const { tool, service, exec } = fixture()
    await expect(tool.execute(args, exec)).rejects.toThrow()
    expect(service.updateProjectSummary).not.toHaveBeenCalled()
    expect(service.recordProjectSummary).not.toHaveBeenCalled()
  })

  it('records a stable lesson and reads its Markdown without new writes', async () => {
    const { tool, service, exec, root } = fixture()
    const item = { id: 'shutdown', text: 'Confirm termination before reuse; verified by process exit', links: [] }
    await expect(tool.execute({ action: 'record', topic: 'pitfalls', item }, exec)).resolves.toMatchObject({ saved: true, panelSynced: true, markdown: expect.stringContaining(item.text) })
    expect(service.updateProjectSummary).toHaveBeenCalledWith(root, { upsertItem: { topic: 'pitfalls', item } })
    await expect(tool.execute({ action: 'read' }, exec)).resolves.toMatchObject({ saved: false, markdown: expect.stringContaining(item.text) })
    expect(service.updateProjectSummary).toHaveBeenCalledTimes(1)
  })

  it('does not misreport a saved file as lost when panel synchronization fails', async () => {
    const { tool, service, exec } = fixture()
    service.recordProjectSummary.mockRejectedValueOnce(new Error('disconnected'))
    await expect(tool.execute({ action: 'record', topic: 'conventions', item: { id: 'encoding', text: 'UTF-8', links: [] } }, exec))
      .resolves.toMatchObject({ saved: true, panelSynced: false })
  })

  it('rejects cancelled work, malformed input and credential-like records', async () => {
    const { tool, service, exec } = fixture()
    const abort = new AbortController()
    abort.abort()
    await expect(tool.execute({ action: 'read' }, { ...exec, signal: abort.signal })).rejects.toThrow()
    await expect(tool.execute({ action: 'record', topic: 'unknown', item: {} }, exec)).rejects.toThrow()
    expect(service.updateProjectSummary).not.toHaveBeenCalled()
    await expect(tool.execute({ action: 'record', topic: 'pitfalls', item: { id: 'secret', text: 'password=example', links: [] } }, exec)).rejects.toThrow(/credential-like/u)
    expect(service.recordProjectSummary).not.toHaveBeenCalled()
  })
})
