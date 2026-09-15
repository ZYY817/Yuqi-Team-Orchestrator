import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPreset, PresetInstallError, removePreset, resolveDshHome } from '../../scripts/install-preset.mjs'

const root = await mkdtemp(join(tmpdir(), 'yuqi-preset-install-'))
const home = join(root, 'dsh-home')
const source = fileURLToPath(new URL('../../presets/yuqi-team/', import.meta.url))

try {
  assert.equal(resolveDshHome(undefined, { DSH_HOME: home }), home)
  assert.equal(resolveDshHome(home, { DSH_HOME: join(root, 'ignored') }), home)

  const first = await installPreset({ dshHome: home, sourceDir: source })
  assert.equal(first.status, 'installed')
  const destination = join(home, '.agent-presets', 'yuqi-team')
  const firstComposition = await readFile(join(destination, 'agent.cordis.yml'), 'utf8')
  const firstMetadata = await readFile(join(destination, 'preset.yml'), 'utf8')
  assert.match(firstComposition, /yuqi-team-orchestrator\/agent/)
  assert.match(firstMetadata, /^name: yuqi团队$/mu)
  const compositionIds = [...firstComposition.matchAll(/^\s*- id:\s*([^\s]+)\s*$/gmu)].map(match => match[1])
  const requiredCompositionIds = [
    'agent-instructions',
    'tool-bash',
    'tool-pwsh',
    'tool-fs',
    'tool-fs-search',
    'tool-jobs',
    'skill-filesystem',
    'tool-skill',
    'command-goal',
    'tool-goal',
    'planning',
    'plan-mode',
    'compaction',
    'compaction-basic',
    'command-compact',
    'tool-result-pruner',
    'delegation',
    'tool-subagent-control',
    'tool-subagent-list-agents',
    'tool-subagent',
    'tool-subagent-fork',
    'workflow-worker-thread',
    'tool-workflow',
    'tool-ralph',
    'tool-ask-user',
    'tool-todo',
    'tool-web',
    'present',
    'yuqi-team-orchestrator-agent',
  ]
  for (const requiredId of requiredCompositionIds) {
    assert.ok(compositionIds.includes(requiredId), `Yuqi preset must retain standard capability row ${requiredId}`)
  }
  assert.equal(new Set(compositionIds).size, compositionIds.length, 'Yuqi preset composition ids must be unique')

  const compositionStat = await stat(join(destination, 'agent.cordis.yml'))
  const second = await installPreset({ dshHome: home, sourceDir: source })
  assert.equal(second.status, 'unchanged')
  assert.equal((await stat(join(destination, 'agent.cordis.yml'))).mtimeMs, compositionStat.mtimeMs)

  await writeFile(join(destination, 'agent.cordis.yml'), 'different content\n', 'utf8')
  await assert.rejects(
    installPreset({ dshHome: home, sourceDir: source }),
    error => error instanceof PresetInstallError && error.code === 'DESTINATION_CONFLICT',
  )
  assert.equal(await readFile(join(destination, 'agent.cordis.yml'), 'utf8'), 'different content\n')

  const updated = await installPreset({ dshHome: home, sourceDir: source, update: true })
  assert.equal(updated.status, 'updated')
  assert.equal(await readFile(join(destination, 'agent.cordis.yml'), 'utf8'), await readFile(join(source, 'agent.cordis.yml'), 'utf8'))

  const dangerous = parse(home).root
  await assert.rejects(
    installPreset({ dshHome: dangerous, sourceDir: source }),
    error => error instanceof PresetInstallError && error.code === 'DANGEROUS_PATH',
  )

  const symlinkHome = join(root, 'symlink-home')
  const outside = join(root, 'outside')
  await mkdir(outside)
  try {
    await symlink(outside, symlinkHome, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      console.warn('Skipping symlink-specific assertion: platform denied test symlink creation')
    } else {
      throw error
    }
  }
  if (await exists(symlinkHome)) {
    await assert.rejects(
      installPreset({ dshHome: symlinkHome, sourceDir: source }),
      error => error instanceof PresetInstallError && error.code === 'SYMLINK_NOT_ALLOWED',
    )
  assert.equal(await exists(join(outside, '.agent-presets')), false)
  }

  const sibling = join(home, '.agent-presets', 'keep-me')
  await mkdir(sibling)
  await writeFile(join(sibling, 'keep.txt'), 'preserve this sibling\n', 'utf8')
  const removed = await removePreset({ dshHome: home })
  assert.equal(removed.status, 'removed')
  assert.equal(await exists(destination), false)
  assert.equal(await readFile(join(sibling, 'keep.txt'), 'utf8'), 'preserve this sibling\n')
  assert.equal((await removePreset({ dshHome: home })).status, 'absent')

  const rollbackHome = join(root, 'rollback-home')
  let writes = 0
  await assert.rejects(
    installPreset({
      dshHome: rollbackHome,
      sourceDir: source,
      writeFileImpl: async (path, data, options) => {
        writes += 1
        await writeFile(path, data, options)
        if (writes === 2) throw new Error('simulated second-file failure')
      },
    }),
    error => error instanceof PresetInstallError && error.code === 'INSTALL_FAILED',
  )
  assert.equal(await exists(join(rollbackHome, '.agent-presets', 'yuqi-team')), false)
  const rollbackEntries = await readdir(join(rollbackHome, '.agent-presets'))
  assert.deepEqual(rollbackEntries, [])

  console.log('Yuqi preset installation passed: copy, idempotency, conflict, safe exact removal, rollback, danger, and symlink gates.')
} finally {
  await rm(root, { recursive: true, force: true })
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
