# Yuqi Team Orchestrator：项目介绍

Yuqi Team Orchestrator `0.0.1` 是面向 DeepSeek Harness 的独立多代理编排插件。它把复杂目标组织成"一个主控 + 多个直属子代理"的持久任务图——用户只在主控对话说明目标，拆分、依赖、调度、日常异常、review 和最终汇总由主控统一处理。

```text
用户目标 → 主控建立任务图 → Host 并发派发 → 结果/证据/review 回到主控 → 主控交付
```

> 当前为 Developer Preview，尚未全部真实验收通过。功能现状与后续方向见[功能实践情况](FEATURES.zh-CN.md)。

## 核心能力

| 能力 | 说明 |
|---|---|
| **任务编排** | 单 Team 最多 100 个任务；并发上限 1–100（默认 100）；依赖图调度，任务在真正派发时才创建子会话 |
| **模型路由** | 跟随主控、固定精确路由，或按 quick/standard/critical 等级的实验性自动路由；跨 Provider 需用户 allowlist |
| **验收 Review** | `off`/`manual`/`quality-gate` 三种策略；自动返工默认 2 轮、最多 3 轮；结构化证据裁判，子代理自报不能替代证据 |
| **权限与恢复** | Read Only / Workspace Write / Full access；暂停、继续、取消、重试、换模、重启对账全部保留旧 attempt 与证据 |
| **Team UI** | 状态、依赖、模型、权限、Token、耗时、证据、变更文件、会话导航和可逆归档 |
| **项目知识** | `.yuqi-team/index.json` 记录进度、决策、踩坑和约定，供跨任务共享 |

## 快速开始

需要 Node.js 24、pnpm 和 **DeepSeek Harness `>=0.1.1-rc.2 <0.2.0`**（sidecar 存储契约已对官方 `0.1.2-rc.1` 验证通过）。

```sh
pnpm install
pnpm run build
dsh plugin --profile <profile> add <仓库绝对路径>
pnpm run preset:install -- --dsh-home <你的 DSH_HOME>
```

重启 Harness Host → 新建会话 → 选择 **yuqi团队** preset → 描述目标并要求 Team 执行。

> 每个存储目录只允许一个 Host 进程；测试与生产使用不同存储目录。完整说明见[使用教程](USER_GUIDE.zh-CN.md)。

## 当前边界

本地单用户 Developer Preview，不包含：预算硬门禁、多人协作、云同步、自动 Git 合并/部署、对所有 Provider/凭据/网络组合的完整 E2E 保证。

## 更多文档

- [中文使用教程](USER_GUIDE.zh-CN.md)
- [English User Guide](USER_GUIDE.md)
- [功能实践情况](FEATURES.zh-CN.md)（[English](FEATURES.md)）

## 许可证

MIT License。Yuqi Team Orchestrator 是独立第三方插件，不代表 DeepSeek Harness 官方项目。
