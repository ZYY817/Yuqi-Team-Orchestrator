import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { YuqiTeamOrchestratorService } from '../src/host/harness/service.ts'
import { OwnedEventStore, ownedEventDomainSpec, type OwnedEventRecord, type OwnedEventTable } from '../src/host/storage/owned-event-store.ts'
import { appendSidecarEvent, hasSidecarSession, SidecarRepository } from '../src/host/storage/session-sidecar.ts'
import { TEAM_PARENT_BINDING_EVENT } from '../src/host/harness/session-journal.ts'
import { completeTeamEvents } from './fixtures.ts'
import { WORKSPACE_SNAPSHOT_LIMITS } from '../src/host/workspace-change-snapshot.ts'

class Table implements OwnedEventTable {
  records = new Map<string, OwnedEventRecord>()
  get(key: string) { return this.records.get(key) }
  entries() { return this.records.entries() }
  async put(key: string, value: OwnedEventRecord) { this.records.set(key, value) }
  async update(key: string, transform: (value: OwnedEventRecord) => OwnedEventRecord) {
    const value = this.get(key)
    if (!value) throw new Error('missing-key')
    const next = transform(value)
    await this.put(key, next)
    return next
  }
}

// Focused probes of real service methods. Deliberately bypass the constructor's
// unrelated agent/model/runner setup; this is NOT a full Cordis lifecycle test.
interface Probe {
  ensureSidecarReady(): Promise<void>
  materializeSidecarSession(session: Session): Promise<void>
  flushProjectionSession(session: Session, flush: (session: Session) => Promise<boolean>): Promise<boolean>
  scheduleParentReportRecovery(session: Session): void
  sidecar: SidecarRepository | undefined
  disposed: boolean
}
function probe(table = new Table()) {
  const live = Session.create(SessionId('service-sidecar-parent'))
  const close = vi.fn(async () => {})
  const open = vi.fn(async (_spec: typeof ownedEventDomainSpec) => ({ table: () => table, close }))
  let facilityAvailable = true
  const materialize = vi.fn(async (_session: Session) => {})
  const list = vi.fn(async (): Promise<{ id: string }[]> => [])
  const load = vi.fn(async () => undefined)
  const unbind = vi.fn()
  const warn = vi.fn()
  const error = vi.fn()
  const scan = vi.fn()
  const deliver = vi.fn()
  const disposers: (() => Promise<void>)[] = []
  const service = Object.create(YuqiTeamOrchestratorService.prototype) as Probe
  Object.defineProperty(service, 'ctx', { value: {
    get: (name: string) => name === 'storageDomain' ? (facilityAvailable ? { open } : undefined)
      : name === 'sessions' ? { list: () => [live], get: (id: SessionId) => String(id) === String(live.id) ? live : undefined } : undefined,
    sessionPersistence: { ensureMaterialized: materialize, list, load },
    effect: (setup: () => () => Promise<void>) => { disposers.push(setup()) },
    on: vi.fn(() => unbind),
    logger: { warn, error },
  } })
  Object.assign(service, {
    disposed: false,
    storageDomain: { open },
    sidecarSessions: new Map(),
    scanColdRecoverySession: scan,
    scheduleParentReportDelivery: deliver,
    scheduleParentReportRecovery: vi.fn(),
  })
  return { service, live, open, close, materialize, list, load, disposers, unbind, warn, scan, deliver,
    removeFacility: () => { facilityAvailable = false } }
}

