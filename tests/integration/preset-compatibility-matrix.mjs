import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPreset, resolveDshHome } from '../../scripts/install-preset.mjs'

const yuqiPresetDir = fileURLToPath(new URL('../../presets/yuqi-team/', import.meta.url))
const harnessStandardPresetPath = fileURLToPath(new URL('../../../deepseek-harness/packages/preset/agent-presets/presets/standard/agent.cordis.yml', import.meta.url))

// 1. Read Yuqi preset YAML and metadata
const yuqiCompositionContent = await readFile(join(yuqiPresetDir, 'agent.cordis.yml'), 'utf8')
const yuqiPresetMetaContent = await readFile(join(yuqiPresetDir, 'preset.yml'), 'utf8')

assert.match(yuqiPresetMetaContent, /name:\s*yuqi团队/, 'Preset metadata must declare name yuqi团队')

// 2. Parse entries and IDs
const yuqiIds = [...yuqiCompositionContent.matchAll(/^\s*- id:\s*([^\s]+)\s*$/gmu)].map(match => match[1])
assert.equal(new Set(yuqiIds).size, yuqiIds.length, 'All composition IDs in Yuqi preset must be unique')

// 3. Compare with official standard preset if available
let standardIds = []
try {
  const standardContent = await readFile(harnessStandardPresetPath, 'utf8')
  standardIds = [...standardContent.matchAll(/^\s*- id:\s*([^\s]+)\s*$/gmu)].map(match => match[1])
  console.log(`Discovered official standard preset with ${standardIds.length} capability rows`)
} catch {
  console.warn('Official standard preset not found on relative path; using built-in baseline assertions')
}

const requiredOfficialCapabilities = [
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
  'compaction',
  'delegation',
  'tool-ask-user',
  'tool-todo',
  'tool-web',
  'present',
]

for (const cap of requiredOfficialCapabilities) {
  assert.ok(yuqiIds.includes(cap), `Yuqi preset must retain official capability row: ${cap}`)
  if (standardIds.length > 0) {
    assert.ok(standardIds.includes(cap), `Official standard preset must also include capability row: ${cap}`)
  }
}

// 4. Assert persona Schema contract (prefix: is strictly required, text: is strictly forbidden)
assert.match(yuqiCompositionContent, /id:\s*compact-team-lead-persona[\s\S]*?name:\s*['"]@deepseek-ai\/dsh-persona['"]/, 'compact-team-lead-persona must be configured')
const personaSectionMatch = /id:\s*compact-team-lead-persona[\s\S]*?config:([\s\S]*?)(?=- id:|$)/.exec(yuqiCompositionContent)
assert.ok(personaSectionMatch, 'compact-team-lead-persona config section must exist')
const personaConfig = personaSectionMatch[1]
assert.match(personaConfig, /\bprefix:\s*\|/, 'compact-team-lead-persona must use "prefix: |" for Schemastery validation')
assert.doesNotMatch(personaConfig, /^\s*text:\s*\|/m, 'compact-team-lead-persona must NOT use "text: |" which breaks Schemastery validation')
assert.match(personaConfig, /用户在决定开始前会看到、子代理也会原样收到/, 'the enabled persona must explain why task goals need user-facing wording')
assert.match(personaConfig, /实际动作、对象和要得到的结果/, 'the enabled persona must require action, object, and result in task goals')
assert.match(personaConfig, /读取\/整理与修改/, 'the enabled persona must preserve the distinction between reading/organizing and changing')

// 5. Assert subagent modelSelectionSettings
assert.match(yuqiCompositionContent, /modelSelectionSettings:\s*true/, 'tool-subagent must include modelSelectionSettings: true')

// 6. Verify preset installer idempotency and update mode
const home = resolveDshHome(undefined)
const updateResult = await installPreset({ update: true })
assert.ok(['installed', 'updated', 'unchanged'].includes(updateResult.status), `Install result should be valid status, got: ${updateResult.status}`)

console.log('Preset compatibility matrix verification passed successfully!')
