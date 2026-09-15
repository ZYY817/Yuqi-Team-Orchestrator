# Yuqi Team Orchestrator · 历史 UI 定位地图 (PROJECT_MAP)

> 本文件为 Client/UI 专项定位记录，行号可能随代码演进过期；以当前源码为准。

> **核心价值**：提供精准代码位置、样式分层、数据流向与单测映射，杜绝全盘盲目翻找，改动直达目标文件与行号，实现秒级定位与靶向测试。

---

## 1. 核心视图与 UI 组件精准定位表

| 视图/功能模块 | 核心 React 组件 | 所在文件路径 | 关键行号范围 | 对应样式定义 | 核心职责与说明 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Team 管理中心外壳** | `TeamCenterDialog` | [src/client/TeamCenter.tsx](./src/client/TeamCenter.tsx) | `L400-L550` | `center-alignment-styles.ts` (`.yuqi-management`) | 弹窗容器、全屏遮罩、顶部 Header、中英切换、3个导航 Tab 切换 |
| **导航 Tab 栏** | `TeamCenterHeader` | [src/client/TeamCenter.tsx](./src/client/TeamCenter.tsx) | `L280-L360` | `center-alignment-styles.ts` (`.yuqi-management-tabs`) | Tab 1: 团队默认设置 / Tab 2: 团队任务 / Tab 3: 待处理事项 |
| **编辑层级分段选择器** | `ScopedTeamSettingsButton` | [src/client/TeamSettingsButton.tsx](./src/client/TeamSettingsButton.tsx) | `L150-L205` | `center-alignment-styles.ts` (`.yuqi-level-segmented`) | `[ 全局默认 ]`、`[ 当前项目 ]`、`[ 当前会话 ]` 三项并列分段框与同步 Select |
| **作用域状态与继承卡片** | `ScopedTeamSettingsButton` | [src/client/TeamSettingsButton.tsx](./src/client/TeamSettingsButton.tsx) | `L168-L185` | `center-alignment-styles.ts` (`.yuqi-settings-scope-status`) | 显示正在使用继承 / 已保存覆盖、会话名称、高级来源分析 (`sources`) |
| **设置项表单卡片组** | `TeamSettingsForm` | [src/client/TeamSettingsButton.tsx](./src/client/TeamSettingsButton.tsx) | `L260-L450` | `settings-alignment-styles.ts` (`.yuqi-settings-aligned`) | 基本执行（并发上限/模式预设）、审查纠错策略、模型路由策略等卡片 |
| **底部吸附操作栏** | `TeamSettingsForm` (footer) | [src/client/TeamSettingsButton.tsx](./src/client/TeamSettingsButton.tsx) | `L440-L480` | `center-alignment-styles.ts` (`.yuqi-settings-footer`) | 物理贴底 `sticky bottom: 0`、遮光不透色、保存/放弃/清除默认值按钮 |
| **团队任务看板列表** | `TeamCenterTeamsTab` | [src/client/TeamCenter.tsx](./src/client/TeamCenter.tsx) | `L560-L720` | `center-alignment-styles.ts` (`.yuqi-team-card-grid`) | 历史任务与运行中 Team 卡片、状态标签、任务搜索与过滤工具栏 |
| **待处理事项列表** | `GlobalTeamAttention` | [src/client/GlobalTeamAttention.tsx](./src/client/GlobalTeamAttention.tsx) | `L100-L280` | `center-alignment-styles.ts` (`#yuqi-center-attention`) | 需人工确认/权限审批/审查拒绝待办、计数徽标联动 |
| **聊天输入框上方团队栏 / Dock** | `YuqiTeamDock`、`TeamDockBar` | [src/client/YuqiTeamDock.tsx](./src/client/YuqiTeamDock.tsx) | `L1-L200` | `styles.ts` (`.yuqi-team-dock-summary`) | 输入框上方唯一团队栏；计划确认时仅提供本次启动，真实投影切换前显示启动中；查看任务打开现有详情面板 |

---

## 2. 样式架构分层地图 (Style Architecture)

所有客户端样式均作为 CSS 文本集中在 `src/client/` 下的独立模块中：

