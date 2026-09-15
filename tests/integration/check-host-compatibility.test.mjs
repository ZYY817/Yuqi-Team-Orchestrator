import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkSidecarCompatibility } from '../../scripts/check-host-compatibility.mjs'

const script = new URL('../../scripts/check-host-compatibility.mjs', import.meta.url)
const sessionURL = new URL('./private-session-fixture.mjs', import.meta.url)
const compatibilityURL = new URL('../../lib/index.js', import.meta.url)
const guardURL = new URL('../../src/host/harness/session-compatibility.ts', import.meta.url)
const secret = 'PRIVATE_TOKEN=C:/sensitive/customer/session.key\nIMPORTED_STACK'
const realGuard = `export * from ${JSON.stringify(guardURL.href)}`
const plainGuard = `
  export function assertYuqiSessionEventCompatibility() {}
  export function appendCompatibleYuqiSessionEvent(s, type, data) {
    return s.append(type, data, { ignorable: true })
  }
`

// Isolated runtime model; hooks live only in each child, with no fixture files,
// package changes, Host boot, or dependency downloads.
function runtime(options = {}) {
  return `
    const options = ${JSON.stringify(options)}
    export class Session {
      static create(id, seed = [], header = { id }) {
        if (options.createThrows) throw new Error(${JSON.stringify(secret)})
        const s = new Session()
        s.id = id; s.header = header; s.events = structuredClone(seed)
        if (options.replayLosesData && seed.length) s.events[0].data = {}
        if (options.noEvents) {
          delete s.events
          s.snapshotEvents = () => { throw new Error('must not adapt snapshotEvents') }
        }
        return s
      }
      append(type, data, options) {
        const event = { type, data, seq: this.events.length, time: 1,
          ...(!${Boolean(options.noMarker)} && options.ignorable ? { ignorable: true } : {}) }
        if (${Boolean(options.circular)}) event.data.self = event
        const stored = structuredClone(event)
        if (${Boolean(options.noStoredMarker)}) delete stored.ignorable
        if (!${Boolean(options.noStoredEvent)}) this.events.push(stored)
        return event
      }
    }
  `
}

function run({ session = runtime(), compatibility = realGuard, api = false, extraArgs = [] } = {}) {
  const bootstrap = `
    import { registerHooks } from 'node:module'
    const sources = new Map(${JSON.stringify([[sessionURL.href, session], [compatibilityURL.href, compatibility]])})
    registerHooks({
      resolve(specifier, context, next) {
        if (sources.has(specifier)) return { url: specifier, shortCircuit: true }
        return next(specifier, context)
      },
      load(url, context, next) {
        if (sources.has(url)) return { format: 'module', source: sources.get(url), shortCircuit: true }
        return next(url, context)
      }
    })
  `
  const args = ['--import', `data:text/javascript,${encodeURIComponent(bootstrap)}`]
  if (api) {
    args.push('--input-type=module', '-e', `
      const { checkHostCompatibility } = await import(${JSON.stringify(script.href)})
      try {
        console.log(JSON.stringify(await checkHostCompatibility(
          ${JSON.stringify(fileURLToPath(sessionURL))}, ${JSON.stringify(compatibilityURL.href)})))
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, stage: error.stage, message: error.message, cause: error.cause }))
        process.exitCode = 1
      }
    `)
  } else args.push(fileURLToPath(script), fileURLToPath(sessionURL), ...extraArgs)
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return result
}

