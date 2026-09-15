#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpathSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Exact messages owned by session-compatibility.ts; never echo arbitrary causes.
const knownCauses = new Map([
  ['Host must provide an empty detached Session using the same append implementation', 'detached-session'],
  ['Session.append must natively store ignorable: true', 'native-append'],
  ['Session.create must preserve the complete downstream event on JSON replay', 'json-replay'],
])

// Standalone installer probe: use only public APIs, never a Host's private log.
function readEvents(session) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events
  assert.ok(Array.isArray(events), 'A public Session event snapshot is required')
  return events
}

class PreflightError extends Error {
  constructor(stage, error) {
    let code = stage === 'session-log-contract-unavailable' ? 'HOST_SESSION_INCOMPATIBLE' : 'PREFLIGHT_FAILED'
    try {
      if (error?.code === 'HOST_SESSION_INCOMPATIBLE') {
        code = 'HOST_SESSION_INCOMPATIBLE'
        if (stage === 'compatibility-check') stage = knownCauses.get(error.cause?.message) ?? stage
      }
    } catch { /* Unreadable error properties are not diagnostics. */ }
    super(`Host compatibility check failed: ${code} (stage: ${stage}). Native ignorable append and replay must pass before installing or starting a Team.`)
    this.code = code
    this.stage = stage
  }
}

/** Detached runtime preflight. Does not boot a Host, discover profiles, or write sessions. */
export async function checkHostCompatibility(sessionModule, compatibilityModule) {
  let stage = 'session-module-load'
  try {
    const { Session } = await import(pathToFileURL(resolve(sessionModule)).href)
    stage = 'session-exports'
    assert.equal(typeof Session?.create, 'function')
    stage = 'compatibility-module-load'
    const compatibility = await import(compatibilityModule ?? new URL('../lib/index.js', import.meta.url).href)
    stage = 'compatibility-exports'
    const append = compatibility.appendCompatibleYuqiSessionEvent ?? compatibility.appendYuqiSessionEvent
    assert.equal(typeof compatibility.assertYuqiSessionEventCompatibility, 'function')
    assert.equal(typeof append, 'function')
    stage = 'detached-session'
    const session = Session.create('yuqi-detached-envelope-probe')
    stage = 'session-log-contract-unavailable'
    readEvents(session)
    stage = 'compatibility-check'
    compatibility.assertYuqiSessionEventCompatibility(session)
    stage = 'native-append'
    const event = append(session, 'yuqi/team-event', { probe: 'cold-replay' })
    assert.equal(event.ignorable, true, 'Host append must write the marker, not merely declare support')
    stage = 'stored-marker'
    const events = readEvents(session)
    assert.equal(events.length, 1)
    assert.equal(events[0].ignorable, true, 'the stored event must retain the marker')
    stage = 'json-replay'
    const restored = Session.create(session.id, JSON.parse(JSON.stringify(events)), session.header)
    assert.deepEqual(readEvents(restored)[0], event, 'JSON replay must retain the complete downstream event')
    return { status: 'passed', sessionModule: pathToFileURL(resolve(sessionModule)).href, checks: ['native-append', 'stored-marker', 'json-replay'] }
  } catch (error) {
    throw new PreflightError(stage, error)
  }
}

class SidecarPreflightError extends Error {
  constructor(stage) {
    super(`Host sidecar compatibility check failed: PREFLIGHT_FAILED (stage: ${stage}). Official public APIs and the built sidecar runtime must pass before using sidecar mode.`)
    this.code = 'PREFLIGHT_FAILED'
    this.stage = stage
  }
}

function isWithin(root, path) {
  const suffix = relative(root, path)
  return suffix !== '' && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
}

/** Official-install sidecar probe. Uses only a new temporary directory and public
 * exports; never loads a profile, starts a server, or calls the legacy guard.
 * The default runtime is the shipped bundle, with no source/fixture fallback.
 */
