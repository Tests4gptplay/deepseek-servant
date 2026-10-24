# DeepSeek Servant 开发顶层架构设计

2026-10-24 · 架构基线 v0.2。当前实现和运行验证请参阅 IMPLEMENTATION.md。

本文集中说明系统的模块组成、数据与运行实例所有权、接口调用、任务闭环，以及开发依赖顺序；技术术语在首次出现时解释。

产品能力与适用环境见[项目说明](README.md)，实际宿主适配和验证过程见[实现说明](IMPLEMENTATION.md)。本文所列 Servant 服务属于插件应用层，由 DSH 适配器接入宿主接口。

## 1. 总体架构决策

**采用“嵌入 DSH 的模块化单体”：一个可安装 bundle，Host 负责长期运行，Client 负责交互，角色 Agent 负责语义判断，DSH 负责实际模型与工具执行。**

不拆微服务，不另开服务器，不把浏览器当调度器，不重建宿主 Agent 引擎。

整个系统分成四个部分：

1. **交互层**：把用户输入和操作送进系统，将状态与成果展示出来。
2. **任务控制层**：保存目标、计划、归属与已接受结果；唯一决定哪个状态变更有效。
3. **语义与执行层**：Planner 判断做法，Worker 实际工作，确定性调度代码负责启动、等待和收取结果。
4. **知识与能力层**：把工作结果提炼成项目知识、偏好和技能，再供后续工作调用。

这四部分协同工作：Planner 负责语义判断，任务控制层负责状态归并与持久化，从而兼顾自主规划和可靠接续。

### 1.1 组件图

```text
DSH Client
┌─────────────────────────────────────────────────────────────┐
│ Servant 独立页面                                                │
│ 对话视图 / 任务视图 / 经验视图 / 设置                           │
└──────────────┬───────────────────────────────▲───────────────┘
               │ 用户命令                     │ 状态、会话、成果
               ▼                              │
DSH Host：deepseek-servant
┌─────────────────────────────────────────────────────────────┐
│ 接入层：ServantApi + 角色工具入口                                 │
│               │                                             │
│               ▼                                             │
│ AssistantService       TaskService          KnowledgeService │
│ 助理会话与交付           任务唯一写入口         知识与技能写入口 │
│                          │                    │              │
│                   TaskKernel 纯状态转换       SkillLifecycle  │
│                          │                    │              │
│                          ▼                    ▼              │
│                 ServantStore：宿主 storageDomain                 │
│                 当前记录 + 待执行动作 + 消费回执               │
│                          │                                   │
│                          ▼                                   │
│ RuntimeCoordinator：依赖、队列、席位、资源、等待、恢复          │
│                          │                                   │
│                          ▼                                   │
│ AgentSupervisor：创建/恢复角色 Agent，持有句柄，绑定实际执行    │
└──────────────────────────┬──────────────────────────────────┘
                           │ DSH 适配层
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ DSH Agent / 模型路由 / 工具 / jobs / Session / Skills / 工作区 │
│ 角色 Agent：Foreground / Planner / Worker / Helper           │
└──────────────────────────┬──────────────────────────────────┘
                           │ 角色命令与实际结果
                           └──────────────→ 回到对应 Service
```

这里的“待执行动作”是已经决定、还需要调用宿主完成的动作，例如启动某次 Worker。它不是另一个 Agent，也不是新的命令执行器。

### 1.2 不可跨越的边界

- Client 不直接创建后台 Worker，也不直接修改任务记录。
- Agent 不直接写内部数据库；通过绑定到自身职责的工具提交语义结果。
- RuntimeCoordinator 不判断文案好坏、模型是否像参考图；那是角色 Agent 的工作。
- Planner 不自行绕开任务控制层启动一组无归属的长期工作。
- Servant 不复制 DSH 的模型循环、工具调度器或技能加载器。
- 一个事实只有一个权威位置：对话在 Session，任务进度在 Task，工程产物在实际文件。

## 2. 模块、输入输出和责任边界

| 模块 | 接收什么 | 产出什么 | 不负责什么 |
| --- | --- | --- | --- |
| ServantApi | 页面操作、前台消息 | 命令回执、查询结果、订阅 | 不持有业务状态副本 |
| AssistantService | 用户消息、任务通知 | 前台会话关联、用户意图来源、交付记录 | 不直接安排 Worker |
| TaskService | 目标、计划决定、执行报告、控制命令 | 持久任务变更、待执行动作 | 不调用模型评价质量 |
| TaskKernel | 当前 Task + 一条有效命令 | 新 Task + 动作描述 | 不做文件、网络、模型 I/O |
| RuntimeCoordinator | 已保存动作、可执行 Child、资源状态 | 有序派发、等待、恢复指令 | 不自己改目标和验收条件 |
| AgentSupervisor | 角色绑定、派发或停止指令 | 活 Agent 句柄、运行观察、标准化回执 | 不接受业务成果 |
| KnowledgeService | 已接受结果、纠正、实际使用反馈 | 项目事实、偏好、技能版本和验证记录 | 不训练模型权重 |
| SkillPublisher | 当前可用技能版本 | DSH scoped provider 的目录与正文 | 不重复实现加载器 |
| QueryService | Task/Knowledge 状态与宿主投影 | 页面、前台所需的小型视图 | 不驱动后台工作 |
| ServantStore / DshAdapters | 上述模块的持久化与宿主请求 | 存储提交、宿主操作结果 | 不包含业务判断 |

