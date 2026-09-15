import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { checkHostCompatibility } from '../../scripts/check-host-compatibility.mjs'

const run = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const harnessRoot = fileURLToPath(new URL('../../../deepseek-harness/', import.meta.url))
const dshBin = join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
// Verify host compatibility (native envelope or sidecar fallback).
try {
  await checkHostCompatibility(join(harnessRoot, 'packages/core/session/lib/index.js'))
} catch (err) {
  if (err?.code !== 'HOST_SESSION_INCOMPATIBLE') throw err
}
const profileName = 'yuqi-install-e2e'
const home = await mkdtemp(join(tmpdir(), 'yuqi-dsh-home-'))

const runDsh = async args => run(
  process.execPath,
  [dshBin, ...args],
  {
    cwd: projectRoot,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  },
)

try {
  await runDsh(['plugin', '--profile', profileName, 'add', '.'])

  const profilePath = join(home, 'profiles', profileName, 'package.json')
  const installed = JSON.parse(await readFile(profilePath, 'utf8'))
  const linkedProject = projectRoot.replace(/[\\/]$/, '').replaceAll('\\', '/')
  assert.equal(installed.dependencies?.['yuqi-team-orchestrator'], `link:${linkedProject}`)
  assert.deepEqual(
    installed.dsh?.profile?.bundles,
    ['@deepseek-ai/dsh-base', 'yuqi-team-orchestrator'],
    'install must activate Yuqi after the base bundle',
  )

  const dump = await runDsh(['--profile', profileName, '--dump-default-config'])
  assert.match(dump.stdout, /# == yuqi-team-orchestrator/)
  assert.match(dump.stdout, /id:\s*yuqi-team-orchestrator/)
  assert.match(dump.stdout, /name:\s*['"]?yuqi-team-orchestrator['"]?/)

  await runDsh(['plugin', '--profile', profileName, 'remove', 'yuqi-team-orchestrator'])
  const removed = JSON.parse(await readFile(profilePath, 'utf8'))
  assert.equal(removed.dependencies?.['yuqi-team-orchestrator'], undefined)
  assert.deepEqual(removed.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base'])

  process.stdout.write('Yuqi profile install E2E passed: isolated add, composition, and remove are reversible.\n')
} finally {
  await rm(home, { recursive: true, force: true })
}
