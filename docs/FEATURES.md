# Feature Status

> Version: `0.0.1` (Developer Preview)
> This document describes the problems the product solves, what is implemented today, and what is planned next.

## 1. What This Product Is For

Yuqi Team Orchestrator does not solve "how to spawn more agents" — it addresses what usually goes unhandled in multi-agent work:

- Why delegated tasks stall, drift, or return nothing without anyone noticing
- How the controller knows whether a sub-agent's result actually meets acceptance criteria
- How complex goals are decomposed with context and dependencies passed along
- Which tasks deserve a strong model and which can use a cheaper one
- How code, docs, and tests are checked before delivery
- How failures retry within bounds and escalate to humans instead of looping forever and burning budget

**Design choice**: a persistent task graph owned by one controller with multiple direct child agents. The user states the goal once in the controller conversation; decomposition, dependency handling, scheduling, routine exceptions, review, and the final summary are all handled by the controller. Reliability comes before apparent parallelism — every state change lands in a versioned event stream, unknown outcomes fail closed, and guessing is never substituted for facts.

## 2. Implemented in 0.0.1

### Orchestration & Scheduling

- Up to **100** tasks per Team; concurrency cap **1–100**, default **100**
- Dependency-graph scheduling: only ready tasks dispatch; dependencies, permission compatibility, and `fileScope` conflicts all affect actual parallelism
- `fileScope` planning contract: declares intended change areas for conflict prediction, file leases, recovery boundaries, and UI display
- Child sessions are created only when a task actually dispatches; pending planned tasks hold no resources

### Model Routing

- Three policies: follow controller, fixed exact route, experimental automatic routing (ordered `quick`/`standard`/`critical` candidates)
- Provider scope defaults to `controller-only`; cross-provider routing requires an explicit user allowlist
- When candidates are exhausted after call failures, routing stops with an explicit error instead of blindly falling back

### Verification & Review

- Review policies: `off` / `manual` / `quality-gate`, default `manual`
- Under `quality-gate`, every completion candidate must pass independent review; automatic rework defaults to 2 rounds, capped at 3
- Structured evidence verdicts: build / test / interface / screenshot checks produce `passed` / `failed` / `inconclusive`; a sub-agent's self-report cannot substitute for evidence

### Permissions, Workspace & Recovery

- Permission modes: Read Only / Workspace Write / Full access; Direct workspace by default, Git worktree isolation optional
- Pause, resume, cancel, task retry, model switching, and restart reconciliation — old attempts and evidence are all preserved
- Controller-less recovery only closes out fail-closed or pauses uncertain work; a runner must restore the exact controller identity before continuing

### User Interface

- Team panel: task status, dependencies, model, permissions, tokens, duration, evidence, actual changed files, session navigation, reversible archive
- Optional pre-start task-graph confirmation; team settings support Chinese/English, concurrency, model policy, review policy, and default permissions
- Attention/pending-items surface centralizes whatever needs user or controller action

### Lightweight Project Knowledge

- `.yuqi-team/index.json` project index: records overall progress, architecture decisions, pitfalls, and conventions with stable-ID updates and link references; Markdown serves as the display view

## 3. Planned Updates

The following directions are under consideration — intentions, not version commitments:

- **Project memory, planned holistically**: grow the lightweight JSON index into a fuller project-memory system so long-term context accumulates and stays retrievable across Teams and sessions
- **Token savings**: reduce repeated context passing and unnecessary full replays across scheduling and reporting paths
- **Lower reasoning overhead**: lighten inference on simple scheduling and status-query paths, reserving strong-model effort for decisions that need it
- **Faster code location**: improve navigation across evidence, changed files, and sessions so users and controllers locate problem code sooner
- **Stronger verification**: extend the existing evidence verdicts with more deterministic delivery checks
- **Harness ecosystem alignment**: directions that depend on Host capabilities, such as a child→controller message channel, will be adopted as Harness evolves

## 4. Explicitly Out of Scope for 0.0.1

- Hard budget gates, monetary cost accounting, or model price/quality scoring
- Multi-user collaboration, cloud sync, or cross-machine scheduling
- Automatic Git merge, push, deployment, or production release
- A complete E2E guarantee across every real Provider, credential, network, and Host combination

---

[中文](FEATURES.zh-CN.md) · [User Guide](USER_GUIDE.md) · [Project Overview](PROJECT_OVERVIEW.zh-CN.md)
