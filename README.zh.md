<div align="center">

# Yuqi Team Orchestrator

**面向 DeepSeek Harness 的多代理编排插件** —— 一个主控，管好一队子代理。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](package.json)
[![Version](https://img.shields.io/badge/version-0.0.1-orange.svg)](package.json)

[English](README.md) · [中文](README.zh.md)

</div>

---

## 项目简介

Yuqi Team Orchestrator `0.0.1` 是独立的 DeepSeek Harness **Developer Preview** 插件。主控把用户目标转换成可持久化任务图，派发直属子代理，保留状态与证据，处理日常决定，并在主控对话交付最终结果——不需要逐个进入子代理会话处理确认。

## 核心能力

- **任务编排** —— 单 Team 最多 100 个任务；并发上限 1–100；依赖图 + `fileScope` 冲突检测调度；任务在真正派发时才创建子会话。
- **模型路由** —— 跟随主控、固定精确路由，或按 `quick`/`standard`/`critical` 等级的实验性自动路由；Provider 范围默认 `controller-only`，跨 Provider 需用户 allowlist。
- **Review** —— `off` / `manual` / `quality-gate`（默认 `manual`）；自动返工默认 2 轮、最多 3 轮。
- **验证证据** —— Host 结构化检查（build / test / interface / screenshot）形成 `passed` / `failed` / `inconclusive`；子代理自报不能替代证据。
- **控制与恢复** —— 暂停、继续、取消、重试、换模、人工接管、重启对账；事件流是唯一事实源，旧 attempt 与证据全部保留；controller-less 恢复 fail-closed。
- **Team UI** —— 主控/子会话导航、状态与证据展示、设置、决定处理、可逆归档；支持中英文。
- **项目知识** —— `.yuqi-team/index.json` 可选项目索引，记录进度、决策、踩坑和约定。

## 快速开始

需要 Node.js 24、pnpm 和兼容的 DeepSeek Harness 构建。

```sh
pnpm install
pnpm run build
dsh plugin --profile <profile> add <当前仓库绝对路径>
pnpm run preset:install -- --dsh-home <你的 DSH_HOME>
```

重启 Harness Host → 新建会话 → 在 preset 选择器中选择 **yuqi团队** → 描述最终目标并要求 Team 执行。

> 每个存储目录只允许一个 Host 进程；测试与生产使用不同存储目录。

## 文档

| 文档 | 说明 |
|---|---|
| [使用教程](docs/USER_GUIDE.zh-CN.md) | 完整教程——安装、配置、运行、恢复全流程 |
| [User Guide](docs/USER_GUIDE.md) | English tutorial |
| [功能实践情况](docs/FEATURES.zh-CN.md) | 0.0.1 已实现功能与后续路线 |
| [Feature Status](docs/FEATURES.md) | English feature status |
| [项目介绍](docs/PROJECT_OVERVIEW.zh-CN.md) | 产品介绍与架构说明 |

## 开发验证

```sh
pnpm run typecheck    # 类型检查
pnpm test             # 全部测试
pnpm run build        # 构建产物
pnpm run check        # 汇总发布门禁
```

架构边界：

```text
host/adapters → application → domain
client → 只读 Projection 与命令
```

`domain` 不依赖 Harness、Cordis、Node I/O、Git、网络或 UI；只有 `host/harness` 接入 Harness 公共 API。

## 当前边界

本地单用户 Developer Preview，不包含：预算硬门禁与货币结算、多人协作/云同步、自动 Git 合并/push/部署、对所有 Provider/凭据/网络组合的完整 E2E 保证。

## 许可证

[MIT](LICENSE)
