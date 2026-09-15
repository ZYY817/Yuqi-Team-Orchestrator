import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CLIENT_BASE_SERVICES, withClientServiceScope } from '../../src/client/client-service-scope.ts'
import { hostClientApi } from '../../src/client/host-client-api.ts'

const officialRoot = process.env.YUQI_OFFICIAL_TEST_ROOT
test('real official Cordis enforces modern namespace declarations and keeps legacy loading', { skip: !officialRoot }, async t => {
  const requireOfficial = createRequire(resolve(officialRoot, 'package.json'))
  const { Context } = await import(pathToFileURL(requireOfficial.resolve('@deepseek-ai/cordis')).href)
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
  for (const legacy of [false, true]) {
    await t.test(legacy ? 'legacy without Remote services' : 'modern waits for namespaces and disposes with provider', async () => {
      const root = new Context()
      const errors = []
      root.on('internal/error', error => errors.push(error))
      const legacyApi = { marker: 'legacy' }
      for (const name of CLIENT_BASE_SERVICES) root.provide(name, name === 'connection' ? (legacy ? { api: legacyApi } : {}) : {})
      let installs = 0
      let active = 0
      let api
      const parent = await root.plugin({ inject: CLIENT_BASE_SERVICES, apply(ctx) {
        withClientServiceScope(ctx, scope => {
          api = hostClientApi(scope)
          installs++
          scope.effect(() => { active++; return () => { active-- } })
        })
      } })
      try {
        await flush()
        if (legacy) {
          assert.equal(installs, 1)
          assert.equal(api, legacyApi)
        } else {
          assert.equal(installs, 0, 'must wait instead of reading undeclared/missing services')
          const session = { create: async request => ({ ok: true, value: request }) }
          const presets = { list: async () => ({ ok: true, value: { presets: [] } }) }
          const provider = await root.plugin({ apply(ctx) {
            ctx.provide('remote.session', session)
            ctx.provide('remote.agentPresets', presets)
          } })
          await flush()
          assert.equal(installs, 1)
          assert.equal(active, 1)
          assert.deepEqual(await api.sessions.create({ sessionId: 'scope-check', agentPreset: 'yuqi-team' }), {
            result: { ok: true, value: { sessionId: 'scope-check', agentPreset: 'yuqi-team' } },
          })
          // Negative control: ordinary object mocks cannot catch this actual guard.
          let rejected = false
          const negative = await root.plugin({ inject: CLIENT_BASE_SERVICES, apply(ctx) {
            try { hostClientApi(ctx) } catch (error) { rejected = /without inject/.test(error.message) }
          } })
          assert.equal(rejected, true)
          await negative.dispose()
          await provider.dispose()
          await flush()
          assert.equal(active, 0, 'UI effects must be removed with the Remote provider')
        }
        assert.deepEqual(errors, [])
      } finally { await parent.dispose() }
      assert.equal(active, 0)
    })
  }
})