代码依赖从界面和适配层指向应用服务、领域模型。领域模型不 import Cordis、React 或某个模型 SDK，避免宿主接入细节污染任务规则。

**TaskService 是任务唯一写入口，KnowledgeService 是知识唯一写入口。** Runtime、UI、角色工具都不能各维护一套状态推进逻辑。

## 3. 部署形态与 Cordis 装配

### 3.1 一个 bundle，三类装配位置

| 位置 | 放什么 | 生命周期 |
| --- | --- | --- |
| Host 插件 | Task/Knowledge 服务、存储、协调器、AgentSupervisor、接入层 | 随插件启停，不随页面关闭 |
| Client 插件 | 导航入口、独立主页面、设置、状态订阅 | 随页面/连接挂载，不拥有后台工作 |
| 角色 preset 贡献 | 角色 MD、绑定工具、技能 provider、角色级策略 | 使用宿主 preset 和 Agent scope |

共享服务放在 Host。preset 只贡献角色行为、工具和知识可见性，不各自创建一个 TaskService 或一套数据库。

角色 preset 的常驻组合可能被多个 Agent 共用。因此，当前 taskId、childId、executionId 必须保存在每个 Agent 的运行绑定中，不能写进共享 preset 插件的一个全局变量。

### 3.2 四个角色不是四个永久进程

- Foreground 由 AssistantRuntime 持有，负责面向用户的连续交流。
- Planner 由对应 TaskRuntime 持有，一个任务同时只有一个有效规划者。
- Worker 由 TaskRuntime 持有，每个当前执行绑定对应自己的角色会话。
- Helper 由具体 IncidentRuntime 持有，仅处理该次明确运行故障。

角色闲置时不持续调用模型。角色更换不改变 Task 的逻辑身份。

### 3.3 建议代码布局

以下为拟建目录，不表示这些实现文件已经存在。

```text
deepseek-servant/
  package.json
  cordis.patch.yml
  src/
    contracts/                 # 命令、回执、查询 DTO 与运行绑定
    domain/
      task.ts                  # Task 聚合和状态转换
      plan.ts                  # Child、依赖、验收决定
      execution.ts             # 执行身份与报告有效性
      knowledge.ts             # 知识和技能生命周期
    application/
      assistant-service.ts
      task-service.ts
      knowledge-service.ts
      query-service.ts
    runtime/
      coordinator.ts
      scheduler.ts
      agent-supervisor.ts
      recovery.ts
    adapters/dsh/
      agents.ts
      sessions.ts
      jobs.ts
      storage.ts
      skills.ts
      workspace.ts
      remote.ts
    roles/
      foreground.md
      planner.md
      worker.md
      helper.md
      bindings.ts
      tools.ts
    client/
      page.tsx
      conversation.tsx
      tasks.tsx
      knowledge.tsx
      settings.tsx
    host.ts
    client.ts
    role-plugin.ts
  tests/                       # 按实际模块边界设置必要测试
```

不以目录数量代替功能。小模块可以合并文件；服务边界和数据归属不能合并成一个任意改状态的大脚本。

## 4. 核心数据模型

### 4.1 领域关系

```text
Assistant ── owns ── Task
    │                   │
    │                   ├── GoalContract
    │                   ├── Plan ── Child ── ExecutionBinding
    │                   ├── AcceptedResults / ArtifactRefs
    │                   ├── Waits / Incidents / PendingActions
    │                   └── Delivery
    │
    └── Knowledge ── ProjectFact / Preference / SkillVersion
                                                │
                                                └── Evidence / UsageFeedback
```

“聚合”指必须一起维护一致性的一组数据。首版把当前计划、Child 状态、有效执行绑定、结果接受和待执行动作放在同一个 Task 聚合中，避免一次完成要跨多个表才能成立。

### 4.2 主要对象

