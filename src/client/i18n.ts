import type { TeamConsoleAttention, TeamConsoleReview } from '../domain/team-console-contract.ts'
import type { TeamAuthorityMode } from '../domain/team-settings-contract.ts'
import type { TaskStatus, TeamStatus, VerificationStatus } from '../domain/states.ts'
import type { ReviewTrigger } from '../domain/review-policy.ts'

export const YUQI_LOCALES = ['zh', 'en'] as const
export type YuqiLocale = typeof YUQI_LOCALES[number]

export type LocalizedCopy<T> = Readonly<Record<YuqiLocale, T>>

export function defineLocalizedCopy<T>(copy: LocalizedCopy<T>): LocalizedCopy<T> {
  return copy
}

export function copyFor<T>(copy: LocalizedCopy<T>, locale: YuqiLocale): T {
  return copy[locale === 'en' ? 'en' : 'zh']
}

export function localeLanguageTag(locale: YuqiLocale): 'zh-CN' | 'en' {
  return locale === 'en' ? 'en' : 'zh-CN'
}

export function labelValue(label: string, value: string | number, locale: YuqiLocale): string {
  return locale === 'en' ? `${label}: ${value}` : `${label}：${value}`
}

export function formatList(values: readonly string[], locale: YuqiLocale): string {
  return values.join(locale === 'en' ? ', ' : '、')
}

const AUTHORITY_COPY = defineLocalizedCopy<Record<TeamAuthorityMode, string>>({
  zh: {
    'read-only': '只读',
    'write-authorized': '工作区写入',
    'full-access': '完全访问',
  },
  en: {
    'read-only': 'Read only',
    'write-authorized': 'Workspace write',
    'full-access': 'Full access',
  },
})

export function formatAuthorityMode(value: TeamAuthorityMode | undefined, locale: YuqiLocale): string {
  return copyFor(AUTHORITY_COPY, locale)[value ?? 'write-authorized']
}