const failures = [
  ['session import exception', { session: `throw new Error(${JSON.stringify(secret)})` }, 'session-module-load'],
  ['compatibility import exception', { compatibility: `throw new Error(${JSON.stringify(secret)})` }, 'compatibility-module-load'],
  ['Session export absent', { session: 'export const other = 1' }, 'session-exports'],
  ['create export invalid', { session: 'export const Session = { create: 1 }' }, 'session-exports'],
  ['guard export absent', { compatibility: 'export function appendCompatibleYuqiSessionEvent() {}' }, 'compatibility-exports'],
  ['append exports absent', { compatibility: 'export function assertYuqiSessionEventCompatibility() {}' }, 'compatibility-exports'],
  ['detached create throws', { session: runtime({ createThrows: true }) }, 'detached-session'],
  ['snapshotEvents throws', { session: runtime({ noEvents: true }) }, 'session-log-contract-unavailable', 'HOST_SESSION_INCOMPATIBLE'],
  ['real guard rejects native marker', { session: runtime({ noMarker: true }) }, 'native-append', 'HOST_SESSION_INCOMPATIBLE'],
  ['real guard rejects stored marker', { session: runtime({ noStoredMarker: true }) }, 'native-append', 'HOST_SESSION_INCOMPATIBLE'],
  ['real guard rejects replay data loss', { session: runtime({ replayLosesData: true }) }, 'json-replay', 'HOST_SESSION_INCOMPATIBLE'],
  ['outer native marker assertion', { session: runtime({ noMarker: true }), compatibility: plainGuard }, 'native-append'],
  ['outer stored marker assertion', { session: runtime({ noStoredMarker: true }), compatibility: plainGuard }, 'stored-marker'],
  ['outer stored length assertion', { session: runtime({ noStoredEvent: true }), compatibility: plainGuard }, 'stored-marker'],
  ['outer complete replay assertion', { session: runtime({ replayLosesData: true }), compatibility: plainGuard }, 'json-replay'],
  ['JSON serialization fails', { session: runtime({ circular: true }), compatibility: plainGuard }, 'json-replay'],
]

for (const [label, fixture, stage, code = 'PREFLIGHT_FAILED'] of failures) {
  test(`${label}: safe CLI and exported function diagnostics`, () => {
    const cli = run(fixture)
    assert.equal(cli.status, 1)
    assert.equal(cli.stdout, '')
    assert.equal(cli.stderr, `Host compatibility check failed: ${code} (stage: ${stage}). Native ignorable append and replay must pass before installing or starting a Team.\n`)
    const api = run({ ...fixture, api: true })
    assert.equal(api.status, 1)
    assert.equal(api.stderr, '')
    assert.deepEqual(JSON.parse(api.stdout), { code, stage, message: cli.stderr.trim() })
  })
}

for (const cause of [
  'Host must provide an empty detached Session using the same append implementation',
  'Session.append must natively store ignorable: true',
  'Session.create must preserve the complete downstream event on JSON replay',
  `Session.append must natively store ignorable: true ${secret}`,
  secret,
  'toString',
]) {
  test(`cause allowlist case ${JSON.stringify(cause).slice(0, 55)}`, () => {
    const compatibility = `${plainGuard.replace('export function assertYuqiSessionEventCompatibility() {}', `
      export function assertYuqiSessionEventCompatibility() {
        throw Object.assign(new Error(${JSON.stringify(secret)}, { cause: new Error(${JSON.stringify(cause)}) }), {
          code: 'HOST_SESSION_INCOMPATIBLE', stage: ${JSON.stringify(secret)}
        })
      }
    `)}`
    const stages = new Map([
      ['Host must provide an empty detached Session using the same append implementation', 'detached-session'],
      ['Session.append must natively store ignorable: true', 'native-append'],
      ['Session.create must preserve the complete downstream event on JSON replay', 'json-replay'],
    ])
    const result = run({ compatibility })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, `Host compatibility check failed: HOST_SESSION_INCOMPATIBLE (stage: ${stages.get(cause) ?? 'compatibility-check'}). Native ignorable append and replay must pass before installing or starting a Team.\n`)
  })
}