export async function checkSidecarCompatibility(officialInstallRoot) {
  let installRoot
  try {
    assert.equal(typeof officialInstallRoot, 'string')
    assert.ok(officialInstallRoot.length > 0)
    installRoot = await realpath(resolve(officialInstallRoot))
    await realpath(join(installRoot, 'node_modules'))
  } catch { throw new SidecarPreflightError('official-module-resolution') }
  // Never inherit --import/--require hooks, NODE_OPTIONS or a parent's module
  // cache. Run the entire contract, not just the import, with official externals.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())))
  try {
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(import.meta.url), '--sidecar-worker', installRoot],
      { env, timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true })
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'passed')
    assert.equal(report.mode, 'sidecar')
    assert.ok(report.checks.includes('official-runtime-import'))
    return report
  } catch (error) {
    // A dependency may print arbitrary output: only accept our exact diagnostic.
    const diagnostic = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const stage = /\(stage: ([a-z-]+)\)/.exec(diagnostic)?.[1]
    if (stage && diagnostic === new SidecarPreflightError(stage).message) throw new SidecarPreflightError(stage)
    throw new SidecarPreflightError('official-runtime-import')
  }
}

function useOfficialExternals(installRoot) {
  const modulesRoot = realpathSync(join(installRoot, 'node_modules'))
  const anchor = pathToFileURL(join(installRoot, 'package.json')).href
  // Use Node's real ESM export-condition resolution, including package subpaths.
  // nextResolve avoids recursively invoking this hook through require.resolve.
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, context)
    const resolved = nextResolve(specifier, { ...context, parentURL: anchor })
    const entry = realpathSync(fileURLToPath(resolved.url))
    assert.ok(isWithin(modulesRoot, entry), 'External resolved outside official installation')
    return { ...resolved, url: pathToFileURL(entry).href }
  } })
}

// Select by public capability, never retry a failed read through a different API.
export async function readPreflightSession(persistence, id) {
  if (typeof persistence.open === 'function' && typeof persistence.stat === 'function') {
    if (await persistence.stat(id) === undefined) return undefined
    const handle = await persistence.open(id, 'read')
    try {
      const result = await handle.read()
      assert.equal(handle.header?.id, id)
      assert.ok(Array.isArray(result?.events))
      return { meta: handle.header, events: result.events,
        inheritedEventCount: handle.inheritedEventCount ?? 0 }
    } finally { await handle.close() }
  }
  assert.equal(typeof persistence.readRaw, 'function')
  assert.equal(typeof persistence.readFrom, 'function')
  const raw = await persistence.readRaw(id)
  if (raw === undefined) return undefined
  const result = await persistence.readFrom(id, 0)
  assert.equal(raw.meta?.id, id)
  assert.ok(Array.isArray(result?.events))
  return { meta: raw.meta, events: result.events, inheritedEventCount: raw.inheritedEventCount ?? 0 }
}

export async function materializePreflightSession(persistence, session) {
  if (typeof persistence.ensureMaterialized === 'function') {
    await persistence.ensureMaterialized(session)
    return
  }
  assert.equal(typeof persistence.create, 'function')
  const existing = await readPreflightSession(persistence, session.id)
  if (existing !== undefined) {
    assert.deepEqual(existing.meta, session.header)
    return
  }
  const handle = await persistence.create(session.header)
  await handle.close()
}

