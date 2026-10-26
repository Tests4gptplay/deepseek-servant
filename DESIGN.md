# DeepSeek Servant 当前架构

对应版本：`0.1.0-alpha.39`，更新于 2026-10-26。本文描述当前代码；运行证据见[实现与验证记录](IMPLEMENTATION.md)和[alpha.39 验收](docs/acceptance-20261026.md)。早期方案保留在[历史架构](docs/history/architecture-20261024.md)，后续 GitHub 功能见[实验性设计](docs/DSS_MASTER_DESIGN_20261025.md)。

## 1. 结构与责任

Servant 是嵌入 DSH 的模块化单体：Host 持有服务、调度和运行所有权，Client 展示对话、任务、经验与设置，角色 Agent 做语义判断，DSH 执行模型、工具、Session 和 Jobs。

```text
Client / Foreground 用户意图
  → ServantApi / AssistantService
  → TaskService → TaskKernel → ServantStore / RecordJournal
  → RuntimeCoordinator → Scheduler / AgentSupervisor
  → 原生 Planner / Worker → DSH tools / jobs / Session
  → 成果评价 → records 封存 → Foreground 交付 → 临时状态清理
```

| 模块 | 当前入口 | 责任 |
| --- | --- | --- |
| 宿主装配 | `src/host.ts` | 装配服务，绑定 DSH 原生接口及插件生命周期 |
| 前台与对话 | `application/assistant-service.ts`、`conversation-store.ts` | 保存用户输入、按日原文、前台轮换与稳定交付 |
| 任务权威 | `application/task-service.ts`、`domain/task.ts` | 串行处理命令，合并任务、计划、结果、控制和动作 |
| 运行协调 | `runtime/coordinator.ts`、`scheduler.ts` | 兑现持久动作，协调依赖、席位、资源与恢复 |
| 执行所有权 | `runtime/agent-supervisor.ts`、`adapters/dsh/agents.ts` | 创建、恢复、观察和释放确切原生 Agent |
| 工作原文 | `application/record-journal.ts`、`task-records.ts`、`task-record-access.ts` | 独立记录需求、Memory、Note、Reply 和执行现场，按引用读取 |
| 封存与维护 | `application/task-archive-store.ts`、`retention-service.ts`、`storage-usage.ts` | 完整档案、精确临时清理、历史入口与容量统计 |
| 知识与技能 | `application/knowledge-service.ts`、`adapters/dsh/skills.ts` | 候选、版本、证据、原生加载与后续反馈 |
| 界面与查询 | `application/query-service.ts`、`src/client.tsx`、`src/client/` | 实际状态投影、历史阅读、日期筛选及设置 |

表中省略 `src/` 的路径均相对于 `src/`。模型不会直接修改内部存储；角色工具与 Client API 共用应用服务。

## 2. 三个运行角色

| 角色 | 当前职责 | 生命周期 |
| --- | --- | --- |
| Foreground | 理解实际用户消息，提交或修订 Task，转交用户回答，主动交付后台结果 | 每次完整用户交互后保存原文并轮换物理 Session |
| Planner | 全局理解、增量 Plan、Memory / Note、成果评价与最终接受 | 每个规划或评审动作按需运行；未完成动作可保存前沿后 handoff |
| Worker | 执行一个有界 Child，保存结果、证据、失败与下一前沿 | `continue` 同实例续作，`handoff` 换代，`complete/failed` 交 Planner 评价 |

执行任务走 Task → Planner → Worker；普通讨论保留为前台对话。当前构建加载 `foreground.md`、`planner.md`、`worker.md`。旧 Helper 记录仍可读，旧角色契约已归入历史文档。

用户来源绑定到当前原生回合实际消费的消息。中断续聊的隐藏输入指回原用户消息；稳定 `task_submit` 身份使恢复沿用同一 Task。`task_answer` 转交当前用户原文，解决对应等待；后台完成通知只提供交付事实。

## 3. 任务身份、版本与推进

- **Task id**：一个持续目标的稳定身份，保存工作区及创建时模型/preset 快照。
- **goalRevision / planRevision**：用户要求与正式计划版本；修订时保留有效成果，仅调整受影响 Child。
- **assignmentVersion**：Child 工作合同版本。正常换代及故障接续保留它，明确修改指派时递增。
- **executionId / generation**：本次实际执行与代际；Worker 报告绑定当前执行和指派，正常并行报告由 TaskService 合并。
- **commandId / resultId**：去重输入、动作与结果，持久回执支持重复读取。