| 对象 | 最少保留的内容 | 用途 |
| --- | --- | --- |
| Assistant | id、前台 session 关联、工作区/模型默认选择、资料引用 | 助理身份独立于某次聊天 |
| Task | id、assistantId、revision、工作区绑定、控制意图、阶段 | 稳定的逻辑任务 |
| GoalContract | 原始请求引用、目标、约束、交付物、验收条件、goalRevision | 判断现在到底要做什么 |
| Plan | planRevision、策略、当前 Child 及依赖、规划决定记录 | 渐进规划，不预填全部未来步骤 |
| Child | id、有界目标、输入、验收条件、assignmentVersion、依赖、写域/资源需求 | 一个可独立执行的工作单元 |
| ExecutionBinding | executionId、角色、Child/任务归属、指派版本、有效代、session 关联 | 判定某个结果属于哪次工作 |
| ExecutionReport | 当前成果、证据引用、接续前沿、继续/完成/等待/失败 | 角色提交的业务结果 |
| ArtifactRef | 实际位置、用途、版本或需要的标识、对应结果 | 引用成品，不复制工程文件进数据库 |
| WaitRecord | 等待种类、具体条件、恢复入口、相关用户问题或作业 | 区分真等待与失去推进 |
| PendingAction | 稳定 actionId、动作种类、目标绑定、提交/执行/观察状态 | 保存尚未兑现的运行决定 |
| Delivery | 对应结果、面向用户的摘要、通知 id、展示/已读状态 | 交付与后台完成分开 |
| SkillVersion | 稳定 skillId、版本、正文、适用范围、来源、证据、状态 | 累积可调用的方法 |

详细推理仍在 Session；这里保存决定和可接续事实，不把完整聊天复制一遍。

### 4.3 三种版本不能混用

- **revision**：防止两个修改者用旧快照覆盖 Task 记录。
- **goalRevision / assignmentVersion**：表示用户目标与具体工作要求的变化。
- **执行身份与代际**：判断哪个执行者当前有权提交这项工作。

特别注意：两个并行 Worker 的报告不能都要求匹配同一个旧 Task revision，否则第一个报告会把第二个正常结果变成“过期”。

因此，Worker 报告按 executionId 和对应 assignmentVersion 验证，由 TaskService 在串行入口中合并；修改整份计划则检查 planRevision 和当前目标版本。

纯粹调高优先级不废弃成果。改变目标后，由 Planner 判断受影响的 Child；旧成果可以作为输入保留，但未经确认不能自动算作新要求已经满足。

### 4.4 三种状态分别保存

| 状态维度 | 表达什么 |
| --- | --- |
| 控制意图 | 用户允许继续、要求暂停或要求取消 |
| 业务阶段 | 规划、执行、评价、等待决定、待交付、完成等 |
| 物理执行 | 哪些 Agent、工具或外部作业实际上仍在运行 |

这样能够同时表示“已暂停派发”和“渲染仍在运行”，让用户看到控制意图与物理状态的准确区别。

## 5. 模型判断与确定性控制怎样衔接

### 5.1 角色契约是实现的一部分

四份角色 MD 不只是角色介绍，要规定各自的输入、可做决定、输出和停止条件。

| 角色 | 输入 | 有权做的语义决定 | 必须提交的结果 |
| --- | --- | --- | --- |
| Foreground | 用户原话、助理资料、相关任务视图 | 识别执行请求/修改/普通讨论，提出必要问题，组织交付 | 带来源的用户意图或面向用户的回复 |
| Planner | 当前 Goal、Plan、Child 报告、已接受成果 | 分解、调整策略、接受或退回结果、确认目标已满足 | 计划变更或明确的评价决定 |
| Worker | 一个有效 Child 指派、输入产物、相关知识/技能 | 在授权范围内选择方法并实际执行 | 产物引用、必要证据、状态与接续前沿 |
| Helper | 具体错误来源、操作、异常、已有运行绑定与可恢复范围 | 对该次机械故障进行有界诊断与修复 | 修复结果及原工作应如何恢复 |

短任务可以由 Foreground 承担简单的计划/评价责任，不必启动独立 Planner Agent；仍使用同一任务模型和结果协议，不另开一条无记录的执行通道。

### 5.2 代码负责什么

TaskKernel 只检查确定性问题，例如：

- 命令来源是否对应当前角色和工作绑定。
- Child 的输入依赖是否已满足。
- 这份报告是否来自当前有效执行者。
- 计划是否引用了不存在的 Child，依赖是否形成循环。
- 用户已暂停时，是否仍在要求启动新工作。
- 结果已消费时，是否只是重复提交。

“这段视频够不够好”“这个方案有没有满足目标”由角色结合证据判断并记录；状态机负责确定性的流程有效性。

### 5.3 完成协议

```text
实际业务产物
  → Worker 提交结果及接续记录
  → TaskService 接受当前绑定的终结报告
  → 保存结果与下一动作
  → Planner/前台评价
  → 接受、返工、继续或交付
```

