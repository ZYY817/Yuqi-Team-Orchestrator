import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { isDeepStrictEqual } from 'node:util'
import { YuqiOrchestratorError } from '../../application/errors.ts'
import { readSessionEvents } from './session-events.ts'

const verified = new WeakMap<object, { create: unknown; append: unknown }>()
const probeType = 'yuqi/session-envelope-probe'

/** Verify native append and detached JSON replay without touching the supplied Session. */
export function assertYuqiSessionEventCompatibility(session: Session): void {
  const runtime = session.constructor as unknown as typeof Session
  const nativeAppend = runtime.prototype?.append
  const cached = verified.get(runtime)
  if (cached !== undefined && cached.create === runtime.create && cached.append === nativeAppend) return
  try {
    const id = 'yuqi-detached-compatibility-probe' as Session['id']
    const probe = runtime.create(id)
    if (probe === session || probe.append !== nativeAppend || readSessionEvents(probe).length !== 0) {
      throw new Error('Host must provide an empty detached Session using the same append implementation')
    }
    const append = probe.append as unknown as (type: string, data: unknown, options: { ignorable: true }) => SessionEvent
    const event = append.call(probe, probeType, { probe: true }, { ignorable: true })
    const storedEvents = [...readSessionEvents(probe)]
    const stored = storedEvents[0]
    if (event.ignorable !== true || stored?.ignorable !== true || storedEvents.length !== 1 || !isDeepStrictEqual(event, stored)) {
      throw new Error('Session.append must natively store ignorable: true')
    }
    const serialized = JSON.stringify(storedEvents)
    const replay = runtime.create(id, JSON.parse(serialized), JSON.parse(JSON.stringify(probe.header)))
    // create() may append its own session/end-seed lifecycle event after the seed.
    if (!isDeepStrictEqual(readSessionEvents(replay).slice(0, storedEvents.length), JSON.parse(serialized))) {
      throw new Error('Session.create must preserve the complete downstream event on JSON replay')
    }
    verified.set(runtime, { create: runtime.create, append: nativeAppend })
  } catch (cause) {
    throw new YuqiOrchestratorError(
      'HOST_SESSION_INCOMPATIBLE',
      'Current Harness does not support ignorable downstream Session events with the required native append and replay contract. '
      + 'No Yuqi event was written to this Session. A version string or capability flag alone is insufficient; '
      + 'use a Host runtime verified by the session-envelope check. Reconcile cannot repair this incompatibility.',
      { cause },
    )
  }
}

/** Check the runtime before any plugin event can enter a live Host log. */
export function appendCompatibleYuqiSessionEvent(session: Session, type: string, data: unknown): SessionEvent {
  assertYuqiSessionEventCompatibility(session)
  const append = session.append as unknown as (type: string, data: unknown, options: { ignorable: true }) => SessionEvent
  return append.call(session, type, data, { ignorable: true })
}
