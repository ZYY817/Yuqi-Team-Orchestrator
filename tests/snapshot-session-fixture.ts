import { Session } from '@deepseek-ai/dsh-session'
import { readSessionEvents } from '../src/host/harness/session-events.ts'

const originals = new WeakMap<Session, Session>()
function append(this: Session, ...args: unknown[]) {
  const original = originals.get(this)!
  return Reflect.apply(original.append, original, args)
}
const runtime = {
  prototype: { append },
  create(...args: Parameters<typeof Session.create>) {
    return snapshotOnlySession(Reflect.apply(Session.create, Session, args) as Session)
  },
}

/** Public snapshot-only facade; native methods retain their original receiver. */
export function snapshotOnlySession(session: Session): Session {
  const facade = new Proxy(session, {
    get(target, property) {
      if (property === 'events') throw new Error('legacy Session.events read')
      if (property === 'snapshotEvents') return () => Object.freeze([...readSessionEvents(target)])
      if (property === 'constructor') return runtime
      if (property === 'append') return append
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  originals.set(facade, session)
  return facade
}
