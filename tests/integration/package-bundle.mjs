import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(manifest.exports?.['.']?.default, './lib/index.js')
assert.equal(manifest.exports?.['./agent']?.default, './lib/agent.js')
assert.equal(manifest.bin?.['yuqi-team-install-preset'], 'scripts/install-preset.mjs')
assert.equal(manifest.bin?.['yuqi-team-check-host'], 'scripts/check-host-compatibility.mjs')
assert.equal(manifest.dsh?.compatibility?.peerRangeMeaning, 'api-baseline-only')
assert.equal(manifest.dsh?.compatibility?.requiredSessionContract, 'public-storage-domain-or-native-ignorable-replay')
assert.equal(manifest.dsh?.compatibility?.verifiedOfficialRelease, null)
assert.equal(manifest.dsh?.compatibility?.verifiedSidecarStorageRelease, '0.1.2-rc.1')
assert.equal(manifest.dsh?.compatibility?.storageWriterScope, 'single-host-process-per-storage-directory')
assert.ok(manifest.files.includes(manifest.dsh.compatibility.preflight))
for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
  if (name.startsWith('@deepseek-ai/dsh-')) {
    assert.equal(range, '>=0.1.1-rc.2 <0.2.0', `${name} is an API baseline, not evidence of native envelope support`)
  }
}
assert.equal(manifest.peerDependencies?.['@deepseek-ai/cordis'], '^4.0.1')
assert.equal(manifest.peerDependencies?.['@deepseek-ai/schemastery'], '^3.18.1')
assert.equal(manifest.peerDependencies?.react, '^18.2.0')
assert.equal(manifest.peerDependencies?.['react-dom'], '^18.2.0')
assert.ok(manifest.files.includes('cordis.patch.yml'))
assert.ok(manifest.files.includes('lib/client.cjs'))
assert.ok(manifest.files.includes('scripts/install-preset.mjs'))
assert.ok(manifest.files.includes('presets/yuqi-team/preset.yml'))
assert.ok(manifest.files.includes('presets/yuqi-team/agent.cordis.yml'))

const patch = await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
assert.match(patch, /id:\s*yuqi-team-orchestrator/)
assert.match(patch, /name:\s*['"]yuqi-team-orchestrator['"]/) 

const plugin = await import(new URL('../../lib/index.js', import.meta.url))
assert.equal(typeof plugin.default, 'function')
const agentPlugin = await import(new URL('../../lib/agent.js', import.meta.url))
assert.equal(agentPlugin.name, 'yuqi-team-orchestrator-agent')
assert.deepEqual(agentPlugin.inject, ['tools', 'yuqiTeamOrchestrator'])

const clientPath = new URL('../../lib/client.cjs', import.meta.url)
const clientSource = await readFile(clientPath, 'utf8')
assert.doesNotMatch(
  clientSource,
  /require\(["']zod["']\)/,
  'browser client must bundle zod instead of requiring an unregistered Harness module',
)
const previousWindow = globalThis.window
let registration
globalThis.window = {
  __ModuleLoader__: {
    load(value) { registration = value },
  },
}
try {
  await import(clientPath)
  assert.equal(registration?.id, 'yuqi-team-orchestrator')
  assert.equal(typeof registration?.factory, 'function')
  const clientPlugin = registration.factory(createRequire(fileURLToPath(clientPath)))
  assert.deepEqual(clientPlugin.inject, ['slots', 'sessions', 'workspaces', 'settingsScope', 'connection'])
  assert.equal(typeof clientPlugin.apply, 'function')
} finally {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
}

const preset = await readFile(new URL('../../presets/yuqi-team/agent.cordis.yml', import.meta.url), 'utf8')
assert.match(preset, /name:\s*['"]yuqi-team-orchestrator\/agent['"]/)
assert.match(preset, /你是 Yuqi 团队负责人（系统身份：Team 主控）/)
assert.match(preset, /compact-team-lead-persona/)
assert.match(preset, /高级专业职责/)
assert.match(preset, /优先使用 Yuqi Team 工具创建真实 Team/)
assert.match(preset, /不盲目恢复、重复启动或把未知说成无副作用/)
assert.match(preset, /使用真实可用的测试、浏览器、接口或截图证据/)
assert.match(preset, /不得自行扩大 Provider\/权限范围/)
assert.match(preset, /legacy-persona[\s\S]*disabled:\s*true/)
assert.match(preset, /默认直写策略是 planned-scope-parallel/)
assert.match(preset, /Review 遵守 Team policy/)
assert.match(preset, /automatic 是实验性按 quick\/standard\/critical 有序候选选择/)
assert.match(preset, /Controller-less recovery 只允许依据 durable 事实 fail-closed/)
const metadata = await readFile(new URL('../../presets/yuqi-team/preset.yml', import.meta.url), 'utf8')
assert.match(metadata, /name:\s*(?:Yuqi Team|yuqi团队)/)
assert.match(metadata, /(?:证据验收|可验证结果)/)
process.stdout.write('Yuqi profile bundle entry passed: manifest, patch, and built Cordis plugin are loadable.\n')
