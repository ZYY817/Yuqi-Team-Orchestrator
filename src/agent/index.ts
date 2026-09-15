/** Scoped model-facing tools for the Yuqi Team user preset. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { fileScopePatternSchema } from '../domain/file-scope.ts'
import { YuqiOrchestratorError } from '../application/errors.ts'
import { teamRunDisposition, type RunTeamLoopResult, type TeamRunStopReason } from '../application/run-team-loop.ts'
import type { TeamProjection } from '../domain/projection.ts'
import {
  MAX_TEAM_TASKS,
  MAX_VERIFICATION_OUTPUT_BYTES,
  MAX_VERIFICATION_TIMEOUT_MS,
  TASK_AUTHORITY_MODES,
  TASK_MODEL_ROLES,
  teamTaskContractSchema,
  verificationChecksSchema,
} from '../domain/task-contract.ts'
import type { YuqiTeamOrchestratorService } from '../host/harness/service.ts'
import { reviewResultSchema, type ReviewOutcome } from '../application/reviewer.ts'
import { registerYuqiCommand } from '../host/harness/commands.ts'
import { readActiveTeamParentBinding, readTeamProjectionEventsForController, readYuqiSessionEvents, selectActiveTeamProjectionBridge } from '../host/harness/session-journal.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import { DEFAULT_TEAM_CONCURRENCY, MAX_TEAM_CONCURRENCY, MIN_TEAM_CONCURRENCY, normalizeTeamModelRouting } from '../application/team-settings.ts'
import { DEFAULT_TEAM_WORKSPACE_MODE, TEAM_WORKSPACE_MODES } from '../domain/team-settings-contract.ts'
import { DEFAULT_TEAM_LOCALE, TEAM_LOCALES, type TeamLocale } from '../domain/locale.ts'
import { registerProjectKnowledgeTool } from './project-knowledge-tool.ts'
import { readSessionEvents } from '../host/harness/session-events.ts'
import { taskRevisionRequestSchema } from '../application/create-task-revision.ts'

export const name = 'yuqi-team-orchestrator-agent'
export const inject = ['tools', 'yuqiTeamOrchestrator']

/** Fields the model may describe; Host-owned identity and provenance are excluded. */
const startTaskSchema = z.object(teamTaskContractSchema.shape).strict()
  .omit({ modelRequest: true, modelId: true, inputDigest: true, baselineRef: true })
  // Verification is an optional Host capability.  A task can still be
  // dispatched when the current Harness cannot collect evidence; the result
  // is surfaced as unavailable/inconclusive by the Host instead of blocking
  // the whole Team at the model-facing boundary.
  .extend({
    goal: z.string().trim().min(1).max(600),
    scope: z.array(z.string().trim().min(1).max(300)).max(4).optional(),
    nonGoals: z.array(z.string().trim().min(1).max(300)).max(4).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(300)).min(1).max(4).optional(),
    modelId: z.string().trim().min(1).optional(),
    model: z.object({
      providerId: z.string().trim().min(1),
      modelId: z.string().trim().min(1),
    }).strict().optional(),
    modelTier: z.enum(['quick', 'standard', 'critical']).optional(),
    authorityMode: z.enum(TASK_AUTHORITY_MODES).optional(),
    verificationChecks: verificationChecksSchema.optional(),
  }).superRefine((task, context) => {
    const selections = [task.model, task.modelId, task.modelTier].filter(value => value !== undefined)
    if (selections.length > 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'model, legacy modelId, and modelTier are mutually exclusive' })
    }
  })

const HOST_PENDING_BASELINE_REF = 'host-pending-baseline'

/**
 * Human-facing specialities accepted by the tool boundary. Durable execution
 * still uses the three Host roles so routing, budgets, and recovery keep one
 * canonical representation.
 */
const MODEL_ROLE_ALIASES = {
  researcher: 'worker',
  'frontend-engineer': 'worker',
  'design-engineer': 'worker',
  'ui-designer': 'worker',
  'art-director': 'worker',
  reviewer: 'verifier',
  planner: 'controller',
  'project-manager': 'controller',
} as const
const MODEL_FACING_ROLES = [...TASK_MODEL_ROLES, ...Object.keys(MODEL_ROLE_ALIASES)] as const

const bootstrapInputSchema = z.object({
  followup: z.object({ sourceTeamId: z.string().trim().min(1), sourceControllerSessionId: z.string().trim().min(1), requestId: z.string().trim().min(1).max(160) }).strict().optional(),
  title: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(1200),
  locale: z.enum(TEAM_LOCALES).optional(),
  projectPath: z.string().trim().min(1).max(300).optional(),
  workspaceMode: z.enum(TEAM_WORKSPACE_MODES).optional(),
  tasks: z.array(startTaskSchema).min(1).max(MAX_TEAM_TASKS),
  maxConcurrency: z.number().int().min(MIN_TEAM_CONCURRENCY).max(MAX_TEAM_CONCURRENCY).optional(),
}).strict()

