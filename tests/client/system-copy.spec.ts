import { describe, expect, it } from 'vitest'
import { localizedSystemCopy } from '../../src/client/TeamPanel.tsx'
import type { YuqiLocale } from '../../src/client/i18n.ts'

describe('TeamPanel system copy', () => {
  it.each([
    ['结果尚未确认：现场记录已保留，需主控核对后决定后续处理。', 'The result is not yet confirmed. Recorded evidence is preserved for the controller to review before deciding what happens next.'],
    ['可在安全门禁通过后重试，历史证据会保留。', 'Retry after the safety gate passes; prior evidence will be preserved.'],
    ['已取消：不会自动重新开始。', 'Cancelled; it will not restart automatically.'],
  ])('translates known system text both ways: %s', (zh, en) => {
    expect(localizedSystemCopy(zh, 'en')).toBe(en)
    expect(localizedSystemCopy(en, 'zh')).toBe(zh)
    expect(localizedSystemCopy(en, 'en')).toBe(en)
    expect(localizedSystemCopy(zh, 'zh')).toBe(zh)
    expect(localizedSystemCopy(en, 'unknown' as YuqiLocale)).toBe(zh)
  })
  it.each(['用户自己的诊断 E_429', 'Custom model output E_429'])('preserves arbitrary content: %s', value => {
    expect(localizedSystemCopy(value, 'en')).toBe(value)
    expect(localizedSystemCopy(value, 'zh')).toBe(value)
  })
})
