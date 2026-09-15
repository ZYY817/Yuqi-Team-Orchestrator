import { afterEach, describe, expect, it, vi } from 'vitest'
import { snapshotOnlySession } from './snapshot-session-fixture.ts'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { GitWorkspacePort } from '../src/application/workspace-ports.ts'
import { HarnessContinuableChildPort } from '../src/host/harness/continuable-child.ts'
import * as sidecar from '../src/host/storage/session-sidecar.ts'
import { boundedSnapshotOperation, captureWorkspaceSnapshot, compareWorkspaceSnapshots, WORKSPACE_CHANGE_SNAPSHOT_EVENT } from '../src/host/workspace-change-snapshot.ts'

const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function workspace() {
  const directory = await mkdtemp(path.join(tmpdir(), 'yuqi-snapshot-'))
  directories.push(directory)
  return directory
}

describe('bounded workspace observations', () => {
  it('detects added, same-size modified and deleted files without storing content', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'changed.txt'), 'before')
    await writeFile(path.join(root, 'deleted.txt'), 'remove')
    const before = await captureWorkspaceSnapshot(root)
    await writeFile(path.join(root, 'changed.txt'), 'after!')
    await rm(path.join(root, 'deleted.txt'))
    await writeFile(path.join(root, 'added.txt'), 'new')
    const event = compareWorkspaceSnapshots(before, await captureWorkspaceSnapshot(root), 'child', 'run')
    expect(event).toMatchObject({ version: 1, scope: 'workspace', attribution: 'unavailable', partial: false })
    expect(event.changes.map(({ path, kind }) => [path, kind])).toEqual([
      ['added.txt', 'added'], ['changed.txt', 'modified'], ['deleted.txt', 'deleted'],
    ])
    expect(event.changes[1]?.before?.size).toBe(event.changes[1]?.after?.size)
    expect(event.changes[1]?.before?.sha256).not.toBe(event.changes[1]?.after?.sha256)
    expect(JSON.stringify(event)).not.toContain('after!')
    expect(JSON.stringify(event)).not.toContain(root)
  })

  it('excludes generated directories and credentials while observing ordinary additions', async () => {
    const root = await workspace()
    for (const name of ['.git', 'node_modules', '.yuqi-team', 'build', 'dist']) {
      await mkdir(path.join(root, name))
      await writeFile(path.join(root, name, 'private.txt'), 'secret')
    }
    await writeFile(path.join(root, '.env'), 'SECRET=never-record')
    await writeFile(path.join(root, 'private.key'), 'never-record')
    await mkdir(path.join(root, 'lib'))
    await writeFile(path.join(root, 'lib', 'source.ts'), 'old source')
    const before = await captureWorkspaceSnapshot(root)
    await writeFile(path.join(root, 'ordinary.txt'), 'yes')
    await writeFile(path.join(root, 'lib', 'source.ts'), 'new source')
    const after = await captureWorkspaceSnapshot(root)
    const event = compareWorkspaceSnapshots(before, after, 'child', 'run')
    expect(event.partial).toBe(true)
    expect(event.reasons).toEqual(expect.arrayContaining(['excluded', 'excluded-directory:build', 'excluded-directory:dist', 'sensitive-excluded']))
    expect(event.changes.map(change => change.path)).toEqual(['lib/source.ts', 'ordinary.txt'])
    expect(JSON.stringify(event)).not.toContain('never-record')
  })

  it('does not follow a directory symlink or a symlink workspace root', async () => {
    const root = await workspace()
    const outside = await workspace()
    await writeFile(path.join(outside, 'outside.txt'), 'private')
    await symlink(outside, path.join(root, 'link'), 'junction')
    const snapshot = await captureWorkspaceSnapshot(root)
    expect(snapshot.files.size).toBe(0)
    expect(snapshot.reasons).toContain('symlink-excluded')
    await rm(path.join(root, 'link'))
    await writeFile(path.join(root, 'link'), 'now a regular file')
    const regular = await captureWorkspaceSnapshot(root)
    expect(compareWorkspaceSnapshots(snapshot, regular, 'c', 'r').changes).toEqual([])
    expect(compareWorkspaceSnapshots(regular, snapshot, 'c', 'r').changes).toEqual([])
    await rm(path.join(root, 'link'))
    await symlink(outside, path.join(root, 'link'), 'junction')
    const linked = await captureWorkspaceSnapshot(path.join(root, 'link'))
    expect(linked.files.size).toBe(0)
    expect(linked.partial).toBe(true)
  })

  it('bounds file count, entry count, bytes and change output without false deletions', async () => {
    const root = await workspace()
    for (const name of ['a', 'b', 'c']) await writeFile(path.join(root, name), '1234')
    const full = await captureWorkspaceSnapshot(root)
    const limited = await captureWorkspaceSnapshot(root, { maxFiles: 1 })
    expect(limited.files.size).toBeLessThanOrEqual(1)
    expect(limited.partial).toBe(true)
    expect(compareWorkspaceSnapshots(full, limited, 'c', 'r').changes).toEqual([])
    expect((await captureWorkspaceSnapshot(root, { maxEntries: 1 })).partial).toBe(true)
    expect((await captureWorkspaceSnapshot(root, { maxFileBytes: 2 })).files.size).toBe(0)
    expect((await captureWorkspaceSnapshot(root, { maxTotalBytes: 4 })).files.size).toBeLessThanOrEqual(1)
    const emptyRoot = await workspace()
    const empty = await captureWorkspaceSnapshot(emptyRoot, { maxChanges: 1 })
    const changed = compareWorkspaceSnapshots({ ...empty, root }, full, 'c', 'r')
    expect(changed.changes).toHaveLength(1)
    expect(changed.reasons).toContain('change-limit')
    expect(compareWorkspaceSnapshots(empty, full, 'c', 'r').reasons).toContain('workspace-mismatch')
  })

  it('contains missing roots and cancellation; bounded work cannot hang its caller', async () => {
    const root = await workspace()
    expect((await captureWorkspaceSnapshot(path.join(root, 'missing'))).partial).toBe(true)
    const controller = new AbortController()
    controller.abort()
    expect((await captureWorkspaceSnapshot(root, {}, controller.signal)).reasons).toContain('cancelled')
    vi.useFakeTimers()
    const pending = boundedSnapshotOperation(() => new Promise(() => {}), 25)
    await vi.advanceTimersByTimeAsync(25)
    await expect(pending).resolves.toBeUndefined()
  })
})

