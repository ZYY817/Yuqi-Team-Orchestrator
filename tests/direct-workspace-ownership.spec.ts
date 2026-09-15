import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Session, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskId, WorkspaceId } from '../src/domain/ids.ts'
import { DirectWorkspacePort } from '../src/host/filesystem/direct-workspace.ts'
import {
  DirectWorkspaceOwnershipGuard,
  canonicalDirectWorkspaceKey,
  type DirectWorkspaceSessionPersistence,
} from '../src/host/harness/direct-workspace-ownership.ts'
import { appendYuqiSessionEvent, TEAM_SESSION_EVENT } from '../src/host/harness/session-journal.ts'
import { contract, event } from './fixtures.ts'
import * as sessionRestore from '../src/host/harness/session-restore.ts'

const roots: string[] = []
let eventSeed = 4_000

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function teamSession(
  id: string,
  projectRoot: string,
  options: { readonly authority?: 'read-only' | 'write-authorized' | 'full-access'; readonly terminal?: boolean } = {},
): Session {
  const seed = eventSeed
  eventSeed += 10
  const taskId = TaskId(`task-${seed}`)
  const workspaceId = WorkspaceId(`workspace-${seed}`)
  const workspace = {
    workspaceId,
    project: { mode: 'direct' as const, projectRoot, volumeRoot: path.parse(projectRoot).root, protectedRoots: [] },
    worktreePath: projectRoot,
    branchName: 'direct',
    status: 'provisioning' as const,
  }
  const events = [
    event(seed, { type: 'yuqi/team-created', title: `Team ${id}`, objective: 'Own direct writes' }),
    event(seed + 1, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    event(seed + 2, {
      type: 'yuqi/task-created',
      contract: { ...contract(taskId), authorityMode: options.authority ?? 'write-authorized' },
    }),
    event(seed + 3, { type: 'yuqi/workspace-provisioning-started', workspace: workspace as never }),
    event(seed + 4, { type: 'yuqi/workspace-provisioned', workspaceId }),
    ...(options.terminal
      ? [event(seed + 5, { type: 'yuqi/team-status-changed', from: 'running', to: 'failed', reason: 'finished' })]
      : []),
  ]
  const session = Session.create(SessionId(id))
  appendYuqiSessionEvent(session, TEAM_SESSION_EVENT, { events })
  return session
}

function persistence(sessions: readonly Session[]): DirectWorkspaceSessionPersistence {
  const stored = new Map(sessions.map(session => [String(session.id), {
    meta: session.header,
    events: [...session.events],
  }]))
  return {
    async list() { return [...stored.values()].map(value => value.meta) },
    async load(id) {
      const value = stored.get(String(id))
      return value
    },
  }
}

function guard(live: Session[], stored: readonly Session[] = [], platform: NodeJS.Platform = process.platform) {
  return new DirectWorkspaceOwnershipGuard({
    workspaces: new DirectWorkspacePort(),
    sessions: { list: () => live } as never,
    persistence: persistence(stored),
    platform,
  })
}

async function projectDirectories(): Promise<{ readonly base: string; readonly project: string; readonly other: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'yuqi-direct-owner-'))
  roots.push(base)
  const project = path.join(base, 'project')
  const other = path.join(base, 'other')
  await Promise.all([mkdir(project), mkdir(other)])
  return { base, project, other }
}

