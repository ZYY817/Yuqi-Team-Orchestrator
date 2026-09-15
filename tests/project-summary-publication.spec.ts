import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { YuqiTeamOrchestratorService } from '../src/host/harness/service.ts'
import { NodeProjectSummaryFile, projectSummaryPath } from '../src/host/project-summary-file.ts'
import { createEmptyProjectSummary, type ProjectSummary } from '../src/application/project-summary.ts'
import { WorkspaceId } from '../src/domain/ids.ts'
import { event } from './fixtures.ts'

const now = '2026-09-06T00:00:00.000Z'
const stale: ProjectSummary = { ...createEmptyProjectSummary(now), conventions: [{ id: 'language', text: '用户明确偏好：中文', links: [] }] }

function fixture(root: string, original = root) {
  const workspaceId = WorkspaceId('memory-workspace')
  const events = [
    event(1, { type: 'yuqi/team-created', title: 'Memory', objective: 'Publish current knowledge' }),
    event(2, { type: 'yuqi/workspace-provisioning-started', workspace: {
      workspaceId, project: { projectRoot: original, repositoryRoot: original, gitCommonDirectory: path.join(original, '.git'), baselineRef: 'baseline', volumeRoot: path.parse(root).root, protectedRoots: [] },
      worktreePath: root, branchName: 'yuqi/memory', status: 'provisioning',
    } }),
    event(3, { type: 'yuqi/workspace-provisioned', workspaceId }),
  ]
  const commit = vi.fn(async (_summary: ProjectSummary) => undefined)
  const journal = { read: () => events, commitProjectSummary: commit }
  const adapter = new NodeProjectSummaryFile(() => now)
  const service = Object.create(YuqiTeamOrchestratorService.prototype) as YuqiTeamOrchestratorService
  Object.defineProperties(service, { journalFor: { value: () => journal }, projectSummaryFile: { value: adapter } })
  const request = { controller: {} as Agent, summary: stale }
  return { service, adapter, commit, request, events }
}

describe('service publishes canonical project memory', () => {
  it.each(['remove', 'clear'] as const)('cannot resurrect a stale caller snapshot after %s', async action => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-memory-publish-'))
    try {
      const f = fixture(root)
      await f.adapter.write(root, stale)
      await f.adapter.update(root, action === 'remove'
        ? { removeItem: { topic: 'conventions', id: 'language' } }
        : { clearTopic: { topic: 'conventions', confirmed: true } })
      await f.service.recordProjectSummary(f.request)
      expect(f.commit).toHaveBeenCalledExactlyOnceWith(await f.adapter.read(root))
      expect(f.commit.mock.calls[0]![0].conventions).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('uses the execution worktree index instead of the original project or supplied summary', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'yuqi-memory-worktree-'))
    try {
      const root = path.join(temporary, 'worktree')
      const original = path.join(temporary, 'original')
      const f = fixture(root, original)
      await f.adapter.write(original, stale)
      const latest = await f.adapter.update(root, { overallProgress: 'Worktree progress' })
      await f.service.recordProjectSummary(f.request)
      expect(f.commit).toHaveBeenCalledExactlyOnceWith(latest)
      expect(await f.adapter.read(original)).toEqual(stale)
    } finally { await rm(temporary, { recursive: true, force: true }) }
  })

  it('publishes empty missing memory but refuses malformed disk data instead of falling back', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-memory-unavailable-'))
    try {
      const f = fixture(root)
      await f.service.recordProjectSummary(f.request)
      expect(f.commit).toHaveBeenCalledExactlyOnceWith(createEmptyProjectSummary(now))
      await expect(readFile(projectSummaryPath(root))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(path.dirname(projectSummaryPath(root)))).rejects.toMatchObject({ code: 'ENOENT' })
      f.commit.mockClear()
      await mkdir(path.dirname(projectSummaryPath(root)))
      await writeFile(projectSummaryPath(root), '{bad')
      await expect(f.service.recordProjectSummary(f.request)).rejects.toThrow(/invalid or unreadable/u)
      expect(f.commit).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects a workspace that is not ready and releases the queue after publication failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-memory-publish-failure-'))
    try {
      const f = fixture(root)
      const ready = f.events.pop()!
      await expect(f.service.recordProjectSummary(f.request)).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
      expect(f.commit).not.toHaveBeenCalled()
      f.events.push(ready)
      f.commit.mockRejectedValueOnce(new Error('journal unavailable'))
      await expect(f.service.recordProjectSummary(f.request)).rejects.toThrow('journal unavailable')
      await f.adapter.write(root, stale)
      await f.service.recordProjectSummary(f.request)
      expect(f.commit).toHaveBeenLastCalledWith(stale)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rechecks workspace readiness after waiting for the index queue', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-memory-binding-'))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pending: Promise<unknown>[] = []
    try {
      const f = fixture(root)
      pending.push(f.adapter.publishLatest(root, async () => {
        entered.resolve()
        await release.promise
      }))
      await entered.promise
      const publishing = f.service.recordProjectSummary(f.request)
      pending.push(publishing)
      const rejection = expect(publishing).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
      // Simulate the durable workspace no longer being ready while queued.
      f.events.pop()
      release.resolve()
      await rejection
      expect(f.commit).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await Promise.allSettled(pending)
      await rm(root, { recursive: true, force: true })
    }
  })
})
