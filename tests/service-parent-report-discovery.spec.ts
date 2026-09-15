import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { YuqiTeamOrchestratorService } from '../src/host/harness/service.ts'

// Exercise the discovery methods, excluding unrelated runner/model setup.
function fixture(headers: Record<string, unknown>[], indexed: Record<string, unknown[]> = {}) {
  const parent = 'parent'
  const load = vi.fn(async (id: string) => Session.create(SessionId(id), [], {
    ...Session.create(SessionId(id)).header,
    parentSession: SessionId(parent),
  }))
  const deliver = vi.fn()
  const list = vi.fn(async () => headers)
  const service = Object.create(YuqiTeamOrchestratorService.prototype)
  Object.defineProperty(service, 'ctx', { value: { sessionPersistence: { list }, logger: { warn: vi.fn() } } })
  Object.assign(service, { disposed: false, parentReportRecoveryScans: new Map(),
    sidecar: { listSessionIds: () => Object.keys(indexed), readStoredEvents: (id: string) => indexed[id] ?? [] },
    loadPersistedControllerSession: load, scheduleParentReportDelivery: deliver,
  })
  return { service, load, deliver, list }
}
const binding = (parentSessionId: string) => ({ type: 'yuqi/team-parent-binding', data: {
  parentSessionId, generation: 1, operationId: 'binding', boundAt: '2026-09-09T00:00:00.000Z',
} })

describe('bounded parent report discovery', () => {
  it('never inflates ordinary chats or native worker history to find a Team report', async () => {
    const h = fixture([{ id: 'huge-ordinary-chat' }, { id: 'worker', parentSession: 'parent', origin: 'subagent' },
      { id: 'yuqi-team-controller', parentSession: 'parent' }])
    await h.service.replayParentReportsFor('parent')
    expect(h.load).toHaveBeenCalledExactlyOnceWith('yuqi-team-controller', undefined, true)
    expect(h.deliver).toHaveBeenCalledExactlyOnceWith('yuqi-team-controller')
  })
  it('uses the durable rebind instead of the original header and skips unrelated indexed journals', async () => {
    const h = fixture([{ id: 'yuqi-team-rebound', parentSession: 'old-parent' },
      { id: 'yuqi-team-other', parentSession: 'parent' }, { id: 'indexed-ordinary' }], {
      'yuqi-team-rebound': [binding('parent')], 'yuqi-team-other': [binding('someone-else')], 'indexed-ordinary': [],
    })
    await h.service.replayParentReportsFor('parent')
    expect(h.load).toHaveBeenCalledExactlyOnceWith('yuqi-team-rebound', undefined, true)
  })
  it('preserves parent-linked legacy controllers with nonstandard ids', async () => {
    const h = fixture([{ id: 'legacy-controller', parentSession: 'parent' }])
    await h.service.replayParentReportsFor('parent')
    expect(h.deliver).toHaveBeenCalledWith('legacy-controller')
  })
  it('coalesces overlapping discovery for the same parent and permits a later retry', async () => {
    const h = fixture([])
    let finish!: () => void
    h.list.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([]) }))
    const parent = Session.create(SessionId('parent'))
    h.service.scheduleParentReportRecovery(parent)
    h.service.scheduleParentReportRecovery(parent)
    expect(h.list).toHaveBeenCalledOnce()
    expect(h.deliver).not.toHaveBeenCalled()
    finish()
    await Promise.all(h.service.parentReportRecoveryScans.values())
    h.service.scheduleParentReportRecovery(parent)
    await Promise.all(h.service.parentReportRecoveryScans.values())
    expect(h.list).toHaveBeenCalledTimes(2)
  })
})