async function harness(options: { early?: boolean; failStart?: boolean; flush?: 'false' | 'throw' | 'hang'; appendFailure?: boolean; snapshotOnly?: boolean;
  root?: string; childId?: string; fileName?: string; beforeWrite?: () => Promise<void> } = {}) {
  const root = options.root ?? await workspace()
  const parent = Session.create(SessionId('snapshot-parent'), [], { ...Session.create(SessionId('snapshot-parent')).header, cwd: root })
  const childId = SessionId(options.childId ?? 'snapshot-child')
  const child = Session.create(childId, [], { ...Session.create(childId).header, cwd: root, parentSession: parent.id })
  const handlers = new Set<(info: SubagentRunEndInfo) => void>()
  let stored: SessionEvent[] = [...child.events]
  const end = { id: child.id, runId: 'snapshot-run', provider: 'in-process', stopReason: 'completed', lastAssistantMessage: [] } as unknown as SubagentRunEndInfo
  const emit = () => { for (const listener of [...handlers]) listener(end) }
  const persistence = {
    readFrom: vi.fn(async () => ({ meta: child.header, events: [...stored] })),
    append: vi.fn(async (_id: unknown, tail: SessionEvent[]) => {
      if (options.appendFailure) throw new Error('persistence failed')
      stored.push(...JSON.parse(JSON.stringify(tail)))
    }),
  }
  const access = {
    get: () => options.snapshotOnly ? snapshotOnlySession(child) : child,
    flush: vi.fn(async () => {
      if (options.flush === 'hang') return new Promise<boolean>(() => {})
      if (options.flush === 'throw') throw new Error('detached')
      if (options.flush === 'false') return false
      stored = JSON.parse(JSON.stringify(child.events))
      return true
    }),
  }
  const ctx = {
    on: (_name: string, callback: (info: SubagentRunEndInfo) => void) => { handlers.add(callback); return () => { handlers.delete(callback) } },
    get: () => access,
    subagents: {
      startContinuable: vi.fn(async () => {
        if (options.failStart) throw new Error('start failed')
        await options.beforeWrite?.()
        await promisify(execFile)(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "external program output")', path.join(root, options.fileName ?? 'external.txt')])
        if (options.early) emit()
        return { childId: child.id, messageId: 'message' }
      }),
      interrupt: vi.fn(),
    },
    sessionPersistence: persistence,
  } as unknown as Context
  const agent = { id: parent.id, session: parent, ctx } as Agent
  const port = new HarnessContinuableChildPort(ctx, agent, {} as GitWorkspacePort)
  const controller = new AbortController()
  const request = { subagentProvider: 'in-process', label: 'test', prompt: [], modelProvider: 'test', modelId: 'test', maxDepth: 1, signal: controller.signal }
  return { root, child, port, request, controller, handlers, emit, persistence, access, stored: () => stored }
}

