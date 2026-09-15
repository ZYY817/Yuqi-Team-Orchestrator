<div align="center">

# Yuqi Team Orchestrator

**Multi-agent orchestration plugin for DeepSeek Harness** — one controller, a managed team of child agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](package.json)
[![Version](https://img.shields.io/badge/version-0.0.1-orange.svg)](package.json)

[English](README.md) · [中文](README.zh.md)

</div>

---

## Overview

Yuqi Team Orchestrator `0.0.1` is an independent DeepSeek Harness **Developer Preview** plugin. A controller turns one user objective into a durable task graph, dispatches direct child Agents, preserves state and evidence, handles routine decisions, and reports the final result in the controller conversation — no need to enter child sessions for routine confirmations.

## Features

- **Orchestration** — up to 100 tasks per Team; concurrency ceiling 1–100; dependency graph + `fileScope` conflict-aware scheduling; child sessions created only at dispatch.
- **Model routing** — inherit controller, fixed exact route, or experimental automatic routing by `quick`/`standard`/`critical` tiers. Provider scope defaults to `controller-only`; cross-Provider requires a user allowlist.
- **Review** — `off` / `manual` / `quality-gate` (default `manual`); automatic rework defaults to 2 rounds, capped at 3.
- **Verification evidence** — Host structured checks (build / test / interface / screenshot) yield `passed` / `failed` / `inconclusive`; a child's prose claim cannot replace evidence.
- **Control & recovery** — pause, resume, cancel, retry, model switch, manual takeover, restart reconciliation; the event stream is authoritative and old attempts/evidence are preserved; controller-less recovery is fail-closed.
- **Team UI** — controller/child navigation, status and evidence display, settings, decision handling, reversible archive; Chinese & English.
- **Project knowledge** — optional `.yuqi-team/index.json` index for progress, decisions, pitfalls, and conventions.

## Quick start

Requires Node.js 24, pnpm, and a compatible DeepSeek Harness build.

```sh
pnpm install
pnpm run build
dsh plugin --profile <profile> add <absolute-path-to-this-repository>
pnpm run preset:install -- --dsh-home <your DSH_HOME>
```

Restart the Harness Host → create a blank session → select **yuqi团队** in the preset picker → describe the objective and request Team execution.

> Only one Host process per storage directory; use separate directories for test and production.

## Documentation

| Document | Description |
|---|---|
| [User Guide](docs/USER_GUIDE.md) | Complete tutorial — install, configure, run, and recover Teams |
| [使用教程](docs/USER_GUIDE.zh-CN.md) | 中文版完整教程 |
| [Feature Status](docs/FEATURES.md) | What 0.0.1 implements and what is planned next |
| [功能实践情况](docs/FEATURES.zh-CN.md) | 中文功能现状与路线图 |
| [Project Overview](docs/PROJECT_OVERVIEW.zh-CN.md) | 项目介绍与架构说明（中文） |

## Development

```sh
pnpm run typecheck    # Type checks
pnpm test             # Full test suite
pnpm run build        # Build artifacts
pnpm run check        # Aggregate release gate
```

Architecture boundary:

```text
host/adapters → application → domain
client → read-only Projection and commands
```

`domain` does not depend on Harness, Cordis, Node I/O, Git, network, or UI; only `host/harness` integrates Harness public APIs.

## Current boundaries

Local single-user Developer Preview. Not included: hard budget gates or monetary accounting, multi-user collaboration/cloud sync, automatic Git merge/push/deploy, and a complete E2E guarantee across every Provider/credential/network combination.

## License

[MIT](LICENSE)
