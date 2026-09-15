import { describe, expect, it, vi } from 'vitest'
import { deliverTeamInstruction } from '../src/host/harness/team-instruction-delivery.ts'
import { TEAM_INSTRUCTION_EVENT, type TeamInstruction } from '../src/domain/team-instruction.ts'

const record: TeamInstruction = { operationId: 'request', teamId: 'team', controllerSessionId: 'controller',
  authorSessionId: 'parent', target: 'all', text: '保留所有已有修改', createdAt: '2026-09-14T00:00:00Z',
  recipients: ['one', 'two'].map(taskId => ({ taskId, goal: taskId, status: 'sending' })) }
function fixture() {
  const events: { type: string; data: unknown }[] = []
  const persist = vi.fn(async (data: TeamInstruction) => { events.push({ type: TEAM_INSTRUCTION_EVENT, data: structuredClone(data) }) })
  const send = vi.fn(async (taskId: string) => ({ childSessionId: `child-${taskId}`, messageId: `message-${taskId}` }))
  return { record, read: () => events, persist, send, rejected: (cause: unknown) => cause === 'gate' }
}
describe('durable instruction delivery', () => {
  it('persists before delivery and replays one record without a second Host call', async () => {
    const f = fixture()
    f.send.mockImplementation(async taskId => { expect(f.persist).toHaveBeenCalled(); return { childSessionId: taskId, messageId: taskId } })
    const first = await deliverTeamInstruction(f)
    expect(first.recipients.map(row => row.status)).toEqual(['accepted', 'accepted'])
    expect(await deliverTeamInstruction(f)).toEqual(first)
    expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('retains per-recipient gate failure and uncertain outcomes without retry', async () => {
    const f = fixture()
    f.send.mockRejectedValueOnce('gate').mockRejectedValueOnce(new Error('connection lost after admission'))
    const result = await deliverTeamInstruction(f)
    expect(result.recipients.map(row => row.status)).toEqual(['failed', 'unknown'])
    await deliverTeamInstruction(f)
    expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('fails closed before a Host call if intent persistence fails', async () => {
    const f = fixture()
    f.persist.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(deliverTeamInstruction(f)).rejects.toThrow('disk unavailable')
    expect(f.send).not.toHaveBeenCalled()
  })
  it('does not resend after acceptance followed by receipt persistence failure', async () => {
    const f = fixture()
    f.persist.mockImplementationOnce(async data => { f.read().push({ type: TEAM_INSTRUCTION_EVENT, data: structuredClone(data) }) })
      .mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(deliverTeamInstruction(f)).rejects.toThrow('disk unavailable')
    const replay = await deliverTeamInstruction(f)
    expect(replay.recipients.map(row => row.status)).toEqual(['unknown', 'unknown'])
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('rejects changed content under the same request identity', async () => {
    const f = fixture()
    await deliverTeamInstruction(f)
    await expect(deliverTeamInstruction({ ...f, record: { ...record, text: 'different' } })).rejects.toThrow('conflicts')
    expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('does not trust an optimistic native receipt when its durability cannot be reconfirmed', async () => {
    const f = fixture()
    await deliverTeamInstruction(f)
    const confirmPersisted = vi.fn(async () => { throw new Error('flush failed') })
    await expect(deliverTeamInstruction({ ...f, confirmPersisted })).rejects.toThrow('flush failed')
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.persist).toHaveBeenCalledTimes(3)
  })
})
