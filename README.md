# 🎛️ Yuqi Team Orchestrator

> Multi-agent orchestration plugin for DeepSeek Harness — one controller, a managed team of child agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](package.json)
[![Version](https://img.shields.io/badge/version-0.0.1-orange.svg)](package.json)

[中文](README.zh.md) · [📖 User Guide](docs/USER_GUIDE.md) · [🗺️ Feature Status](docs/FEATURES.md) · [📋 Project Overview (中文)](docs/PROJECT_OVERVIEW.zh-CN.md)

---

## 🤔 What Problem Does It Solve

Yuqi Team Orchestrator `0.0.1` is an independent DeepSeek Harness **Developer Preview** plugin. It doesn't solve "how to spawn more agents" — it solves:

- 🔍 Why delegated tasks stall, drift, or return nothing without anyone noticing
- ✅ How the controller knows whether a child's result actually meets acceptance criteria
- 🧩 How complex goals are decomposed with context and dependencies passed along
- 💰 Which tasks deserve a strong model and which can use a cheaper one
- 🛡️ How failures retry within bounds and escalate to humans instead of looping forever

A controller turns one user objective into a durable task graph, dispatches direct child Agents, preserves state and evidence, handles routine decisions, and reports the final result in the controller conversation — **no need to enter child sessions for routine confirmations**.

## ✨ Available in 0.0.1

| Capability | Description |
|---|---|
| 📋 **Orchestration** | Up to 100 tasks per Team; concurrency 1–100; dependency graph + `fileScope` conflict-aware scheduling; child sessions created only at dispatch |
| 🧠 **Model Routing** | Inherit controller, fixed exact route, or experimental automatic routing by `quick`/`standard`/`critical` tiers; Provider scope defaults to `controller-only` |
| 🔎 **Review** | `off` / `manual` / `quality-gate` (default `manual`); automatic rework 2 rounds default, capped at 3 |
| 📊 **Verification** | Host structured checks (build / test / interface / screenshot) yield `passed` / `failed` / `inconclusive`; a child's prose claim cannot replace evidence |
| 🎮 **Control & Recovery** | Pause, resume, cancel, retry, model switch, manual takeover, restart reconciliation; event stream is authoritative, old attempts and evidence preserved |
| 🖥️ **Team UI** | Controller/child navigation, status and evidence display, settings, decision handling, reversible archive; Chinese & English |
| 📚 **Project Knowledge** | Optional `.yuqi-team/index.json` index for progress, decisions, pitfalls, and conventions |

## 🚀 Install and Use

Requires Node.js 24, pnpm, and a compatible DeepSeek Harness build.

```sh
pnpm install
pnpm run build
dsh plugin --profile <profile> add <absolute-path-to-this-repository>
pnpm run preset:install -- --dsh-home <your DSH_HOME>
```

Restart the Harness Host → create a blank session → select **yuqi团队** in the preset picker → describe the objective and request Team execution.

> ⚠️ Only one Host process per storage directory; use separate directories for test and production.

See the [📖 User Guide](docs/USER_GUIDE.md) for details.

## 🔧 Development Verification

```sh
pnpm run typecheck    # Type checks
pnpm test             # Full test suite
pnpm run build        # Build artifacts
pnpm run check        # Aggregate release gate
```

## 🏗️ Architecture Boundary

```text
host/adapters → application → domain
client → read-only Projection and commands
```

`domain` does not depend on Harness, Cordis, Node I/O, Git, network, or UI; only `host/harness` integrates Harness public APIs.

## ⚠️ Current Boundaries

Local single-user Developer Preview. Not included:

- 💵 Hard budget gates or monetary accounting
- 👥 Multi-user collaboration / cloud sync / multi-machine scheduling
- 🚀 Automatic Git merge / push / deploy
- 🌐 Complete E2E guarantee across every Provider / credential / network combination

## 📄 License

MIT