终结报告是本次执行的最后业务提交。运行绑定关闭后，该执行者不能继续发起新的业务操作；纯回复文字不构成另一个完成信号。

实现时将终结报告工具与同批业务工具执行隔开，使用宿主支持的独占/屏障调度方式，避免“先宣布完成，后面的文件写入还没执行”。

报告提交成功不等于整项任务完成；Worker complete 只结束对应工作指派，最终接受由 Planner 或短任务的前台评价路径完成。

### 5.4 什么事件触发什么下一步

| 当前事件 | 确定性动作 | 是否启动语义判断 |
| --- | --- | --- |
| 新 Task 需要分解 | 保存规划动作 | 启动 Planner |
| 正常阶段进展，仍在既定计划内 | 保存前沿与证据，按既定指派继续 | 不逐工具调用唤醒 Planner |
| 有界工作段报告继续 | 检查指派、控制意图与审阅计数 | 达到例行审阅点才回 Planner |
| Child 报告完成 | 保存结果并排入评价 | 立即评价，不等待例行轮数 |
| 用户改目标、方法明显失效 | 暂停相关新派发，保留成果 | 立即回 Planner |
| 等用户/配置/实际作业 | 保存可判定的等待条件 | 条件未变化不重复推理 |
| 已报告机械故障 | 建立或补充绑定 Incident | 激活对应 Helper |
| 交付条件已满足 | 保存 Delivery 和通知动作 | 不固定追加一个审计 Agent |

正常延续的例行审阅间隔建议先取 5 个有界语义工作段，作为可配置策略，延续 CAH 不逐步重审的思路。它不是 5 次工具调用，也不是要求每 5 次调用新建会话。

progress/wait 报告可以保留原执行绑定；complete 或明确结束当前指派的报告才关闭它。等待外部作业不等于销毁 owner Agent。

## 6. 模块接口契约

以下列出 Servant 应用层接口；宿主 Service 与模型工具通过对应适配器连接。

### 6.1 面向页面和前台的入口

| 操作 | 必要输入 | 返回或效果 |
| --- | --- | --- |
| assistant.sendMessage | assistantId、稳定消息标识、正文/附件引用 | 写入绑定的宿主会话，返回接收标识 |
| task.submit | 用户请求来源、GoalContract、工作区绑定 | taskId、当前 revision |
| task.reviseGoal | taskId、预期版本、变更内容、用户来源 | 新目标版本及需要重新协调的范围 |
| task.control | taskId、pause/resume/cancel、用户来源 | 已接受的控制意图及仍在途的工作 |
| task.query | taskId、所需视图 | 当前阶段、成果、等待原因和下一步 |
| task.answer | 问题 id、用户选择 | 消费对应等待，不跳过其他等待条件 |
| knowledge.edit/disable | 知识或技能 id、版本、修改 | 新版本或停用结果，不改用户其他来源的技能 |

授权确认和回答用户专属问题不能开放为 Agent 替自己批准的工具。其他操作的 UI 与工具入口调用相同应用服务。

### 6.2 面向角色的入口

| 操作 | 调用者 | 结果 |
| --- | --- | --- |
| planning.commit | 当前 Planner，或短任务的指定前台评价者 | 保存计划、Child 和依赖变更 |
| planning.decide | 当前评价者 | 接受/返工/继续/等待/确认交付条件满足 |
| execution.report | 当前绑定 Worker | 保存阶段或终结结果，返回消费回执 |
| execution.requestHelp | 当前执行者 | 登记具体缺口或故障；不凭空创建新目标 |
| recovery.report | 当前 Incident 的 Helper | 保存故障处理结果 |
| knowledge.propose | 有对应工作证据的角色 | 形成知识或技能候选 |
| knowledge.feedback | 可关联实际使用与结果的角色/运行观察 | 合并一次真实反馈 |

运行绑定从服务端当前 Agent 身份推导，不相信工具参数中自称的 role、taskId 或 generation。模型填写的是内容，不是给自己签发执行权限。

### 6.3 命令与回执

每条变更命令包含稳定 commandId、命令类型、目标、正文和来源引用。身份由接入层填充；只有需要基于旧快照修改内容时才要求相应 expectedRevision。

回执分为：

- applied：本次已保存。
- duplicate：此前已经保存，返回原回执。
- stale：目标版本已变化，返回必要的新状态。
- rejected：当前绑定或状态不允许，并说明具体原因。

不要把所有“没有推进”都归为错误，更不能遇到 stale 就自动重放具有副作用的旧决定。

## 7. 持久化与事件推进

### 7.1 存储选择

