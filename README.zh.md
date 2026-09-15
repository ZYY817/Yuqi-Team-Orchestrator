# 🎛️ Yuqi Team Orchestrator

> 面向 DeepSeek Harness 的多代理编排插件 —— 一个主控，管好一队子代理。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](package.json)
[![Version](https://img.shields.io/badge/version-0.0.1-orange.svg)](package.json)

[English](README.md) · [📖 完整使用教程](docs/USER_GUIDE.zh-CN.md) · [🗺️ 功能实践情况](docs/FEATURES.zh-CN.md) · [📋 项目介绍](docs/PROJECT_OVERVIEW.zh-CN.md)

---

## 🤔 解决什么问题

Yuqi Team Orchestrator `0.0.1` 是独立的 DeepSeek Harness **Developer Preview** 插件。它解决的不是"怎么多开几个 Agent"，而是：

- 🔍 任务分出去后，为什么中断、跑偏、无结果却没人知道
- ✅ 主控如何知道子代理的结果是否满足验收条件
- 🧩 复杂任务怎样拆分、传递上下文和依赖
- 💰 哪些任务该用强模型，哪些可用低成本模型
- 🛡️ 失败后如何有限重试、升级人工，而不是无限循环烧钱

主控把用户目标转换成可持久化任务图，派发直属子代理，保留状态与证据，处理日常决定，并在主控对话交付最终结果——**不需要逐个进入子代理会话处理确认**。

## ✨ 0.0.1 当前能力

| 能力 | 说明 |
|---|---|
| 📋 **任务编排** | 单 Team 最多 100 个任务；并发上限 1–100；依赖图 + `fileScope` 冲突检测调度；任务在真正派发时才创建子会话 |
| 🧠 **模型路由** | 跟随主控、固定精确路由，或按 `quick`/`standard`/`critical` 等级的实验性自动路由；Provider 范围默认 `controller-only` |
| 🔎 **Review** | `off` / `manual` / `quality-gate`（默认 `manual`）；自动返工默认 2 轮、最多 3 轮 |
| 📊 **验证证据** | Host 结构化检查（build / test / interface / screenshot）形成 `passed` / `failed` / `inconclusive`；子代理自报不能替代证据 |
| 🎮 **控制与恢复** | 暂停、继续、取消、重试、换模、人工接管、重启对账；事件流是唯一事实源，旧 attempt 与证据全部保留 |
| 🖥️ **Team UI** | 主控/子会话导航、状态与证据展示、设置、决定处理、可逆归档；支持中英文 |
| 📚 **项目知识** | `.yuqi-team/index.json` 可选项目索引，记录进度、决策、踩坑和约定 |

## 🚀 安装与使用

需要 Node.js 24、pnpm 和兼容的 DeepSeek Harness 构建。

```sh
pnpm install
pnpm run build
dsh plugin --profile <profile> add <当前仓库绝对路径>
pnpm run preset:install -- --dsh-home <你的 DSH_HOME>
```

重启 Harness Host → 新建会话 → 在 preset 选择器中选择 **yuqi团队** → 描述最终目标并要求 Team 执行。

> ⚠️ 每个存储目录只允许一个 Host 进程；测试与生产使用不同存储目录。

详细步骤见[📖 使用教程](docs/USER_GUIDE.zh-CN.md)。

## 🔧 开发验证

```sh
pnpm run typecheck    # 类型检查
pnpm test             # 全部测试
pnpm run build        # 构建产物
pnpm run check        # 汇总发布门禁
```

## 🏗️ 架构边界

```text
host/adapters → application → domain
client → 只读 Projection 与命令
```

`domain` 不依赖 Harness、Cordis、Node I/O、Git、网络或 UI；只有 `host/harness` 接入 Harness 公共 API。

## ⚠️ 当前边界

本地单用户 Developer Preview，不包含：

- 💵 预算硬门禁与货币结算
- 👥 多人协作 / 云同步 / 多机器调度
- 🚀 自动 Git 合并 / push / 部署
- 🌐 对所有 Provider / 凭据 / 网络组合的完整 E2E 保证

## 📄 许可证

MIT
