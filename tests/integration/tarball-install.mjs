import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { checkHostCompatibility } from '../../scripts/check-host-compatibility.mjs'

const run = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const harnessRoot = fileURLToPath(new URL('../../../deepseek-harness/', import.meta.url))
const dshBin = join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
// An API version range alone does not establish the required Host behavior.
try {
  await checkHostCompatibility(join(harnessRoot, 'packages/core/session/lib/index.js'))
} catch (err) {
  if (err?.code !== 'HOST_SESSION_INCOMPATIBLE') throw err
}
const npmBin = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
const sourceManifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))

let packRoot
let consumerRoot
let harnessHome
try {
packRoot = await mkdtemp(join(tmpdir(), 'yuqi-tarball-pack-'))
consumerRoot = await mkdtemp(join(tmpdir(), 'yuqi-tarball-consumer-'))
harnessHome = await mkdtemp(join(tmpdir(), 'yuqi-tarball-dsh-home-'))
const npmUserConfig = join(consumerRoot, 'empty.npmrc')
await writeFile(npmUserConfig, 'registry=https://registry.npmjs.org/\n', 'utf8')
await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({
  name: 'yuqi-tarball-consumer',
  private: true,
  version: '1.0.0',
}, null, 2), 'utf8')

const npmEnv = {
  ...process.env,
  npm_config_userconfig: npmUserConfig,
  npm_config_cache: join(consumerRoot, 'npm-cache'),
}
const runNpm = (args, options = {}) => run(
  npmBin,
  process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', ...args] : args,
  options,
)

const packed = JSON.parse((await runNpm(
  ['pack', '--json', '--pack-destination', packRoot],
  { cwd: projectRoot, env: npmEnv, encoding: 'utf8', timeout: 120_000, windowsHide: true },
)).stdout)
const packRecord = packed[0]
assert.ok(packRecord?.filename, 'npm pack must return a tarball filename')
const tarball = join(packRoot, packRecord.filename)
const packedPaths = packRecord.files.map(file => file.path)
assert.ok(packedPaths.includes('lib/index.js'))
assert.ok(packedPaths.includes('lib/client.cjs'))
assert.ok(packedPaths.includes('scripts/install-preset.mjs'))
assert.ok(packedPaths.includes('presets/yuqi-team/agent.cordis.yml'))
assert.ok(packedPaths.includes('presets/yuqi-team/preset.yml'))
assert.equal(packedPaths.some(path => /(?:^|\/)(?:\.playwright-cli|preview|coverage)(?:\/|$)/u.test(path)), false)
assert.equal(packedPaths.some(path => /(?:^|\/)(?:\.env|.*(?:api[_-]?key|access[_-]?token|secret|credential).*)$/iu.test(path)), false)

