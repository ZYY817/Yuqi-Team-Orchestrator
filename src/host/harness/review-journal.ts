/** Durable short reviewer results in the controller Session; no transcript copy. */

import { readSessionEvents } from './session-events.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ReviewResult } from '../../application/reviewer.ts'
import { appendSidecarEvent, hasSidecarSession, readSidecarEvents } from '../storage/session-sidecar.ts'
import { appendYuqiSessionEvent, REVIEW_SESSION_EVENT, syncTeamProjectionToParent, type HarnessSessionStore } from './session-journal.ts'

export { REVIEW_SESSION_EVENT } from './session-journal.ts'

export class HarnessReviewJournal {
  readonly #session: Session
  readonly #sessions: HarnessSessionStore

  constructor(session: Session, sessions: HarnessSessionStore) {
    this.#session = session
    this.#sessions = sessions
  }

  read(): readonly ReviewResult[] {
    return (readSidecarEvents(this.#session) ?? readSessionEvents(this.#session))
      .filter(entry => entry.type === REVIEW_SESSION_EVENT)
      .map(entry => entry.data.result)
  }

  async commit(result: ReviewResult): Promise<void> {
    if (hasSidecarSession(this.#session)) {
      await appendSidecarEvent(this.#session, REVIEW_SESSION_EVENT, { result })
    } else {
      appendYuqiSessionEvent(this.#session, REVIEW_SESSION_EVENT, { result })
      if (!(await this.#sessions.flush(this.#session))) throw new Error(`Yuqi review journal ${String(this.#session.id)} has no durability listener`)
    }
    await syncTeamProjectionToParent(this.#session, this.#sessions)
  }
}
