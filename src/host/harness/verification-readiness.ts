/** Host-side readiness checks shared by Team creation and execution entry points. */

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { TeamTaskContract } from '../../domain/task-contract.ts'
import { verificationChecksSchema } from '../../domain/task-contract.ts'
import type { HarnessEvidenceCapability } from './evidence-collector.ts'

export interface VerificationReadinessIssue {
  readonly taskId: string
  readonly reason: string
}

export type VerificationCommandAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string }

/**
 * Validate only the shape of explicitly supplied verification configuration.
 *
 * Verification is deliberately not a Team-start gate: a project may be run
 * with no checks, and a check may target a Host capability that is not present
 * in this Harness build.  The evidence path records that outcome as
 * unavailable/inconclusive; it must never turn an otherwise valid Team start
 * into a product-level rejection.  Safety checks for the actual collector
 * remain in the evidence execution boundary.
 */
export function findVerificationReadinessIssue(
  tasks: readonly TeamTaskContract[],
  _capabilities: readonly HarnessEvidenceCapability[],
): VerificationReadinessIssue | undefined {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { taskId: '<team>', reason: 'Team start requires at least one task' }
  }

  for (const task of tasks) {
    const taskId = String(task?.taskId ?? '<unknown>')
    if (task?.verificationChecks === undefined) continue
    const parsed = verificationChecksSchema.safeParse(task?.verificationChecks)
    if (!parsed.success) {
      return { taskId, reason: 'Task verificationChecks must be a valid non-empty list when supplied' }
    }

    // Unsupported command/capability is a truthful verification outcome, not
    // a reason to prevent child work from starting. The runtime evidence
    // boundary owns that outcome.
  }
  return undefined
}

/**
 * Proves that a fixed command matches the durable workspace before starting a
 * process. A stack mismatch is configuration-unavailable, never code failure.
 */
export async function verificationCommandAvailability(
  commandRef: string,
  workspaceRoot: string,
): Promise<VerificationCommandAvailability> {
  if (commandRef === 'pnpm-build' || commandRef === 'pnpm-typecheck' || commandRef === 'pnpm-test'
    || commandRef === 'pnpm-interface-probe' || commandRef === 'pnpm-screenshot-probe') {
    const script = commandRef === 'pnpm-build' ? 'build'
      : commandRef === 'pnpm-typecheck' ? 'typecheck'
        : commandRef === 'pnpm-test' ? 'test'
          : commandRef === 'pnpm-interface-probe' ? 'yuqi-interface-probe' : 'yuqi-screenshot-probe'
    try {
      const value = JSON.parse(await readFile(path.join(workspaceRoot, 'package.json'), 'utf8')) as unknown
      const scripts = isRecord(value) && isRecord(value.scripts) ? value.scripts : undefined
      if (scripts !== undefined && typeof scripts[script] === 'string' && scripts[script].trim() !== '') return { available: true }
    } catch {
      // Missing/unreadable/malformed metadata has the same bounded outcome.
    }
    return { available: false, reason: `Verification configuration unavailable: package.json does not declare scripts.${script}` }
  }
  if (commandRef === 'dotnet-build') {
    try {
      const entries = await readdir(workspaceRoot, { withFileTypes: true })
      const targets = entries.filter(entry => entry.isFile() && /\.(?:sln|slnx|csproj)$/iu.test(entry.name))
      if (targets.length === 1) return { available: true }
      if (targets.length > 1) {
        return { available: false, reason: 'Verification configuration unavailable: dotnet build has multiple root project/solution targets' }
      }
    } catch {
      // Report the stable configuration class without Host path details.
    }
    return { available: false, reason: 'Verification configuration unavailable: no root .sln, .slnx, or .csproj target exists' }
  }
  return { available: false, reason: `Verification configuration unavailable: no Host command is registered for ${commandRef}` }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