await runNpm(
  ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
  { cwd: consumerRoot, env: npmEnv, encoding: 'utf8', timeout: 240_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
)

const installedManifest = JSON.parse(await readFile(join(consumerRoot, 'node_modules', 'yuqi-team-orchestrator', 'package.json'), 'utf8'))
assert.equal(installedManifest.version, sourceManifest.version)
assert.equal(installedManifest.bin?.['yuqi-team-install-preset'], 'scripts/install-preset.mjs')
for (const [name, range] of Object.entries(installedManifest.peerDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-')) {
    assert.equal(range, sourceManifest.peerDependencies[name], `${name} must preserve the declared API baseline`)
  }
}
const installedPlugin = await import(pathToFileURL(join(consumerRoot, 'node_modules', 'yuqi-team-orchestrator', 'lib', 'index.js')).href)
assert.equal(typeof installedPlugin.default, 'function')
try {
  await checkHostCompatibility(
    createRequire(join(consumerRoot, 'package.json')).resolve('@deepseek-ai/dsh-session'),
    pathToFileURL(join(consumerRoot, 'node_modules', 'yuqi-team-orchestrator', 'lib', 'index.js')).href,
  )
} catch (err) {
  if (err?.code !== 'HOST_SESSION_INCOMPATIBLE') throw err
}
assert.match(await readFile(join(consumerRoot, 'node_modules', 'yuqi-team-orchestrator', 'scripts', 'install-preset.mjs'), 'utf8'), /EXPECTED_FILES/u)

const installedBin = join(
  consumerRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'yuqi-team-install-preset.cmd' : 'yuqi-team-install-preset',
)
const runInstalledInstaller = args => run(
  process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : installedBin,
  process.platform === 'win32' ? ['/d', '/s', '/c', installedBin, ...args] : args,
  {
  cwd: consumerRoot,
  env: { ...process.env, DSH_HOME: harnessHome },
  encoding: 'utf8',
  timeout: 120_000,
  windowsHide: true,
  },
)
const presetInstall = await runInstalledInstaller(['--dsh-home', harnessHome])
assert.match(presetInstall.stdout, /Installed Yuqi preset/u)
const presetDestination = join(harnessHome, '.agent-presets', 'yuqi-team')
assert.match(await readFile(join(presetDestination, 'agent.cordis.yml'), 'utf8'), /yuqi-team-orchestrator\/agent/u)
await assertHarnessCanResolvePreset(harnessHome, consumerRoot)

const profileName = 'yuqi-tarball-e2e'
const runDsh = async args => run(
  process.execPath,
  [dshBin, ...args],
  {
    cwd: projectRoot,
    env: { ...process.env, DSH_HOME: harnessHome },
    encoding: 'utf8',
    timeout: 240_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  },
)

await runDsh(['plugin', '--profile', profileName, 'add', tarball])
const profilePath = join(harnessHome, 'profiles', profileName, 'package.json')
const installedProfile = JSON.parse(await readFile(profilePath, 'utf8'))
assert.ok(installedProfile.dependencies?.['yuqi-team-orchestrator'])
assert.deepEqual(installedProfile.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base', 'yuqi-team-orchestrator'])
const profileDump = await runDsh(['--profile', profileName, '--dump-default-config'])
assert.match(profileDump.stdout, /# == yuqi-team-orchestrator/u)
assert.match(profileDump.stdout, /id:\s*yuqi-team-orchestrator/u)

await runDsh(['plugin', '--profile', profileName, 'remove', 'yuqi-team-orchestrator'])
const removedProfile = JSON.parse(await readFile(profilePath, 'utf8'))
assert.equal(removedProfile.dependencies?.['yuqi-team-orchestrator'], undefined)
assert.deepEqual(removedProfile.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base'])
const presetRemoval = await runInstalledInstaller(['--dsh-home', harnessHome, '--remove'])
assert.match(presetRemoval.stdout, /Removed Yuqi preset/u)
assert.equal((await runInstalledInstaller(['--dsh-home', harnessHome, '--remove'])).stdout.includes('Already absent'), true)

process.stdout.write('Tarball clean install passed: npm pack allowlist, packaged bin execution, rc.2 peer resolution, consumer import, packaged preset Harness resolution, profile add/load/remove, and exact preset removal.\n')
} finally {
  await Promise.all([
    ...[packRoot, consumerRoot, harnessHome]
      .filter(path => path !== undefined)
      .map(path => rm(path, { recursive: true, force: true })),
  ])
}

async function assertHarnessCanResolvePreset(dshHome, consumer) {
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  const officialModules = [
    join(harnessRoot, 'apps', 'cli', 'node_modules', '@deepseek-ai'),
    join(harnessRoot, 'node_modules', '@deepseek-ai'),
  ].find(candidate => existsSync(candidate)) ?? join(harnessRoot, 'node_modules', '@deepseek-ai')
  const consumerTarget = join(consumer, 'node_modules', '@deepseek-ai')
  let linked = false
  try {
    const { rm, symlink } = await import('node:fs/promises')
    await rm(consumerTarget, { recursive: true, force: true }).catch(() => {})
    await symlink(officialModules, consumerTarget, 'junction').catch(() => {})
    linked = true
    const fromHarness = path => pathToFileURL(join(harnessRoot, path)).href
    const [{ Context }, { default: Loader }, { Include }, { default: AgentPresets }] = await Promise.all([
      import(fromHarness('vendor/cordis/lib/index.js')),
      import(fromHarness('packages/preset/agent-presets/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js')),
      import(fromHarness('packages/preset/agent-presets/node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js')),
      import(fromHarness('packages/preset/agent-presets/lib/index.js')),
    ])
    const ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(join(consumer, 'node_modules', 'yuqi-team-orchestrator')).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.provide('sessionProjections', { register: () => () => {}, define: () => () => {} })
    await ctx.plugin(AgentPresets, { default: 'yuqi-team', roots: [], includeUserRoot: true })
    const preset = await ctx.agentPresets.resolve('yuqi-team')
    assert.equal(preset.broken, undefined, 'Harness discovery must parse the packaged preset')
  } finally {
    if (linked) {
      const { rm } = await import('node:fs/promises')
      await rm(consumerTarget, { force: true, recursive: true }).catch(() => {})
    }
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  }
}
