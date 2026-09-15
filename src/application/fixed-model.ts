/** Deterministic fixed-model selection against a host-provided public catalog. */

import type { TeamTaskContract } from '../domain/task-contract.ts'
import type { FixedModelRef } from '../domain/workspace.ts'
import { fixedModelRefSchema } from '../domain/workspace.ts'
import { YuqiOrchestratorError } from './errors.ts'
import type { ModelCatalogEntry, ModelCatalogPort } from './workspace-ports.ts'

export interface FixedModelPolicy {
  readonly task?: FixedModelRef
  readonly roles?: Partial<Record<TeamTaskContract['modelRole'], FixedModelRef>>
  readonly team?: FixedModelRef
  readonly harnessDefault: FixedModelRef
}

/** Resolve task > role > Team > Harness default and reject non-routable catalog entries. */
export function resolveFixedModel(
  role: TeamTaskContract['modelRole'],
  policy: FixedModelPolicy,
  catalog: readonly ModelCatalogEntry[],
): FixedModelRef {
  const selected = selectFixedModel(role, policy)
  const available = catalog.some(entry => entry.available
    && entry.modelProvider === selected.modelProvider
    && entry.modelId === selected.modelId)
  if (!available) {
    throw new YuqiOrchestratorError('FIXED_MODEL_UNAVAILABLE', `Fixed model ${selected.modelProvider}/${selected.modelId} is unavailable`)
  }
  return Object.freeze(selected)
}

/** Resolve route metadata only; successful resolution is not a credential-validity claim. */
export async function resolveFixedModelFromPort(
  role: TeamTaskContract['modelRole'],
  policy: FixedModelPolicy,
  models: ModelCatalogPort,
  signal?: AbortSignal,
): Promise<FixedModelRef> {
  const selected = selectFixedModel(role, policy)
  let resolved: ModelCatalogEntry
  try {
    resolved = await models.resolveModel(selected.modelProvider, selected.modelId, signal)
  } catch (cause) {
    throw new YuqiOrchestratorError('FIXED_MODEL_UNAVAILABLE', `Fixed model ${selected.modelProvider}/${selected.modelId} could not be resolved`, { cause })
  }
  if (!resolved.available
    || resolved.modelProvider !== selected.modelProvider
    || resolved.modelId !== selected.modelId) {
    throw new YuqiOrchestratorError('FIXED_MODEL_UNAVAILABLE', 'The host returned a different or unavailable fixed model route')
  }
  return Object.freeze(selected)
}

function selectFixedModel(role: TeamTaskContract['modelRole'], policy: FixedModelPolicy): FixedModelRef {
  const selected = fixedModelRefSchema.parse(policy.task ?? policy.roles?.[role] ?? policy.team ?? policy.harnessDefault)
  if (selected.role !== role) {
    throw new YuqiOrchestratorError('FIXED_MODEL_INVALID', `Fixed model role ${selected.role} does not match task role ${role}`)
  }
  return selected
}