const bootstrapParameters = {
  followup: { type: 'object', additionalProperties: false, description: 'Optional explicit continuation of an ended Team in this same parent conversation and original direct project. Provide a complete new plan; old results are reference data, not current verification. Reuse requestId for identical retries.', properties: {
    sourceTeamId: { type: 'string', required: true }, sourceControllerSessionId: { type: 'string', required: true }, requestId: { type: 'string', required: true },
  } },
  title: { type: 'string', required: true, description: 'Short human-readable Team title; do not include the plan or specifications.' },
  objective: { type: 'string', required: true, description: 'One to three concise sentences describing the shared outcome. Do not repeat project background, design rules, file lists, or per-task details.' },
  locale: { type: 'string', enum: TEAM_LOCALES, description: 'Optional Host-authored Team language. Use zh or en when the user language is clear; omit only when the current conversation does not safely establish it.' },
  projectPath: {
    type: 'string',
    description: 'Optional safe directory relative to the current project, for example website. When supplied, every task fileScope is relative to that selected subproject.',
  },
  workspaceMode: {
    type: 'string',
    enum: TEAM_WORKSPACE_MODES,
    description: 'Optional execution workspace. Omit to use Team settings (current project/direct by default). Use git-worktree only when the user explicitly requests Git isolation, an independent branch, or rollback separation.',
  },
  tasks: {
    type: 'array',
    required: true,
    description: 'Minimal task contracts only. Call before writing a full plan. Split by coherent deliverable or module, not mechanically by individual file. Each task needs one short goal, dependencies, fileScope, and modelRole; omit optional narrative fields unless they add information not already present. Goals are shown to the user before execution and passed unchanged to the child, so make them easy to understand.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', required: true },
        revision: { type: 'integer', required: true, description: 'Positive task contract revision; use 1 for a new task.' },
        goal: { type: 'string', required: true, description: 'One concise, natural-language sentence unique to this task. State the actual action, its object, and the intended result; preserve material scope, safety, permission, or read-only boundaries. Distinguish reading/organizing from changing. Do not use vague wording such as "optimize the feature", pile on implementation jargon, or repeat shared background. Use scope, nonGoals, acceptanceCriteria, and fileScope for supporting detail instead. Example: "整理软件的所有页面，标明每个页面对应的代码位置，方便以后查找和修改。"' },
        scope: { type: 'array', description: 'Optional concise scope labels. Normally omit; the Host derives a safe scope from goal and fileScope.', items: { type: 'string' } },
        nonGoals: { type: 'array', description: 'Optional exceptional exclusions only. Normally omit; fileScope is only a scheduling and change-presentation hint.', items: { type: 'string' } },
        dependencies: {
          type: 'array',
          description: 'Task IDs that must finish first. Omit or use [] when the task has no dependencies; never use an empty string. Declare only genuine output/data dependencies: independent, non-conflicting tasks must stay dependency-free so the Host can dispatch them in parallel.',
          items: { type: 'string' },
        },
        fileScope: {
          type: 'array',
          required: true,
          description: 'Project-relative files and directory globs this task is expected to change. This is a planning, conflict-avoidance, and change-presentation hint—not a filesystem write limit, one-file limit, or read sandbox. Include multiple related files/globs when one coherent deliverable spans them, and prefer a directory glob over enumerating many files. Do not split one module into one task per file. Keep planned parallel areas disjoint where practical; if implementation legitimately needs adjacent files, the child may update them and the Host will present the actual changed files. Use forward-slash paths/globs such as package.json, src/components/Hero.tsx, src/styles/hero.css, src/features/auth/**, or **/*.md. Do not use ".", "..", absolute paths, trailing slashes, backslashes, braces, negation, or empty strings.',
          items: { type: 'string' },
        },
        modelRole: {
          type: 'string',
          required: true,
          enum: MODEL_FACING_ROLES,
          description: 'Execution role or a supported human speciality. researcher/frontend-engineer/design-engineer/ui-designer/art-director map to worker; reviewer maps to verifier; planner/project-manager map to controller.',
        },
        modelId: {
          type: 'string',
          description: 'Legacy provider-less exact model id. Prefer model {providerId, modelId}; retained for compatibility.',
        },
        model: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional exact provider/model route intent.',
          properties: {
            providerId: { type: 'string', required: true },
            modelId: { type: 'string', required: true },
          },
        },
        modelTier: {
          type: 'string',
          enum: ['quick', 'standard', 'critical'],
          description: 'Automatic model tier for this task. Use quick for simple bounded work, standard by default, and critical for high-risk or complex work. Ignored when modelId is explicit.',
        },
        acceptanceCriteria: { type: 'array', description: 'Optional task-specific criteria only. Normally omit; the Host supplies a goal-and-fileScope acceptance baseline.', items: { type: 'string' } },
        authorityMode: { type: 'string', enum: TASK_AUTHORITY_MODES, description: 'Optional per-task permission override: read-only, write-authorized, or full-access. Omit to use Team settings.' },
        verificationChecks: {
          type: 'array',
          description: 'Optional Host-verifiable checks. Omit when no suitable Host collector is available; acceptance will then be reported as unavailable/inconclusive rather than blocking Team start.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              checkId: { type: 'string', required: true },
              kind: { type: 'string', required: true, enum: ['build', 'test', 'interface', 'screenshot'], description: 'Host evidence kind.' },
              commandRef: { type: 'string', required: true, enum: ['pnpm-build', 'pnpm-typecheck', 'pnpm-test', 'dotnet-build', 'pnpm-interface-probe', 'pnpm-screenshot-probe'], description: 'Registered fixed Host command reference; interface/screenshot runners must be explicitly provided by the project.' },
              timeoutMs: { type: 'integer', required: true, description: `Positive timeout in milliseconds, at most ${MAX_VERIFICATION_TIMEOUT_MS}.` },
              stdoutMaxBytes: { type: 'integer', required: true, description: `Positive output limit in bytes, at most ${MAX_VERIFICATION_OUTPUT_BYTES}.` },
              stderrMaxBytes: { type: 'integer', required: true, description: `Positive output limit in bytes, at most ${MAX_VERIFICATION_OUTPUT_BYTES}.` },
              method: { type: 'string', description: 'Required for interface probes; uppercase HTTP method.' },
              path: { type: 'string', description: 'Required for interface/screenshot probes; project-configured relative path beginning with /.' },
              expectedStatusCodes: { type: 'array', items: { type: 'integer' }, description: 'Optional expected HTTP status codes for interface probes.' },
              viewport: { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
              format: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'], description: 'Required for screenshot probes.' },
              referenceDigest: { type: 'string', description: 'Required for screenshot probes; durable reference identity.' },
            },
          },
        },
        maxAttempts: { type: 'integer' },
      },
    },
  },
} as const

const bootstrapOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      teamId: { type: 'string', required: true },
      status: { type: 'string', required: true },
      taskCount: { type: 'integer', required: true },
      controllerSessionId: { type: 'string', required: true },
      stopReason: { type: 'string', required: true },
      disposition: { type: 'string', required: true, enum: ['started', 'completed', 'failed', 'cancelled', 'yielded', 'recoverable', 'needs_reconciliation'] },
      terminal: { type: 'boolean', required: true },
      requiresAttention: { type: 'boolean', required: true },
      reportUnavailable: { type: 'boolean', description: 'True when bounded child reports were required for this stop but the Host could not read them.' },
      attentionReason: {
        type: 'string',
        enum: ['plan_confirmation', 'task_outcomes', 'manual_pause'],
        description: 'Present for paused Teams so the controller can distinguish startup confirmation from a post-execution decision point.',
      },
      taskOutcomes: {
        type: 'array',
        description: 'Actionable failed, cancelled, or blocked task outcomes when attentionReason is task_outcomes.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['failed', 'cancelled', 'blocked'] },
            goal: { type: 'string', required: true },
          },
        },
      },
      taskReports: {
        type: 'array', description: 'Bounded latest child conclusions for the completed tasks; source text remains in child Sessions.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            agentSessionId: { type: 'string' },
            output: { type: 'string' },
            truncated: { type: 'boolean' },
            stopReason: { type: 'string' },
            verificationReasons: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  checkId: { type: 'string', required: true },
                  code: { type: 'string', required: true },
                  detail: { type: 'string', required: true },
                },
              },
            },
            reportUnavailable: { type: 'boolean' },
          },
        },
      },
      review: {
        type: 'object', description: 'Bounded read-only reviewer result; skipped for simple Teams.',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['skipped', 'completed'] },
          reviewId: { type: 'string' },
          trigger: { type: 'string' },
          reason: { type: 'string' },
          result: {
            type: 'object',
            additionalProperties: false,
            properties: {
              reviewId: { type: 'string', required: true },
              trigger: { type: 'string', required: true },
              reviewerSessionId: { type: 'string', required: true },
              decision: { type: 'string', required: true, enum: ['pass', 'changes_required', 'inconclusive'] },
              findings: { type: 'array', required: true },
              unverified: { type: 'array', required: true },
            },
          },
        },
      },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

