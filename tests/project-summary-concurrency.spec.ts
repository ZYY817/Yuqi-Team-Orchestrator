import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProjectSummary, type ProjectSummaryPatch } from '../src/application/project-summary.ts'
import { NodeProjectSummaryFile, projectSummaryPath } from '../src/host/project-summary-file.ts'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, realpath: vi.fn(actual.realpath), rename: vi.fn(actual.rename) }
})

const now = '2026-08-16T00:00:00.000Z'
const patches: ProjectSummaryPatch[] = [
  { overallProgress: 'Team A progress' },
  { architectureDecisions: [{ id: 'design', text: 'Team B decision', links: [] }] },
  { pitfalls: [{ id: 'pitfall', text: 'Team C finding', links: [] }] },
  { conventions: [{ id: 'style', text: 'Team D convention', links: [] }] },
  { documentLinks: ['./docs/design.md'] },
]

afterEach(() => { vi.clearAllMocks() })

describe('project summary writer coordination', () => {
  it('holds the index queue through publication and publishes fresh data after a queued deletion', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-summary-publish-queue-'))
    const adapter = new NodeProjectSummaryFile(() => now)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pending: Promise<unknown>[] = []
    const published: string[][] = []
    try {
      await adapter.update(root, { conventions: [{ id: 'old', text: 'old preference', links: [] }] })
      pending.push(adapter.publishLatest(root, async summary => {
        entered.resolve()
        await release.promise
        published.push(summary.conventions.map(item => item.id))
      }))
      await entered.promise
      const deleting = new NodeProjectSummaryFile().update(root, { clearTopic: { topic: 'conventions', confirmed: true } })
      pending.push(deleting)
      await vi.waitFor(() => expect(vi.mocked(realpath).mock.results).toHaveLength(3))
      await vi.mocked(realpath).mock.results[2]!.value
      await setImmediate()
      expect(rename).toHaveBeenCalledTimes(1)
      expect((await adapter.read(root)).conventions).toHaveLength(1)
      pending.push(new NodeProjectSummaryFile().publishLatest(root, async summary => {
        published.push(summary.conventions.map(item => item.id))
      }))
      release.resolve()
      await Promise.all(pending)
      expect(published).toEqual([['old'], []])
      expect((await adapter.read(root)).conventions).toEqual([])
    } finally {
      release.resolve()
      await Promise.allSettled(pending)
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['remove', 'clear'] as const)('preserves an addition queued while %s is committing', async action => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-summary-cleanup-queue-'))
    const adapter = new NodeProjectSummaryFile(() => now)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const pending: Promise<unknown>[] = []
    try {
      await adapter.update(root, { upsertItem: { topic: 'conventions', item: { id: 'old', text: 'old preference', links: [] } } })
      vi.mocked(rename).mockImplementationOnce(async (source, target) => {
        entered.resolve()
        await release.promise
        await actual.rename(source, target)
      })
      pending.push(adapter.update(root, action === 'remove'
        ? { removeItem: { topic: 'conventions', id: 'old' } }
        : { clearTopic: { topic: 'conventions', confirmed: true } }))
      await entered.promise
      // Readers see the complete old index until atomic replacement commits.
      expect((await adapter.read(root)).conventions.map(item => item.id)).toEqual(['old'])
      pending.push(new NodeProjectSummaryFile(() => now).update(root, {
        upsertItem: { topic: 'conventions', item: { id: 'new', text: 'new explicit preference', links: [] } },
      }))
      await vi.waitFor(() => expect(vi.mocked(realpath).mock.results).toHaveLength(3))
      await vi.mocked(realpath).mock.results[2]!.value
      await setImmediate()
      expect(rename).toHaveBeenCalledTimes(2)
      release.resolve()
      await Promise.all(pending)
      expect((await adapter.read(root)).conventions.map(item => item.id)).toEqual(['new'])
      expect(await readdir(path.dirname(projectSummaryPath(root)))).toEqual(['index.json'])
    } finally {
      release.resolve()
      await Promise.allSettled(pending)
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['same instance', 'different instances', 'root alias', 'summary directory alias', 'missing nested root'])(
    'preserves concurrent disjoint patches through %s', async mode => {
      const temporary = await mkdtemp(path.join(tmpdir(), 'yuqi-summary-concurrent-'))
      try {
        const root = path.join(temporary, 'project')
        const alias = path.join(temporary, 'alias')
        await mkdir(root)
        let roots = [root]
        if (mode === 'root alias' || mode === 'missing nested root') {
          await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
          roots = mode === 'root alias'
            ? [root, alias]
            : [path.join(root, 'new', 'nested'), path.join(alias, 'new', 'nested')]
        } else if (mode === 'summary directory alias') {
          await mkdir(path.dirname(projectSummaryPath(root)))
          await mkdir(alias)
          await symlink(path.dirname(projectSummaryPath(root)), path.dirname(projectSummaryPath(alias)), process.platform === 'win32' ? 'junction' : 'dir')
          roots = [root, alias]
        }
        const shared = new NodeProjectSummaryFile(() => now)
        await Promise.all(patches.map((patch, index) => {
          const adapter = mode === 'same instance' ? shared : new NodeProjectSummaryFile(() => now)
          return adapter.update(roots[index % roots.length]!, patch)
        }))
        await expect(shared.read(roots[0]!)).resolves.toEqual({
          ...createEmptyProjectSummary(now), ...Object.assign({}, ...patches),
        })
        expect(await readdir(path.dirname(projectSummaryPath(roots[0]!)))).toEqual(['index.json'])
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    },
  )

  it.each(['write', 'update'] as const)('queues %s behind an in-flight update while other projects remain independent', async operation => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-summary-queue-'))
    const other = await mkdtemp(path.join(tmpdir(), 'yuqi-summary-independent-'))
    const adapter = new NodeProjectSummaryFile(() => now)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const pending: Promise<unknown>[] = []
    try {
      vi.mocked(rename).mockImplementationOnce(async (source, target) => {
        entered.resolve()
        await release.promise
        await actual.rename(source, target)
      })
      const updating = adapter.update(root, { overallProgress: 'first update' })
      pending.push(updating)
      await entered.promise
      const replacement = { ...createEmptyProjectSummary(now), documentLinks: ['./replacement.md'] }
      const next = new NodeProjectSummaryFile(() => now)
      const writing = operation === 'write'
        ? next.write(root, replacement)
        : next.update(root, { documentLinks: replacement.documentLinks })
      pending.push(writing)
      // Wait until the second writer has resolved its physical directory and
      // reached the queue; the first rename is still explicitly held open.
      await vi.waitFor(() => expect(vi.mocked(realpath).mock.results).toHaveLength(2))
      await vi.mocked(realpath).mock.results[1]!.value
      await setImmediate()
      expect(rename).toHaveBeenCalledTimes(1)
      await expect(adapter.update(other, { overallProgress: 'independent' })).resolves.toMatchObject({ overallProgress: 'independent' })
      release.resolve()
      await Promise.all(pending)
      await expect(adapter.read(root)).resolves.toEqual(operation === 'write'
        ? replacement
        : { ...replacement, overallProgress: 'first update' })
    } finally {
      release.resolve()
      await Promise.allSettled(pending)
      await rm(root, { recursive: true, force: true })
      await rm(other, { recursive: true, force: true })
    }
  })

  it('releases a failed write for queued writers and cleans its temporary file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-summary-failed-write-'))
    try {
      vi.mocked(rename).mockRejectedValueOnce(new Error('injected rename failure'))
      const results = await Promise.allSettled([
        new NodeProjectSummaryFile(() => now).update(root, patches[0]!),
        new NodeProjectSummaryFile(() => now).update(root, patches[1]!),
      ])
      expect(results.filter(result => result.status === 'rejected')).toEqual([
        { status: 'rejected', reason: expect.objectContaining({ message: 'injected rename failure' }) },
      ])
      const success = results.find(result => result.status === 'fulfilled')
      expect(success?.status).toBe('fulfilled')
      if (success?.status === 'fulfilled') await expect(new NodeProjectSummaryFile().read(root)).resolves.toEqual(success.value)
      expect(await readdir(path.dirname(projectSummaryPath(root)))).toEqual(['index.json'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['{bad', '{"schemaVersion":999}'])('rejects invalid content without overwriting it or poisoning the queue: %s', async raw => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-summary-invalid-'))
    try {
      await mkdir(path.dirname(projectSummaryPath(root)))
      await writeFile(projectSummaryPath(root), raw, 'utf8')
      const results = await Promise.allSettled(patches.slice(0, 2).map(patch => new NodeProjectSummaryFile(() => now).update(root, patch)))
      for (const result of results) {
        expect(result).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringMatching(/invalid or unreadable/u) }) })
      }
      expect(await readFile(projectSummaryPath(root), 'utf8')).toBe(raw)
      const adapter = new NodeProjectSummaryFile(() => now)
      await adapter.write(root, createEmptyProjectSummary(now))
      await expect(adapter.update(root, patches[0]!)).resolves.toMatchObject(patches[0]!)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps explicit array replacement and clearing semantics after concurrent updates', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-summary-replace-'))
    try {
      const adapter = new NodeProjectSummaryFile(() => now)
      const first = [{ id: 'first', text: 'first decision', links: [] }]
      const second = [{ id: 'second', text: 'second decision', links: [] }]
      await adapter.update(root, { architectureDecisions: first })
      await Promise.all([
        adapter.update(root, { architectureDecisions: second }),
        new NodeProjectSummaryFile(() => now).update(root, patches[0]!),
      ])
      await expect(adapter.read(root)).resolves.toMatchObject({ architectureDecisions: second, ...patches[0] })
      await expect(adapter.update(root, { architectureDecisions: [], overallProgress: '' })).resolves.toMatchObject({ architectureDecisions: [], overallProgress: '' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