test('successful return remains unchanged, including legacy append fallback', () => {
  for (const compatibility of [realGuard, plainGuard.replaceAll('appendCompatibleYuqiSessionEvent', 'appendYuqiSessionEvent')]) {
    for (const api of [false, true]) {
      const result = run({ compatibility, api })
      assert.equal(result.status, 0)
      assert.equal(result.stderr, '')
      assert.deepEqual(JSON.parse(result.stdout), {
        status: 'passed', sessionModule: sessionURL.href,
        checks: ['native-append', 'stored-marker', 'json-replay'],
      })
    }
  }
})

test('snapshot-only public API passes both CLI and exported preflight', () => {
  const session = runtime().replace('export class Session {', 'export class Session {\n #entries;\n snapshotEvents() { return this.#entries.slice() }')
    .replace('delete s.events', 's.events = undefined')
    .replaceAll('s.events', 's.#entries').replaceAll('this.events', 'this.#entries')
  for (const api of [false, true]) {
    const result = run({ session, api })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).status, 'passed')
  }
})

test('invalid CLI arguments fail without disclosing argument values', () => {
  const result = run({ extraArgs: [secret] })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /PREFLIGHT_FAILED \(stage: arguments\)/)
  assert.ok(!result.stderr.includes(secret))
})

const officialRoot = process.env.YUQI_OFFICIAL_TEST_ROOT
const actualSidecarSource = `
  export * from ${JSON.stringify(new URL('../../src/host/storage/session-sidecar.ts', import.meta.url).href)}
  export * from ${JSON.stringify(new URL('../../src/host/storage/owned-event-store.ts', import.meta.url).href)}
`

async function runSidecar(args, runtimeSource, officialFault, poisonParent = false) {
  let root
  try {
    let entry = fileURLToPath(script)
    if (runtimeSource !== undefined) {
      // Isolated test artifact only. No installed exports or source files change;
      // the production worker always imports an actual file in its own process.
      root = await mkdtemp(join(tmpdir(), 'yuqi-preflight-fixture-'))
      await mkdir(join(root, 'scripts'))
      await mkdir(join(root, 'lib'))
      await writeFile(join(root, 'package.json'), '{"type":"module"}')
      entry = join(root, 'scripts', 'check-host-compatibility.mjs')
      await writeFile(entry, await readFile(script))
      const faultSource = officialFault ? `\nimport { ${officialFault.export} } from '@deepseek-ai/${officialFault.package}';\n${officialFault.code}` : ''
      await writeFile(join(root, 'lib', 'index.js'), runtimeSource + faultSource)
    }
    const bootstrap = poisonParent ? ['--import', `data:text/javascript,${encodeURIComponent(`
      import { registerHooks } from 'node:module'
      const target = ${JSON.stringify(new URL('../lib/index.js', pathToFileURL(entry)).href)}
      registerHooks({ load(url, context, next) {
        if (url === target) return { format: 'module', source: 'export const cached = true', shortCircuit: true }
        return next(url, context)
      } })
      await import(target)
    `)}`] : []
    const result = spawnSync(process.execPath, [...bootstrap, entry, '--sidecar', ...args], {
      encoding: 'utf8', timeout: 25000,
    })
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    return result
  } finally {
    if (root) {
      assert.equal(resolve(root, '..'), resolve(tmpdir()))
      assert.ok(root.startsWith(join(tmpdir(), 'yuqi-preflight-fixture-')))
      await rm(root, { recursive: true, force: true })
    }
  }
}

test('sidecar requires an explicit installation root and sanitizes resolution failures', async () => {
  for (const args of [[], ['--unknown'], [secret, 'extra']]) {
    const result = await runSidecar(args)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /stage: arguments/)
    assert.ok(!result.stderr.includes(secret))
    assert.ok(!result.stderr.includes('Native ignorable'))
  }
  await assert.rejects(checkSidecarCompatibility(secret), error => {
    assert.equal(error.stage, 'official-module-resolution')
    assert.equal(error.code, 'PREFLIGHT_FAILED')
    assert.equal(error.cause, undefined)
    assert.ok(!error.message.includes(secret))
    return true
  })
})