/** Registers the complete Host-owned Team start-and-run entry. */
export function apply(ctx: Context): void {
  // The command exists only in the Yuqi preset scope. Loading the Host bundle
  // must not add /yuqi to ordinary agents or create native command events in
  // unrelated conversations.
  registerYuqiCommand(ctx, ctx.yuqiTeamOrchestrator)
  registerProjectKnowledgeTool(ctx, (parent, identity) => resolveBoundTeam(ctx, parent, identity))
  ctx.tools.register(defineTool({
    name: 'yuqi_team_start',
    description: 'When the user explicitly requests Team mode, a Team, or subagent-split/parallel execution, call this tool promptly before Shell, file inspection, native subagents, or manual workspace cleanup; ordinary discussion and simple work stay on normal tools. Teams use the selected current project by default and do not require Git, even for writable tasks. Set workspaceMode=git-worktree only when the user explicitly requests Git isolation, an independent branch, or rollback separation. projectPath must name an existing nested directory. When the task itself will create a new directory, keep the current project root and prefix every task fileScope with that new directory instead. When an existing app is nested below the current project (for example website/), set projectPath to that directory only when every required input and output is inside it; otherwise keep the common parent as the project and prefix fileScope with the app directory. A task may own multiple related files and directory globs: split work by coherent deliverable, not one task per file. fileScope guides scheduling, conflict avoidance, and change presentation; it is not a filesystem write limit or per-file read sandbox. Use normalized paths/globs such as package.json, src/components/Hero.tsx, src/styles/hero.css, src/features/auth/**, or **/*.md, never ".".',
    parameters: bootstrapParameters,
    output: bootstrapOutput,
    async execute(args, exec) {
      requireAgent(exec)
      const sessionEvents = readSessionEvents(exec.agent.session)
      const parsedInput = bootstrapInputSchema.safeParse(normalizeModelInput(args))
      const activeBridge = selectActiveTeamProjectionBridge(readYuqiSessionEvents(exec.agent.session))
      if (activeBridge !== undefined) {
        const activeProjection = replayTeamEvents(activeBridge.events)
        if (!isTerminalTeamStatus(activeProjection.team.status) && !(parsedInput.success && parsedInput.data.followup !== undefined)) {
          throw new Error(
            `Yuqi team start rejected: this conversation already has active Team ${activeProjection.team.id} `
            + `(${activeProjection.team.status}) on controller ${activeBridge.controllerSessionId}; `
            + 'use yuqi_team_control to recover, resume, pause, reconcile, or cancel it instead of creating a duplicate Team',
          )
        }
      }
      const input = parsedInput
      if (!input.success) {
        const issue = input.error.issues[0]
        const field = issue?.path.length === 0 ? 'input' : issue?.path.join('.')
        throw new Error(`Yuqi team start rejected: ${field ?? 'input'} ${issue?.message ?? 'is invalid'}`)
      }
      const sessionProjectCwd = exec.agent.session.header.cwd
      if (sessionProjectCwd === undefined || !path.isAbsolute(sessionProjectCwd)) throw new Error('Yuqi team start requires a project working directory')
      const projectCwd = resolveSelectedProjectCwd(sessionProjectCwd, input.data.projectPath)
      const locale = input.data.locale ?? inferTeamLocale(sessionEvents) ?? DEFAULT_TEAM_LOCALE
      // Agent.options is the Host default, not necessarily the route used by
      // the request that is currently executing this tool.  The request/header
      // fold is the atomic provider/model snapshot captured for that step; use
      // it when available so a concurrent next-step model switch cannot split
      // the Team controller route. Older Hosts may not expose requestHeader().
      const controllerModel = currentRequestControllerModel(exec.agent)
      const controllerModelId = configuredModelId(controllerModel.model)
      const controllerProvider = configuredModelProvider(controllerModel.provider)
      // Independent controllers inherit from their durable parent binding;
      // normal admission uses the actual invoking Session, never the new controller.
      const settingsSourceSessionId = readActiveTeamParentBinding(exec.agent.session)?.parentSessionId
        ?? String(exec.agent.session.id ?? exec.agent.id)
      const teamDefaults = typeof ctx.yuqiTeamOrchestrator.teamDefaults === 'function'
        ? ctx.yuqiTeamOrchestrator.teamDefaults(settingsSourceSessionId)
        : {
            maxConcurrency: typeof ctx.yuqiTeamOrchestrator.maxConcurrencyLimit === 'function' ? ctx.yuqiTeamOrchestrator.maxConcurrencyLimit() : DEFAULT_TEAM_CONCURRENCY,
            childPresetId: 'standard', childModelId: '', childModelPolicy: 'inherit' as const,
            quickModelId: '', standardModelId: '', criticalModelId: '',
            defaultAuthorityMode: 'write-authorized' as const,
            defaultWorkspaceMode: DEFAULT_TEAM_WORKSPACE_MODE,
            // Older Host services do not expose this setting; preserve their
            // established immediate-run behavior during a hot reload.
            requirePlanConfirmation: false,
          }
      const tasks = input.data.tasks.map(task => completeTaskContract(task, teamDefaults))
      const modelRouting = normalizeTeamModelRouting(teamDefaults, { modelProvider: controllerProvider, modelId: controllerModelId })
      const workspaceMode = input.data.workspaceMode ?? teamDefaults.defaultWorkspaceMode ?? DEFAULT_TEAM_WORKSPACE_MODE
      // Keep the model-facing entry compatible with an older Host service
      // during a profile hot-reload; a matching current service always
      // provides this method and therefore enforces the persisted setting.
      const configuredMaxConcurrency = teamDefaults.maxConcurrency
      // Concurrency is user-owned. A model must not silently serialize an
      // otherwise parallel task graph by requesting a smaller batch.
      const maxConcurrency = configuredMaxConcurrency

      let started: Awaited<ReturnType<YuqiTeamOrchestratorService['startTeam']>> | undefined
      try {
        const startRequest: Parameters<YuqiTeamOrchestratorService['startTeam']>[0] = {
          maxConcurrency,
          title: input.data.title,
          objective: input.data.objective,
          locale,
          tasks,
          projectCwd,
          workspaceMode,
          managedRoot: workspaceMode === 'direct'
            ? path.dirname(projectCwd)
            : (teamDefaults.gitWorkspaceRoot?.trim() || path.join(path.dirname(input.data.projectPath === undefined ? projectCwd : sessionProjectCwd), '.yuqi-team-worktrees')),
          controllerModel,
          modelRouting,
          requirePlanConfirmation: teamDefaults.requirePlanConfirmation === true,
          ...(teamDefaults.reviewPolicy === undefined ? {} : { reviewPolicy: teamDefaults.reviewPolicy }),
          childPresetId: teamDefaults.childPresetId,
          controllerParentSessionId: String(exec.agent.id),
          signal: exec.signal,
        }
        if (input.data.followup === undefined) {
          started = await ctx.yuqiTeamOrchestrator.startTeam(startRequest)
        } else {
          const source = input.data.followup
          const result = await ctx.yuqiTeamOrchestrator.startFollowupTeam(startRequest, {
            teamId: source.sourceTeamId, controllerSessionId: source.sourceControllerSessionId,
            requestDigest: createHash('sha256').update(JSON.stringify(input.data)).digest('hex'),
            operationId: `followup-v1:${createHash('sha256').update(JSON.stringify([String(exec.agent.id), source.sourceTeamId, source.requestId])).digest('hex')}`,
          })
          if (result.kind === 'existing') {
            const current = await ctx.yuqiTeamOrchestrator.readFollowupResult(result.controllerSessionId, result.teamId, String(exec.agent.id))
            return mapRunResult(current, result.controllerSessionId)
          }
          started = result.value
        }
        exec.signal.throwIfAborted()
        if (teamDefaults.requirePlanConfirmation === true) {
          const paused = started.bootstrap
          const durableGate = paused.team.status === 'paused'
            && paused.team.planConfirmationRequired === true
            && paused.controlOperations[`plan-review:${started.teamId}`]?.action === 'pause'
          if (!durableGate) {
            if (typeof ctx.yuqiTeamOrchestrator.abortTeam === 'function') {
              await ctx.yuqiTeamOrchestrator.abortTeam({
                controller: started.controller,
                teamId: started.teamId,
                operationId: `atomic-plan-gate-rejected:${started.teamId}`,
              })
            }
            throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Host did not persist the required atomic plan-confirmation gate')
          }
          if (typeof ctx.yuqiTeamOrchestrator.launchTeamInBackground === 'function') {
            ctx.yuqiTeamOrchestrator.launchTeamInBackground({
              controller: started.controller,
              teamId: started.teamId,
              maxConcurrency,
              disposeController: started.dispose,
            })
            return mapRunResult({ projection: paused, reason: 'paused', disposition: 'recoverable', cycles: 0 }, started.sessionId)
          }
        }
        const runResult = typeof ctx.yuqiTeamOrchestrator.launchTeamInBackground === 'function'
          ? ctx.yuqiTeamOrchestrator.launchTeamInBackground({
              controller: started.controller,
              teamId: started.teamId,
              maxConcurrency,
              disposeController: started.dispose,
            })
          : await ctx.yuqiTeamOrchestrator.runTeam({
              controller: started.controller,
              teamId: started.teamId,
              maxConcurrency,
              signal: exec.signal,
              disposeController: started.dispose,
            })
        const result = runResult.reason === 'aborted'
          ? await recoverAbortedRun(ctx.yuqiTeamOrchestrator, started, runResult)
          : runResult
        const needsTaskReports = shouldReadTaskReports(result)
        const taskReports = needsTaskReports && typeof ctx.yuqiTeamOrchestrator.readTeamTaskReports === 'function'
          ? await attemptTaskReports(ctx.yuqiTeamOrchestrator, started, exec.signal)
          : undefined
        const review = reviewOutcomeFromProjection(result.projection)
        const mapped = mapRunResult(result, started.sessionId, review, taskReports, requiresFailureReports(result) && taskReports === undefined)
        if (mapped.terminal) {
          requestControllerDisposal(started.dispose)
        }
        return mapped
      } catch (cause) {
        if (exec.signal.aborted) {
          if (started !== undefined) {
            const recovered = await recoverAbortedRunAfterFailure(ctx.yuqiTeamOrchestrator, started)
            if (recovered !== undefined) {
              const mapped = mapRunResult(recovered, started.sessionId)
              if (mapped.terminal) requestControllerDisposal(started.dispose)
              return mapped
            }
          }
          throw new Error('Yuqi team abort requires reconciliation')
        }
        if (started !== undefined) requestControllerDisposal(started.dispose)
        // Host/application details can contain paths or adapter diagnostics; the
        // model-facing boundary deliberately exposes only a stable safe error.
        const detail = cause instanceof YuqiOrchestratorError
          ? ` (${cause.code}): ${cause.message}`
          : ''
        throw new Error(`Yuqi team start failed${detail}`)
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'yuqi_team_control',
    description: 'Control the exact Yuqi Team currently bound to this conversation. Use stop with taskId to stop one running child without cancelling independent tasks. For cancel or reconcile only, an exact teamId plus controllerSessionId reported by a WORKSPACE_CONFLICT may target that persisted Team from another conversation. Use retry with taskId to create a new attempt for one failed, cancelled, or blocked task and resume a paused Team. Use resume only for an explicit continue request. For an authorized recovery and continuation, use recover_continue: it checks current Host facts, resolves only safely recoverable interrupted attempts, preserves files, and resumes eligible work. accepted means the request was processed, not that recovery succeeded: inspect status; needs_reconciliation or paused is not running. Do not repeatedly retry unchanged blocked recovery. Use reconcile only for actual needs_reconciliation state, never for ordinary task outcomes. Legacy recover only clears an already-resolved recovery gate to paused; it does not resolve interrupted attempts. Never guess identities.',
    parameters: {
      action: { type: 'string', required: true, enum: ['pause', 'resume', 'cancel', 'reconcile', 'recover', 'recover_continue', 'retry', 'stop', 'scope', 'retry_review', 'authorize_final_rework', 'waive', 'fail', 'cancel_review'] },
      taskId: { type: 'string', description: 'Required for retry, stop, or scope: the exact task id reported by the bound Team.' },
      fileScope: { type: 'array', items: { type: 'string' }, description: 'Required only for scope: complete replacement of the task planning fileScope (1-512 normalized project-relative paths/globs). Include existing patterns to retain them. Requires a safely paused Team with no active execution, leases, or manual ownership. Does not grant permissions or resume execution; overlapping scopes use existing serial scheduling.' },
      reviewId: { type: 'string', description: 'Exact awaiting-user review id.' },
      candidateEventId: { type: 'string', description: 'Exact review candidate cut.' },
      reviewRound: { type: 'number', description: 'Exact review cycle round.' },
      reason: { type: 'string', description: 'Required audit reason for waive.' },
      requestId: { type: 'string', description: 'Stable idempotency key required for scope and review decisions. Reuse only with identical input.' },
      teamId: { type: 'string', description: 'Optional exact Team id; omit to control the active Team bound to this conversation.' },
      controllerSessionId: { type: 'string', description: 'Optional exact controller id; omit to use the active Team bound to this conversation.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          teamId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          accepted: { type: 'boolean', required: true },
          taskId: { type: 'string' },
          notice: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      const input = z.object({
        action: z.enum(['pause', 'resume', 'cancel', 'reconcile', 'recover', 'recover_continue', 'retry', 'stop', 'scope', 'retry_review', 'authorize_final_rework', 'waive', 'fail', 'cancel_review']),
        taskId: z.string().trim().min(1).optional(),
        fileScope: fileScopePatternSchema.array().min(1).max(512).optional(),
        reviewId: z.string().trim().min(1).optional(),
        candidateEventId: z.string().trim().min(1).optional(),
        reviewRound: z.number().int().min(0).max(3).optional(),
        reason: z.string().trim().min(1).max(2_000).optional(),
        requestId: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,128}$/u).optional(),
        teamId: z.string().trim().min(1).optional(),
        controllerSessionId: z.string().trim().min(1).optional(),
      }).strict().superRefine((value, issue) => {
        if (['retry', 'stop', 'scope'].includes(value.action) && value.taskId === undefined) issue.addIssue({ code: 'custom', path: ['taskId'], message: `taskId is required for ${value.action}` })
        if (!['retry', 'stop', 'scope'].includes(value.action) && value.taskId !== undefined) issue.addIssue({ code: 'custom', path: ['taskId'], message: 'taskId is only valid for retry, stop, or scope' })
        if (value.action === 'scope' && (value.fileScope === undefined || value.requestId === undefined)) issue.addIssue({ code: 'custom', path: ['fileScope'], message: 'scope requires fileScope and requestId' })
        if (value.action !== 'scope' && value.fileScope !== undefined) issue.addIssue({ code: 'custom', path: ['fileScope'], message: 'fileScope is only valid for scope' })
        const reviewDecision = ['retry_review', 'authorize_final_rework', 'waive', 'fail', 'cancel_review'].includes(value.action)
        if (reviewDecision && (value.reviewId === undefined || value.candidateEventId === undefined || value.reviewRound === undefined || value.requestId === undefined)) {
          issue.addIssue({ code: 'custom', path: ['reviewId'], message: 'reviewId, candidateEventId, reviewRound, and requestId are required for review decisions' })
        }
        if (value.action === 'waive' && value.reason === undefined) issue.addIssue({ code: 'custom', path: ['reason'], message: 'waive requires a reason' })
      }).parse(args)
      if ((input.action === 'cancel' || input.action === 'reconcile')
        && input.teamId !== undefined && input.controllerSessionId !== undefined) {
        const next = await ctx.yuqiTeamOrchestrator.controlTeamByIdentity({
          teamId: input.teamId,
          controllerSessionId: input.controllerSessionId,
          operationId: `model-v1:${createHash('sha256').update(`${String(exec.agent.id)}:${input.teamId}:${input.action}:${input.requestId ?? Date.now()}`).digest('hex').slice(0, 24)}`,
          action: input.action,
          signal: exec.signal,
        })
        if (next === undefined) throw new Error(`Yuqi Team controller ${input.controllerSessionId} is unavailable`)
        return { teamId: next.team.id, status: next.team.status, accepted: true }
      }
      const { controller, teamId } = await resolveBoundTeam(ctx, exec.agent, input)
      const operationId = `model-v1:${createHash('sha256').update(`${String(exec.agent.id)}:${teamId}:${input.action}:${input.requestId ?? Date.now()}`).digest('hex').slice(0, 24)}`
      if (input.action === 'recover_continue') {
        const next = await ctx.yuqiTeamOrchestrator.recoverAndContinueTeam({
          controller, teamId, operationId, signal: exec.signal,
        })
        return { teamId: next.team.id, status: next.team.status, accepted: true }
      }
      if (input.action === 'scope') {
        const next = await ctx.yuqiTeamOrchestrator.setTaskFileScope({
          controller, teamId, taskId: input.taskId!, fileScope: input.fileScope!, operationId,
        })
        return { teamId: next.team.id, status: next.team.status, accepted: true, ...(input.taskId === undefined ? {} : { taskId: input.taskId }) }
      }
      if (['retry_review', 'authorize_final_rework', 'waive', 'fail', 'cancel_review'].includes(input.action)) {
        const next = await ctx.yuqiTeamOrchestrator.decideReview({
          controller, teamId, operationId, reviewId: input.reviewId!, candidateEventId: input.candidateEventId!,
          round: input.reviewRound!, decision: reviewDecisionFromAgentAction(input.action),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
        return { teamId: next.team.id, status: next.team.status, accepted: true }
      }
      let next = input.action === 'pause'
        ? await ctx.yuqiTeamOrchestrator.pauseTeam({ controller, teamId, operationId })
        : input.action === 'resume'
          ? await ctx.yuqiTeamOrchestrator.resumeTeam({ controller, teamId, operationId })
          : input.action === 'cancel'
            ? await ctx.yuqiTeamOrchestrator.cancelTeam({ controller, teamId, operationId })
            : input.action === 'recover'
              ? await ctx.yuqiTeamOrchestrator.clearTeamRecovery({ controller, teamId, operationId, target: 'paused', signal: exec.signal })
              : input.action === 'retry'
                ? await ctx.yuqiTeamOrchestrator.retryTask({ controller, teamId, taskId: input.taskId!, operationId })
                : input.action === 'stop'
                  ? await ctx.yuqiTeamOrchestrator.stopTask({ controller, teamId, taskId: input.taskId!, operationId })
                : await ctx.yuqiTeamOrchestrator.reconcileTeam({ controller, teamId, operationId, signal: exec.signal })
      if (input.action === 'retry' && next.team.status === 'paused') {
        next = await ctx.yuqiTeamOrchestrator.resumeTeam({
          controller, teamId,
          operationId: `${operationId}:resume`,
        })
      }
      return { teamId: next.team.id, status: next.team.status, accepted: true,
        ...(input.action === 'resume' && next.team.status === 'running' && next.controlOperations[operationId] === undefined
          ? { notice: 'Team is already running. No new resume or wake was performed. Do not repeat start based on an older snapshot.' } : {}),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'yuqi_team_revise',
    description: 'Create a separately tracked revision of a completed task in a running or paused Team. Preserve old results. Set includeDependents=true to recreate all completed downstream consumers for fresh verification; unfinished consumers, review history or uncertain execution require explicit replanning. Same scope, authority and model. Reuse a stable requestId only for identical requirements. Does not resume a paused Team; ended Teams use a follow-up Team.',
    parameters: {
      sourceTaskId: { type: 'string', required: true },
      includeDependents: { type: 'boolean', description: 'Explicitly include all completed downstream consumers as new revalidation tasks; default false.' },
      requestId: { type: 'string', required: true, description: 'Stable unique revision request identity; reuse only for identical requirements.' },
      goal: { type: 'string', required: true, description: 'One concise, natural-language sentence for the new requested change, at most 600 characters. State the actual action, object, and intended result; retain material boundaries and distinguish reading/organizing from changing. This goal is shown to the user and passed unchanged to the revision child. Put supporting detail in acceptanceCriteria; avoid vague wording such as "optimize the feature" and unnecessary implementation jargon.' },
      acceptanceCriteria: { type: 'array', required: true, items: { type: 'string' }, description: 'One to four explicit acceptance criteria for the new result.' },
      teamId: { type: 'string' },
      controllerSessionId: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        taskId: { type: 'string', required: true },
        taskIds: { type: 'array', items: { type: 'string' }, required: true },
        status: { type: 'string', required: true },
        accepted: { type: 'boolean', required: true },
      } },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      const input = taskRevisionRequestSchema.omit({ teamId: true, operationId: true }).extend({
        requestId: z.string().trim().min(1).max(160),
        teamId: z.string().trim().min(1).optional(),
        controllerSessionId: z.string().trim().min(1).optional(),
      }).strict().parse(args)
      const { controller, teamId } = await resolveBoundTeam(ctx, exec.agent, input)
      const operationId = `revision-v1:${createHash('sha256').update(JSON.stringify([String(exec.agent.id), teamId, input.requestId])).digest('hex')}`
      const next = await ctx.yuqiTeamOrchestrator.createTaskRevision({
        controller, teamId, operationId, sourceTaskId: input.sourceTaskId,
        goal: input.goal, acceptanceCriteria: input.acceptanceCriteria,
        ...(input.includeDependents === undefined ? {} : { includeDependents: input.includeDependents }),
      })
      const taskId = next.taskIds.find(id => next.tasks[id]!.contract.userRevision?.operationId === operationId)!
      const taskIds = next.taskIds.filter(id => next.tasks[id]!.contract.userRevision?.operationId === operationId)
      return { taskId, taskIds, status: next.tasks[taskId]!.status, accepted: true }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'yuqi_team_message',
    description: 'Send a later instruction or answer to one exact running Yuqi Team child. Delivery enters the child FIFO inbox; it does not interrupt the current step and it never bypasses Team pause or terminal state.',
    parameters: {
      taskId: { type: 'string', required: true },
      message: { type: 'string', required: true },
      teamId: { type: 'string', description: 'Optional exact Team id; omit to use the active Team bound to this conversation.' },
      controllerSessionId: { type: 'string', description: 'Optional exact controller id; omit to use the active Team bound to this conversation.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          childSessionId: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
          accepted: { type: 'boolean', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      const input = z.object({
        taskId: z.string().trim().min(1),
        message: z.string().trim().min(1).max(16_384),
        teamId: z.string().trim().min(1).optional(),
        controllerSessionId: z.string().trim().min(1).optional(),
      }).strict().parse(args)
      const { controller, teamId } = await resolveBoundTeam(ctx, exec.agent, input)
      const delivered = await ctx.yuqiTeamOrchestrator.sendTaskMessage({
        controller, teamId, taskId: input.taskId, message: input.message, signal: exec.signal,
      })
      return { taskId: input.taskId, ...delivered, accepted: true }
    },
  }))
}

/** Starts controller cleanup without allowing a stuck Host adapter to block a tool turn. */
function requestControllerDisposal(dispose: () => Promise<void>): void {
  void Promise.resolve().then(dispose).catch(() => undefined)
}

/**
 * Model tool callers occasionally encode "no dependencies" as `[""]`.
 * Normalize only that unambiguous representation at the model-facing edge;
 * all other values still pass through the strict durable contract unchanged.
 */
function normalizeModelInput(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.tasks)) return value
  return {
    ...value,
    tasks: value.tasks.map(task => {
      if (!isRecord(task)) return task
      const dependencies = task.dependencies === undefined
        ? []
        : normalizeDependencies(task.dependencies)
      const verificationChecks = Array.isArray(task.verificationChecks)
        ? (task.verificationChecks.length === 0
            ? undefined
            : task.verificationChecks.map(check => normalizeVerificationCheck(check)))
        : task.verificationChecks
      const { verificationChecks: _discardedVerificationChecks, ...taskWithoutVerificationChecks } = task
      return {
        ...taskWithoutVerificationChecks,
        dependencies,
        modelRole: normalizeModelRole(task.modelRole),
        ...(verificationChecks === undefined ? {} : { verificationChecks }),
      }
    }),
  }
}

function normalizeModelRole(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const normalized = value.trim().toLowerCase()
  return MODEL_ROLE_ALIASES[normalized as keyof typeof MODEL_ROLE_ALIASES] ?? normalized
}

function normalizeDependencies(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  if (value.length === 0) return value
  const isNoDependencySentinel = (dependency: unknown): boolean => {
    if (typeof dependency !== 'string') return false
    const normalized = dependency.trim()
    return normalized === '' || normalized === '[]'
  }
  return value.every(isNoDependencySentinel) ? [] : value
}

function normalizeVerificationCheck(value: unknown): unknown {
  if (!isRecord(value)) return value
  return {
    ...value,
    timeoutMs: capAt(value.timeoutMs, MAX_VERIFICATION_TIMEOUT_MS),
    stdoutMaxBytes: capAt(value.stdoutMaxBytes, MAX_VERIFICATION_OUTPUT_BYTES),
    stderrMaxBytes: capAt(value.stderrMaxBytes, MAX_VERIFICATION_OUTPUT_BYTES),
  }
}

function capAt(value: unknown, maximum: number): unknown {
  return typeof value === 'number' && Number.isFinite(value) && value > maximum ? maximum : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type AbortControlService = Pick<YuqiTeamOrchestratorService, 'abortTeam'>

async function attemptTaskReports(
  service: Pick<YuqiTeamOrchestratorService, 'readTeamTaskReports'>,
  started: { readonly controller: Parameters<YuqiTeamOrchestratorService['readTeamTaskReports']>[0]['controller']; readonly teamId: string },
  signal: AbortSignal,
) {
  try {
    return await service.readTeamTaskReports({ controller: started.controller, teamId: started.teamId, signal })
  } catch {
    return undefined
  }
}

function reviewOutcomeFromProjection(projection: TeamProjection): ReviewOutcome | undefined {
  const reviewId = projection.reviewIds?.at(-1)
  const review = reviewId === undefined ? undefined : projection.reviews[reviewId]
  if (review?.result === undefined) return undefined
  return { status: 'completed', result: reviewResultSchema.parse({ reviewId: review.id, trigger: review.trigger, ...review.result }) }
}

function reviewDecisionFromAgentAction(action: string): 'retry_review' | 'authorize_final_rework' | 'waive' | 'fail' | 'cancel' {
  if (action === 'cancel_review') return 'cancel'
  if (action === 'retry_review' || action === 'authorize_final_rework' || action === 'waive' || action === 'fail') return action
  throw new Error(`Unsupported review decision ${action}`)
}

function mapRunResult(
  result: RunTeamLoopResult,
  controllerSessionId: string,
  review?: ReviewOutcome,
  taskReports?: Awaited<ReturnType<YuqiTeamOrchestratorService['readTeamTaskReports']>>,
  reportUnavailable = false,
) {
  const disposition = result.disposition ?? teamRunDisposition(result.reason)
  const terminal = isTerminalTeamStatus(result.projection.team.status)
  const attentionReason = result.projection.team.status === 'paused'
    ? pausedAttentionReason(result.projection)
    : undefined
  const taskOutcomes = attentionReason === 'task_outcomes'
    ? result.projection.taskIds.flatMap(taskId => {
        const task = result.projection.tasks?.[taskId]
        if (task === undefined || (task.status !== 'failed' && task.status !== 'cancelled' && task.status !== 'blocked')) return []
        return [{ taskId, status: task.status, goal: task.contract.goal }]
      })
    : undefined
  return {
    teamId: result.projection.team.id,
    status: result.projection.team.status,
    taskCount: result.projection.taskIds.length,
    controllerSessionId,
    stopReason: result.reason,
    disposition,
    terminal,
    ...(attentionReason === undefined ? {} : { attentionReason }),
    ...(taskOutcomes === undefined ? {} : { taskOutcomes }),
    ...(taskReports === undefined ? {} : {
      taskReports: taskReports.map(({ verificationReasons, ...report }) => ({
        ...report,
        ...(verificationReasons === undefined ? {} : { verificationReasons: verificationReasons.map(reason => ({ ...reason })) }),
      })),
    }),
    ...(reportUnavailable ? { reportUnavailable: true } : {}),
    ...(review === undefined ? {} : { review }),
    requiresAttention: disposition !== 'yielded' && disposition !== 'started' && (
      !terminal || disposition === 'recoverable' || disposition === 'needs_reconciliation'
        || (review?.status === 'completed' && review.result.decision !== 'pass')
    ),
  }
}

function shouldReadTaskReports(result: RunTeamLoopResult): boolean {
  return result.reason === 'completed' || requiresFailureReports(result)
}

function requiresFailureReports(result: RunTeamLoopResult): boolean {
  return result.projection.team.status === 'paused'
    || result.projection.team.status === 'failed'
    || result.projection.team.status === 'needs_reconciliation'
    || result.projection.taskIds.some(taskId => result.projection.tasks?.[taskId]?.status === 'blocked')
}

function pausedAttentionReason(projection: RunTeamLoopResult['projection']): 'plan_confirmation' | 'task_outcomes' | 'manual_pause' {
  const taskStatuses = projection.taskIds.map(taskId => projection.tasks?.[taskId]?.status)
  if (taskStatuses.some(status => status === 'failed' || status === 'cancelled' || status === 'blocked')) return 'task_outcomes'
  if (taskStatuses.length > 0 && taskStatuses.every(status => status === 'pending' || status === 'ready')) return 'plan_confirmation'
  return 'manual_pause'
}

async function recoverAbortedRun(
  service: AbortControlService,
  started: { readonly controller: Parameters<YuqiTeamOrchestratorService['cancelTeam']>[0]['controller']; readonly teamId: string },
  result: RunTeamLoopResult,
): Promise<RunTeamLoopResult> {
  const projection = await abortProjection(service, started)
  if (projection === undefined) return { ...result, disposition: 'needs_reconciliation' }
  const reason = terminalOrReconciliationReason(projection.team.status) ?? 'aborted'
  return { ...result, projection, reason, disposition: teamRunDisposition(reason) }
}

async function recoverAbortedRunAfterFailure(
  service: AbortControlService,
  started: { readonly controller: Parameters<YuqiTeamOrchestratorService['cancelTeam']>[0]['controller']; readonly teamId: string },
): Promise<RunTeamLoopResult | undefined> {
  const projection = await abortProjection(service, started)
  if (projection === undefined) return undefined
  const reason = terminalOrReconciliationReason(projection.team.status) ?? 'aborted'
  return { projection, reason, disposition: teamRunDisposition(reason), cycles: 0 }
}

async function abortProjection(
  service: AbortControlService,
  started: { readonly controller: Parameters<YuqiTeamOrchestratorService['cancelTeam']>[0]['controller']; readonly teamId: string },
): Promise<TeamProjection | undefined> {
  try {
    return await service.abortTeam({ controller: started.controller, teamId: started.teamId, operationId: abortOperationId(started.teamId) })
  } catch {
    return undefined
  }
}

function terminalOrReconciliationReason(status: TeamProjection['team']['status']): TeamRunStopReason | undefined {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'needs_reconciliation': return status
    default: return undefined
  }
}

function isTerminalTeamStatus(status: TeamProjection['team']['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function abortOperationId(teamId: string): string {
  return `agent-abort:${teamId}`
}

function requireAgent(exec: ToolRunContext): asserts exec is ToolRunContext & { agent: NonNullable<ToolRunContext['agent']> } {
  if (exec.agent === undefined) throw new Error('Yuqi team start requires an agent-owned execution')
}

function resolveSelectedProjectCwd(sessionProjectCwd: string, projectPath: string | undefined): string {
  const base = path.resolve(sessionProjectCwd)
  if (projectPath === undefined) return base
  if (path.isAbsolute(projectPath)) throw new Error('Yuqi team start projectPath must be relative to the current project')
  const selected = path.resolve(base, projectPath)
  const relative = path.relative(base, selected)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Yuqi team start projectPath must select a nested directory inside the current project')
  }
  return selected
}

/** Infer only from the latest real user turn; model-generated tool copy is not a language preference. */
function inferTeamLocale(events: readonly unknown[] | undefined): TeamLocale | undefined {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isRecord(event) || event.type !== 'user/message' || !isRecord(event.data)) continue
    const source = event.data.source
    if (isRecord(source) && source.kind !== 'user') continue
    const content = event.data.content
    if (!Array.isArray(content)) continue
    const text = content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
    if (/\p{Script=Han}/u.test(text)) return 'zh'
    const words = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/gu) ?? []
    return words.length >= 2 ? 'en' : undefined
  }
  return undefined
}

async function resolveBoundTeam(
  ctx: Context,
  parent: Agent,
  requested: { readonly teamId?: string | undefined; readonly controllerSessionId?: string | undefined },
): Promise<{ readonly controller: Agent; readonly teamId: string }> {
  const activeBridge = requested.controllerSessionId === undefined
    ? selectActiveTeamProjectionBridge(readYuqiSessionEvents(parent.session))
    : undefined
  const controllerSessionId = requested.controllerSessionId ?? activeBridge?.controllerSessionId
  if (controllerSessionId === undefined) throw new Error('This conversation has no active Yuqi Team binding')
  const bridged = readTeamProjectionEventsForController(parent.session, controllerSessionId)
  if (bridged === undefined) throw new Error(`Yuqi Team controller ${controllerSessionId} is not bound to this conversation`)
  const projection = replayTeamEvents(bridged)
  const teamId = requested.teamId ?? projection.team.id
  if (projection.team.id !== teamId) throw new Error(`Yuqi Team identity mismatch: expected ${projection.team.id}`)
  const controller = await ctx.yuqiTeamOrchestrator.resolveTeamController?.(controllerSessionId)
  if (controller === undefined) throw new Error(`Yuqi Team controller ${controllerSessionId} is unavailable`)
  const activeParent = readActiveTeamParentBinding(controller.session)?.parentSessionId
  if (activeParent !== undefined && activeParent !== String(parent.id)) throw new Error('Yuqi Team is bound to another main conversation')
  return { controller, teamId }
}

function currentRequestControllerModel(agent: Agent): { readonly provider: string; readonly model: string; readonly maxTokens?: number } {
  const requestHeader = typeof agent.session.requestHeader === 'function'
    ? agent.session.requestHeader()
    : undefined
  const config = requestHeader?.config
  if (typeof config?.provider === 'string' && config.provider.trim() !== ''
    && typeof config.model === 'string' && config.model.trim() !== '') {
    return {
      provider: config.provider.trim(),
      model: config.model.trim(),
      ...(agent.options.maxTokens === undefined ? {} : { maxTokens: agent.options.maxTokens }),
    }
  }
  return {
    provider: configuredModelProvider(agent.options.provider),
    model: configuredModelId(agent.options.model),
    ...(agent.options.maxTokens === undefined ? {} : { maxTokens: agent.options.maxTokens }),
  }
}

function configuredModelId(model: string | undefined): string {
  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error('Yuqi team start requires a configured controller model')
  }
  return model.trim()
}

