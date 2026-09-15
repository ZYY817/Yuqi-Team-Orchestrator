import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setImmediate } from 'node:timers/promises'
import ts from 'typescript'

const root = process.env.YUQI_OFFICIAL_TEST_ROOT
test('exact official public Host imports gate bounded service initialization', { skip: !root }, async t => {
  const cleanup = []
  t.after(async () => { for (const close of cleanup.reverse()) await close() })
  const resolutions = new Map()
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, context)
    const result = nextResolve(specifier, { ...context, parentURL: pathToFileURL(resolve(root, 'package.json')).href })
    const target = realpathSync(fileURLToPath(result.url))
    const path = relative(realpathSync(resolve(root, 'node_modules')), target)
    assert.ok(!path.startsWith('..') && !isAbsolute(path), `External escaped exact root: ${specifier}`)
    resolutions.set(specifier, target)
    return result
  } })
  try {
    assert.equal(JSON.parse(readFileSync(resolve(root, 'node_modules/@deepseek-ai/dsh-settings/package.json'), 'utf8')).version, '0.1.2-rc.1')
    const failures = []
    const visited = new Set()
    let checked = 0
    // Inspect every runtime import/re-export in the Host and agent entry graphs,
    // including every named binding, rather than stopping at the first linker error.
    async function audit(url) {
      if (visited.has(url.href)) return
      visited.add(url.href)
      const original = readFileSync(url, 'utf8')
      const source = url.pathname.endsWith('.ts') ? stripTypeScriptTypes(original, { mode: 'transform' }) : original
      const ast = ts.createSourceFile(url.href, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
        if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
        const specifier = statement.moduleSpecifier.text
        if (specifier.startsWith('.')) { await audit(new URL(specifier, url)); continue }
        try {
          const exports = await import(specifier)
          checked++
          const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined
          const names = []
          if (clause?.name) names.push('default')
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            names.push(...clause.namedBindings.elements.map(item => (item.propertyName ?? item.name).text))
          }
          if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            names.push(...statement.exportClause.elements.map(item => (item.propertyName ?? item.name).text))
          }
          for (const name of names) if (!Object.hasOwn(exports, name)) failures.push(`${url.pathname}: ${specifier} missing ${name}`)
        } catch (error) { failures.push(`${url.pathname}: ${specifier}: ${error.message}`) }
      }
    }
    const entries = [new URL('../../src/index.ts', import.meta.url), new URL('../../src/agent/index.ts', import.meta.url)]
    if (process.env.YUQI_TEST_BUILT_IMPORTS === '1') entries.push(new URL('../../lib/index.js', import.meta.url), new URL('../../lib/agent.js', import.meta.url))
    for (const entry of entries) await audit(entry)
    for (const entry of entries) {
      try { await import(entry.href) }
      catch (error) { failures.push(`Actual entry import ${entry.pathname}: ${error.message}`) }
    }
    console.log(JSON.stringify({ stage: 'external-audit', files: visited.size, imports: checked, failures, resolutions: [...resolutions] }))
    assert.deepEqual(failures, [], 'No service initialization is allowed while runtime exports are missing')
    console.log('Actual entry imports passed; beginning bounded service initialization')

    const [{ Context }, { SettingsProvider }, { YuqiTeamOrchestratorService }, { TEAM_SETTINGS_NAMESPACE }] = await Promise.all([
      import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-settings'),
      process.env.YUQI_TEST_BUILT_IMPORTS === '1' ? import('../../lib/index.js') : import('../../src/host/harness/service.ts'),
      import('../../src/application/team-settings.ts'),
    ])
    class MemorySettings extends SettingsProvider {
      writable = true
      async load() { return {} }
      async persist() {}
    }
    const ctx = new Context()
    const directory = await mkdtemp(resolve(tmpdir(), 'yuqi-official-public-service-'))
    // Delete only this freshly allocated test directory, never any Host/user root.
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const [{ SessionStore }, { JsonlSessionPersistence }, { Storage }, { JsonStorageBackend }, { DomainFacility }] = await Promise.all([
      import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-persistence-jsonl'),
      import('@deepseek-ai/dsh-storage'), import('@deepseek-ai/dsh-storage-json'), import('@deepseek-ai/dsh-storage-domain'),
    ])
    const sessionFiber = await ctx.plugin(SessionStore)
    cleanup.push(() => sessionFiber.dispose())
    const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: resolve(directory, 'sessions'), compression: 'none' })
    cleanup.push(() => persistenceFiber.dispose())
    const storageFiber = await ctx.plugin(Storage)
    cleanup.push(() => storageFiber.dispose())
    const backend = new JsonStorageBackend(resolve(directory, 'storage'))
    cleanup.push(() => backend.close())
    const unregister = ctx.storage.backend.register('json', backend)
    cleanup.push(() => unregister())
    const facility = new DomainFacility(ctx, { backend: 'json' })
    cleanup.push(() => facility.closeAll())
    ctx.provide('storageDomain', facility)
    const settingsFiber = await ctx.plugin(MemorySettings)
    cleanup.push(() => settingsFiber.dispose())
    // Model-only dependencies are explicit fail-on-use fixtures, not native exports.
    // No agents or connection: this does not claim full Team/RPC startup coverage.
    const unused = new Proxy({}, { get: (_target, key) => {
      if (typeof key === 'symbol' || key === 'then') return undefined
      throw new Error(`Model/runtime capability must not be used during settings init: ${String(key)}`)
    } })
    ctx.provide('subagents', unused)
    ctx.provide('llm', unused)
    ctx.provide('sandboxPolicy', unused)
    let serviceFiber
    try {
      serviceFiber = await ctx.plugin(YuqiTeamOrchestratorService)
      for (let i = 0; i < 50 && ctx.settings.describe().length < 2; i++) await setImmediate()
      assert.deepEqual(ctx.settings.describe().map(row => String(row.ns)).sort(), ['yuqi-team-orchestrator', 'yuqi-team-settings-scopes'])
      await ctx.settings.update(TEAM_SETTINGS_NAMESPACE, { maxConcurrency: 6 })
      assert.equal(ctx.yuqiTeamOrchestrator.teamDefaults().maxConcurrency, 6)
      const runtime = process.env.YUQI_TEST_BUILT_IMPORTS === '1' ? await import('../../lib/index.js') : await import('../../src/host/storage/session-sidecar.ts')
      const session = ctx.sessions.create(undefined, { meta: { cwd: directory } })
      for (let i = 0; i < 200 && runtime.readSidecarEvents(session) === undefined; i++) await setImmediate()
      assert.deepEqual(runtime.readSidecarEvents(session), [], 'Service must bind the real Session to its real storage domain')
      await ctx.sessionPersistence.ensureMaterialized(session)
      const restored = await ctx.sessionPersistence.load(session.id)
      assert.ok(restored, 'Actual native JSONL materialization/load must succeed')
      assert.ok(session.snapshotEvents().every(event => !event.type.startsWith('yuqi')))
      console.log('Official Context + SettingsProvider + SessionStore + JSONL + Storage/Domain + public service initialized and bound a real Session; no model or keys used')
    } finally {
      await serviceFiber?.dispose()
    }
  } finally { hook.deregister() }
})
