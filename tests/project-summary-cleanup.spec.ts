import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createEmptyProjectSummary, updateProjectSummary, type ProjectSummaryPatch,
} from '../src/application/project-summary.ts'
import { NodeProjectSummaryFile, projectSummaryPath } from '../src/host/project-summary-file.ts'

const now = '2026-09-06T00:00:00.000Z'
const later = '2026-09-06T01:00:00.000Z'
const item = (id: string) => ({ id, text: `Explicit record ${id}`, links: ['./source.ts'] })
const seeded = () => updateProjectSummary(createEmptyProjectSummary(now), {
  architectureDecisions: [item('shared')], pitfalls: [item('shared'), item('keep')],
  conventions: [item('preference')], documentLinks: ['./source.ts'], overallProgress: 'ongoing',
}, now)

describe('bounded memory deletion', () => {
  it('atomically clears all memory in the execution index, preserving other workspaces and files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-all-cleanup-'))
    try {
      const adapter = new NodeProjectSummaryFile(() => later)
      const other = path.join(root, 'other-workspace')
      await adapter.write(root, seeded())
      await adapter.write(other, seeded())
      await writeFile(path.join(root, 'source.ts'), 'source sentinel')
      const patch = { clearTopic: { topic: 'all', confirmed: true } } as const
      await adapter.update(root, patch)
      expect(await adapter.read(root)).toEqual(createEmptyProjectSummary(later))
      expect(await adapter.read(other)).toEqual(seeded())
      expect(await readFile(path.join(root, 'source.ts'), 'utf8')).toBe('source sentinel')
      const before = (await stat(projectSummaryPath(root))).mtimeMs
      await adapter.update(root, patch)
      expect((await stat(projectSummaryPath(root))).mtimeMs).toBe(before)
      await expect(adapter.update(root, { clearTopic: { topic: 'all', confirmed: false } } as never)).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('removes only the selected topic/id and is idempotent including updatedAt', () => {
    const before = seeded()
    const patch = { removeItem: { topic: 'pitfalls', id: 'shared' } } as const
    const after = updateProjectSummary(before, patch, later)
    expect(after).toEqual({ ...before, pitfalls: [item('keep')], updatedAt: later })
    expect(updateProjectSummary(after, patch, now)).toBe(after)
  })

  it.each(['architectureDecisions', 'pitfalls', 'conventions', 'documentLinks', 'overallProgress'] as const)(
    'clears only confirmed category %s and preserves v1 shape', topic => {
      const before = seeded()
      const patch = { clearTopic: { topic, confirmed: true } } as const
      const after = updateProjectSummary(before, patch, later)
      expect(after).toEqual({ ...before, [topic]: topic === 'overallProgress' ? '' : [], updatedAt: later })
      expect(updateProjectSummary(after, patch, now)).toBe(after)
      expect(after.schemaVersion).toBe(1)
    },
  )

  it.each([
    { clearTopic: { topic: 'pitfalls' } },
    { clearTopic: { topic: 'pitfalls', confirmed: false } },
    { clearTopic: { topic: 'runtime', confirmed: true } },
    { clearTopic: { topic: 'recovery', confirmed: true } },
    { removeItem: { topic: 'documentLinks', id: 'shared' } },
    { removeItem: { topic: 'pitfalls', id: '../source.ts' } },
    { removeItem: { topic: 'pitfalls', id: 'shared', path: './source.ts' } },
    { removeItem: { topic: 'pitfalls', id: 'shared' }, overallProgress: 'stale' },
    { removeItem: { topic: 'pitfalls', id: 'shared' }, clearTopic: { topic: 'pitfalls', confirmed: true } },
  ])('rejects invalid or ambiguous deletion %#', patch => {
    expect(() => updateProjectSummary(seeded(), patch as ProjectSummaryPatch, later)).toThrow()
  })

  it('serializes deletion with concurrent additions and leaves linked source/recovery files untouched', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-cleanup-'))
    try {
      const adapter = new NodeProjectSummaryFile(() => later)
      await adapter.write(root, seeded())
      const source = path.join(root, 'source.ts')
      const recovery = path.join(root, '.yuqi-team', 'recovery.json')
      await writeFile(source, 'source sentinel')
      await writeFile(recovery, 'recovery sentinel')
      await Promise.all([
        adapter.update(root, { removeItem: { topic: 'pitfalls', id: 'shared' } }),
        new NodeProjectSummaryFile().update(root, { upsertItem: { topic: 'pitfalls', item: item('new') } }),
        new NodeProjectSummaryFile().update(root, { clearTopic: { topic: 'conventions', confirmed: true } }),
        new NodeProjectSummaryFile().update(root, { upsertItem: { topic: 'architectureDecisions', item: item('new-decision') } }),
      ])
      const after = await adapter.read(root)
      expect(after.pitfalls.map(entry => entry.id).sort()).toEqual(['keep', 'new'])
      expect(after.architectureDecisions.map(entry => entry.id).sort()).toEqual(['new-decision', 'shared'])
      expect(after.conventions).toEqual([])
      expect(after.documentLinks).toEqual(['./source.ts'])
      expect(after.overallProgress).toBe('ongoing')
      expect(await readFile(source, 'utf8')).toBe('source sentinel')
      expect(await readFile(recovery, 'utf8')).toBe('recovery sentinel')
      const raw = await readFile(projectSummaryPath(root), 'utf8')
      const metadata = await stat(projectSummaryPath(root))
      await adapter.update(root, { removeItem: { topic: 'pitfalls', id: 'shared' } })
      await adapter.update(root, { clearTopic: { topic: 'conventions', confirmed: true } })
      expect(await readFile(projectSummaryPath(root), 'utf8')).toBe(raw)
      expect((await stat(projectSummaryPath(root))).mtimeMs).toBe(metadata.mtimeMs)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not create a missing index for a no-op or overwrite malformed old data', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-cleanup-empty-'))
    try {
      const adapter = new NodeProjectSummaryFile(() => now)
      await adapter.update(root, { removeItem: { topic: 'pitfalls', id: 'missing' } })
      await adapter.update(root, { clearTopic: { topic: 'conventions', confirmed: true } })
      await expect(readFile(projectSummaryPath(root))).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(projectSummaryPath(root), '{bad')
      await expect(adapter.update(root, { clearTopic: { topic: 'pitfalls', confirmed: true } })).rejects.toThrow(/invalid or unreadable/u)
      expect(await readFile(projectSummaryPath(root), 'utf8')).toBe('{bad')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
