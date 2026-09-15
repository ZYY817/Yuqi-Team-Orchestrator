# Yuqi Team Orchestrator 使用教程

面向 `0.0.1`（Developer Preview）首次使用者。你在主控对话说明目标，子代理执行委派任务，进度、阻塞、review 结果和最终结果统一回到主控——不需要逐个进入子代理会话处理确认。

## 1. 安装

需要 Node.js 24、pnpm，以及兼容的 DeepSeek Harness 构建。

### 从源码安装

```sh
pnpm install
pnpm run build
dsh plugin --profile <profile> add <仓库绝对路径>
pnpm run preset:install -- --dsh-home <你的 DSH_HOME>
```

安装后重启 Harness Host；源码变化后重新构建并重启。

### 从 tarball 或 registry 安装

```sh
npm pack
dsh plugin --profile <profile> add ./yuqi-team-orchestrator-0.0.1.tgz
# 发布后：dsh plugin --profile <profile> add yuqi-team-orchestrator@0.0.1
pnpm --dir "<你的 DSH_HOME>/profiles/<profile>" exec yuqi-team-install-preset --dsh-home "<你的 DSH_HOME>"
```

### 安装前检查（可选）

对官方安装根目录运行 sidecar 预检，确认 Host 存储契约兼容：

```sh
node scripts/check-host-compatibility.mjs --sidecar "<official-install-root>"
```

> **注意**：每个存储目录只允许一个 Host 进程。测试与生产必须使用不同存储目录。

## 2. 创建 Team

1. 新建空白会话。
2. 在 preset 选择器中选择 **yuqi团队**。
3. 描述最终目标，并明确要求 Team 或并行子代理执行。
4. 若启用了"启动前确认任务图"，在 Team 面板检查任务、依赖、模型和权限后开始。
5. 在主控对话或 Team 面板查看进度与结果。

已有空闲普通对话可点击顶部 **转为团队任务** 在同一项目新建团队会话，原对话保留不变。

## 3. Team 设置

点击左下角团队入口打开管理中心，在 **团队默认设置** 中配置：

- **设置范围**：全局 → 项目 → 会话 逐级继承，更具体的覆盖优先。
- **并发保护上限**：1–100，默认 100（是上限和填满目标，不是实际并发保证）。
- **默认子代理 preset**：选择已安装的非 Yuqi Harness preset。
- **模型路由**：跟随主控、固定精确路由，或按 `quick`/`standard`/`critical` 等级启用实验性自动路由；Provider 范围默认 `controller-only`，跨 Provider 需用户明确 allowlist。
- **Review 策略**：`off` / `manual` / `quality-gate`，默认 `manual`；自动返工默认 2 轮、最多 3 轮。
- **启动前确认任务图**：开启后新 Team 先暂停等待批准。
- **默认权限**：Read Only / Workspace Write / Full access。
- **工作区**：默认当前项目；Git worktree 隔离可选，可指定隔离父目录。

设置仅影响之后启动的 Team，不热更新已有 Team。

## 4. 执行过程

### 任务调度

- 主控把目标拆成任务图，按依赖和 `fileScope`（计划变更区域）调度；范围冲突的任务不会同时写入。
- 任务在真正派发时才创建子会话。
- 运行中的任务可发送补充消息；已完成任务的修改通过 `yuqi_team_revise` 创建关联新任务，旧结果保留。

### 文件范围（fileScope）

`fileScope` 是计划契约：用于冲突预测、文件租约、恢复边界和 UI 展示，不是写入沙箱。子代理可联动必要文件并回报实际改动。

### Review

- `off`：不创建独立 reviewer。
- `manual`（默认）：主控明确请求时运行。
- `quality-gate`：在计划、交接、连续失败、完成等节点自动运行独立审查，可能触发有限返工。

Review 结果和决定都回到主控处理。

### 项目记忆

`.yuqi-team/index.json` 是可选的轻量项目索引：记录总体进度、架构决策、踩坑、约定和文档链接。主控通过 `yuqi_team_knowledge` 读写；面板中可刷新、删除单条或清空分类。**不要写入凭证或密钥。**

## 5. 控制与恢复

- **暂停**：停止新派发，等待在途工作收尾。
- **继续**：从暂停状态恢复调度。
- **取消**：终止整个 Team。
- **重试**：为失败/阻塞任务创建新 attempt，旧记录保留。
- **人工接管**：暂停整个 Team 后确认接管，修改完成后交还主控。
- **异常待恢复**：面板会说明哪个任务结果不确定；点击 **恢复并继续** 核对事实后继续。

## 6. 验证证据

任务声明 Host 支持的检查后（如 pnpm build/typecheck、Vitest JSON），结构化证据形成 `passed` / `failed` / `inconclusive`。子代理的文字自报不能替代证据，证据不可用不会被转换为成功。

## 7. 归档与卸载

- 管理中心可归档/恢复 Team 入口（可逆隐藏，不删除会话历史）。
- 运行中的 Team 不能归档；归档不等于取消。

卸载时先移除 preset，再移除插件：

```sh
pnpm run preset:install -- --remove --dsh-home <你的 DSH_HOME>
dsh plugin --profile <profile> remove yuqi-team-orchestrator
```

## 8. 当前边界

`0.0.1` 是本地单用户 Developer Preview，不包含：预算硬门禁与货币结算、多人协作/云同步、自动 Git 合并/push/部署、对所有 Provider/凭据/网络组合的完整 E2E 保证。

---

[English](USER_GUIDE.md) · [功能实践情况](FEATURES.zh-CN.md) · [项目介绍](PROJECT_OVERVIEW.zh-CN.md)
