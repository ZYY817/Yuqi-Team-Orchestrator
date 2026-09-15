import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { registerHooks } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setImmediate } from 'node:timers/promises'

// The resolver selects dependencies only. It never changes source or exports.
const root = process.env.YUQI_OFFICIAL_TEST_ROOT
const resolutions = new Map()
const hook = root ? registerHooks({ resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, context)
  const result = nextResolve(specifier, {
    ...context, parentURL: pathToFileURL(resolve(root, 'package.json')).href,
  })
  const target = realpathSync(fileURLToPath(result.url))
  const path = relative(realpathSync(resolve(root, 'node_modules')), target)
  assert.ok(!path.startsWith('..') && !isAbsolute(path), `External escaped exact root: ${specifier}`)
  resolutions.set(specifier, target)
  return result
} }) : undefined
after(() => hook?.deregister())
if (root) {
  assert.equal(JSON.parse(readFileSync(resolve(root, 'node_modules/@deepseek-ai/dsh-settings/package.json'), 'utf8')).version, '0.1.2-rc.1')
}
const [{ Context }, settingsApi, { default: z }, { installSettingsSection }, team, { TeamSettingsScopes }] = await Promise.all([
  import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-settings'), import('@deepseek-ai/schemastery'),
  import('../../src/host/harness/settings-compatibility.ts'),
  import('../../src/application/team-settings.ts'), import('../../src/host/harness/team-settings-scope.ts'),
])

class MemorySettings extends settingsApi.SettingsProvider {
  writable = true
  document = {}
  async load() { return this.document }
  async persist(ns, section) { this.document = { ...this.document, [ns]: structuredClone(section) } }
}

test('prefers provider method, preserving receiver and all five arguments', () => {
  const args = [null, 'adapter-test', z.object({}), {}, { setSource() {}, onChange() {} }]
  const provider = { installSection(...actual) { assert.equal(this, provider); assert.deepEqual(actual, args) } }
  args[0] = { settings: provider }
  installSettingsSection(...args)
})

test('provider validation errors propagate unchanged without legacy retry', () => {
  const failure = new Error('validation sentinel')
  assert.throws(() => installSettingsSection({ settings: { installSection() { throw failure } } },
    'adapter-test', z.object({}), {}, { setSource() {}, onChange() {} }), error => error === failure)
})

test('actual provider validates namespaces, installs both Team sections and updates source', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(MemorySettings)
  try {
    const provider = ctx.settings
    if (root) {
      assert.equal(Reflect.get(settingsApi, 'installSettingsSection'), undefined)
      assert.equal(Reflect.get(settingsApi, 'settingsNamespace'), undefined)
      assert.equal(typeof provider.installSection, 'function')
    } else {
      assert.equal(typeof Reflect.get(settingsApi, 'installSettingsSection'), 'function')
      assert.equal(typeof provider.installSection, 'undefined', 'Exercise actual legacy fallback')
    }
    let source
    let changes = 0
    const hooks = { setSource: next => { source = next }, onChange: () => { changes++ },
      validate: value => team.assertTeamConcurrency(value.maxConcurrency) }
    const entry = team.TEAM_SETTINGS_SCHEMA({})
    // Legacy register trusts its branded argument; only the new Host validates it.
    if (root) assert.throws(() => installSettingsSection(ctx, 'INVALID namespace', team.TEAM_SETTINGS_SCHEMA, entry, hooks))
    assert.equal(provider.describe().length, 0)
    installSettingsSection(ctx, team.TEAM_SETTINGS_NAMESPACE, team.TEAM_SETTINGS_SCHEMA, entry, hooks)
    // The legacy helper installs through ctx.inject, unlike the new method.
    for (let i = 0; !source && i < 20; i++) await setImmediate()
    const scopes = new TeamSettingsScopes(ctx)
    assert.equal(source().maxConcurrency, entry.maxConcurrency)
    await provider.update(team.TEAM_SETTINGS_NAMESPACE, { maxConcurrency: 6 })
    assert.equal(source().maxConcurrency, 6)
    assert.equal(scopes.read({ level: 'global' }).value.maxConcurrency, 6)
    assert.ok(changes >= 2)
    await assert.rejects(provider.update(team.TEAM_SETTINGS_NAMESPACE, { maxConcurrency: -1 }))
    assert.equal(source().maxConcurrency, 6)
    if (root) assert.throws(() => installSettingsSection(ctx, team.TEAM_SETTINGS_NAMESPACE, team.TEAM_SETTINGS_SCHEMA, entry, hooks))
  } finally { await fiber.dispose() }
  assert.equal(ctx.get('settings'), undefined)
  if (root) console.log('exact official settings dependencies:', JSON.stringify([...resolutions]))
})
