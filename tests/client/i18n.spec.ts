import { describe, expect, it } from 'vitest'
import {
  copyFor,
  defineLocalizedCopy,
  formatAttentionMessage,
  formatBlockedTaskOutcome,
  formatAuthorityMode,
  formatModelRouteBasis,
  formatModelRouteFallbackReason,
  formatModelRouteTier,
  formatList,
  formatReviewIndependence,
  formatReviewSeverity,
  formatReviewStatus,
  formatReviewTrigger,
  formatTeamStatus,
  formatTaskStatus,
  formatVerificationStatus,
  labelValue,
  localeLanguageTag,
} from '../../src/client/i18n.ts'

describe('typed client i18n formatters', () => {
  it('renders worker blockers in the currently selected locale without translating worker content', () => {
    const taskOutcome = { status: 'reported' as const, outcome: { version: 1 as const, kind: 'blocked' as const, summary: '用户提供的原因', nextAction: '询问规格', question: '选哪个？' } }
    const attention = { owner: 'controller' as const, code: 'task-blocked' as const, taskId: 'task', message: '旧语言文本', taskOutcome }
    expect(formatAttentionMessage(attention, 'en')).toContain('Task blocked; resolve in the controller before retrying.')
    expect(formatAttentionMessage(attention, 'en')).toContain('Next: 询问规格')
    expect(formatAttentionMessage(attention, 'zh')).toContain('下一步： 询问规格')
    expect(formatBlockedTaskOutcome({ status: 'missing' }, 'en')).toContain('missing or invalid')
  })
  it('localizes semantic permission, status, review, and punctuation values', () => {
    expect(formatAuthorityMode('write-authorized', 'zh')).toBe('工作区写入')
    expect(formatAuthorityMode('write-authorized', 'en')).toBe('Workspace write')
    expect(formatTaskStatus('completed', 'en')).toBe('Completed')
    expect(formatReviewTrigger('rework-verification', 'zh')).toBe('返工验证')
    expect(formatReviewSeverity('critical', 'en')).toBe('Critical')
    expect(formatReviewStatus('awaiting_user', 'zh')).toBe('等待用户')
    expect(labelValue('Status', 'Running', 'en')).toBe('Status: Running')
    expect(labelValue('状态', '运行中', 'zh')).toBe('状态：运行中')
  })

  it('preserves unknown semantic values and arbitrary legacy text', () => {
    expect(formatReviewTrigger('legacy custom trigger', 'en')).toBe('legacy custom trigger')
    expect(formatTaskStatus('future-status', 'zh')).toBe('future-status')
    expect(formatAttentionMessage({ owner: 'user', code: 'verification-inconclusive', taskId: 'one', message: '用户提供的说明' }, 'en')).toBe('用户提供的说明')
  })

  it('translates only recognized system-authored legacy attention copy', () => {
    expect(formatAttentionMessage({
      owner: 'user', code: 'verification-inconclusive', taskId: 'one',
      message: 'Host 无法完成所需验证，需要用户确认后续处理。',
    }, 'en')).toBe('The Host could not complete the required verification. Choose how to proceed.')
  })

  it('localizes routing and review checkpoint facts while preserving unknown values', () => {
    expect(formatModelRouteBasis('automatic', 'zh')).toBe('自动路由')
    expect(formatModelRouteBasis('automatic', 'en')).toBe('Automatic routing')
    expect(formatModelRouteTier('critical', 'zh')).toBe('关键')
    expect(formatModelRouteTier('critical', 'en')).toBe('Critical')
    expect(formatModelRouteFallbackReason('automatic-candidates-exhausted', 'zh')).toBe('自动候选已耗尽')
    expect(formatModelRouteFallbackReason('automatic-candidates-exhausted', 'en')).toBe('Automatic candidates exhausted')
    expect(formatReviewIndependence('model-diverse', 'zh')).toBe('多模型')
    expect(formatReviewIndependence('model-diverse', 'en')).toBe('Model-diverse')
    expect(formatModelRouteBasis('future-basis', 'en')).toBe('future-basis')
    expect(formatModelRouteTier('future-tier', 'zh')).toBe('future-tier')
    expect(formatModelRouteFallbackReason('future-reason', 'zh')).toBe('future-reason')
    expect(formatReviewIndependence('future-independence', 'en')).toBe('future-independence')
  })

  it('covers locale helpers, list punctuation, defaults, and all remaining status fallbacks', () => {
    const copy = defineLocalizedCopy({ zh: { title: '中文' }, en: { title: 'English' } })
    expect(copyFor(copy, 'zh')).toEqual({ title: '中文' })
    expect(copyFor(copy, 'en')).toEqual({ title: 'English' })
    expect(localeLanguageTag('zh')).toBe('zh-CN')
    expect(localeLanguageTag('en')).toBe('en')
    expect(formatList(['a', 'b'], 'zh')).toBe('a、b')
    expect(formatList(['a', 'b'], 'en')).toBe('a, b')
    expect(formatAuthorityMode(undefined, 'zh')).toBe('工作区写入')
    expect(formatTeamStatus('paused', 'en')).toBe('Paused')
    expect(formatTeamStatus('future-team-state', 'zh')).toBe('future-team-state')
    expect(formatVerificationStatus('waived', 'zh')).toBe('已豁免')
  })

  it('translates the reviewer-gate compatibility message and preserves it in Chinese', () => {
    const attention = {
      owner: 'user' as const,
      code: 'verification-inconclusive' as const,
      taskId: 'review',
      message: 'Reviewer gate 需要用户在主对话选择重试审查、最终返工、waive、失败或取消。',
    }
    expect(formatAttentionMessage(attention, 'en')).toContain('retry review')
    expect(formatAttentionMessage(attention, 'zh')).toBe(attention.message)
  })
})