const TASK_STATUS_COPY = defineLocalizedCopy<Record<TaskStatus, string>>({
  zh: { pending: '未开始', ready: '等待派发', running: '运行中', verifying: '验证中', blocked: '阻塞', completed: '已完成', failed: '失败', cancelled: '已取消' },
  en: { pending: 'Not started', ready: 'Awaiting dispatch', running: 'Running', verifying: 'Verifying', blocked: 'Blocked', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' },
})

export function formatTaskStatus(value: string, locale: YuqiLocale): string {
  return copyFor(TASK_STATUS_COPY, locale)[value as TaskStatus] ?? value
}

const TEAM_STATUS_COPY = defineLocalizedCopy<Record<TeamStatus, string>>({
  zh: { draft: '草稿', running: '运行中', pausing: '暂停中', paused: '已暂停', cancelling: '取消中', cancelled: '已取消', completed: '已完成', failed: '失败', needs_reconciliation: '待安全核对' },
  en: { draft: 'Draft', running: 'Running', pausing: 'Pausing', paused: 'Paused', cancelling: 'Cancelling', cancelled: 'Cancelled', completed: 'Completed', failed: 'Failed', needs_reconciliation: 'Safety check needed' },
})

export function formatTeamStatus(value: string, locale: YuqiLocale): string {
  return copyFor(TEAM_STATUS_COPY, locale)[value as TeamStatus] ?? value
}

const VERIFICATION_STATUS_COPY = defineLocalizedCopy<Record<VerificationStatus, string>>({
  zh: { pending: '待验证', running: '验证中', passed: '已通过', failed: '失败', waived: '已豁免', cancelled: '已取消' },
  en: { pending: 'Pending', running: 'Running', passed: 'Passed', failed: 'Failed', waived: 'Waived', cancelled: 'Cancelled' },
})

export function formatVerificationStatus(value: VerificationStatus, locale: YuqiLocale): string {
  return copyFor(VERIFICATION_STATUS_COPY, locale)[value]
}

const REVIEW_TRIGGER_COPY = defineLocalizedCopy<Record<ReviewTrigger, string>>({
  zh: {
    'plan-confirmation': '任务图确认',
    'public-contract-change': '公共契约变更',
    'pre-completion': '完成前审查',
    'consecutive-failure': '连续失败',
    'user-request': '用户请求',
    'quality-gate': '质量门',
    'rework-verification': '返工验证',
  },
  en: {
    'plan-confirmation': 'Task graph confirmation',
    'public-contract-change': 'Public contract change',
    'pre-completion': 'Pre-completion review',
    'consecutive-failure': 'Consecutive failure',
    'user-request': 'User request',
    'quality-gate': 'Quality gate',
    'rework-verification': 'Rework verification',
  },
})

/** Unknown legacy values are preserved because the wire field was historically free text. */
export function formatReviewTrigger(value: string, locale: YuqiLocale): string {
  return copyFor(REVIEW_TRIGGER_COPY, locale)[value as ReviewTrigger] ?? value
}

export function formatReviewSeverity(value: TeamConsoleReview['findings'][number]['severity'], locale: YuqiLocale): string {
  const labels = locale === 'en'
    ? { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' }
    : { low: '低', medium: '中', high: '高', critical: '严重' }
  return labels[value]
}

export function formatReviewStatus(value: NonNullable<TeamConsoleReview['status']>, locale: YuqiLocale): string {
  const labels = locale === 'en'
    ? { requested: 'Requested', completed: 'Completed', awaiting_user: 'Awaiting user' }
    : { requested: '已请求', completed: '已完成', awaiting_user: '等待用户' }
  return labels[value]
}

/** Format stable routing facts without exposing protocol enum names as UI copy. */
export function formatModelRouteBasis(value: string, locale: YuqiLocale): string {
  const labels: Readonly<Record<string, LocalizedCopy<string>>> = {
    'task-exact': { zh: '任务精确路由', en: 'Task exact route' },
    'team-fixed': { zh: '团队固定路由', en: 'Team fixed route' },
    automatic: { zh: '自动路由', en: 'Automatic routing' },
    'controller-inherit': { zh: '继承主控路由', en: 'Controller-inherited route' },
    'user-fixed': { zh: '用户指定路由', en: 'User-fixed route' },
    'durable-journal': { zh: '持久化日志路由', en: 'Durable journal route' },
  }
  return labels[value] === undefined ? value : copyFor(labels[value], locale)
}

export function formatModelRouteTier(value: string, locale: YuqiLocale): string {
  const labels: Readonly<Record<string, LocalizedCopy<string>>> = {
    quick: { zh: '快速', en: 'Quick' },
    standard: { zh: '标准', en: 'Standard' },
    critical: { zh: '关键', en: 'Critical' },
  }
  return labels[value] === undefined ? value : copyFor(labels[value], locale)
}

export function formatModelRouteFallbackReason(value: string, locale: YuqiLocale): string {
  const labels: Readonly<Record<string, LocalizedCopy<string>>> = {
    'automatic-candidates-exhausted': { zh: '自动候选已耗尽', en: 'Automatic candidates exhausted' },
    'task-default-controller-inherit': { zh: '任务默认回退到主控模型', en: 'Task default fell back to the controller model' },
    'team-inherit-controller': { zh: '团队跟随主控模型', en: 'Team inherits the controller model' },
  }
  return labels[value] === undefined ? value : copyFor(labels[value], locale)
}

export function formatReviewIndependence(value: string, locale: YuqiLocale): string {
  const labels: Readonly<Record<string, LocalizedCopy<string>>> = {
    'model-diverse': { zh: '多模型', en: 'Model-diverse' },
    'context-only': { zh: '仅上下文', en: 'Context-only' },
    'same-model': { zh: '同一模型', en: 'Same model' },
  }
  return labels[value] === undefined ? value : copyFor(labels[value], locale)
}

const LEGACY_ATTENTION_MESSAGES: Readonly<Record<TeamConsoleAttention['code'], LocalizedCopy<string>>> = {
  'task-blocked': { zh: '任务受阻；请在主控处理原因后重试。', en: 'Task blocked; resolve in the controller before retrying.' },
  'attempt-outcome-unknown': { zh: '子代理上次执行结果待核对；需主控依据现有证据决定后续处理。', en: 'The child Agent’s previous result needs review. The controller must use the recorded evidence to decide what happens next.' },
  'verification-inconclusive': { zh: 'Host 无法完成所需验证，需要用户确认后续处理。', en: 'The Host could not complete the required verification. Choose how to proceed.' },
  'task-failed': { zh: '任务失败；由主控根据重试门禁、预算和历史证据决定后续动作。', en: 'The task failed. The controller will choose the next action using retry policy, budget, and prior evidence.' },
  'dependency-blocked': { zh: '依赖未完成；由主控调度器处理，不要求用户立即决定。', en: 'A dependency is incomplete. The controller scheduler will handle it; no immediate user decision is required.' },
}

/**
 * Compatibility for known system-authored Chinese wire messages. Arbitrary
 * legacy text is returned verbatim so user/model-authored content is never
 * guessed at or machine-translated in the client.
 */
export function formatAttentionMessage(attention: TeamConsoleAttention, locale: YuqiLocale): string {
  if (attention.code === 'task-blocked') return formatBlockedTaskOutcome(attention.taskOutcome, locale)
  const known = LEGACY_ATTENTION_MESSAGES[attention.code]
  if (known !== undefined && (attention.message === known.zh || attention.message === known.en)) {
    const message = copyFor(known, locale)
    return attention.code === 'task-failed' ? `${message} ${modelFailureGuidance(locale)}` : message
  }
  const review = {
    zh: 'Reviewer gate 需要用户在主对话选择重试审查、最终返工、waive、失败或取消。',
    en: 'The reviewer gate needs your decision in the controller conversation: retry review, authorize final rework, waive, fail, or cancel.',
  }
  if (attention.message === review.zh || attention.message === review.en) return copyFor(review, locale)
  return attention.code === 'task-failed' ? `${attention.message} ${modelFailureGuidance(locale)}` : attention.message
}

/** Advice only: model selection does not bypass existing execution or retry gates. */
export function modelFailureGuidance(locale: YuqiLocale): string {
  return locale === 'en'
    ? 'If the failure is model-related, inform the controller in the main conversation; you or the controller can choose another available model. The controller must still check retry gates and budget; changing models does not authorize unlimited retries.'
    : '若失败与模型有关，请在主对话告知主控；你或主控可选择其他可用模型。后续重试仍需主控检查重试门禁和预算，换模型不代表允许无限重试。'
}

/** Translate only the system labels, never the worker's diagnostic content. */
export function formatBlockedTaskOutcome(evidence: import('../domain/task-outcome.ts').TaskOutcomeEvidence | undefined, locale: YuqiLocale, teamStatus?: string): string {
  const en = locale === 'en'
  if (teamStatus === 'paused' || teamStatus === 'pausing') {
    // Only missing/absent outcomes are pause interruptions that auto-resume on
    // Continue; 'invalid' stays blocked after resume and keeps the reconcile text.
    if (evidence === undefined || evidence.status === 'missing') {
      return en ? 'Task paused with Team. Execution will resume automatically when continued.' : '任务已随团队暂停。点击「继续任务」后将自动恢复执行。'
    }
  }
  const prefix = copyFor(LEGACY_ATTENTION_MESSAGES['task-blocked'], locale)
  if (evidence?.status !== 'reported') return `${prefix} ${en ? 'The final task result is missing or invalid.' : '缺少有效的最终任务结果。'}`
  const outcome = evidence.outcome
  return `${prefix} ${outcome.summary}${'nextAction' in outcome && outcome.nextAction ? ` ${en ? 'Next:' : '下一步：'} ${outcome.nextAction}` : ''}${'question' in outcome && outcome.question ? ` ${en ? 'Question:' : '问题：'} ${outcome.question}` : ''}`
}