首版使用宿主 storageDomain。任务、助理、知识与技能属于 Servant 的领域记录；DSH Session 保留原始消息、工具过程和模型回合。

不另引入 SQLite，不手写另一份 Session 日志，也不把 Team 任务板与 Servant Task 同时当成权威状态。

但当前已核对的 storageDomain 接口没有跨表事务或跨进程 CAS 保证。因此架构不能依赖这些不存在的承诺。

### 7.2 一次任务变更的提交路径

```text
输入命令
  → 按 taskId 进入串行处理队列
  → 读取当前 Task，检查绑定/版本/commandId
  → TaskKernel 计算新状态和待执行动作
  → 在同一 Task 记录内保存状态、回执、PendingAction
  → 提交成功后更新查询视图
  → RuntimeCoordinator 兑现 PendingAction
  → 宿主实际结果再次作为命令进入 TaskService
```

单记录提交减少跨表不一致，具体后端的原子替换/持久写入保证在该适配器实现时核对。不把 JavaScript 内存更新当成已经可靠保存。

关键失败处理不是“再执行一次”：

- 保存失败：不启动尚未获准的下一动作。
- 保存成功但调用宿主前退出：重启后处理已保存的待执行动作。
- 宿主可能已经执行，但回执没保存：先凭绑定的 Session、工具记录和实际产物核对；结果不明时标为待协调，不盲目重复副作用。
- 回执重复：同一 actionId/resultId 只消费一次。

这是任务层的幂等与恢复，不承诺所有外部系统都能严格 exactly-once。

### 7.3 不建设第二套消息中间件

进程内通知只用于唤醒和更新视图，持久记录才决定是否还有工作。丢掉一次内存通知不应永久丢掉 Task。

跨聚合动作也用稳定来源标识：例如 Task 产生“提炼经验”动作，KnowledgeService 以原 resultId 去重；已经接收后再返回回执。无需为此引入消息队列服务器。

启动时扫描未完成记录和未兑现动作；正常运行靠真实事件推进，不持续全量扫描所有 Task。

## 8. 运行实例所有权与并发

### 8.1 谁拥有谁

```text
Host 插件 scope
  ├── AssistantRuntime
  │     └── Foreground Agent handle
  ├── TaskRuntime A
  │     ├── Planner Agent handle
  │     ├── Worker Agent handle → 该 Agent 实际拥有的 jobs
  │     └── Worker Agent handle → 该 Agent 实际拥有的 jobs
  └── IncidentRuntime
        └── Helper Agent handle

Client 页面仅订阅这些运行实例的状态，不拥有它们。
```

TaskRuntime 是 Servant 的协调对象，不是另一个模型。AgentSupervisor 持有和释放宿主句柄。

Worker 不挂在可随时结束的前台会话或一次性 Planner 回合下面。使用 Subagent/Team 时，也必须按其真实父级生命周期接入；逻辑 taskId 相同不意味着已经迁移了父子归属。

### 8.2 调度准入

Scheduler 只派发满足以下条件的 Child：

1. 任务控制意图允许执行。
2. 当前指派有效，所需依赖已经接受。
3. 有可用后台执行席位。
4. 没有已知的写域或独占资源冲突。
5. 没有尚未解决的必要配置/用户决定。

建议默认两个后台 Worker 席位，是配置值而非架构常量。前台拥有独立交流 Agent；Planner 按需运行。同一 Agent 不进行两个模型回合的并发重入。

同一模型或项目文件在 Servant 管理范围内交给一个写入者；这是应用层协调，操作系统文件锁与其他程序中的并发修改由宿主环境管理。

### 8.3 推理容量与物理资源分开

等待渲染时可不继续占用模型推理回合，但 GPU/进程资源仍在占用。不能把“Agent 暂时没生成文字”理解成资源已经释放。

宿主或供应商限流照常生效。Servant 只管理自己的派发，不重新实现全宿主容量池。

### 8.4 三种接续

- 同一 Agent 的历史处理：使用宿主既有能力；不是本项目的中心模块。
- 换 Agent：提交接续记录，并处理该旧 Agent 的在途 jobs/下级工作后再释放。
- 重启宿主：恢复逻辑任务并核对实际执行；不假设旧内存 job registry 还能恢复。

尤其不能将“保存 jobId + dispose 旧 Agent”实现成迁移。对于仍在运行的作业，首版保留实际 owner 到结果收取或确认结束，不增加通用作业转移器。

## 9. 四条核心调用链

### 9.1 用户交代任务 → 实际成果

