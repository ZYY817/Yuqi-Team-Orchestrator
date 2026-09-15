import { describe, expect, it } from 'vitest'
import { parseTaskOutcomeReport, taskOutcomeAllowsCompletion } from '../src/domain/task-outcome.ts'
import { decideChildSettlement } from '../src/application/child-settlement.ts'
import type { ChildEnd } from '../src/application/ports.ts'

const completed = parseTaskOutcomeReport('YUQI_TASK_OUTCOME: {"version":1,"kind":"completed","summary":"file written"}')
const blocked = parseTaskOutcomeReport('YUQI_TASK_OUTCOME: {"version":1,"kind":"blocked","summary":"missing input","nextAction":"ask controller","question":"Which input?"}')
const failed = parseTaskOutcomeReport('YUQI_TASK_OUTCOME: {"version":1,"kind":"failed","summary":"test failed"}')
const end: ChildEnd = { runId: 'run', provider: 'spawn', childSessionId: 'child', stopReason: 'completed', hasAssistantOutput: true }

describe('versioned task outcomes', () => {
  it('accepts explicit completed/blocked/failed declarations, not arbitrary prose', () => {
    expect(completed).toMatchObject({ status: 'reported', outcome: { kind: 'completed' } })
    expect(blocked).toMatchObject({ status: 'reported', outcome: { kind: 'blocked', question: 'Which input?' } })
    expect(failed).toMatchObject({ status: 'reported', outcome: { kind: 'failed' } })
    expect(parseTaskOutcomeReport('I am blocked, or perhaps completed')).toEqual({ status: 'missing' })
  })
  it.each([
    'YUQI_TASK_OUTCOME: not-json',
    'YUQI_TASK_OUTCOME: {"version":2,"kind":"completed","summary":"done"}',
    'YUQI_TASK_OUTCOME: {"version":1,"kind":"blocked","summary":"input"}',
    'YUQI_TASK_OUTCOME: {"version":1,"kind":"completed","summary":" "}',
    'YUQI_TASK_OUTCOME: {"version":1,"kind":"completed","summary":"done","teamId":"other"}',
    'YUQI_TASK_OUTCOME: {}\nYUQI_TASK_OUTCOME: {}',
    `YUQI_TASK_OUTCOME: ${' '.repeat(5001)}`,
  ])('rejects malformed, duplicate or untrusted identity declarations: %s', text => {
    expect(parseTaskOutcomeReport(text)).toEqual({ status: 'invalid' })
  })
  it('keeps legacy journals readable without granting new attempts legacy success', () => {
    expect(taskOutcomeAllowsCompletion(undefined, undefined)).toBe(true)
    expect(taskOutcomeAllowsCompletion(undefined, { status: 'missing' })).toBe(true)
    expect(taskOutcomeAllowsCompletion(1, undefined)).toBe(false)
    expect(taskOutcomeAllowsCompletion(1, { status: 'missing' })).toBe(false)
    expect(taskOutcomeAllowsCompletion(undefined, blocked)).toBe(false)
    expect(taskOutcomeAllowsCompletion(undefined, { status: 'invalid' })).toBe(false)
  })
  it.each([undefined, { status: 'missing' } as const, { status: 'invalid' } as const, blocked])('does not complete or verify an incomplete new result %j', outcome => {
    const result = decideChildSettlement({ ...end, ...(outcome === undefined ? {} : { taskOutcome: outcome }) }, false, true, 1)
    expect(result).toMatchObject({ taskStatus: 'blocked', attemptStatus: 'settled', completedWithoutVerification: false, releaseLease: true })
  })
  it('reports blocker, action and question to the controller', () => {
    const result = decideChildSettlement({ ...end, taskOutcome: blocked }, false, false, 1)
    expect(result.reason).toContain('missing input')
    expect(result.reason).toContain('ask controller')
    expect(result.reason).toContain('Which input?')
  })
  it('does not bypass declared verification', () => {
    expect(decideChildSettlement({ ...end, taskOutcome: completed }, false, true, 1)).toMatchObject({ taskStatus: 'verifying', releaseLease: false })
    expect(decideChildSettlement({ ...end, taskOutcome: completed }, false, false, 1)).toMatchObject({ taskStatus: 'completed', completedWithoutVerification: true, releaseLease: true })
    expect(decideChildSettlement({ ...end, taskOutcome: failed }, false, false, 1).taskStatus).toBe('failed')
  })
  it.each(['aborted', 'error', 'refusal'])('does not override runtime %s with a success declaration', stopReason => {
    expect(decideChildSettlement({ ...end, stopReason, taskOutcome: completed }, false, false, 1).taskStatus).toBe(stopReason === 'aborted' ? 'cancelled' : 'failed')
  })
  it('honors cancellation before blocked/completed and rejects blank final output', () => {
    expect(decideChildSettlement({ ...end, taskOutcome: blocked }, true, true, 1).taskStatus).toBe('cancelled')
    expect(decideChildSettlement({ ...end, taskOutcome: completed }, true, false, 1).taskStatus).toBe('cancelled')
    expect(decideChildSettlement({ ...end, hasAssistantOutput: false, taskOutcome: completed }, false, false, 1).taskStatus).toBe('failed')
  })
})
