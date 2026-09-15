import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { appendCompatibleYuqiSessionEvent, assertYuqiSessionEventCompatibility } from '../src/host/harness/session-compatibility.ts'

it('unit fixture stores, freezes, publishes and replays the same marked event without a capability flag', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(SessionStore)
  try {
    expect(Reflect.get(Session, 'supportsIgnorableEventEnvelope')).toBeUndefined()
    const session = ctx.sessions.create(SessionId('fixture-envelope'))
    let observed: unknown
    ctx.on('session/event', (_session, event) => { observed = event })
    assertYuqiSessionEventCompatibility(session)
    expect(session.events).toHaveLength(0)
    const event = appendCompatibleYuqiSessionEvent(session, 'yuqi/team-event', { probe: true })
    expect(event.ignorable).toBe(true)
    expect(session.events[0]).toBe(event)
    expect(observed).toBe(event)
    expect(Object.isFrozen(event)).toBe(true)
    const restored = Session.create(session.id, JSON.parse(JSON.stringify(session.events)), session.header)
    expect(restored.events[0]).toEqual(event)
  } finally {
    await fiber.dispose()
  }
})

it('does not mark ordinary events when the caller did not request an ignorable envelope', () => {
  const session = Session.create(SessionId('fixture-ordinary-event'))
  const event = session.append('turn/start', { turn: 1 })
  expect(event.ignorable).toBeUndefined()
  expect(session.events[0]).toBe(event)
})
