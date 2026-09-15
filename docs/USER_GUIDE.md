# Yuqi Team Orchestrator User Guide

For first-time users of `0.0.1` (Developer Preview). You state your goal in the controller conversation; child Agents execute delegated work, and progress, blockers, review outcomes, and final results return to the controller — no need to enter child sessions for routine confirmations.

## 1. Install

Requires **Node.js 24**, **pnpm**, and **DeepSeek Harness `>=0.1.1-rc.2 <0.2.0`**.

The sidecar storage contract is verified against the official `0.1.2-rc.1` install; full official-release acceptance (`verifiedOfficialRelease`) remains `null`.

### From source

```sh
pnpm install
pnpm run build
dsh plugin --profile <profile> add <absolute-repository-path>
pnpm run preset:install -- --dsh-home <your DSH_HOME>
```

Restart the Harness Host. Rebuild and restart after source changes.

### From a tarball or registry

```sh
npm pack
dsh plugin --profile <profile> add ./yuqi-team-orchestrator-0.0.1.tgz
# After publication: dsh plugin --profile <profile> add yuqi-team-orchestrator@0.0.1
pnpm --dir "<your DSH_HOME>/profiles/<profile>" exec yuqi-team-install-preset --dsh-home "<your DSH_HOME>"
```

### Pre-install check (optional)

Run the sidecar preflight against the official installation root to verify Host storage compatibility:

```sh
node scripts/check-host-compatibility.mjs --sidecar "<official-install-root>"
```

> **Note**: only one Host process per storage directory. Test and production must use separate directories.

## 2. Start a Team

1. Create a blank session.
2. Select **yuqi团队** in the preset picker.
3. Describe the final objective and explicitly request Team or parallel child-Agent execution.
4. If "confirm graph before start" is enabled, inspect tasks, dependencies, models, and permissions in the Team panel before starting.
5. Follow progress and results in the controller conversation or Team panel.

An idle ordinary conversation can be converted via **Turn into a Team task** in its header — the original conversation stays unchanged.

## 3. Team settings

Open the lower-left Team entry and configure **Team defaults**:

- **Settings scope**: Global → Project → Session; more specific overrides win.
- **Max concurrency**: 1–100, default 100 (a ceiling and fill target, not an actual-parallelism guarantee).
- **Default child preset**: an installed non-Yuqi Harness preset.
- **Model routing**: inherit controller, fixed exact route, or experimental automatic routing by `quick`/`standard`/`critical` tiers. Provider scope defaults to `controller-only`; cross-Provider requires an explicit allowlist.
- **Review policy**: `off` / `manual` / `quality-gate`, default `manual`; automatic rework defaults to 2 rounds, capped at 3.
- **Confirm graph before start**: new Teams pause for approval first.
- **Default authority**: Read Only / Workspace Write / Full access.
- **Workspace**: current project by default; Git worktree isolation optional, with a configurable parent directory.

Settings apply only to Teams started afterwards; they do not hot-update existing Teams.

## 4. During execution

### Scheduling

- The controller decomposes the goal into a task graph and dispatches by dependency and `fileScope` (planned change areas); conflicting scopes do not write concurrently.
- Child sessions are created only when a task actually dispatches.
- Running tasks accept follow-up messages; changes to completed tasks go through `yuqi_team_revise`, which creates a linked new task while preserving the old result.

### File scope

`fileScope` is a planning contract for conflict prediction, file leases, recovery boundaries, and UI display — not a write sandbox. A child may touch related files and must report the actual changes.

### Review

- `off`: no independent reviewer.
- `manual` (default): runs only when the controller requests it.
- `quality-gate`: runs independent review at plan, handoff, repeated-failure, and completion checkpoints, possibly triggering bounded rework.

Review findings and decisions return to the controller.

### Project memory

`.yuqi-team/index.json` is an optional lightweight project index: overall progress, architecture decisions, pitfalls, conventions, and document links. The controller reads/writes it via `yuqi_team_knowledge`; the panel supports refresh, per-item delete, and category clear. **Never store credentials or secrets in it.**

## 5. Control and recovery

- **Pause**: stop new dispatch, let in-flight work settle.
- **Resume**: restart scheduling from paused.
- **Cancel**: terminate the whole Team.
- **Retry**: create a new attempt for failed/blocked tasks; old records are preserved.
- **Manual takeover**: pause the Team, confirm takeover, edit, then return to the controller.
- **Needs recovery**: the panel explains which task outcome is uncertain; use **Recover and continue** to recheck facts and proceed.

## 6. Verification evidence

When a task declares Host-supported checks (pnpm build/typecheck, Vitest JSON, etc.), structured evidence yields `passed` / `failed` / `inconclusive`. A child Agent's prose claim cannot replace evidence, and unavailable evidence is never converted into success.

## 7. Archive and uninstall

- The management center archives/restores Team entries (reversible hiding; session history is not deleted).
- Running Teams cannot be archived; archiving is not cancellation.

To uninstall, remove the preset first, then the plugin:

```sh
pnpm run preset:install -- --remove --dsh-home <your DSH_HOME>
dsh plugin --profile <profile> remove yuqi-team-orchestrator
```

## 8. Current boundaries

`0.0.1` is a local single-user Developer Preview. Not included: hard budget gates or monetary accounting, multi-user collaboration/cloud sync, automatic Git merge/push/deploy, and a complete E2E guarantee across every Provider/credential/network combination.

---

[中文](USER_GUIDE.zh-CN.md) · [Feature status](FEATURES.md) · [Project overview](PROJECT_OVERVIEW.zh-CN.md)