```text
用户
 → ServantApi
 → AssistantService 写入前台 Session
 → Foreground 理解意图，调用 task.submit
 → TaskService 持久化 Task + 启动规划动作
 → RuntimeCoordinator / AgentSupervisor 启动 Planner
 → Planner 通过 planning.commit 提交当前计划
 → TaskService 保存 Child 与依赖
 → Scheduler 派发可执行 Child
 → Worker 使用 DSH 工具实际完成工作
 → execution.report
 → TaskService 保存结果并生成评价动作
 → Planner 接受 / 返工 / 扩展下一步
 → 任务满足交付条件
 → AssistantService 展示成果并保存通知状态
```

简单工作跳过独立 Planner 实例，由指定的前台评价路径给出决定；其余提交与执行机制不另造一套。

### 9.2 用户改目标 → 仅调整受影响部分

```text
新用户要求
 → reviseGoal 保存要求及来源
 → 暂停受影响部分的新派发
 → Planner 比较当前计划与新要求
 → 保留有效成果，修改相关 Child 的指派版本
 → 通知对应 Worker 调整或停止
 → 后来的报告按实际有效指派判断
```

影响范围尚未判明的旧报告先保留，不抢先作为新要求的验收结果。对未变化的成果，不重新执行或全面检查。

### 9.3 后端退出 → 启动恢复

```text
插件启动
 → 打开 Servant 数据域
 → 读取未终结 Task、控制意图和 PendingAction
 → DshAdapters 查询能确认的 Session/实际执行事实
 → 重建必要的 TaskRuntime
 → 对确定未执行的动作继续派发
 → 对确定完成的结果补消费
 → 对不确定副作用进入具体协调
```

手动暂停/取消、等待用户回答的任务保持原控制意图。普通浏览器关闭不触发这一套恢复，它不曾拥有后台生命周期。

### 9.4 实际结果 → 可复用技能

```text
结果被接受 / 发生有价值的纠正
 → Task 保存提炼经验动作，绑定 resultId
 → KnowledgeService 提供来源和现有相关知识
 → 角色提炼具体候选或修订建议
 → 验证记录支持限定适用范围
 → 新 SkillVersion 成为可用版本
 → SkillPublisher 通知宿主目录失效
 → 下一次匹配工作通过宿主 skill 工具加载
 → 实际结果再写入成功/失败反馈
```

技能学习是主流程的一条输出和下一次任务的输入，不是最后补一个“记忆页面”。提炼优先由正在评价该结果的 Planner，或短任务的前台评价者承担，不固定新增一个 Learner Agent。没有新方法或有效纠正时不生成提炼动作；已经满足条件的用户交付也不等待普通技能整理，除非任务本身就是编写技能。

## 10. 知识与能力子系统

### 10.1 四类内容分开

| 类型 | 写入依据 | 生效范围 |
| --- | --- | --- |
| Task checkpoint | 本次真实执行与决定 | 当前任务 |
| ProjectFact | 已确认项目事实及来源 | 对应项目 |
| Preference | 用户明确的长期偏好或纠正 | 对应助理及适用场景 |
| SkillVersion | 可复用方法、适用条件、实际证据 | 匹配任务，可逐步推广 |

不能把一个任务的临时要求永久化，也不能把工程私有数据混进无条件通用技能。

### 10.2 技能生命周期

采用 candidate → active → revised/disabled/retired 的显式状态；失败不从记录里消失。

晋级依据可以是当前任务已经完成的有效结果，不为了晋级重复同一实验。没有证据支持的扩大适用范围保留为候选。用户修改后的新版本与旧版本分开，不自动把旧 PASS 继承给已经变化的内容。

现有用户技能仍按 DSH 原规则可用，不要求它们先取得 Servant 的 PASS。

### 10.3 发布到宿主

采用 Servant preset scope 下的单个 Skill provider：

- 使用自己的技能命名空间，不覆盖现有名称。
- 按工作区/适用范围提供摘要，正文按需获取。
- 候选可在经验页查看，不当成已验证能力展示给执行者。
- 技能变更时主动使宿主目录失效。
- 导出的 Markdown 是用户可取走的副本，不与数据库正文同时争当权威编辑源。

每次实际使用和反馈按来源结果去重；成功次数由宿主实际加载观察和对应结果确认，传输重试不会增加成功次数。

### 10.4 能力缺口怎么处理

Worker 先查已有工具和技能；任务内脚本可直接服务当前工作。确实形成重复使用的执行能力时，才提出版本化工具/插件扩展。

需要新授权、账户、付费资源或重大环境变更时形成具体 WaitRecord，由前台带回用户；不另造一套审批系统。技能提炼不能成为偷偷部署任意插件的后门。

本子系统不修改外置记忆插件或角色人设的持久文件。

## 11. 暂停、取消与故障恢复

### 11.1 控制命令先落盘

pause/cancel 先进入 TaskService 保存，再阻止新的派发。后续晚到结果仍可登记，但不会因此自动开始下一轮模型工作。