describe('service sidecar integration seams', () => {
  it('keeps durable storage optional at construction and activates it when available', () => {
    expect(YuqiTeamOrchestratorService.inject).not.toContain('storageDomain')
  })

  it('opens the declared domain once and materializes before appending plugin facts', async () => {
    const { service, live, open, materialize, disposers, close } = probe()
    try {
      await Promise.all([service.ensureSidecarReady(), service.ensureSidecarReady()])
      expect(open).toHaveBeenCalledExactlyOnceWith(ownedEventDomainSpec)
      expect(hasSidecarSession(live)).toBe(true)
      await appendSidecarEvent(live, 'yuqi/probe', {})
      expect(materialize).toHaveBeenCalledExactlyOnceWith(live)
    } finally { for (const dispose of disposers) await dispose() }
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('accepts a cold controller only when its exact native header is already durable', async () => {
    const { service, materialize, list, disposers } = probe()
    const cold = Session.create(SessionId('service-sidecar-cold'))
    try {
      await service.ensureSidecarReady()
      service.sidecar!.bind(cold)
      materialize.mockRejectedValueOnce(new Error('session is not registered for persistence'))
      list.mockResolvedValueOnce([cold.header])
      await expect(appendSidecarEvent(cold, 'yuqi/probe', {})).resolves.toMatchObject({ type: 'yuqi/probe' })

      materialize.mockRejectedValueOnce(new Error('session is not registered for persistence'))
      list.mockResolvedValueOnce([({ ...cold.header, cwd: 'F:/different-workspace' } as Session['header'])])
      await expect(service.materializeSidecarSession(cold)).rejects.toThrow('not registered')
      expect(materialize).toHaveBeenCalledTimes(2)
      expect(list).toHaveBeenCalledTimes(2)
    } finally { for (const dispose of disposers) await dispose() }
  })

  it('must flush native parent inbox even when plugin facts use sidecar', async () => {
    const { service, live, disposers } = probe()
    try {
      await service.ensureSidecarReady()
      const flush = vi.fn(async () => true)
      await service.flushProjectionSession(live, flush)
      expect(flush).toHaveBeenCalledExactlyOnceWith(live)
    } finally { for (const dispose of disposers) await dispose() }
  })

  it('reconciles cold Team controllers when their durable parent binding is already live at startup', async () => {
    const table = new Table()
    const parentId = 'service-sidecar-parent'
    const controllerId = 'yuqi-team-cold-controller'
    await seed(table, controllerId, TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: parentId, generation: 1, operationId: 'startup-recovery', boundAt: '2026-09-09T00:00:00.000Z',
    })
    const { service, live, list, disposers } = probe(table)
    list.mockResolvedValue([{ id: controllerId }])
    try {
      await service.ensureSidecarReady()
      expect(service.scheduleParentReportRecovery).toHaveBeenCalledWith(live)
    } finally { for (const dispose of disposers) await dispose() }
  })

  it('retries initialization after a transient failure without poisoning the Host', async () => {
    const { service, open, disposers, removeFacility } = probe()
    const error = new Error('transient storage unavailable')
    open.mockRejectedValueOnce(error)
    try {
      await expect(service.ensureSidecarReady()).rejects.toBe(error)
      await service.ensureSidecarReady()
      expect(open).toHaveBeenCalledTimes(2)
      removeFacility()
    } finally { for (const dispose of disposers) await dispose() }
  })

  it('does not poison the Host lifecycle when sidecar initialization fails', async () => {
    const table = new Table()
    await seed(table, 'orphan', 'yuqi/unknown', {})
    const { service, open, disposers, close, warn } = probe(table)
    const drain = vi.fn(async () => { service.disposed = true })
    Object.assign(service, { reviewer: {}, drainReviewShutdown: drain })
    try {
      await expect(service.ensureSidecarReady()).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored deleted orphan'))
      expect(close).not.toHaveBeenCalled()
      expect(drain).not.toHaveBeenCalled()
      expect(service.disposed).toBe(false)
      open.mockResolvedValueOnce({ table: () => new Table(), close })
      await service.ensureSidecarReady()
      expect(service.disposed).toBe(false)
      expect(open).toHaveBeenCalledOnce()
    } finally { for (const dispose of disposers) await dispose() }
  })

  it('drains reviewer closure before closing storage on actual shutdown', async () => {
    const { service, close, disposers } = probe()
    const order: string[] = []
    Object.assign(service, { reviewer: {}, drainReviewShutdown: async () => {
      await Promise.resolve()
      order.push('review-closed')
    } })
    close.mockImplementation(async () => { order.push('domain-closed') })
    await service.ensureSidecarReady()
    for (const dispose of disposers) await dispose()
    expect(order).toEqual(['review-closed', 'domain-closed'])
  })

  it('retains cold active controllers found in native metadata without loading or running them', async () => {
    const table = new Table()
    await seed(table, 'cold', 'yuqi/team-event', { events: completeTeamEvents().slice(0, 8) })
    const before = JSON.stringify([...table.entries()])
    const { service, list, load, scan, deliver, warn, disposers } = probe(table)
    list.mockResolvedValue([{ id: 'cold' }])
    try {
      await service.ensureSidecarReady()
      expect(list).toHaveBeenCalledOnce()
      expect(load).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
      expect(scan.mock.calls.every(([session]) => String((session as Session).id) !== 'cold')).toBe(true)
      expect(deliver).not.toHaveBeenCalled()
      expect(JSON.stringify([...table.entries()])).toBe(before)
    } finally { for (const dispose of disposers) await dispose() }
  })

  it('fails closed when native inventory cannot confirm cold identities', async () => {
    const table = new Table()
    await seed(table, 'cold', 'yuqi/team-event', { events: completeTeamEvents() })
    const { service, list, close, disposers } = probe(table)
    list.mockRejectedValueOnce(new Error('inventory unavailable'))
    try {
      await expect(service.ensureSidecarReady()).rejects.toThrow('inventory unavailable')
      expect(close).toHaveBeenCalledOnce()
      expect(service.disposed).toBe(false)
    } finally { for (const dispose of disposers) await dispose() }
  })

  it('must rollback the opened domain when cold identity recovery fails', async () => {
    const table = new Table()
    const orphan = Session.create(SessionId('orphan-sidecar'))
    const repo = new SidecarRepository(table)
    repo.bind(orphan)
    await appendSidecarEvent(orphan, 'yuqi/probe', {})
    repo.dispose()
    const { service, close, disposers, warn } = probe(table)
    try {
      await expect(service.ensureSidecarReady()).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored deleted orphan'))
      expect(close).not.toHaveBeenCalled()
      expect(service.sidecar).toBeDefined()
    } finally { for (const dispose of disposers) await dispose() }
  })
})

async function seed(table: Table, id: string, type: string, data: unknown) {
  await new OwnedEventStore({ table, controllerSessionId: id }).commit({
    expectedRevision: 0, operationId: 'seed', events: [{ type, data, seq: 1, time: 1, ignorable: true }],
  })
}

describe('service orphan policy and source ownership', () => {
  const child = { version: 1, childSessionId: 'orphan', runId: 'run', scope: 'workspace',
    attribution: 'unavailable', beforeCapturedAt: '2026-09-06T00:00:00Z', afterCapturedAt: '2026-09-06T00:00:01Z',
    partial: false, reasons: [], limits: { ...WORKSPACE_SNAPSHOT_LIMITS }, changes: [] }
  it.each([
    { kind: 'child-evidence', type: 'yuqi/workspace-change-snapshot', data: child },
    { kind: 'parent-index', type: 'yuqi/team-parent-detached', data: { controllerSessionId: 'controller', bindingGeneration: 1 } },
    { kind: 'parent-index', type: 'yuqi/team-projection-bridge', data: {
      controllerSessionId: 'controller', sourceEventCount: 3, events: completeTeamEvents().slice(0, 3),
    } },
    { kind: 'terminal-controller', type: 'yuqi/team-event', data: { events: completeTeamEvents() } },
  ])('retains $kind without recovery, delivery, or native materialization', async ({ kind, type, data }) => {
    const table = new Table()
    await seed(table, 'orphan', type, data)
    const before = JSON.stringify([...table.entries()])
    const { service, close, disposers, warn, scan, deliver, materialize, unbind } = probe(table)
    try {
      await service.ensureSidecarReady()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`retained ${kind}`))
      expect(scan.mock.calls.every(([session]) => String((session as Session).id) !== 'orphan')).toBe(true)
      expect(deliver).not.toHaveBeenCalled()
      expect(materialize).not.toHaveBeenCalled()
      expect(close).not.toHaveBeenCalled()
      expect(JSON.stringify([...table.entries()])).toBe(before)
    } finally { for (const dispose of disposers) await dispose() }
    expect(unbind).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it.each([
    { type: 'yuqi/team-event', data: { events: completeTeamEvents().slice(0, 8) } },
    { type: 'yuqi/team-event', data: { events: [{ type: 'yuqi/team-created' }] } },
    { type: 'yuqi/unknown', data: {} },
  ])('blocks incomplete, corrupt, or unknown orphan %# and cleans up once', async ({ type, data }) => {
    const table = new Table()
    await seed(table, 'orphan', type, data)
    const { service, close, disposers, unbind, scan, deliver, live, warn } = probe(table)
    try {
      await expect(service.ensureSidecarReady()).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored deleted orphan'))
      expect(close).not.toHaveBeenCalled()
      expect(unbind).not.toHaveBeenCalled()
      expect(service.sidecar).toBeDefined()
      expect(hasSidecarSession(live)).toBe(true)
      expect(scan.mock.calls.every(([session]) => String((session as Session).id) !== 'orphan')).toBe(true)
      expect(deliver).not.toHaveBeenCalled()
      await expect(service.ensureSidecarReady()).resolves.toBeUndefined()
    } finally { for (const dispose of disposers) await dispose() }
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([false, true])('preserves legacy only and isolates a double source (sidecar=%s)', async stored => {
    const table = new Table()
    const { service, live, close, disposers } = probe(table)
    live.append('yuqi/team-event', { events: completeTeamEvents() })
    if (stored) await seed(table, String(live.id), 'yuqi/team-event', { events: completeTeamEvents() })
    try {
      if (stored) {
        await service.ensureSidecarReady()
        expect(hasSidecarSession(live)).toBe(false)
        expect(close).not.toHaveBeenCalled()
      } else {
        await service.ensureSidecarReady()
        expect(hasSidecarSession(live)).toBe(false)
      }
    } finally { for (const dispose of disposers) await dispose() }
  })

  it('rejects readiness after a successful domain has closed, including absent facility', async () => {
    const { service, disposers, removeFacility, close } = probe()
    await service.ensureSidecarReady()
    for (const dispose of disposers) await dispose()
    await expect(service.ensureSidecarReady()).rejects.toThrow('closed')
    removeFacility()
    await expect(service.ensureSidecarReady()).rejects.toThrow('closed')
    expect(close).toHaveBeenCalledTimes(1)
  })
})