// Called only by the fresh worker entry below; deliberately not a public bypass.
async function checkSidecarInWorker(officialInstallRoot) {
  let stage = 'official-module-resolution'
  let root
  const closers = []
  let result, failure
  try {
    assert.equal(typeof officialInstallRoot, 'string')
    assert.ok(officialInstallRoot.length > 0)
    const installRoot = await realpath(resolve(officialInstallRoot))
    const modulesRoot = await realpath(join(installRoot, 'node_modules'))
    const requireOfficial = createRequire(join(installRoot, 'package.json'))
    stage = 'official-runtime-import'
    const runtimeModule = new URL('../lib/index.js', import.meta.url).href
    const runtime = await import(runtimeModule)
    const names = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-json',
      '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-session-persistence-jsonl',
      '@deepseek-ai/dsh-client-connection']
    const entries = await Promise.all(names.map(async name => {
      const entry = await realpath(requireOfficial.resolve(name))
      assert.ok(isWithin(modulesRoot, entry), 'Official exports must resolve inside the selected installation')
      return pathToFileURL(entry).href
    }))
    stage = 'official-module-load'
    const [{ Context }, { Storage }, { JsonStorageBackend }, { DomainFacility, defineDomain },
      { Session, SessionStore }, { SessionPersistence }, { JsonlSessionPersistence },
      { HostConnectionService }] = await Promise.all(entries.map(entry => import(entry)))
    stage = 'official-exports'
    for (const value of [Context, Storage, JsonStorageBackend, DomainFacility, defineDomain,
      SessionStore, Session?.create, Session?.prototype?.snapshotEvents]) {
      assert.equal(typeof value, 'function')
    }
    stage = 'rpc-handle-export'
    // Inspect the actual public accessor without starting HTTP or fabricating a transport.
    assert.equal(typeof Reflect.get(HostConnectionService.prototype, 'rpc')?.handle, 'function')
    stage = 'sidecar-runtime-exports'
    const { SidecarRepository, readSidecarEvents, hasSidecarSession, appendSidecarEvent, ownedEventDomainSpec } = runtime
    for (const value of [SidecarRepository, readSidecarEvents, hasSidecarSession, appendSidecarEvent]) {
      assert.equal(typeof value, 'function')
    }
    assert.equal(ownedEventDomainSpec?.layout, 'single')
    const spec = defineDomain(ownedEventDomainSpec)
    stage = 'temporary-directory'
    root = await mkdtemp(join(tmpdir(), 'yuqi-sidecar-preflight-'))

    async function open() {
      const ctx = new Context()
      let backend, facility, repository, unregister, closing
      const close = () => closing ??= (async () => {
        repository?.dispose()
        try { await facility?.closeAll() }
        finally {
          try { unregister?.(); await backend?.close() }
          finally { await ctx.fiber.dispose() }
        }
      })()
      closers.push(close)
      await ctx.plugin(Storage)
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'native'), compression: 'none' })
      assert.ok(typeof ctx.sessionPersistence?.ensureMaterialized === 'function'
        || typeof ctx.sessionPersistence?.create === 'function')
      backend = new JsonStorageBackend(join(root, 'sidecar'))
      unregister = ctx.storage.backend.register('json', backend)
      facility = new DomainFacility(ctx, { backend: 'json' })
      const domain = await facility.open(spec)
      repository = new SidecarRepository(domain.table('sessions'), {
        beforeAppend: async session => {
          await materializePreflightSession(ctx.sessionPersistence, session)
          const raw = await readPreflightSession(ctx.sessionPersistence, session.id)
          assert.equal(raw?.meta.id, session.id, 'Native header must be materialized before the sidecar write')
        },
      })
      return { ctx, repository, close }
    }

    stage = 'official-domain-open'
    const first = await open()
    stage = 'native-session-create'
    const detached = Session.create('yuqi-sidecar-detached-probe')
    assert.ok(Array.isArray(detached.snapshotEvents()))
    const sessions = ['yuqi-sidecar-parent-probe', 'yuqi-sidecar-child-probe']
      .map(id => first.ctx.sessions.create(id, { meta: { cwd: root } }))
    const nativeBefore = sessions.map(session => structuredClone(session.snapshotEvents()))
    assert.ok(nativeBefore.every(events => events.every(event => !event.type.startsWith('yuqi/'))))
    for (const session of sessions) first.repository.bind(session)
    stage = 'ensure-materialized-and-sidecar-commit'
    const committed = []
    for (const session of sessions) {
      assert.equal(await readPreflightSession(first.ctx.sessionPersistence, session.id), undefined)
      const event = await appendSidecarEvent(session, 'yuqi/preflight', { probe: 'cold-replay' })
      assert.equal(event.type, 'yuqi/preflight')
      assert.deepEqual(event.data, { probe: 'cold-replay' })
      assert.equal(event.seq, 1)
      assert.equal(event.ignorable, true)
      assert.ok(Number.isFinite(event.time))
      assert.deepEqual(readSidecarEvents(session), [event])
      committed.push([event])
    }
    stage = 'native-log-isolation'
    assert.deepEqual(sessions.map(session => session.snapshotEvents()), nativeBefore)
    const nativeRaw = await Promise.all(sessions.map(session => readPreflightSession(first.ctx.sessionPersistence, session.id)))
    for (const [index, session] of sessions.entries()) {
      assert.deepEqual(nativeRaw[index].events, nativeBefore[index])
    }
    stage = 'sidecar-dispose'
    await first.close()
    for (const session of sessions) {
      assert.throws(() => readSidecarEvents(session), /disposed/)
      assert.throws(() => hasSidecarSession(session), /disposed/)
      await assert.rejects(appendSidecarEvent(session, 'yuqi/preflight', {}), /disposed/)
    }
    stage = 'sidecar-cold-replay'
    const second = await open()
    for (const [index, session] of sessions.entries()) {
      stage = 'native-cold-read'
      const saved = await readPreflightSession(second.ctx.sessionPersistence, session.id)
      assert.ok(nativeRaw[index], 'Materialized native artifact is required')
      assert.deepEqual(saved.events, nativeBefore[index])
      stage = 'native-cold-restore'
      const restored = Session.create(session.id, saved.events, saved.meta, saved.inheritedEventCount)
      // Official restore may add its own end-seed lifecycle marker in memory.
      const restoredNative = structuredClone(restored.snapshotEvents())
      assert.ok(restoredNative.every(event => !event.type.startsWith('yuqi/')))
      stage = 'sidecar-cold-replay'
      second.repository.bind(restored)
      assert.deepEqual(readSidecarEvents(restored), committed[index])
      stage = 'native-cold-isolation'
      assert.deepEqual(await readPreflightSession(second.ctx.sessionPersistence, session.id), nativeRaw[index])
      stage = 'native-restored-snapshot'
      assert.deepEqual(restored.snapshotEvents(), restoredNative)
    }
    assert.deepEqual(second.repository.listSessionIds().sort(), sessions.map(session => session.id).sort())
    result = { status: 'passed', mode: 'sidecar', officialInstallRoot: installRoot, runtimeModule,
      checks: ['official-runtime-import', 'official-public-exports', 'rpc-handle-export', 'native-session-create', 'snapshot-events',
        'ensure-materialized', 'sidecar-commit', 'native-log-isolation', 'disposed-no-native-fallback', 'sidecar-cold-replay'] }
  } catch {
    failure = new SidecarPreflightError(stage)
  } finally {
    const closed = await Promise.allSettled(closers.reverse().map(close => close()))
    if (closed.some(item => item.status === 'rejected')) failure ??= new SidecarPreflightError('cleanup')
    if (root) {
      try {
        assert.equal(resolve(root, '..'), resolve(tmpdir()))
        assert.ok(root.startsWith(join(tmpdir(), 'yuqi-sidecar-preflight-')))
        await rm(root, { recursive: true, force: true })
      } catch { failure ??= new SidecarPreflightError('cleanup') }
    }
  }
  if (failure) throw failure
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let stage = 'arguments'
  try {
    if (process.argv[2] === '--sidecar-worker') {
      if (process.argv.length !== 4) throw new SidecarPreflightError('arguments')
      try { useOfficialExternals(resolve(process.argv[3])) }
      catch { throw new SidecarPreflightError('official-module-resolution') }
      console.log(JSON.stringify(await checkSidecarInWorker(process.argv[3])))
    } else if (process.argv[2] === '--sidecar') {
      if (process.argv.length !== 4 || !process.argv[3] || process.argv[3].startsWith('--')) throw new SidecarPreflightError('arguments')
      console.log(JSON.stringify(await checkSidecarCompatibility(process.argv[3])))
    } else {
      if (process.argv.length > 3) throw new Error('Usage: node scripts/check-host-compatibility.mjs [absolute-session-module]')
      stage = 'session-module-load'
      const sessionModule = process.argv[2] ?? createRequire(resolve('package.json')).resolve('@deepseek-ai/dsh-session')
      console.log(JSON.stringify(await checkHostCompatibility(sessionModule)))
    }
  } catch (error) {
    // Print only our diagnostic, never imported-module stacks or environment values.
    console.error(error instanceof PreflightError || error instanceof SidecarPreflightError ? error.message : new PreflightError(stage, error).message)
    process.exitCode = 1
  }
}
