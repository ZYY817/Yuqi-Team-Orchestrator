import { beforeEach, vi } from 'vitest'

// Unit-only behavior fixture; the separate integration probes never load this setup.
// Events carry the marker before storage, freezing, and observer publication.
vi.mock('@deepseek-ai/dsh-session', async () => {
  const { loadSessionEnvelopeFixture } = await import('./session-envelope-runtime.ts')
  return loadSessionEnvelopeFixture()
})

// Client tests model the Chinese Host unless a case explicitly selects a
// different document or persisted locale. Real browsers may then fall through
// to navigator.languages as covered by client-locale.spec.tsx.
beforeEach(() => {
  const testDocument = (globalThis as { document?: { documentElement: { lang: string } } }).document
  if (testDocument !== undefined) testDocument.documentElement.lang = 'zh-CN'
})