function completeTaskContract(task: z.output<typeof startTaskSchema>, settings: ReturnType<YuqiTeamOrchestratorService['teamDefaults']>) {
  const {
    model,
    modelId,
    modelTier,
    scope = [task.goal],
    nonGoals = ['Do not make changes unrelated to the assigned task goal.'],
    acceptanceCriteria = [`Complete the task goal and report every repository-relative file changed: ${task.goal}`],
    ...contract
  } = task
  const authorityMode = task.authorityMode ?? settings.defaultAuthorityMode ?? 'write-authorized'
  const modelRequest = model !== undefined
    ? { kind: 'exact' as const, model: { modelProvider: model.providerId, modelId: model.modelId } }
    : modelId !== undefined
      ? { kind: 'legacy' as const, modelId }
      : modelTier !== undefined
        ? { kind: 'tier' as const, tier: modelTier }
        : { kind: 'default' as const }
  return {
    ...contract,
    scope,
    nonGoals,
    acceptanceCriteria,
    authorityMode,
    modelRequest,
    inputDigest: digestTaskContract({ ...task, scope, nonGoals, acceptanceCriteria, authorityMode }),
    baselineRef: HOST_PENDING_BASELINE_REF,
  }
}

/** Stable provenance for the exact model-visible task contract. */
function digestTaskContract(task: z.output<typeof startTaskSchema>): string {
  const canonical = JSON.stringify({
    taskId: String(task.taskId),
    revision: task.revision,
    goal: task.goal,
    scope: task.scope,
    nonGoals: task.nonGoals,
    dependencies: task.dependencies.map(String),
    fileScope: task.fileScope,
    modelRole: task.modelRole,
    model: task.model,
    modelId: task.modelId,
    modelTier: task.modelTier,
    acceptanceCriteria: task.acceptanceCriteria,
    authorityMode: task.authorityMode,
    verificationChecks: task.verificationChecks,
    maxAttempts: task.maxAttempts,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function configuredModelProvider(provider: string | undefined): string {
  if (typeof provider !== 'string' || provider.trim() === '') {
    throw new Error('Yuqi team start requires a configured controller provider')
  }
  return provider.trim()
}