| 样式文件 | 作用作用域 | 核心设计变量与类名 | 职责与规范 |
| :--- | :--- | :--- | :--- |
| [center-alignment-styles.ts](./src/client/center-alignment-styles.ts) | `.yuqi-management` (管理中心整体) | `--yuqi-canvas: #0F1117`<br>`--yuqi-surface: #181A20`<br>`--yuqi-line: #2B2D38`<br>`--yuqi-brand: #3B82F6` | **大厂 Dark Slate 体系**、模态框全宽布局、Header/Tabs、`.yuqi-level-segmented`、`.yuqi-settings-footer` 实体吸底 |
| [settings-alignment-styles.ts](./src/client/settings-alignment-styles.ts) | `.yuqi-settings-aligned` (表单卡片细节) | `.yuqi-settings-group`<br>`.yuqi-settings-field`<br>`.yuqi-review-mode-choices` | 表单字段两端对齐、开关 Switch、审查模式单选卡片、模型路由分组 |
| [management-styles.ts](./src/client/management-styles.ts) | 基础管理层级降级样式 | `.yuqi-management-layer`<br>`.yuqi-settings-state` | 兜底布局、Loading 骨架屏与异常状态展示面板 |
| [styles.ts](./src/client/styles.ts) | 全局 Dock / Panel / 任务行 | `.yuqi-dock`<br>`.yuqi-task-row` | 任务列表树、执行日志流水、侧边交互按钮 |

---

## 3. 数据流与作用域继承链路 (Scope & IPC Architecture)

```
[ 用户在 UI 修改 ]
       │
       ▼
[ TeamSettingsForm 本地 state (dirty 状态) ]
       │
       ├─► 触发 [ 保存 ] 按钮激活 (保存/放弃/清除)
       │
       ▼
[ bindTeamSettingsScope.save(overrides) ]
       │
       ▼
[ HostClientApi.call(context, 'write', { level, overrides, sessionId }) ]
       │ (JSON-RPC 跨进程传输)
       ▼
[ Host 端: TeamSettingsService ] 
       │
       ├─► 写入 storage (逐级持久化)
       └─► 广播变更事件 (team-settings-events)
```

- **三级作用域继承机制**：
  - `global`（全局默认）：保存在用户根配置目录，所有新建 Team 默认遵循；
  - `project`（项目独立）：针对当前工作区覆盖，需有绑定工作区；
  - `session`（会话独立）：针对当前会话覆盖，需有 `sessionId`。
- **状态保护守卫**：
  - `dirty = true` 时，禁止切换 `level`、禁止直接移除本级，强制提示保存或放弃修改；
  - `!sessionId` 时，`project` 和 `session` 级别自动置灰禁用。

---

## 4. 靶向测试精准对照表 (Targeted Testing Index)

> **核心提速原则**：日常单点改动只跑**单靶向测试**（耗时从 10s 骤降到 0.5s~1.5s），全量 44 套件仅在提交前终审执行。

| 修改的代码文件 | 关联业务领域 | 靶向单测命令 (秒级反馈 ⚡) |
| :--- | :--- | :--- |
| `src/client/TeamSettingsButton.tsx` (层级/作用域) | 编辑层级、范围切换、继承显示 | `npx vitest run tests/client/team-settings-scope.spec.tsx` |
| `src/client/TeamSettingsButton.tsx` (表单/路由) | 并发上限、审查模式、模型选择 | `npx vitest run tests/client/team-settings-button.spec.tsx` |
| `src/client/TeamCenter.tsx` | Tab 切换、弹窗外壳、任务卡片 | `npx vitest run tests/client/team-center.spec.tsx` |
| `src/client/GlobalTeamAttention.tsx` | 待处理事项、审批操作、提醒偏好 | `npx vitest run tests/client/global-team-attention.spec.tsx` |
| `src/client/YuqiTeamDock.tsx` | 侧边栏常驻图标、徽标计数 | `npx vitest run tests/client/yuqi-team-dock.spec.tsx` |
| `src/client/index.ts` / 整体入口 | 插件初始化、Host 注入与生命周期 | `npx vitest run tests/client/client-entry.spec.ts` |

---

## 5. 极速验证工作流手册 (Fast Verification Workflow)

1. **改动后 1 秒精准测试**：
   ```bash
   npx vitest run tests/client/team-settings-scope.spec.tsx
   ```
2. **TypeScript 快速零漏检**：
   ```bash
   npm run typecheck
   ```
3. **打包生产包**：
   ```bash
   npm run build
   ```
4. **实时网页截图核验**：
   ```bash
   node <local-screenshot-script>   # 本地截图工具，路径因机器而异
   ```