test('sidecar does not fall back to source when built runtime exports are absent', { skip: !officialRoot }, async () => {
  const result = await runSidecar([officialRoot], `export const version = 'compatible'`)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /stage: sidecar-runtime-exports/)
})

test('sidecar sanitizes built runtime import failures', { skip: !officialRoot }, async () => {
  const result = await runSidecar([officialRoot], `throw new Error(${JSON.stringify(secret)})`)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /stage: official-runtime-import/)
  assert.ok(!result.stderr.includes(secret))
})

for (const [name, fault, stage] of [
  ['ensureMaterialized', { package: 'dsh-session-persistence', export: 'SessionPersistence', code: 'SessionPersistence.prototype.ensureMaterialized = undefined' }, 'official-exports'],
  ['rpc.handle', { package: 'dsh-client-connection', export: 'HostConnectionService', code: "Object.defineProperty(HostConnectionService.prototype, 'rpc', { get() { return {} } })" }, 'rpc-handle-export'],
]) {
  test(`sidecar rejects missing official ${name} capability (negative-only instrumentation)`, { skip: !officialRoot }, async () => {
    const result = await runSidecar([officialRoot], actualSidecarSource, fault)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.ok(result.stderr.includes(`stage: ${stage}`), result.stderr)
  })
}

test('built sidecar CLI passes against the selected official installation without import hooks', {
  skip: !officialRoot || process.env.YUQI_PREFLIGHT_BUILT_RUNTIME !== '1',
}, async () => {
  const result = await runSidecar([officialRoot])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).mode, 'sidecar')
})

test('official temporary contract uses real source sidecar and native persistence (not bundle acceptance)', { skip: !officialRoot }, async () => {
  const before = (await readdir(tmpdir())).filter(name => name.startsWith('yuqi-sidecar-preflight-')).sort()
  // The temporary artifact re-exports actual source, not the installed bundle.
  // Official Session, persistence, Cordis and Storage imports are never mocked.
  const result = await runSidecar([officialRoot], actualSidecarSource)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.mode, 'sidecar')
  assert.equal(report.status, 'passed')
  assert.ok(report.checks.includes('ensure-materialized'))
  assert.ok(report.checks.includes('sidecar-cold-replay'))
  assert.ok(report.checks.includes('rpc-handle-export'))
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('yuqi-sidecar-preflight-')).sort(), before)
})

test('sidecar fails if runtime omits native header materialization and cleans its temporary directory', { skip: !officialRoot }, async () => {
  const before = (await readdir(tmpdir())).filter(name => name.startsWith('yuqi-sidecar-preflight-')).sort()
  const source = `${actualSidecarSource}
    import { SidecarRepository as Actual } from ${JSON.stringify(new URL('../../src/host/storage/session-sidecar.ts', import.meta.url).href)}
    export class SidecarRepository extends Actual { constructor(table) { super(table) } }
  `
  const result = await runSidecar([officialRoot], source)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /stage: (native-log-isolation|native-cold-read)/)
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('yuqi-sidecar-preflight-')).sort(), before)
})

test('missing official named export fails in a fresh worker despite parent hook and module cache', { skip: !officialRoot }, async () => {
  const source = `import { yuqiDefinitelyMissingExport } from '@deepseek-ai/dsh-settings';\nexport { yuqiDefinitelyMissingExport }`
  const result = await runSidecar([officialRoot], source, undefined, true)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /stage: official-runtime-import/)
  assert.ok(!result.stderr.includes('yuqiDefinitelyMissingExport'))
})

test('official external subpaths use package exports and never fall back to repository dependencies', { skip: !officialRoot }, async () => {
  const result = await runSidecar([officialRoot], `import '@deepseek-ai/dsh-settings/yuqi-not-exported';`)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /stage: official-runtime-import/)
  assert.ok(!result.stderr.includes('yuqi-not-exported'))
})
