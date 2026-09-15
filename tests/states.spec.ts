import { describe, expect, it } from 'vitest'
import {
  transitionAttempt,
  transitionTask,
  transitionTeam,
  transitionVerification,
  YuqiDomainError,
} from '../src/index.ts'
import type { AttemptStatus, TaskStatus, TeamStatus, VerificationStatus } from '../src/index.ts'

function verifyTransitions<T extends string>(
  states: readonly T[],
  allowed: Readonly<Record<T, readonly T[]>>,
  transition: (from: T, to: T) => T,
): void {
  for (const from of states) {
    for (const to of states) {
      if (allowed[from].includes(to)) {
        expect(transition(from, to)).toBe(to)
      } else {
        expect(() => transition(from, to)).toThrowError(YuqiDomainError)
      }
    }
  }
}

describe('closed lifecycle transitions', () => {
  it('accepts exactly the Team transition table', () => {
    const states: readonly TeamStatus[] = ['draft', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'completed', 'failed', 'needs_reconciliation']
    verifyTransitions(states, {
      draft: ['running', 'cancelled'],
      running: ['pausing', 'cancelling', 'completed', 'failed', 'needs_reconciliation'],
      pausing: ['paused', 'running', 'cancelling', 'needs_reconciliation'],
      paused: ['running', 'cancelling'],
      cancelling: ['cancelled', 'needs_reconciliation'],
      cancelled: [], completed: [], failed: [],
      needs_reconciliation: ['paused', 'running', 'cancelled', 'failed'],
    }, transitionTeam)
  })

  it('accepts exactly the task transition table', () => {
    const states: readonly TaskStatus[] = ['pending', 'ready', 'running', 'verifying', 'blocked', 'completed', 'failed', 'cancelled']
    verifyTransitions(states, {
      pending: ['ready', 'blocked', 'cancelled'],
      ready: ['running', 'blocked', 'cancelled'],
      running: ['verifying', 'completed', 'blocked', 'failed', 'cancelled'],
      verifying: ['completed', 'ready', 'blocked', 'failed', 'cancelled'],
      blocked: ['pending', 'ready', 'failed', 'cancelled'],
      completed: [], failed: [], cancelled: [],
    }, transitionTask)
  })

  it('accepts exactly the attempt transition table', () => {
    const states: readonly AttemptStatus[] = ['dispatching', 'running', 'settled', 'verification_failed', 'completed', 'failed', 'cancelled', 'unknown']
    verifyTransitions(states, {
      dispatching: ['running', 'failed', 'cancelled', 'unknown'],
      running: ['settled', 'failed', 'cancelled', 'unknown'],
      settled: ['verification_failed', 'completed', 'failed', 'unknown'],
      verification_failed: ['completed', 'failed'],
      completed: [], failed: [], cancelled: [],
      unknown: ['running', 'settled', 'failed', 'cancelled'],
    }, transitionAttempt)
  })

  it('accepts exactly the verification transition table', () => {
    const states: readonly VerificationStatus[] = ['pending', 'running', 'passed', 'failed', 'waived', 'cancelled']
    verifyTransitions(states, {
      pending: ['running', 'waived', 'cancelled'],
      running: ['passed', 'failed', 'waived', 'cancelled'],
      passed: [], failed: [], waived: [], cancelled: [],
    }, transitionVerification)
  })
})