- pause：停止新的业务推进；已启动作业按实际情况显示。
- stop execution：向具体 owner 路径请求停止，追踪返回事实。
- cancel：目标不再继续，并处置已有运行；不是删除成果。
- resume：基于当前记录重新判断可执行项，不回滚到旧计划。

不能以 cancel 返回 accepted 代替“所有进程已经退出”。

### 11.2 恢复按故障对象处理

| 问题 | 处理责任 |
| --- | --- |
| 业务方法失败、结果不满足要求 | Worker/Planner 改方法或返工 |
| 已报告的 Harness/Host/Bridge 机械错误 | 立即建立或补充具体 Incident，激活对应 Helper |
| 缺少用户决定/配置/授权 | 保存等待，经前台提出具体问题 |
| 重复回执、旧指派提交 | TaskKernel 去重或判定失效，不启动额外 AI 审查 |
| 已知宿主短暂传输故障 | 在同一逻辑执行身份下处理物理重试，不自动另开新目标 |

同一活跃 Incident 的新增错误交给同一个 Helper，不为每条日志再创建一个恢复者。Helper 只在绑定的修复范围内操作，不越权接管业务，也不自动恢复用户已经停下的任务。

物理重试不改变已接受的语义结果。新的工作方案或有效执行者交接才建立新的业务指派/代际，不能把“又试了一次网络调用”计成新一代任务。

## 12. 客户端、工作区与展示数据

### 12.1 页面不等于一个普通聊天

使用宿主 sidebar.panellist 注册独立入口、main 注册独立页面。当前已核对 schedules 的 order 为 10，Servant 可建议使用 20；实际位置在集成时核对。

独立页面必须显式绑定 Assistant 的前台 session，不借用用户当前打开的普通聊天。角色内部会话可以按需查看，但不成为默认 UI。

前台对话使用宿主会话事实；任务列表使用 QueryService 的 TaskView。Client 不自己折叠整份后台历史来推导进度。

### 12.2 读模型

提供三个主要视图：

- AssistantView：前台 session、工作区、任务摘要、待决定事项。
- TaskView：目标、阶段、实际运行、当前成果、等待原因、可用操作。
- KnowledgeView：项目事实、偏好、技能版本、来源及有效状态。

变更提交后发布增量更新。页面重新连接时获取当前快照，再订阅后续更新；通知失败不撤销已经成功保存的任务变更。

### 12.3 工作区绑定

配置保存 Servant 自己选择的 workspaceId；默认值由宿主默认工作区或默认目录确定，独立于列表排序和普通聊天的当前 cwd。

创建 Task 时保存解析后的工作区和实际目录绑定。以后修改默认设置只影响新 Task。工作中的进程、Agent 和产物位置不会因用户切换普通聊天而变化。

配置中可分别选择前台和后台模型；Task/执行绑定保存实际采用的模型路由与角色配置版本。设置变化不偷偷改写已在途工作的执行环境。

## 13. DSH 适配层与复用决策

| Servant 需要的能力 | 采用的宿主基础 | Servant 必须补充的语义 |
| --- | --- | --- |
| 创建/恢复角色执行者 | Agent 服务、模型路由、preset | task/child/execution 与句柄归属 |
| 输入与输出 | Agent 消息、Session 历史/投影 | 把结果归并为业务状态 |
| 具体文件、命令与应用操作 | 当前模型路由可用工具 | 当前工作范围、成果引用 |
| 长作业 | 实际执行路径的 job 能力 | 真实 owner、等待条件、结果消费 |
| 领域存储 | storageDomain | Task/Knowledge schema 与单写入口 |
| 技能发现和加载 | skills provider、宿主 skill 工具 | 候选、验证、版本和反馈 |
| 前端入口与状态连接 | Client slots、现有 Host/Client 接入 | Servant 页面和读模型 |
| 工作区 | workspaceRegistry、workingDirectory | 助理默认选择和任务绑定 |

这些基础已由前一轮源码/Inspect 核对，不重新从零研究。准确的参数和事件签名在对应适配器编码时使用当前契约，不把工具名当插件 API。

不把 Team 作为强制主干：它可用于适合的协作，但其任务板不代替 Task 聚合。也不同时挂载另一个通用 goal 自动续作循环，以免两个控制者同时推进同一任务。

ChatCMD 的代码选择放在具体模块开工时进行，按真实版本和许可证取用；目前不列没有读过的“可直接复用文件清单”。

## 14. 开发工作包与依赖顺序

开发按领域与模块契约、持久命令通道、宿主执行桥、真实端到端链路的顺序推进，再完善交互与交付。

