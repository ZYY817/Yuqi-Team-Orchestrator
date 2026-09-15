import { describe, expect, it } from 'vitest'
import type { TeamConsoleDuration, TeamConsoleTaskUsage, TeamConsoleUsage } from '../../src/domain/team-console-contract.ts'
import { formatCompactTokens, formatTokens, presentDuration, presentTaskUsage, presentTeamUsage, unavailableDurationLabel } from '../../src/client/usage-presentation.ts'

describe('client usage presentation', () => {
  it('abbreviates large totals only in compact displays', () => {
    expect(formatCompactTokens(7368653)).toBe('736.9万')
    expect(formatCompactTokens(7368653, 'en')).toBe('7.4M')
    expect(formatTokens(7368653)).toBe('7,368,653')
    expect(formatCompactTokens(0)).toBe('0')
  })
  it('presents every English usage and duration state without inventing missing data', () => {
    const known = {
      state: 'known' as const, scope: '受管子 Agent' as const, uncachedInputTokens: 1000,
      outputTokens: 200, cacheReadTokens: 30, cacheWriteTokens: 4, totalTokens: 1234, label: 'known',
    }
    const partial = { ...known, state: 'partial' as const, missingAttemptCount: 1, activeAttemptCount: 2 }
    expect([
      presentTeamUsage({ state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' }, 'en').stateLabel,
      presentTeamUsage({ state: 'unavailable', scope: '受管子 Agent', label: '用量：提供方未上报' }, 'en').stateLabel,
      presentTeamUsage(partial, 'en').detailLabel,
      presentTeamUsage({ ...partial, missingAttemptCount: 0, activeAttemptCount: 0 }, 'en').detailLabel,
      presentTeamUsage(known, 'en').compactLabel,
    ]).toEqual([
      'No data', 'Unavailable', '1 attempt(s) not reported; 2 attempt(s) still running',
      'Team settlement is still in progress', '1.2K tokens used',
    ])

    expect([
      presentTaskUsage({ state: 'pending', label: 'Token：暂无数据' }, 'en').tokenLabel,
      presentTaskUsage({ state: 'unavailable', label: 'Token：提供方未上报' }, 'en').tokenLabel,
      presentTaskUsage({ ...known, state: 'live', label: 'live' }, 'en').detailLabel,
      presentTaskUsage({ ...known, label: 'known' }, 'en').detailLabel,
    ]).toEqual(['Tokens: no data', 'Tokens: unavailable', '1,234 tokens accumulated live', '1,234 tokens recorded'])

    const start = Date.parse('2026-08-30T00:00:00Z')
    expect([
      presentDuration({ state: 'unavailable' }, start, 'en').label,
      presentDuration({ state: 'known', elapsedMs: 45_000 }, start, 'en').label,
      presentDuration({ state: 'known', elapsedMs: 120_000 }, start, 'en').label,
      presentDuration({ state: 'known', elapsedMs: 125_000 }, start, 'en').label,
      presentDuration({ state: 'known', elapsedMs: 3_600_000 }, start, 'en').label,
      presentDuration({ state: 'known', elapsedMs: 5_400_000 }, start, 'en').label,
      presentDuration({ state: 'running', startedAt: '2026-08-30T00:00:00Z' }, start + 65_000, 'en').label,
      presentDuration({ state: 'running', startedAt: 'invalid' }, start, 'en').stateLabel,
    ]).toEqual(['No reliable data', '45s', '2m', '2m 5s', '1h', '1h 30m', 'Running 1m 5s', 'Unavailable'])
  })

  it('formats a complete Team total without changing the durable buckets', () => {
    const usage: TeamConsoleUsage = {
      state: 'known', scope: '受管子 Agent', uncachedInputTokens: 10, outputTokens: 3,
      cacheReadTokens: 4, cacheWriteTokens: 2, totalTokens: 19, label: '用量：19 tok',
    }
    expect(presentTeamUsage(usage)).toEqual({
      totalLabel: '19 Token', stateLabel: '完整', detailLabel: '已结算 attempt 均有 Token 记录', compactLabel: '已用 19 Token',
    })
  })

  it('explains partial coverage and never turns missing usage into zero', () => {
    const usage: TeamConsoleUsage = {
      state: 'partial', scope: '受管子 Agent', uncachedInputTokens: 10, outputTokens: 3,
      cacheReadTokens: 4, cacheWriteTokens: 2, totalTokens: 19, label: '用量：已记录 19 tok（部分）',
      missingAttemptCount: 1, activeAttemptCount: 1,
    }
    const presentation = presentTeamUsage(usage)
    expect(presentation.totalLabel).toBe('19 Token')
    expect(presentation.stateLabel).toBe('部分数据')
    expect(presentation.detailLabel).toBe('1 个 attempt 未上报；1 个 attempt 仍在运行')
    expect(presentation.compactLabel).not.toContain('0 Token')
  })

  it('keeps each partial-usage reason honest when only one or neither count is present', () => {
    const base = {
      state: 'partial' as const, scope: '受管子 Agent' as const,
      uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 3, label: '部分',
    }
    expect(presentTeamUsage({ ...base, missingAttemptCount: 1, activeAttemptCount: 0 }).detailLabel).toBe('1 个 attempt 未上报')
    expect(presentTeamUsage({ ...base, missingAttemptCount: 0, activeAttemptCount: 1 }).detailLabel).toBe('1 个 attempt 仍在运行')
    expect(presentTeamUsage({ ...base, missingAttemptCount: 0, activeAttemptCount: 0 }).detailLabel).toBe('团队仍在结算')
  })

  it.each([
    ['pending', { state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' }, '暂无数据', '暂无数据'],
    ['unavailable', { state: 'unavailable', scope: '受管子 Agent', label: '用量：提供方未上报' }, '不可用', '不可用'],
  ] as const)('keeps %s usage explicit instead of showing zero', (_state, usage, totalLabel, stateLabel) => {
    const presentation = presentTeamUsage(usage)
    expect(presentation.totalLabel).toBe(totalLabel)
    expect(presentation.stateLabel).toBe(stateLabel)
    expect(presentation.detailLabel).not.toContain('0 Token')
  })

  it.each([
    ['known', { state: 'known', totalTokens: 19, label: 'Token：19 tok' }, 'Token：19', '已记录 19 Token'],
    ['live', { state: 'live', totalTokens: 7, label: 'Token：7 tok（运行中）' }, 'Token：7（运行中）', '实时累计 7 Token'],
    ['pending', { state: 'pending', label: 'Token：暂无数据' }, 'Token：暂无数据', '尚未产生可用 Token 数据'],
    ['unavailable', { state: 'unavailable', label: 'Token：提供方未上报' }, 'Token：不可用', '提供方未上报 Token'],
  ] as const)('formats %s task usage for the attempt row', (_state, usage, tokenLabel, detailLabel) => {
    expect(presentTaskUsage(usage as TeamConsoleTaskUsage)).toEqual({ tokenLabel, detailLabel })
  })

  it('exposes the safe duration fallback because the current client contract has no duration pair', () => {
    expect(unavailableDurationLabel).toBe('暂无可靠数据')
  })

  it('formats a durable ended duration without consulting the current clock', () => {
    const duration: TeamConsoleDuration = { state: 'known', elapsedMs: 62_000 }
    expect(presentDuration(duration, Number.NaN)).toEqual({ label: '1 分 2 秒', stateLabel: '已结束' })
    expect(presentDuration({ state: 'known', elapsedMs: Number.NaN }, 0).label).toBe(unavailableDurationLabel)
    expect(presentDuration({ state: 'known', elapsedMs: -1 }, 0).label).toBe(unavailableDurationLabel)
    expect(presentDuration({ state: 'known', elapsedMs: 120_000 }, 0).label).toBe('2 分钟')
    expect(presentDuration({ state: 'known', elapsedMs: 3_600_000 }, 0).label).toBe('1 小时')
    expect(presentDuration({ state: 'known', elapsedMs: 5_400_000 }, 0).label).toBe('1 小时 30 分钟')
  })

  it('uses the durable start only for a running duration', () => {
    const duration: TeamConsoleDuration = { state: 'running', startedAt: '2026-08-15T00:00:00Z' }
    expect(presentDuration(duration, Date.parse('2026-08-15T00:01:02Z'))).toEqual({ label: '运行中 1 分 2 秒', stateLabel: '运行中' })
    expect(presentDuration(duration, Date.parse('2026-08-14T23:59:59Z')).stateLabel).toBe('不可用')
  })

  it('adds only active worker time to settled time, including concurrent attempts', () => {
    const duration: TeamConsoleDuration = {
      state: 'running', startedAt: '2026-08-15T00:00:10Z', elapsedMs: 2_000,
      activeStartedAts: ['2026-08-15T00:00:10Z', '2026-08-15T00:00:11Z'],
    }
    expect(presentDuration(duration, Date.parse('2026-08-15T00:00:13Z'))).toEqual({ label: '累计执行 7 秒', stateLabel: '运行中' })
    expect(presentDuration({
      ...duration,
      activeStartedAts: ['not-a-time', '2026-08-15T00:00:11Z'],
    }, Date.parse('2026-08-15T00:00:13Z'))).toEqual({ label: unavailableDurationLabel, stateLabel: '不可用' })
  })
})
