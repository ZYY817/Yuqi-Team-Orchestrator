import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createEmptyProjectSummary,
  updateProjectSummary,
  upsertProjectSummaryItem,
  renderProjectSummaryMarkdown,
  projectKnowledgeSnapshot,
} from '../src/application/project-summary.ts'
import { NodeProjectSummaryFile, projectSummaryPath } from '../src/host/project-summary-file.ts'

describe('project-local summary index', () => {
  it('preserves concurrent lesson additions and renders the canonical record as Markdown', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-lessons-'))
    try {
      await Promise.all(['one', 'two'].map(id => new NodeProjectSummaryFile().update(root, {
        upsertItem: { topic: 'pitfalls', item: { id, text: `Symptom ${id}; verified remedy; verification pending`, links: [] } },
      })))
      const summary = await new NodeProjectSummaryFile().read(root)
      expect(summary.pitfalls.map(item => item.id).sort()).toEqual(['one', 'two'])
      const markdown = renderProjectSummaryMarkdown(summary)
      expect(markdown).toContain('Lessons / 踩坑与处理经验')
      expect(markdown).toContain('Symptom one')
      expect(markdown).toContain('Symptom two')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('creates, reads, updates UTF-8 short entries and keeps the file inside the project root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-summary-'))
    try {
      const file = new NodeProjectSummaryFile(() => '2026-08-16T00:00:00.000Z')
      const first = await file.update(root, {
        overallProgress: '已完成摘要索引接入。',
        documentLinks: ['./docs/architecture.md', 'https://example.com/design'],
      })
      const item = { id: 'architecture-1', text: 'Team event stream 是运行态唯一事实源。', links: ['./docs/architecture.md'] }
      const second = await file.update(root, {
        architectureDecisions: upsertProjectSummaryItem(first.architectureDecisions, item),
        pitfalls: [{ id: 'pitfall-1', text: '先验证真实 Host 证据。', links: ['./HOST-EVIDENCE-AUDIT.md'] }],
        conventions: [{ id: 'utf8', text: '项目文件使用 UTF-8。', links: [] }],
      })
      const read = await file.read(root)
      const raw = await readFile(projectSummaryPath(root), 'utf8')
      expect(read).toEqual(second)
      expect(raw).toContain('Team event stream')
      expect(raw).toContain('项目文件使用 UTF-8')
      expect(path.dirname(projectSummaryPath(root))).toBe(path.join(root, '.yuqi-team'))
      expect(read.architectureDecisions).toHaveLength(1)
      expect(read.pitfalls).toHaveLength(1)
      expect(read.documentLinks).toEqual(['./docs/architecture.md', 'https://example.com/design'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not write credential-like text or unsafe absolute links', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-summary-safe-'))
    try {
      const file = new NodeProjectSummaryFile(() => '2026-08-16T00:00:00.000Z')
      await expect(file.update(root, { overallProgress: 'token=should-not-be-written' })).rejects.toThrow(/credential-like/u)
      await expect(file.update(root, { documentLinks: ['C:\\Users\\secret.txt'] })).rejects.toThrow()
      await expect(file.update(root, { documentLinks: ['https://example.com/safe'] })).resolves.toMatchObject({ documentLinks: ['https://example.com/safe'] })
      expect(() => projectSummaryPath('relative-project')).toThrow(/absolute project root/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('bounds the index and preserves a deterministic empty shape', () => {
    const empty = createEmptyProjectSummary('2026-08-16T00:00:00.000Z')
    expect(empty).toMatchObject({ schemaVersion: 1, overallProgress: '', architectureDecisions: [], pitfalls: [], conventions: [], documentLinks: [] })
    const items = Array.from({ length: 12 }, (_, index) => ({ id: `item-${index}`, text: `条目 ${index}`, links: [] }))
    const updated = updateProjectSummary(empty, { architectureDecisions: items }, '2026-08-16T00:00:01.000Z')
    expect(updated.architectureDecisions).toHaveLength(12)
    expect(() => upsertProjectSummaryItem(items, { id: 'extra', text: 'new', links: [] })).toThrow(/Existing lessons were not removed/u)
    expect(upsertProjectSummaryItem(items, { id: 'item-0', text: 'revised', links: [] })).toHaveLength(12)
    const snapshot = JSON.parse(projectKnowledgeSnapshot(updated))
    expect(snapshot.architectureDecisions).toHaveLength(6)
    expect(snapshot.note).toContain('Condensed reference')
    expect(updated.architectureDecisions).toHaveLength(12)
  })

  it('reads a missing file as an empty index and rejects malformed JSON', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'yuqi-summary-read-'))
    try {
      const file = new NodeProjectSummaryFile(() => '2026-08-16T00:00:00.000Z')
      await expect(file.read(root)).resolves.toMatchObject({ schemaVersion: 1, overallProgress: '', updatedAt: '2026-08-16T00:00:00.000Z' })
      await expect(readFile(projectSummaryPath(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(new NodeProjectSummaryFile().read(root)).resolves.toMatchObject({ schemaVersion: 1, updatedAt: expect.any(String) })
      await file.write(root, createEmptyProjectSummary('2026-08-16T00:00:00.000Z'))
      const target = projectSummaryPath(root)
      await (await import('node:fs/promises')).writeFile(target, '{bad', 'utf8')
      await expect(file.read(root)).rejects.toThrow(/invalid or unreadable/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('atomically replaces complete files with explicit last-write-wins semantics', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-summary-atomic-'))
    try {
      const file = new NodeProjectSummaryFile()
      await file.write(root, updateProjectSummary(createEmptyProjectSummary('2026-08-16T00:00:00.000Z'), { overallProgress: 'first' }, '2026-08-16T00:00:01.000Z'))
      const last = updateProjectSummary(createEmptyProjectSummary('2026-08-16T00:00:00.000Z'), { overallProgress: 'last' }, '2026-08-16T00:00:02.000Z')
      await file.write(root, last)
      await expect(file.read(root)).resolves.toEqual(last)
      expect(await readdir(path.dirname(projectSummaryPath(root)))).toEqual(['index.json'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
