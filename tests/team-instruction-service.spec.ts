import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { DurableJournalCoordinator } from '../src/application/durable-journal.ts'
import { ControlOperationId } from '../src/domain/ids.ts'
import { replayTeamEvents } from '../src/domain/projection.ts'
import type { TeamEvent } from '../src/domain/events.ts'
import { readTeamInstructions } from '../src/domain/team-instruction.ts'
import { YuqiTeamOrchestratorService } from '../src/host/harness/service.ts'
import { HarnessSessionJournal, TEAM_SESSION_EVENT } from '../src/host/harness/session-journal.ts'
import { completeTeamEvents, event, TASK_ID, TEAM_ID } from './fixtures.ts'

function instructionService(events: readonly TeamEvent[]) {
  const session = Session.create(SessionId('instruction-controller'))
  session.append(TEAM_SESSION_EVENT, { events })
  const controller = { id: session.id, session } as never
  const sends = vi.fn(async () => 'instruction-message-1' as never)
  const sessions = { flush: vi.fn(async () => true) }
  const journal = new HarnessSessionJournal(session, sessions)
  const service = Object.create(YuqiTeamOrchestratorService.prototype) as YuqiTeamOrchestratorService
  Object.defineProperties(service, {
    ctx: { value: {
      subagents: { sendMessage: sends },
      get: (name: string) => name === 'sessions' ? sessions : undefined,
    } },
    instructionQueues: { value: new Map() },
    transactions: { value: new DurableJournalCoordinator() },
    journalFor: { value: () => journal },
    projectionForTeam: { value: (candidate: { read(): readonly unknown[] }, teamId: string) => {
      const projection = replayTeamEvents(candidate.read() as readonly TeamEvent[])
      if (projection.team.id !== teamId) throw new Error('wrong Team fixture')
      return projection
    } },
  })
  const request = (operationId: string) => ({
    controller, teamId: String(TEAM_ID), operationId, authorSessionId: 'main-parent',
    target: String(TASK_ID), message: 'Keep the existing layout and add the requested audit trail.',
    signal: new AbortController().signal,
  })
  return { service, session, sends, sessions, journal, request }
}

describe('Team instruction service entrypoint', () => {
  it('serializes duplicate concurrent requests and never sends the same instruction twice', async () => {
    const fixture = instructionService(completeTeamEvents().slice(0, 8))
    const request = fixture.request('instruction-repeat')

    const [first, second] = await Promise.all([
      fixture.service.sendTeamInstruction(request),
      fixture.service.sendTeamInstruction(request),
    ])

    expect(first).toMatchObject({ operationId: 'instruction-repeat', recipients: [{
      taskId: TASK_ID, status: 'accepted', childSessionId: 'session-worker-1', messageId: 'instruction-message-1',
    }] })
    expect(fixture.sends).toHaveBeenCalledOnce()
    expect(second).toEqual(first)
    expect(readTeamInstructions(sessionEvents(fixture.session))).toEqual([first])
    expect(fixture.sessions.flush).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['paused', [
      ...completeTeamEvents().slice(0, 3),
      event(30, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(31, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
    ]],
    ['cancellation gate', [
      ...completeTeamEvents().slice(0, 8),
      event(32, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('cancel-intent'), action: 'cancel' }),
    ]],
  ] as const)('persists a failed receipt without sending while the Team is %s', async (_label, events) => {
    const fixture = instructionService(events)
    const result = await fixture.service.sendTeamInstruction(fixture.request(`instruction-${_label}`))

    expect(fixture.sends).not.toHaveBeenCalled()
    expect(result.recipients).toEqual([expect.objectContaining({ taskId: TASK_ID, status: 'failed' })])
    expect(result.recipients[0]?.detail).toMatch(/Team messages require a running Team|cancellation or recovery gate/u)
  })

  it('observes a concurrently started Team without committing control facts or waking a runner', async () => {
    const events = completeTeamEvents().slice(0, 8)
    const projection = replayTeamEvents(events)
    const service = Object.create(YuqiTeamOrchestratorService.prototype) as YuqiTeamOrchestratorService
    const journal = { key: 'running-team', read: () => events }
    const teamControls = { resume: vi.fn() }
    const wake = vi.fn()
    Object.defineProperties(service, {
      journalFor: { value: () => journal },
      projectionForTeam: { value: () => projection },
      teamControls: { value: teamControls },
      teamRunnerSupervisor: { value: { canWake: vi.fn(), acquireWakeLease: vi.fn() } },
      wakeTeamRunner: { value: wake },
    })

    await expect(service.resumeTeam({
      controller: { id: 'running-controller' } as never, teamId: String(TEAM_ID), operationId: 'late-confirmation',
    })).resolves.toBe(projection)
    expect(teamControls.resume).not.toHaveBeenCalled()
    expect(wake).not.toHaveBeenCalled()
  })
})

function sessionEvents(session: Session): readonly { type: string; data: unknown }[] {
  return session.events.map(event => ({ type: event.type, data: event.data }))
}