| 工作包 | 修改范围 | 依赖 | 可交付内容 |
| --- | --- | --- | --- |
| W0 领域契约 | contracts、domain、四个角色 MD | 本方案 | Task/Child/执行/技能结构、命令回执与状态转换 |
| W1 持久命令通道 | TaskService、ServantStore | W0 | 单写、版本检查、去重、PendingAction 保存与恢复 |
| W2 宿主执行桥 | DshAdapters、AgentSupervisor、角色工具 | W0；接入时使用 W1 | 正确归属的 Agent 与实际工具结果回收 |
| W3 运行协调 | coordinator、scheduler、recovery | W1、W2 | 依赖派发、真实并发、等待、控制与恢复 |
| W4 知识闭环 | KnowledgeService、SkillPublisher | W0、W1；端到端依赖 W3 结果 | 从实际结果晋级到下一次任务可调用的技能 |
| W5 Client 与交付 | 页面、设置、QueryService、通知 | W0 定接口；逐步接 W1–W4 | 独立入口、真实任务/经验视图与可打开成果 |

W2 与 W5 的部分工作可以在 W0 后并行设计和开发；这只是依赖图，不要求为本次文档任务启动多个 Agent。

### 14.1 第一个纵向切片

单目标 → 一个 Worker → 实际文件 → 结果接受 → 前台交付。

这个切片必须经过真实 TaskService、持久化和宿主桥，不用临时脚本伪装后台架构。它证明主链已经接通。

### 14.2 第二个纵向切片

一个含两个独立 Child 的计划 → 两个 Worker 实际并行 → 结果合并 → 中途改要求或暂停 → 正确接续。

同时加入具体故障恢复与一次后端重启恢复，证明控制和执行所有权有效。

### 14.3 第三个纵向切片

一次工作中的有效方法 → 技能候选/验证 → 宿主加载 → 后一项相关任务实际复用并留下反馈。

达到这一切片，才具有本方案要求的完整做事与学习闭环。技能能力不是无限期的后续项目。

## 15. 架构验收与剩余落点

只验证架构中真正可能出错的连接：

1. 并行 Child 提交结果不会因全 Task revision 竞争丢掉一个正常结果。
2. 迟到报告、重复通知、控制命令与实际执行交错时，不错误推进任务。
3. 提交前后退出、调用宿主后未收回执这几个边界能恢复，不盲目重放副作用。
4. 前台、Planner 或页面变化，不释放仍拥有有效作业的 Worker。
5. 已接受结果可进入技能，并在下一项工作中实际可见；用户既有技能保持原样。

没有必要另加一个全局监督 Agent、通用 watchdog、分布式事务系统或全量日志审计模块。

目前需要在实现中具体落实的仅是：使用的存储后端单记录写入保证、Host/Client 命令注册签名、角色 preset 的精确装配、不同执行路由可观察的作业回执。它们有明确模块归属，不改变上面的核心分层。

**架构的中心是：Task 作为持久责任单元，角色 Agent 作语义决策，确定性控制层归并与推进，DSH 执行实际操作，Knowledge 将结果变成下一次工作的能力。上下文接续由 AgentSupervisor 管理，服务于持续任务执行。**

## 16. GitHub 跨实例协作模式（实验性扩展设计）

DeepSeek Servant 面向多种运行与协作形态。现有单实例模式由该 DSH Host 持有任务与 Agent 所有权；扩展模式计划在不改变既有任务核心语义的前提下，让多个 DSH 实例经同一个获授权的 GitHub 仓库协作。

**交互与配置：**在独立助理页面中选择协作模式，设置 GitHub Token、私有协作仓库及参与实例；凭据由使用者自己的环境安全保存，不写入协作仓库、运行结果或日志。协作设置与原有工作区、模型配置分开。

**任务链路：**用户提交目标后，将任务约定、计划、工作前沿及必要引用写入共享仓库；参与实例按任务归属获取 Child 工作。Planner 和 Worker 分别由参与实例真实的 DSH 后台 Agent 承担，工具与作业仍交给各自 DSH 宿主。Worker 保存结果与证据后，Planner 评价并决定继续、返工或交付。GitHub 负责跨实例状态同步、可追溯提交与接续请求，运行时使用现有原生 Agent 机制，不经 GitHub Actions Runner 执行用户工作。

**状态一致性：**复用 Task/Child/execution 的稳定身份、assignment 和执行归属；跨实例提交使用明确的版本条件避免旧结果覆盖新阶段。掉线与恢复基于已落盘的工作前沿及真实作业归属，避免重复执行外部副作用。共享数据采用任务所需的最小记录与权限，不将完整聊天、Token 或设备私有文件上传。

本节记录独立的研发方向。`0.1.0-alpha.4` 的运行验证覆盖单实例任务链路；跨设备 GitHub 协作在后续实现与试验中逐步验收。
