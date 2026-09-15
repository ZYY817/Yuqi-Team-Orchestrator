import { describe, expect, it } from 'vitest'
import {
  assertChildPresetId,
  assertTeamConcurrency,
  DEFAULT_TEAM_SETTINGS,
  DEFAULT_TEAM_CONCURRENCY,
  MAX_TEAM_CONCURRENCY,
  MIN_TEAM_CONCURRENCY,
  TEAM_SETTINGS_SCHEMA,
  normalizeTeamReviewPolicy,
  normalizeTeamModelRouting,
  type TeamSettings,
} from '../src/application/team-settings.ts'
import { DEFAULT_EXPERIMENTAL_MODEL_ROUTING } from '../src/domain/team-settings-contract.ts'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { TEAM_SETTINGS_NAMESPACE } from '../src/application/team-settings.ts'

class MemorySettingsProvider extends SettingsProvider {
  readonly writable = true
  #document: Record<string, unknown> = {}

  protected async load(): Promise<Record<string, unknown>> { return this.#document }
  protected async persist(ns: string, section: Record<string, unknown>): Promise<void> {
    this.#document = { ...this.#document, [ns]: structuredClone(section) }
  }
  publishDocument(document: Record<string, unknown>): void { this.publish(document) }
}

describe('Team settings', () => {
  it('accepts custom absolute roots and rejects relative, network and malformed roots', () => {
    for (const root of ['', 'F:\\Team Workspaces', '/tmp/team-workspaces']) {
      expect(TEAM_SETTINGS_SCHEMA({ gitWorkspaceRoot: root } as TeamSettings).gitWorkspaceRoot).toBe(root)
    }
    for (const root of ['relative', '../teams', 'F:\\', '/', '\\\\server\\share', 'F:\\bad\nname']) {
      expect(() => TEAM_SETTINGS_SCHEMA({ gitWorkspaceRoot: root } as TeamSettings)).toThrow()
    }
  })
  it('defaults to running every possible Team task concurrently', () => {
    expect(DEFAULT_TEAM_CONCURRENCY).toBe(MAX_TEAM_CONCURRENCY)
    expect(TEAM_SETTINGS_SCHEMA({} as TeamSettings)).toEqual({
      maxConcurrency: DEFAULT_TEAM_CONCURRENCY,
      childPresetId: 'standard',
      childModelId: '',
      childModelPolicy: 'automatic',
      quickModelId: '',
      standardModelId: '',
      criticalModelId: '',
      requirePlanConfirmation: true,
      defaultAuthorityMode: 'write-authorized',
      defaultWorkspaceMode: 'direct',
      gitWorkspaceRoot: '',
      reviewPolicy: { mode: 'manual', maxReworkRounds: 2, additionalPrompt: '' },
    })
  })

  it('normalizes the atomic reviewer policy and enforces its hard bounds', () => {
    const settings = TEAM_SETTINGS_SCHEMA({ reviewPolicy: {
      mode: 'quality-gate', maxReworkRounds: 3, additionalPrompt: '  inspect migrations  ',
    } } as TeamSettings)
    expect(settings.reviewPolicy).toEqual({
      mode: 'quality-gate', maxReworkRounds: 3, additionalPrompt: '  inspect migrations  ',
    })
    expect(normalizeTeamReviewPolicy(settings)).toEqual({
      mode: 'quality-gate', maxReworkRounds: 3, additionalPrompt: 'inspect migrations',
    })
    expect(() => TEAM_SETTINGS_SCHEMA({ reviewPolicy: {
      mode: 'quality-gate', maxReworkRounds: 4, additionalPrompt: '',
    } } as TeamSettings)).toThrow()
    expect(() => normalizeTeamReviewPolicy(TEAM_SETTINGS_SCHEMA({ reviewPolicy: {
      mode: 'manual', maxReworkRounds: 2, additionalPrompt: 'x'.repeat(4_001),
    } } as TeamSettings))).toThrow()
  })

  it('accepts native and user preset ids but rejects recursion and malformed persisted values', () => {
    for (const value of ['standard', 'code', 'minimal', 'creator', 'my-custom_preset.v2']) {
      expect(() => assertChildPresetId(value)).not.toThrow()
    }
    for (const value of ['', 'yuqi-team', 'contains space', 'x'.repeat(129)]) {
      expect(() => assertChildPresetId(value)).toThrow(RangeError)
    }
  })

  it('accepts each boundary and rejects unsafe or fractional values', () => {
    expect(() => assertTeamConcurrency(MIN_TEAM_CONCURRENCY)).not.toThrow()
    expect(() => assertTeamConcurrency(MAX_TEAM_CONCURRENCY)).not.toThrow()
    for (const value of [0, MAX_TEAM_CONCURRENCY + 1, 1.5, Number.NaN]) {
      expect(() => assertTeamConcurrency(value)).toThrow(RangeError)
    }
  })

  it('defines an empty, controller-only experimental automatic default', () => {
    expect(DEFAULT_EXPERIMENTAL_MODEL_ROUTING).toEqual({
      providerScope: { kind: 'controller-only' },
      teamPolicy: { kind: 'automatic', tierCandidates: { quick: [], standard: [], critical: [] } },
    })
  })

  it('normalizes legacy fixed and automatic settings within the controller Provider', () => {
    const { modelRouting: _modelRouting, ...base } = TEAM_SETTINGS_SCHEMA({} as TeamSettings)
    const controller = { modelProvider: 'controller-provider', modelId: 'controller-model' }

    expect(normalizeTeamModelRouting({ ...base, childModelPolicy: 'fixed', childModelId: ' fixed-model ' }, controller)).toEqual({
      providerScope: { kind: 'controller-only' },
      teamPolicy: { kind: 'fixed', model: { modelProvider: 'controller-provider', modelId: 'fixed-model' } },
    })
    expect(normalizeTeamModelRouting({
      ...base,
      childModelPolicy: 'automatic',
      quickModelId: 'quick-model',
      standardModelId: '',
      criticalModelId: 'critical-model',
    }, controller)).toEqual({
      providerScope: { kind: 'controller-only' },
      teamPolicy: {
        kind: 'automatic',
        tierCandidates: {
          quick: [{ modelProvider: 'controller-provider', modelId: 'quick-model' }],
          standard: [],
          critical: [{ modelProvider: 'controller-provider', modelId: 'critical-model' }],
        },
      },
    })
  })

  it('keeps legacy empty fixed settings compatible by normalizing them to inherit', () => {
    const { modelRouting: _modelRouting, ...base } = TEAM_SETTINGS_SCHEMA({} as TeamSettings)
    expect(normalizeTeamModelRouting(
      { ...base, childModelPolicy: 'fixed', childModelId: '' },
      { modelProvider: 'controller-provider', modelId: 'controller-model' },
    ).teamPolicy).toEqual({ kind: 'inherit' })
  })

  it('prefers and deeply freezes a valid structured policy when present', () => {
    const base = TEAM_SETTINGS_SCHEMA({} as TeamSettings)
    const normalized = normalizeTeamModelRouting({
      ...base,
      modelRouting: {
        providerScope: { kind: 'controller-plus-allowlist', providerAllowlist: ['external-provider'] },
        teamPolicy: {
          kind: 'automatic',
          tierCandidates: {
            quick: [{ modelProvider: 'external-provider', modelId: 'quick' }],
            standard: [],
            critical: [],
          },
        },
      },
    }, { modelProvider: 'controller-provider', modelId: 'controller-model' })

    expect(normalized.providerScope).toEqual({
      kind: 'controller-plus-allowlist', providerAllowlist: ['external-provider'],
    })
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(Object.isFrozen(normalized.teamPolicy)).toBe(true)
    if (normalized.teamPolicy.kind === 'automatic') {
      expect(Object.isFrozen(normalized.teamPolicy.tierCandidates.quick)).toBe(true)
      expect(Object.isFrozen(normalized.teamPolicy.tierCandidates.quick[0])).toBe(true)
    }
  })

  it('does not merge the default automatic branch into a persisted inherit branch', async () => {
    const provider = new MemorySettingsProvider(new Context())
    const { modelRouting: _modelRouting, ...settingsBase } = DEFAULT_TEAM_SETTINGS
    const scope = provider.register(TEAM_SETTINGS_NAMESPACE, TEAM_SETTINGS_SCHEMA, { base: settingsBase })
    provider.publishDocument({ [String(TEAM_SETTINGS_NAMESPACE)]: {
      modelRouting: {
        providerScope: { kind: 'controller-only' },
        teamPolicy: { kind: 'inherit' },
      },
    } })

    expect(scope.get().modelRouting).toEqual({
      providerScope: { kind: 'controller-only' },
      teamPolicy: { kind: 'inherit' },
    })
    await provider.mutate(TEAM_SETTINGS_NAMESPACE, [{ op: 'set', path: ['modelRouting'], value: {
      providerScope: { kind: 'controller-only' },
      teamPolicy: { kind: 'fixed', model: { modelProvider: 'controller', modelId: 'model' } },
    } }])
    expect(scope.get().modelRouting).toEqual({
      providerScope: { kind: 'controller-only' },
      teamPolicy: { kind: 'fixed', model: { modelProvider: 'controller', modelId: 'model' } },
    })
  })
})
