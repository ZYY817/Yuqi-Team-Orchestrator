/** Durable reviewer policy and fixed structured-result contract. */

import { z } from 'zod'

export const REVIEW_POLICY_MODES = ['off', 'manual', 'quality-gate'] as const
export const DEFAULT_MAX_REWORK_ROUNDS = 2
export const MAX_REWORK_ROUNDS = 3
export const MAX_REVIEW_ADDITIONAL_PROMPT_LENGTH = 4_000
export const DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS = 6
export const MAX_TEAM_AUTOMATIC_REWORKS = 12

export const DEFAULT_REVIEW_CHECKLIST_PROMPT_ZH =
  '对照用户目标、明确约束和实际行为审查方案与结果：检查需求遗漏、歧义、重复或相互冲突的规则/实现。对重要问题追溯根因，检查完成当前任务所必需的上下游、共享状态和同根因影响，不擅自纳入无关范围。核查逻辑一致性、边界输入、异常/取消/恢复、权限与副作用、兼容性和回归风险；标出无必要的停顿、重复确认或没有退出条件的流程。区分已验证事实、合理推断和缺失证据；不得声称未执行的测试、浏览器操作或结果。每项发现按“优先级｜证据｜影响｜最小修复｜验证方式”给出；若未发现问题，说明已覆盖范围和仍未验证项。'

export const DEFAULT_REVIEW_CHECKLIST_PROMPT_EN =
  'Review the plan and result against the user goal, explicit constraints and actual behavior. Check for missing requirements, ambiguity, duplication or conflicting rules/implementation. Trace each material issue to its root cause; cover necessary upstream/downstream, shared-state and same-cause effects needed to complete this task, without adding unrelated scope. Check logic consistency, boundary inputs, failure/cancel/recovery, permissions, side effects, compatibility and regressions; flag needless pauses, repeated confirmations or flows with no exit condition. Separate verified facts, reasonable inferences and missing evidence. Do not claim tests, browser actions or outcomes that were not performed. For every finding provide: priority, evidence, impact, smallest corrective action and verification method. If no issue is found, state the coverage and remaining unverified areas.'

export const reviewPolicySchema = z.object({
  mode: z.enum(REVIEW_POLICY_MODES),
  maxReworkRounds: z.number().int().min(0).max(MAX_REWORK_ROUNDS),
  additionalPrompt: z.string().trim().max(MAX_REVIEW_ADDITIONAL_PROMPT_LENGTH),
}).strict()

export type ReviewPolicy = Readonly<z.output<typeof reviewPolicySchema>>

export const REVIEW_CHECKPOINT_SUBJECTS = [
  'team-plan',
  'task-attempt',
  'team-completion',
  'failure-escalation',
] as const
export const reviewCheckpointSubjectSchema = z.enum(REVIEW_CHECKPOINT_SUBJECTS)
export type ReviewCheckpointSubject = z.output<typeof reviewCheckpointSubjectSchema>

export const REVIEW_CHECKPOINT_PHASES = [
  'reviewing',
  'reworking',
  'awaiting-controller',
  'satisfied',
] as const
export const reviewCheckpointPhaseSchema = z.enum(REVIEW_CHECKPOINT_PHASES)
export type ReviewCheckpointPhase = z.output<typeof reviewCheckpointPhaseSchema>

/** Stable subject identity retained while a checkpoint moves through rework candidates. */
export const reviewCheckpointAnchorSchema = z.object({
  eventId: z.string().trim().min(1),
  taskId: z.string().trim().min(1).optional(),
  attemptId: z.string().trim().min(1).optional(),
}).strict().superRefine((anchor, context) => {
  if (anchor.attemptId !== undefined && anchor.taskId === undefined) {
    context.addIssue({ code: 'custom', path: ['taskId'], message: 'attempt checkpoint anchors require taskId' })
  }
})
export type ReviewCheckpointAnchor = Readonly<z.output<typeof reviewCheckpointAnchorSchema>>

