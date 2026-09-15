import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { executeYuqiCommand, type YuqiCommandService } from '../src/host/harness/commands.ts'
import { TEAM_SESSION_EVENT, TEAM_PARENT_BINDING_EVENT, TEAM_PARENT_PROJECTION_EVENT } from '../src/host/harness/session-journal.ts'
import { WorkspaceId } from '../src/domain/ids.ts'
import { completeTeamEvents, event } from './fixtures.ts'

function setup(ready = true) {
  const facts = [...completeTeamEvents().slice(0, 4), event(80, { type: 'yuqi/workspace-provisioning-started', workspace: {
    workspaceId: WorkspaceId('knowledge-workspace'), status: 'provisioning', worktreePath: 'F:/managed/worktree', branchName: 'yuqi/test',
    project: { projectRoot: 'F:/repo/app', repositoryRoot: 'F:/repo', gitCommonDirectory: 'F:/repo/.git', baselineRef: 'commit-1', volumeRoot: 'F:/', protectedRoots: [] },
  } })]
  if (ready) facts.push(event(81, { type: 'yuqi/workspace-provisioned', workspaceId: WorkspaceId('knowledge-workspace') }))
  const controllerSession = Session.create(SessionId('knowledge-controller'))
  const parent = Session.create(SessionId('knowledge-parent'))
  for (const fact of facts) controllerSession.append(TEAM_SESSION_EVENT, { event: fact })
  controllerSession.append(TEAM_PARENT_BINDING_EVENT, { parentSessionId: String(parent.id), generation: 1, operationId: 'bind', boundAt: '2026-09-06T00:00:00Z' })
  parent.append(TEAM_PARENT_PROJECTION_EVENT, { controllerSessionId: String(controllerSession.id), sourceEventCount: facts.length, events: facts })
  const controller = { id: controllerSession.id, session: controllerSession } as Agent
  const stored = { schemaVersion: 1 as const, overallProgress: 'Current disk memory', architectureDecisions: [], pitfalls: [], conventions: [], documentLinks: [], updatedAt: '2026-09-06T00:00:00Z' }
  const readProjectSummary = vi.fn(async () => stored)
  const recordProjectSummary = vi.fn(async () => undefined)
  const updateProjectSummary = vi.fn()
  const service = { readProjectSummary, recordProjectSummary, updateProjectSummary } as unknown as YuqiCommandService
  const resolve = vi.fn(async () => controller)
  const signal = new AbortController()
  const run = (rawInput = 'knowledge-refresh team-1 knowledge-controller refresh-1', session = parent) => executeYuqiCommand({
    rawInput, agent: { id: session.id, session } as Agent, commandId: CommandId('refresh-command'), attachments: [], signal: signal.signal,
  }, service, resolve)
  return { run, controller, stored, readProjectSummary, recordProjectSummary, updateProjectSummary, resolve, service, signal }
}

describe('knowledge-refresh exact command binding', () => {
  it.each([false, true])('reads then publishes without saving the index (controller-local=%s)', async local => {
    const h = setup()
    const result = await h.run(undefined, local ? h.controller.session : undefined)
    expect(result.kind).toBe('success')
    expect(JSON.parse(result.text!)).toMatchObject({ saved: false, panelSynced: true, teamId: 'team-1', controllerSessionId: 'knowledge-controller' })
    expect(h.readProjectSummary).toHaveBeenCalledWith(path.resolve('F:/managed/worktree', 'app'))
    expect(h.recordProjectSummary).toHaveBeenCalledWith({ controller: h.controller, summary: h.stored })
    expect(h.readProjectSummary.mock.invocationCallOrder[0]!).toBeLessThan(h.recordProjectSummary.mock.invocationCallOrder[0]!)
    expect(h.updateProjectSummary).not.toHaveBeenCalled()
  })

  it.each(['knowledge-refresh', 'knowledge-refresh refresh-1', 'knowledge-refresh wrong-team knowledge-controller refresh-1', 'knowledge-refresh team-1 wrong-controller refresh-1', 'knowledge-refresh team-1 knowledge-controller bad/id'])('rejects incomplete or incorrect identity: %s', async input => {
    const h = setup()
    expect((await h.run(input)).kind).toBe('error')
    expect(h.readProjectSummary).not.toHaveBeenCalled()
    expect(h.recordProjectSummary).not.toHaveBeenCalled()
  })

  it.each(['workspace', 'unavailable', 'rebound', 'aborted', 'unsupported'])('rejects %s without reading or publishing', async state => {
    const h = setup(state !== 'workspace')
    if (state === 'unavailable') h.resolve.mockResolvedValue(undefined as never)
    if (state === 'rebound') h.controller.session.append(TEAM_PARENT_BINDING_EVENT, { parentSessionId: 'new-parent', generation: 2, operationId: 'rebind', boundAt: '2026-09-06T00:01:00Z' })
    if (state === 'aborted') h.signal.abort()
    if (state === 'unsupported') delete h.service.recordProjectSummary
    expect((await h.run()).kind).toBe('error')
    expect(h.readProjectSummary).not.toHaveBeenCalled()
    expect(h.recordProjectSummary).not.toHaveBeenCalled()
    expect(h.updateProjectSummary).not.toHaveBeenCalled()
  })

  it.each(['read', 'publish'])('reports %s failure as an error without claiming panel synchronization', async phase => {
    const h = setup()
    if (phase === 'read') h.readProjectSummary.mockRejectedValue(new Error('read failed'))
    else h.recordProjectSummary.mockRejectedValue(new Error('publication failed'))
    const result = await h.run()
    expect(result.kind).toBe('error')
    expect(result.text).not.toContain('"panelSynced":true')
    if (phase === 'read') expect(h.recordProjectSummary).not.toHaveBeenCalled()
    expect(h.updateProjectSummary).not.toHaveBeenCalled()
  })
})