describe('child snapshot lifecycle', () => {
  it('awaits sidecar append on the retained child even after an early end, without Host persistence', async () => {
    const h = await harness({ early: true })
    vi.spyOn(sidecar, 'hasSidecarSession').mockImplementation(session => session === h.child)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const append = vi.spyOn(sidecar, 'appendSidecarEvent').mockImplementation(async (_session, type, data) => {
      await gate
      return { type, data } as SessionEvent
    })
    const nativeAppend = vi.spyOn(h.child, 'append').mockImplementation(() => { throw new Error('Host append forbidden') })
    const settled = vi.fn()
    const dispose = h.port.onEnd(settled)
    try {
      await h.port.start(h.request)
      await vi.waitFor(() => expect(append).toHaveBeenCalledOnce())
      expect(append).toHaveBeenCalledWith(h.child, WORKSPACE_CHANGE_SNAPSHOT_EVENT, expect.objectContaining({ childSessionId: String(h.child.id) }))
      expect(settled).not.toHaveBeenCalled()
      release()
      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
      expect(nativeAppend).not.toHaveBeenCalled()
      expect(h.access.flush).not.toHaveBeenCalled()
      expect(h.persistence.readFrom).not.toHaveBeenCalled()
      expect(h.persistence.append).not.toHaveBeenCalled()
    } finally {
      release()
      h.port.interrupt(String(h.child.id))
      dispose()
    }
  })

  it('keeps failed optional sidecar evidence out of Host history and still delivers child end', async () => {
    const h = await harness()
    vi.spyOn(sidecar, 'hasSidecarSession').mockReturnValue(true)
    const append = vi.spyOn(sidecar, 'appendSidecarEvent').mockRejectedValue(new Error('sidecar failed'))
    const nativeAppend = vi.spyOn(h.child, 'append')
    const settled = vi.fn()
    const dispose = h.port.onEnd(settled)
    try {
      await h.port.start(h.request)
      h.emit()
      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
      expect(append).toHaveBeenCalledOnce()
      expect(nativeAppend).not.toHaveBeenCalled()
      expect(h.access.flush).not.toHaveBeenCalled()
      expect(h.persistence.readFrom).not.toHaveBeenCalled()
      expect(h.persistence.append).not.toHaveBeenCalled()
    } finally {
      h.port.interrupt(String(h.child.id))
      dispose()
    }
  })

  it.each(['id', 'parentSession', 'cwd'] as const)('preserves the child %s boundary before sidecar writes', async field => {
    const h = await harness()
    const wrong = Session.create(SessionId(field === 'id' ? 'unrelated' : String(h.child.id)), [], {
      ...h.child.header,
      id: SessionId(field === 'id' ? 'unrelated' : String(h.child.id)),
      ...(field === 'parentSession' ? { parentSession: SessionId('unrelated') } : {}),
      ...(field === 'cwd' ? { cwd: path.join(h.root, 'unrelated') } : {}),
    })
    vi.spyOn(h.access, 'get').mockReturnValue(wrong)
    vi.spyOn(sidecar, 'hasSidecarSession').mockReturnValue(true)
    const append = vi.spyOn(sidecar, 'appendSidecarEvent')
    const settled = vi.fn()
    const dispose = h.port.onEnd(settled)
    try {
      await h.port.start(h.request)
      h.emit()
      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
      expect(append).not.toHaveBeenCalled()
      expect(h.access.flush).not.toHaveBeenCalled()
      expect(h.persistence.append).not.toHaveBeenCalled()
    } finally {
      h.port.interrupt(String(h.child.id))
      dispose()
    }
  })

  it('persists the appended tail from a snapshot-only child after store flush fails', async () => {
    const h = await harness({ snapshotOnly: true, flush: 'false' })
    const settled = vi.fn()
    const dispose = h.port.onEnd(settled)
    try {
      await h.port.start(h.request)
      h.emit()
      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
      expect(h.persistence.append).toHaveBeenCalledOnce()
      expect(h.stored().filter(event => event.type === WORKSPACE_CHANGE_SNAPSHOT_EVENT)).toHaveLength(1)
    } finally {
      h.port.interrupt(String(h.child.id))
      dispose()
    }
  })
  it('observes both concurrent writers without attributing shared changes to either child', async () => {
    const root = await workspace()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let started = 0
    const beforeWrite = async () => { started++; await gate }
    const one = await harness({ root, childId: 'one', fileName: 'one.txt', beforeWrite })
    const two = await harness({ root, childId: 'two', fileName: 'two.txt', beforeWrite })
    const starting = Promise.all([one.port.start(one.request), two.port.start(two.request)])
    await vi.waitFor(() => expect(started).toBe(2))
    release()
    await starting
    one.emit()
    two.emit()
    await vi.waitFor(() => {
      for (const h of [one, two]) expect(h.stored().filter(event => event.type === WORKSPACE_CHANGE_SNAPSHOT_EVENT)).toHaveLength(1)
    })
    for (const h of [one, two]) {
      const event = h.stored().find(event => event.type === WORKSPACE_CHANGE_SNAPSHOT_EVENT)!
      expect(event.data).toMatchObject({ scope: 'workspace', attribution: 'unavailable',
        changes: [{ path: 'one.txt', kind: 'added' }, { path: 'two.txt', kind: 'added' }] })
      expect(event.data).not.toHaveProperty('owner')
      h.port.interrupt(String(h.child.id))
    }
  })

  it.each([undefined, 'false', 'throw'] as const)('persists a real ignorable child event before onEnd (flush=%s)', async flush => {
    const h = await harness(flush === undefined ? {} : { flush })
    const settled = vi.fn(() => {
      expect(h.stored().filter(event => event.type === WORKSPACE_CHANGE_SNAPSHOT_EVENT)).toHaveLength(1)
    })
    const dispose = h.port.onEnd(settled)
    await h.port.start(h.request)
    h.emit()
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
    const event = h.stored().find(event => event.type === WORKSPACE_CHANGE_SNAPSHOT_EVENT)!
    expect(event.ignorable).toBe(true)
    expect(event.data).toMatchObject({ childSessionId: 'snapshot-child', runId: 'snapshot-run', attribution: 'unavailable', changes: [{ path: 'external.txt', kind: 'added' }] })
    // JSON persistence + native Session replay must retain the complete event.
    const replay = Session.create(h.child.id, JSON.parse(JSON.stringify(h.stored())), JSON.parse(JSON.stringify(h.child.header)))
    expect(replay.events.find(entry => entry.type === WORKSPACE_CHANGE_SNAPSHOT_EVENT)).toEqual(event)
    expect(h.child.events.some(entry => entry.type === 'tool/result')).toBe(false)
    h.emit()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.stored().filter(entry => entry.type === WORKSPACE_CHANGE_SNAPSHOT_EVENT)).toHaveLength(1)
    dispose()
    expect(h.handlers.size).toBe(0)
  })

  it('handles terminal events emitted before admission resolves', async () => {
    const h = await harness({ early: true })
    const settled = vi.fn()
    const dispose = h.port.onEnd(settled)
    await h.port.start(h.request)
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
    expect(h.stored().some(event => event.type === WORKSPACE_CHANGE_SNAPSHOT_EVENT)).toBe(true)
    h.port.interrupt('snapshot-child')
    dispose()
  })

  it('cleans admission failure and aborted attempts without synthetic evidence', async () => {
    const failed = await harness({ failStart: true })
    await expect(failed.port.start(failed.request)).rejects.toThrow('start failed')
    expect(failed.handlers.size).toBe(0)
    const cancelled = await harness()
    await cancelled.port.start(cancelled.request)
    expect(cancelled.handlers.size).toBe(2)
    cancelled.controller.abort()
    // Abort releases optional snapshot observation, not the independent native
    // end/timeout safety valve. Native settlement or explicit interrupt owns it.
    expect(cancelled.handlers.size).toBe(1)
    cancelled.emit()
    expect(cancelled.handlers.size).toBe(0)
    expect(cancelled.stored().some(event => event.type === WORKSPACE_CHANGE_SNAPSHOT_EVENT)).toBe(false)
    cancelled.port.interrupt('snapshot-child')
    const explicitlyCancelled = await harness()
    await explicitlyCancelled.port.start(explicitlyCancelled.request)
    // The existing cancellation authority failure is unchanged; even that path
    // must release this adapter's optional snapshot observer.
    await expect(explicitlyCancelled.port.cancel('snapshot-child')).rejects.toThrow('Cannot safely cancel child')
    expect(explicitlyCancelled.handlers.size).toBe(0)
  })

  it('collects without onEnd subscribers and rejects incompatible Session append without blocking end', async () => {
    const h = await harness()
    await h.port.start(h.request)
    h.emit()
    await vi.waitFor(() => expect(h.stored().some(event => event.type === WORKSPACE_CHANGE_SNAPSHOT_EVENT)).toBe(true))
    expect(h.handlers.size).toBe(0)
    h.port.interrupt('snapshot-child')
    const incompatible = await harness()
    const settled = vi.fn()
    const off = incompatible.port.onEnd(settled)
    await incompatible.port.start(incompatible.request)
    vi.spyOn(incompatible.child, 'append').mockImplementation(() => { throw new Error('incompatible') })
    incompatible.emit()
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
    expect(incompatible.stored().some(event => event.type === WORKSPACE_CHANGE_SNAPSHOT_EVENT)).toBe(false)
    off()
  })

  it('preserves terminal delivery when persistence rejects or stalls', async () => {
    const failed = await harness({ flush: 'false', appendFailure: true })
    const failedEnd = vi.fn()
    const off = failed.port.onEnd(failedEnd)
    await failed.port.start(failed.request)
    failed.emit()
    await vi.waitFor(() => expect(failedEnd).toHaveBeenCalledOnce())
    expect(failed.stored().some(event => event.type === WORKSPACE_CHANGE_SNAPSHOT_EVENT)).toBe(false)
    off()
    const stalled = await harness({ flush: 'hang' })
    const settled = vi.fn()
    const dispose = stalled.port.onEnd(settled)
    await stalled.port.start(stalled.request)
    stalled.emit()
    await vi.waitFor(() => expect(stalled.access.flush).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), { timeout: 5000 })
    expect(stalled.handlers.size).toBe(1)
    expect(stalled.persistence.append).not.toHaveBeenCalled()
    dispose()
  })
})