每次命令先按 Task 串行处理，由 TaskKernel 计算新状态，ServantStore 保存可恢复提交及分离记录，随后 RuntimeCoordinator 兑现 PendingAction。真实模型、工具、Job 和用户事件触发后续工作。

`progress` 保存进度；有效 `continue/handoff` 工作段默认每累计 5 段触发 Planner 评审，计数跨代保留；`complete/failed` 立即进入评价。评审间隔由 Host `reviewEvery` 配置，默认 5。达到评审点的 handoff 先接受 Planner 决定，再派发后继。

## 4. Worker 席位与资源

Worker 席位默认 2，设置页可保存 1–32。持久配置立即影响后续调度，每个新 Planner 动作取得当前全局容量快照。调高后继续派发，调低后已有 Worker 自然完成到当前边界。

Scheduler 同时使用用户控制、Child 依赖、执行归属、写域和资源声明。模型推理席位与物理 Job 所有权分别管理；等待长作业时，原 Worker 持续拥有相应 Job，直到实际结果收取或退出。

## 5. 前台上下文与工作原文

前台每个完整用户交互包含原用户消息和相应最终回复。新 Session 自动带入最近六次完整交互，更早原文按日期和引用检索。后台完成通知单独保存。历史页面向上滚动预加载，按稳定消息身份合并并保持阅读锚点；日历使用 DSH 主题及官方 UI primitives。

Task 保存当前机器状态和记录引用；完整需求、Planner Memory、Note 版本、Child Reply、执行与恢复记录在同一 Domain 独立追加。ContextAssembler 提供有界当前输入和精确 `next_reads`，角色需要时读取原文。热上下文的分页与摘要不缩短永久记录。

## 6. 冷启动与故障恢复

1. 读取保存的 Task、控制意图、原生 Session、当前租约、原生 Agent 和存活 Job。
2. 当前仍有所有者时保留实际归属；可恢复的正常空闲 Worker 可继续原 execution/session。
3. 原运行已经消失时，将中断工具、排队输入、旧 Job 等历史现场保存到 `interruption`，退休失活身份。
4. 从原 Child 或原 Planner 动作建立同角色后继，保留工作前沿、分配版本、有效段计数和已有成果。
5. 后继根据 Session 与实际产物继续未完成工作；已保存最终报告直接进入评价。

前台失活的未消费 claim 使用原消息身份重新接纳；已消费的中断回合恢复原 Session 并关联原始输入。历史未结束工具或 Job 记录用于接续取证，不作为永久阻塞恢复的条件。

用户暂停、取消及真实当前所有权继续生效。普通工具报错由原执行处理；相同配置故障且没有新进展时形成具体等待。宿主中断与这种重复配置故障分别处理。

## 7. 存储、交付和清理

所有 DSS 自有状态位于既有 `deepseek_servant` storageDomain。逻辑键包括 `assistant/`、`conversations/`、`knowledge/`、`task-origin/`、`task:`、`planner-memory/`、`planner-note/`、`worker-reply/`、`execution/`、`recovery/`、`records/`、`record-archive/` 和 `task-history/`。

完成顺序：**Planner 接受 → 封存完整 records → 唤醒前台交付 → 运行所有者与动作收束 → 封存最终状态 → 保存永久身份 → 精确清理临时键，Task 热状态最后删除。**

原始需求、逐日对话、完整 records、知识及实际工程成果保留。历史引用在临时状态删除后继续解析。清理中断从已保存清单继续。记录目录迁移、工作区选择及 DSH 原生 Session 日志分别管理；详见[记录与清理](RETENTION.md)。

## 8. 知识与扩展

KnowledgeService 将实际接受结果和纠正关联到事实、偏好及 SkillVersion；原生 Skill provider 提供当前作用域的可用技能。实际加载与结果反馈按执行和结果身份关联，已有用户技能沿用 DSH 的管理方式。

可选 GitHub 工具集成与跨设备状态协作继续作为后续实验设计，保留远端新增的默认关闭、原生凭据、原生 Approval 及复用上游实现等要求。具体方案与进度见[统一设计基线](docs/DSS_MASTER_DESIGN_20261025.md)。