/** Limits are snapshotted on the request so replay never depends on later settings. */
export const reviewAutomaticReworkBudgetSchema = z.object({
  checkpointLimit: z.number().int().min(0).max(MAX_REWORK_ROUNDS),
  teamLimit: z.number().int().min(0).max(MAX_TEAM_AUTOMATIC_REWORKS),
}).strict().superRefine((budget, context) => {
  if (budget.checkpointLimit > budget.teamLimit) {
    context.addIssue({ code: 'custom', path: ['checkpointLimit'], message: 'checkpoint limit cannot exceed Team limit' })
  }
})
export type ReviewAutomaticReworkBudget = Readonly<z.output<typeof reviewAutomaticReworkBudgetSchema>>

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = Object.freeze({
  mode: 'manual',
  maxReworkRounds: DEFAULT_MAX_REWORK_ROUNDS,
  additionalPrompt: '',
})

/** Normalize settings before they become immutable Team bootstrap facts. */
export function normalizeReviewPolicy(input: Partial<ReviewPolicy> | undefined): ReviewPolicy {
  const parsed = reviewPolicySchema.parse({
    mode: input?.mode ?? DEFAULT_REVIEW_POLICY.mode,
    maxReworkRounds: input?.maxReworkRounds ?? DEFAULT_REVIEW_POLICY.maxReworkRounds,
    additionalPrompt: input?.additionalPrompt ?? DEFAULT_REVIEW_POLICY.additionalPrompt,
  })
  return Object.freeze(parsed)
}

export const REVIEW_TRIGGERS = [
  'plan-confirmation',
  'public-contract-change',
  'pre-completion',
  'consecutive-failure',
  'user-request',
  'quality-gate',
  'rework-verification',
] as const
export const reviewTriggerSchema = z.enum(REVIEW_TRIGGERS)
export type ReviewTrigger = z.output<typeof reviewTriggerSchema>

export const reviewFindingSchema = z.object({
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  evidence: z.array(z.string().trim().min(1).max(512)).max(8),
  impact: z.string().trim().min(1).max(1_000),
  recommendation: z.string().trim().min(1).max(1_000),
}).strict()

export const reviewDecisionSchema = z.enum(['pass', 'changes_required', 'inconclusive'])

/** The only reviewer output shape accepted at either model or durable boundaries. */
export const reviewerVerdictSchema = z.object({
  decision: reviewDecisionSchema,
  findings: z.array(reviewFindingSchema).max(16),
  unverified: z.array(z.string().trim().min(1).max(512)).max(16),
}).strict().superRefine((value, context) => {
  if (value.decision === 'pass' && (value.findings.length > 0 || value.unverified.length > 0)) {
    context.addIssue({ code: 'custom', path: ['decision'], message: 'pass requires empty findings and unverified arrays' })
  }
  if (value.decision === 'changes_required' && value.findings.length === 0) {
    context.addIssue({ code: 'custom', path: ['findings'], message: 'changes_required requires findings' })
  }
  if (value.decision === 'inconclusive' && value.unverified.length === 0) {
    context.addIssue({ code: 'custom', path: ['unverified'], message: 'inconclusive requires an unverified reason' })
  }
})

export const reviewResultSchema = reviewerVerdictSchema.extend({
  reviewId: z.string().trim().min(1).max(160),
  trigger: reviewTriggerSchema,
  reviewerSessionId: z.string().trim().min(1).max(160),
}).strict()

export type ReviewFinding = Readonly<z.output<typeof reviewFindingSchema>>
export type ReviewerVerdict = Readonly<z.output<typeof reviewerVerdictSchema>>
export type ReviewResult = Readonly<z.output<typeof reviewResultSchema>>

export const REVIEW_USER_DECISIONS = ['retry_review', 'authorize_final_rework', 'waive', 'fail', 'cancel'] as const
export const reviewUserDecisionSchema = z.enum(REVIEW_USER_DECISIONS)
export type ReviewUserDecision = z.output<typeof reviewUserDecisionSchema>

/** Content-derived and order-independent identity used to stop repeated correction loops. */
export function reviewFindingFingerprint(finding: ReviewFinding): string {
  const canonical = JSON.stringify({
    severity: finding.severity,
    evidence: [...finding.evidence].map(normalizeFingerprintText).sort(),
    impact: normalizeFingerprintText(finding.impact),
    recommendation: normalizeFingerprintText(finding.recommendation),
  })
  let hash = 0x811c9dc5
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `finding-v1-${hash.toString(16).padStart(8, '0')}`
}

function normalizeFingerprintText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}
