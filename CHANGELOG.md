# Changelog

All notable changes to this project are documented here.

## 0.0.1

- Added durable controller-owned Teams, dependency-aware scheduling, continuable child Agents, event replay, evidence-preserving attempts, and controller-centered reporting.
- Set the user concurrency ceiling to 1–100 with a default of 100. The scheduler tries to fill the ceiling with ready work; dependencies, authority, planned scopes, Host capacity, and Provider availability can reduce actual concurrency.
- Made `planned-scope-parallel` the default direct-write strategy and defined `fileScope` as a planning/recovery contract rather than a write sandbox. `strict-writer-serial` remains a technical integration option and is not currently a user setting.
- Added inherit, exact fixed, and experimental ordered-tier model routing. Provider scope defaults to `controller-only`; cross-Provider routes require a user allowlist. Catalog metadata does not prove credential validity, and routing does not score price or quality.
- Added `off`, `manual`, and `quality-gate` review policies. `manual` is the default; automatic review rework defaults to 2 rounds and is capped at 3, with decisions handled through the controller.
- Added pause, resume, cancel, retry, model switching, authority selection, and restart reconciliation. Controller-less recovery remains fail-closed and cannot resume a runner without the exact controller identity.
- Added Team summary/detail UI, controller/child navigation, settings, decision handling, language switching, and reversible archive/restore.
- Added Direct current-project execution by default with opt-in Git worktree isolation.
- Added source, tarball/profile, and preset install/uninstall workflows for version `0.0.1`.
- Clarified that budget hard gates, long-term project memory, multi-user collaboration, cloud sync, and multi-machine orchestration are not `0.0.1` capabilities.

Final release-gate results and complete real-Provider E2E status are intentionally not recorded here pending mainline validation.
