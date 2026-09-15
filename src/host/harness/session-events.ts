import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Read public Session events without copying, caching, or mutating the source. */
export function readSessionEvents(session: unknown): readonly SessionEvent[] {
  if (typeof session !== 'object' || session === null) {
    throw new TypeError('Harness Session must expose snapshotEvents() or events')
  }

  const snapshotEvents: unknown = Reflect.get(session, 'snapshotEvents')
  if (typeof snapshotEvents === 'function') {
    const events: unknown = Reflect.apply(snapshotEvents, session, [])
    if (!Array.isArray(events)) {
      throw new TypeError('Harness Session.snapshotEvents() must return an array')
    }
    return events as readonly SessionEvent[]
  }

  const events: unknown = Reflect.get(session, 'events')
  if (!Array.isArray(events)) {
    throw new TypeError('Harness Session must expose snapshotEvents() or an events array')
  }
  return events as readonly SessionEvent[]
}
