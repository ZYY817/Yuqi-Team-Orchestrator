import { Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { readSessionEvents } from './session-events.ts'
import { isDeepStrictEqual } from 'node:util'

/** Persisted metadata and the exact fork boundary must travel together. */
export interface PersistedSessionSnapshot {
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly inheritedEventCount?: number
}

/** Public detached restore, supporting both legacy and current Host factories. */
export function restorePersistedSession(
  stored: PersistedSessionSnapshot,
  runtime: Pick<typeof Session, 'create'> = Session,
): Session {
  const inherited = stored.inheritedEventCount
  if (inherited !== undefined && (!Number.isSafeInteger(inherited) || inherited < 0 || inherited > stored.events.length)) {
    throw new TypeError('Invalid persisted Session inherited event count')
  }
  const restored = Reflect.apply(runtime.create, runtime, [
    stored.meta.id, [...stored.events], stored.meta,
    ...(inherited === undefined ? [] : [inherited]),
  ]) as Session
  if (restored.id !== stored.meta.id || !isDeepStrictEqual(readSessionEvents(restored).slice(0, stored.events.length), stored.events)) {
    throw new Error('Restored Session does not preserve its persisted identity and event prefix')
  }
  if (inherited !== undefined) {
    const actual: unknown = Reflect.get(restored, 'inheritedEventCount')
    if (actual !== inherited && !(actual === undefined && inherited === 0)) {
      throw new Error('Host cannot preserve the persisted Session fork boundary')
    }
  }
  return restored
}