describe('DirectWorkspaceOwnershipGuard', () => {
  it.each(['load', 'inspect', 'readFrom'] as const)('preserves inheritedEventCount through the %s cold restore DTO', async method => {
    const { project } = await projectDirectories()
    const stored = teamSession('yuqi-team-inherited-owner', path.resolve(project))
    const snapshot = { meta: stored.header, events: [...stored.events], inheritedEventCount: 1 }
    const restore = vi.spyOn(sessionRestore, 'restorePersistedSession').mockReturnValue(stored)
    try {
      const ownership = new DirectWorkspaceOwnershipGuard({
        workspaces: new DirectWorkspacePort(),
        sessions: { list: () => [] } as never,
        persistence: {
          list: async () => [stored.header],
          ...(method === 'load' ? { load: async () => snapshot } : {}),
          ...(method === 'inspect' ? { inspect: async () => snapshot } : {}),
          ...(method === 'readFrom' ? { readFrom: async () => ({ events: snapshot.events, inheritedEventCount: 1 }) } : {}),
        },
      })
      await expect(ownership.withWriterAdmission({ projectRoot: project }, async () => 'admitted'))
        .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
      expect(restore).toHaveBeenCalledExactlyOnceWith(snapshot)
    } finally {
      restore.mockRestore()
    }
  })
  it('folds canonical path case only on Windows', () => {
    expect(canonicalDirectWorkspaceKey('C:\\Work\\Project', 'win32')).toBe('c:\\work\\project')
    expect(canonicalDirectWorkspaceKey('/Work/Project', 'linux')).toBe('/Work/Project')
    expect(canonicalDirectWorkspaceKey('/work/project', 'linux')).not.toBe('/Work/Project')
  })

  it('uses DirectWorkspacePort realpaths and keeps admission atomic under the keyed lock', async () => {
    const { base, project } = await projectDirectories()
    const alias = path.join(base, 'project-alias')
    await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const live: Session[] = []
    const ownership = guard(live)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const entered = vi.fn()

    const first = ownership.withWriterAdmission({ projectRoot: alias }, async identity => {
      entered(identity.projectRoot)
      await held
      live.push(teamSession('live-writer', identity.projectRoot))
      return identity.projectRoot
    })
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1))
    const second = ownership.withWriterAdmission({ projectRoot: project }, async () => 'incorrectly admitted')
    release()

    await expect(first).resolves.toBe(path.resolve(project))
    await expect(second).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
  })

  it('detects a persistence-only writer that is absent from SessionStore', async () => {
    const { project } = await projectDirectories()
    const ownership = guard([], [teamSession('yuqi-team-cold-writer', path.resolve(project))])
    const operation = vi.fn(async () => undefined)

    await expect(ownership.withWriterAdmission({ projectRoot: project }, operation))
      .rejects.toMatchObject({
        code: 'WORKSPACE_CONFLICT',
        teamId: 'team-1',
        controllerSessionId: 'yuqi-team-cold-writer',
      })
    expect(operation).not.toHaveBeenCalled()
  })

  it('excludes self, terminal, read-only, and other-directory Teams during authority upgrade', async () => {
    const { project, other } = await projectDirectories()
    const self = teamSession('self-controller', path.resolve(project))
    const live = [
      self,
      teamSession('terminal-controller', path.resolve(project), { terminal: true }),
      teamSession('reader-controller', path.resolve(project), { authority: 'read-only' }),
      teamSession('other-controller', path.resolve(other)),
    ]
    const operation = vi.fn(async identity => identity.projectRoot)

    await expect(guard(live).withAuthorityUpgrade({
      projectRoot: project,
      selfSessionId: String(self.id),
    }, operation)).resolves.toBe(path.resolve(project))
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('blocks an authority upgrade when another durable writer owns the project', async () => {
    const { project } = await projectDirectories()
    const self = teamSession('upgrade-self', path.resolve(project), { authority: 'read-only' })
    const competing = teamSession('yuqi-team-upgrade-competitor', path.resolve(project))

    await expect(guard([self], [competing]).withAuthorityUpgrade({
      projectRoot: project,
      selfSessionId: String(self.id),
    }, async () => undefined)).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
  })

  it('does not let unavailable historical persistence lock an otherwise free live workspace', async () => {
    const { project } = await projectDirectories()
    const unavailable: DirectWorkspaceSessionPersistence = {
      async list(): Promise<readonly SessionHeader[]> { throw new Error('offline') },
      async load() { throw new Error('offline') },
    }
    const ownership = new DirectWorkspaceOwnershipGuard({
      workspaces: new DirectWorkspacePort(),
      sessions: { list: () => [] } as never,
      persistence: unavailable,
    })

    await expect(ownership.withWriterAdmission({ projectRoot: project }, async () => 'admitted'))
      .resolves.toBe('admitted')
  })

  it('can skip persistence-only history while still enforcing current live writers', async () => {
    const { project } = await projectDirectories()
    const liveWriter = teamSession('live-current-writer', path.resolve(project))
    const persistenceList = vi.fn(async () => { throw new Error('must not load cold history') })
    const ownership = new DirectWorkspaceOwnershipGuard({
      workspaces: new DirectWorkspacePort(),
      sessions: { list: () => [liveWriter] } as never,
      persistence: { list: persistenceList },
      scanColdHistory: false,
    })

    await expect(ownership.withWriterAdmission({ projectRoot: project }, async () => 'incorrectly admitted'))
      .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(persistenceList).not.toHaveBeenCalled()
  })

  it('skips one unreadable historical Session but still blocks a later readable writer', async () => {
    const { project } = await projectDirectories()
    const unreadable = teamSession('yuqi-team-unreadable-history', path.resolve(project))
    const writer = teamSession('yuqi-team-readable-writer', path.resolve(project))
    const ownership = new DirectWorkspaceOwnershipGuard({
      workspaces: new DirectWorkspacePort(),
      sessions: { list: () => [] } as never,
      persistence: {
        async list() { return [unreadable.header, writer.header] },
        async load(id) {
          if (String(id) === String(unreadable.id)) throw new Error('corrupt history')
          return { meta: writer.header, events: [...writer.events] }
        },
      },
    })

    await expect(ownership.withWriterAdmission({ projectRoot: project }, async () => undefined))
      .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
  })

  it('checks cold history with bounded concurrency and does not skip sessions', async () => {
    const { project, other } = await projectDirectories()
    const stored = Array.from({ length: 30 }, (_, index) =>
      teamSession(`yuqi-team-cold-terminal-${index}`, path.resolve(other), { terminal: true }))
    let active = 0
    let maxActive = 0
    let loaded = 0
    const byId = new Map(stored.map(session => [String(session.id), session]))
    const ownership = new DirectWorkspaceOwnershipGuard({
      workspaces: new DirectWorkspacePort(),
      sessions: { list: () => [] } as never,
      persistence: {
        async list() { return stored.map(session => session.header) },
        async load(id) {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise(resolve => setTimeout(resolve, 2))
          active -= 1
          loaded += 1
          const session = byId.get(String(id))
          return session === undefined ? undefined : { meta: session.header, events: [...session.events] }
        },
      },
    })

    await expect(ownership.withWriterAdmission({ projectRoot: project }, async () => 'admitted'))
      .resolves.toBe('admitted')
    expect(loaded).toBe(stored.length)
    expect(maxActive).toBeGreaterThan(1)
    expect(maxActive).toBeLessThanOrEqual(12)
  })

  it('stops replaying older same-workspace history after the newest terminal writer boundary', async () => {
    const { project } = await projectDirectories()
    const older = teamSession('yuqi-team-old-terminal', path.resolve(project), { terminal: true })
    const newest = teamSession('yuqi-team-new-terminal', path.resolve(project), { terminal: true })
    const byId = new Map([older, newest].map(session => [String(session.id), session]))
    const loads: string[] = []
    const ownership = new DirectWorkspaceOwnershipGuard({
      workspaces: new DirectWorkspacePort(),
      sessions: { list: () => [] } as never,
      persistence: {
        async list() {
          return [
            { ...older.header, cwd: path.resolve(project), createdAt: 1 },
            { ...newest.header, cwd: path.resolve(project), createdAt: 2 },
          ]
        },
        async load(id) {
          loads.push(String(id))
          const session = byId.get(String(id))
          return session === undefined ? undefined : { meta: session.header, events: [...session.events] }
        },
      },
    })

    await expect(ownership.withWriterAdmission({ projectRoot: project }, async () => 'admitted'))
      .resolves.toBe('admitted')
    expect(loads).toEqual([String(newest.id)])
  })

  it('still blocks immediately when the newest same-workspace writer is active', async () => {
    const { project } = await projectDirectories()
    const older = teamSession('yuqi-team-older-terminal', path.resolve(project), { terminal: true })
    const newest = teamSession('yuqi-team-new-active', path.resolve(project))
    const byId = new Map([older, newest].map(session => [String(session.id), session]))
    const loads: string[] = []
    const ownership = new DirectWorkspaceOwnershipGuard({
      workspaces: new DirectWorkspacePort(),
      sessions: { list: () => [] } as never,
      persistence: {
        async list() {
          return [
            { ...older.header, cwd: path.resolve(project), createdAt: 1 },
            { ...newest.header, cwd: path.resolve(project), createdAt: 2 },
          ]
        },
        async load(id) {
          loads.push(String(id))
          const session = byId.get(String(id))
          return session === undefined ? undefined : { meta: session.header, events: [...session.events] }
        },
      },
    })

    await expect(ownership.withWriterAdmission({ projectRoot: project }, async () => 'incorrectly admitted'))
      .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT', controllerSessionId: String(newest.id) })
    expect(loads).toEqual([String(newest.id)])
  })

  it('does not load Team controllers whose canonical controller cwd is another project', async () => {
    const { project, other } = await projectDirectories()
    const unrelated = teamSession('yuqi-team-unrelated-cwd', path.resolve(other))
    let loads = 0
    const ownership = new DirectWorkspaceOwnershipGuard({
      workspaces: new DirectWorkspacePort(),
      sessions: { list: () => [] } as never,
      persistence: {
        async list() { return [{ ...unrelated.header, cwd: path.resolve(other) }] },
        async load() { loads += 1; return { meta: unrelated.header, events: [...unrelated.events] } },
      },
    })

    await expect(ownership.withWriterAdmission({ projectRoot: project }, async () => 'admitted'))
      .resolves.toBe('admitted')
    expect(loads).toBe(0)
  })

  it('uses the production list plus readFrom persistence shape without requiring inspect', async () => {
    const { project } = await projectDirectories()
    const stored = teamSession('yuqi-team-production-shape', path.resolve(project), { terminal: true })
    const ownership = new DirectWorkspaceOwnershipGuard({
      workspaces: new DirectWorkspacePort(),
      sessions: { list: () => [] } as never,
      persistence: {
        async list() { return [stored.header] },
        async readFrom(_id, fromSeq) { return { events: [...stored.events.slice(fromSeq)] } },
      },
    })

    await expect(ownership.withWriterAdmission({ projectRoot: project }, async identity => identity.projectRoot))
      .resolves.toBe(path.resolve(project))
  })
})
