# DeepSeek Servant · 统一架构设计与实施基线

日期：2026-10-25（Asia/Tokyo）
存放位置：本项目 `docs/DSS_MASTER_DESIGN_20261025.md`，与插件源码和 UI 同一仓库。
性质：**截至本日用户已确认的整体方案**，避免前台/Task/Memory/故障清理/UI 设计散落在多个聊天与设计文件中。原始详细审计仍留在私人 `Tests4gptplay/temp/DSS/`，下文有链接。
特别说明：文档里的“目标”不是“已经上线”。此提交只实现【记录容量 UI/只读存储计量】；其余大规模生命周期和独立存储机制均属后续实现工作，不能宣称已交付。

## A. 产品定位和职责

目标是长期存在、能自主完成复杂任务并与用户自然持续聊天的 Servant，而非本地命令工具的薄包装。

主要角色：
- **Foreground**：唯一持续面对用户的助手身份，承接真实用户需求、对话、任务更新与交付。物理 Agent/Session 按完成的一轮对话替换，用户视觉上仍是连续的同一位助理。
- **Planner**：理解 Root Goal、拆解有界 Child、设置真实依赖，维护正式 Plan/独立 Memory/Note，评审 Worker 成果与最终交付。
- **Worker**：在自己被分配的 Child 范围内真正执行工作，保留原成果，按自身上下文选择继续或交接。
- **RuntimeCoordinator / TaskService / AgentSupervisor**：本地确定性程序，维护归属/准入/调度/事件与异常恢复。**取消 Helper AI 角色**；不设置永久监工 AI，也不照搬 CAH 30 分钟定时杀 Agent。

## B. 存储位置唯一原则

**所有 DSS 自有内部状态、永久历史与任务期间临时记忆均位于既有 DSH `storageDomain` 的 `deepseek_servant` Domain 内。** 不迁移到用户 Workspace、不引入第二套数据库，也没有“复制出来修改再复制回去”流程。

`deepseek_servant` 下的 `records` KV 表可按不同逻辑 Key 管理原文与元数据。以下是最终计划的 Key 家族示意，非已经存在的物理目录：

| 永久记录 | 任务运行期记录 |
| --- | --- |
| `assistant/<id>`：身份/设置/交付索引 | `task:<taskId>`：Root Task / Plan / Children / 当前 Action |
| `conversations/<assistantId>/<date>/...`：逐日完整聊天原文 | `planner-memory/<taskId>/...`：规划、评审、跨代语义历史 |
| `knowledge/skills|facts|preferences/...`：技能、事实、偏好 | `planner-note/<taskId>/...`：未来阶段、暂缓原因与前沿 |
| `task-origin/<taskId>`：原始需求与修订来源 | `worker-reply/<taskId>/<childId>/...`：阶段进展、证据、Checkpoint |
| `records/<taskId>/...`：完整 `records.md` 逻辑档案 | `execution/<taskId>/...`：调度、Job、handoff 与回执 |
| `task-history/<taskId>`：最小历史索引及身份保护 | `recovery/<taskId>/...`：异常和同角色恢复 |

单个长期文档可按日期、Entry、分片、索引分别落在 **同一个 Domain** 中；永久内容不设任意总长度或条目数量上限，模型单次读取则按游标、时间、Key 和精确引用分页。Schema 单次输入限制不得导致永久截断。

**DSH Native Session Persistence 是 DSH 自己的通用原生日志系统，含对话消息正文与工具事件，但不属于上述 `deepseek_servant` Domain。** DSS 读取它进行对话原文补录，自己保存的副本才属于 DSS 长期聊天档案。它不计入 DSS 记录容量 UI（无论前台或后台）。

## C. 前台长期聊天和上下文

1. 前台用户消息、AI 可见完整回复原文按**日期**保存于 Domain 内；时区按用户本地日期，永久保留，跨日期可滚动、按关键词/引用准确补读，不把历史替换成摘要。
2. 每个**完成的前台交互轮**允许换新 Agent/Session；机械层从原文档案固定装载最近**六轮完整用户/AI 往返**。模型需要话题更早上下文时主动读取真正的历史原文。
3. 每次轮换必须先确认当前轮消息及重要动作已持久化；用户仍看到连续一条聊天。人工 Workspace 的切换不能替换 Servant 自有 Domain。
4. 用户原文与完整聊天的保存不是模型的随手工作，采用程序持久化和稳定消息身份去重。

## D. Task / Planner / Worker 与记录边界

**Task != Memory。**

- Task 保存原始 Goal 引用、当前版本的正式 Plan、Children、依赖/验收、执行/等待/动作的当前机器状态与必要 Memory refs；不把多年语义历史全部重写在大 Task JSON 中。
- Planner Memory 是同 Domain 里独立、追加式的跨代判断和交接记录；Planner Note 独立负责尚未展开的未来阶段、边界、原因、依赖与触发点，可在不同 Planner 动作间维护。
- Worker Reply 是每个 Child 自身独立的持久历史、成果与失败依据、Checkpoint、上一代 Worker 交接前沿。
- Planner 先形成全局工作理解和实际拆解；当前有界 Child 先派发，不明确的未来需求写入 Note。即使只分配一个 Worker，也必须给出足够明确可验收的 Child 合同，不是直接把整个 Root Goal 扔给 Worker。
- Planner 正常每个规划/评审 Action 使用新 Agent；复杂**同一 Action 尚未完成时**允许先存 Memory/Note 再换 Planner 继续该 Action。正式 Plan 要能**增量追加 Child**，已接受或正在执行的旧 Child 不因本轮未重发而自动取消。
- Worker 原生 `progress` 原轮保存；`continue` 同 Agent/Session；`handoff` 保存 Reply/Checkpoint、换 Agent/Session。Worker 自主判断何时需要新上下文，**不加入 CAH 约 10 分钟软换代规则**。
- 已确定的每累计 **5 个有效 continue/handoff 工作段**进行 Planner 周期性评审；Worker 真正 complete/failed 立即评审；progress 不计段。先确认完整 Root Goal 覆盖与 Note 无尚待分解的必要需求，才允许 Root Task 最终 complete。

## D.1 Scheduler Worker 并发席位：UI 配置与 Planner 实时容量提示（2026-10-25 新增确认）

这不是网络端口，也不是操作系统物理线程，而是 DSS Scheduler 的 **Worker Agent 并发执行席位数**，对应当前 `src/host.ts` 的 `Config.workerSeats`、`src/runtime/scheduler.ts` 的 `Scheduler.workerSeats`。**现有代码默认 2，Host 配置接受 1～32 的整数；运行时 Scheduler 当前只读且主要通过插件启动时的 Config 注入，前台 UI 暂时只有席位总数显示，没有设置控件。**

**正式升级要求：**

1. 在 DSS 现有「设置」页面添加清晰的小型 **「Worker 并发席位」数字设置**，默认 **2**，沿用目前有效的 **1～32** 配置范围。输入校验、实际保存值、有效运行值、界面显示值必须统一，不能只有一个装饰性输入框。
2. 由用户手动决定并发上限；Planner **只获得当前并发信息，不自动修改上限**。这是执行调度的最大并发 Worker 数量，而不是 Planner 可以创建的 Child 总量，仍可分解超过席位数的有意义 Child，并由 Scheduler 排队。没有待执行 Child 时，不需要占满席位或为此空转模型。
3. 最好在运行时立即应用配置变更，**不要求重启插件**：调高后主动触发调度检查；调低后已有 Worker 正常执行到原有完成/交接边界，不强制停止已经启动的 Agent，仅不再准入超出新上限的后续 Worker。设置需要持久化在原有 DSS `deepseek_servant` Domain；与已有 Host `workerSeats` 配置要明确迁移/优先级，不能出现 UI 显示 4、Scheduler 实际仍 2 的双真相。
4. **每一次新的 Planner 规划和评审 Agent/Action 首条机器输入**，由宿主直接注入当时的并发快照，不靠 Planner 猜测，例如：
   ```text
   [Scheduler / Worker capacity — runtime supplied]
   maxWorkerSeats: 4
   occupiedWorkerSeats: 2
   availableWorkerSeats: 2
   ```
   读取 Scheduler 的**真实有效配置**和当前全局已占席位/待绑定派发预留；空闲数按 `max(0, maxWorkerSeats - occupiedWorkerSeats)` 计算，不得仅按本 Task 的 Worker 数计算。该信息是规划时的快照，其他任务可能在推理期间改变负载；最终是否可以派发仍由 Scheduler 根据实时 Owner、资源声明、Child 依赖与重叠写域判断。
5. 如果 Planner 在**同一超长未完规划动作**中 handoff 给下一代，新 Planner 也重新取得最新容量快照；工作区更换/用户在 UI 调整席位也不应使现有 Child/Task 消失。普通 Worker 不需要占用额外的模型推理轮询容量。
6. 统计口径要与 Scheduler 真正的 Worker inference slot admission 相符：运行中的 Worker 和已正式保留、即将绑定的派发应计入占用；等待 Job 的物理资源/文件排他仍应单独依据现有 `resources/writeScopes` 规则判断。**并发席位不等价于可并行使用多个 GPU 或重叠文件写入权限。**

**必须验收：** 首次安装无历史配置显示 2；1/4/32 等合法值可保存并重开保留；0/33/小数不被接受；配置变化确实改变调度结果而非仅 UI；Planner 的两次相邻规划/评审准确看到**不同的最新配置和占用快照**；多任务同时存在时全局席位计算正确；降低上限不终止已有 Worker；不要为了提示容量而启动单独 AI。

## E. 异常恢复（没有 Helper）

DSH 原生 `agent/error`、Agent abnormal-idle、Session/Job 真实状态进入程序观察/对账。只是执行时间长、正常 Job 没输出、普通工具错误，不意味着 Agent 已死亡。

异常明确且原执行者已失效、旧 Job 与可能产生的副作用已经核对时，程序记录 `ErrorRecord`、旧代身份、错误、进度和结果引用，再创建**同角色**新 Agent/Session：
- Planner 出错 → 新 Planner 接续原计划/原评审 Action；
- Worker 出错 → 新 Worker 接续**原 Child 与分配版本**。

新 Agent 首次机器输入必须表明它是前代错误重启、给出原始错误、最新 Memory/Reply/Note、已完成成果、未知副作用与 `next_reads`；绝不伪造原代成功，更不能重跑已经成功的外部操作。相同配置错误无有效新进展时不得无限重启消耗 Token，具体依赖交给 Foreground 明确提示。监控和简单调度状态修复完全是宿主程序动作，**不启动 Helper 或额外模型巡检**。

## F. 任务完成后的 records.md 和程序清理

Root Task 全部验收后，Planner 写最后的验收与实际产物引用并提交语义 `complete`；程序立即生成**包含原文来源**的完整 `records.md` 逻辑档案并保存于同 Domain `records/<taskId>/...`，回读校验哈希和 sealed manifest。只有核验完成，程序才自动删除该 Task 的临时 Task/Plan/Planner Memory/Note/Worker Reply/Checkpoint/执行交接/故障等待等 Key，并释放实际 Planner/Worker Agent/Session 运行态、Job 与资源占用。原始 Foreground 需求、逐日聊天、持久 Knowledge、已验收项目和完整 records 档案必须保留。

不让 AI 执行固定删除命令；程序调用 StoragePort 的精确 Key 删除。归档失败保留源记录并反馈具体故障；半途停止从回执继续清剩余项，不重新执行用户业务。工程实体输出保留在原 Workspace；用户需要时从 Domain 导出物理 `records.md` 副本，但这不是归档唯一权威。DSH 的原生 Session 日志清理须单独按 DSH 官方能力处理，不擅自视其 archive = 实际磁盘删除。

## G. 记录容量 UI（本次落实代码）

**只计 `deepseek_servant` Domain 的实际记录正文容量。** 不加 DSH 原生前后台 Session 日志、不加用户工程文件。

```text
┌────────────────────────────────────────────────────────┐
│ Servant 记录管理                          总计 869 B    │
├───────────────────────────┬────────────────────────────┤
│ 前台完整聊天          0 B │ 活动任务 / Plan        0 B │
│ 助理身份与设置      869 B │ Planner Memory        0 B │
│ 知识与技能            0 B │ Planner Note          0 B │
│ 原始任务需求          0 B │ Worker Reply          0 B │
│ 已完成任务档案        0 B │ 执行 / 交接记录       0 B │
│ 历史任务索引          0 B │ 故障 / 等待记录       0 B │
├───────────────────────────┼────────────────────────────┤
│ 长期合计            869 B │ 任务合计              0 B │
└───────────────────────────┴────────────────────────────┘
```

表内数值是展示布局示例，真实 UI 从 Domain 的当前 Keys 读出并自动更新。旧版 `task:<id>` JSON 里尚未抽离的 `decisions`、`plannerNote`、`reports`、`executions` 等，统计程序按原 JSON 字段长度分摊到对应栏目，**整体只计一次**；旧 Task 剩余部分归“活动任务 / Plan”。左列＋右列＝顶部总量。折叠的旧清理设置仍可手动使用，但不在默认表格下重复展示大段说明或原生 Session 日志。

## H. 现状、缺口和实施边界

- **已实现于本次仓库更新的范围**：容量统计 DTO、读 Domain Keys 的 API、存储变更后自动刷新 UI、对旧聚合 Task 的分类、六行×两列的简洁布局、中英文文案与保留既有折叠式清理控制。没有改变真实数据存储位置和现有运行时清理行为。
- **尚待实现**：设置页 Worker 并发席位（默认 2，可配置 1～32）持久化与运行时更新、Planner 每次规划/评审时获得真实并发容量快照；前台每轮新 Session 与按日完整原文，固定六轮自动装载/历史搜索；Planner/Worker 独立 Domain Keys 与自主读写；增量 Plan/未完成规划中途 handoff；完全去除 Helper 及同角色异常重启；任务终态 records.md 写入/封口/自动精确清理；Native Session 物理清理兼容等。这些是相互配套的下一阶段任务，不能当作本次 UI 已经实施。
- 旧版 DSH `storageDomain` 对版本与 schema 有严格校验，未来迁移需要保持旧记录可读，不可直接提高版本导致宿主无法打开；原生 DSH Storage Domain 不是普通 Agent Workspace，日常直接读写应通过 DSS 的 Domain-bound 受控原生工具，不进行“复制回去覆盖”的中转操作。

## I. GitHub 实验性集成：复用 dsh-github，用户在 DSS 设置中配置 Token（2026-10-25）

**最新用户需求：** 将 [PerryLink/dsh-github](https://github.com/PerryLink/dsh-github) 的 GitHub 集成能力纳入 DSS，作为 **用户自愿启用的实验功能**，在 DSS 自身设置页配置 GitHub Token。此功能应与现有 Foreground、Planner、Worker 的正常任务链配合使用，保留 DSS 已确认的存储、上下文、任务生命周期和兼容性原则。此节为实施设计，尚未写入 DSS 正式运行代码。

**已核对上游源码：** 上游公开仓库许可证为 `Apache-2.0`；参考 `v0.7.27`（2026-10-23 Release）和 2026-10-24 `main` commit `02bb9565bd1be132e3a942b828b8d8b4b5693da6`。上游已实现 `gh_repo`、`gh_file`、`gh_repo_search`、`gh_search`、`gh_review`、`gh_issue`、`gh_checks`，以及 `pr_create/pr_update/pr_merge`、`issue_open/issue_comment/issue_close`、`review_post`，并有按需 PR 审查、`/ci`、可选 CI 机器人；GitHub Token 由官方 DSH Credentials 服务解析，非普通插件配置字段。源代码参考和许可证必须在实现时保留归属与必要 NOTICE。

### I.1 目标交互

- DSS「设置」中增加简洁的 **GitHub（实验性）** 区域：启用开关、GitHub Token 密码输入、已配置/未配置状态，以及可选的默认 `owner/repo`。保持现有 UI 风格，不添加重复的第二套设置页。
- 默认不调用 GitHub、不启动 GitHub 轮询任务；用户开启后，本 DSS 的授权 Foreground/Planner/Worker 可以调用对应 GitHub 工具。Planner 可根据既有任务目标规划 GitHub 工作，Worker 执行实际仓库/PR/Issue 相关子任务；前台处理用户直接要求。
- Token 的用户配置入口参考上游 `src/client.ts` 已验证设计：使用 DSH 客户端 `remote.credentials.describe([tokenRef])` 查询**配置状态**，经 `remote.credentials.set(tokenRef, token)` 将用户输入的 Token 写入 DSH Credentials；Host 通过 `ctx.credentials.resolve(credentialRef(tokenRef))` **逐次操作读取**。默认引用名可沿用上游 `GITHUB_TOKEN`。输入框为 password，保存后清空，不从 Host 向浏览器回传既存明文。Token 不放进 `deepseek_servant` 普通 JSON、提示词、Session、Worker Reply、日志或 `records.md`。
- 启用标记、`tokenRef`、可选默认仓库、CI 可选项等**非秘密配置**保留在原有 `deepseek_servant` Storage Domain。Token 放在 DSH 官方凭据容器，是有明确权限语义的凭据数据，不改变 DSS 内部业务记录的统一存储位置。
- 提供明确的连通性验证状态，验证时经上游 REST 客户端发出真实只读请求，显示结果/错误类型，不泄露 Token。Token 更新下次调用即生效，不重启完整 DSS，也不因未配置 Token 阻止 DSS 其他功能。

### I.2 集成方式和权限边界

- **复用上游 GitHub 实现**，而不是复制 API 表面名称却另造不同 GitHub 行为。优先评估把上游所需模块作为 **DSS 包内可交付的组件**进行作用域注册，安装一份 DSS 即可使用这一实验功能；不要要求用户另外安装一套 dsh-github 才能用。现有独立 dsh-github 已安装时应避免重复注册同名工具/命令。
- **不把上游 `package.json` 的 `engines.dsh >=0.2.1-0 <0.3.0` 或复杂精确 peer ranges 原样作为 DSS 宿主准入限制。** 这是上游包自己的声明，不是 DSS 的版本锁。DSS 原有“宿主依实际 API 能力与错误判定兼容性”原则继续适用。若选择依赖打包，必须核验最终安装包/依赖解析不会重新添加硬版本阻断。
- 实际注册遵守 DSS 现有 Host → Agent scope → `ctx.tools` 体系，**只有启用时**注册/暴露相关 GitHub 能力，停用后按实际作用域释放；不越过原有 TaskService、ExecutionBinding、原生 DSH 权限。GitHub 操作应以真实任务和用户输入为来源，不能由 GitHub 返回的外部文本冒充用户的新授权。
- GitHub 写操作复用上游已有的 **DSH 原生 Approval/Tools 机制**及宿主实际策略，不再额外叠加 DSS 自创审批、二次确认、版本检查或任意拒绝条件。Token/凭据必须保密，外部 GitHub 响应作为外部资料处理。
- 上游 `ci.enabled` 默认 `false`，所以 DSS 初始实验开关启用并不自动打开轮询 CI 机器人。PR/Issue/Repo 工具可按实际请求使用；用户如独立启用 CI 功能，再按照原功能和真实宿主 Job 事件工作。不要为监控 CI 消耗周期性 AI Token。
- 此项整合提供 GitHub 工具能力。跨设备 Planner/Worker Task 状态同步仍按已确定的 DSS Task/Memory/GitHub 协作架构另行完成，不把 GitHub API 工具接入当作远程任务执行闭环已经验收。

### I.3 要求 Codex 实测的闭环

1. **单份 DSS 安装包**在真实 DSH 中包含可用 GitHub 实验功能，默认关闭，不改变普通聊天、Planner/Worker、运行内存与 UI。
2. 设置中保存/更新 GitHub Token 后客户端只得到是否已配置，网络请求可真实使用新凭据；重启后仍有效。替换 Token 后不需修改普通 Domain JSON 中的任何明文。
3. 启用后至少能实际查询私有仓库、读取文件、搜索仓库/Issue/PR、查看 checks；写操作在宿主允许时能完成真实 PR/Issue 工作并返回结果引用。工具注册不与单独安装的 dsh-github 重复冲突。
4. GitHub 相关操作可被现有 Worker 用作 Child 工作的一部分，符合本 DSS Task/Memory/结果归档接口；Agent 换代与异常同角色重启后仍可使用凭据，但 Token 不进入任何 AI 上下文。
5. 禁用后不影响 DSS 其他功能，外部授权与凭据仍按用户原有设置保留；不因为关闭插件就擅自销毁用户的 GitHub 登录。
6. 检查 TypeScript、bundle、pack、最终包许可证/NOTICE、中英文 UI，按可用 DSH 版本实际测试，不能用上游包的版本字符串人为拒绝宿主；对不可用实际接口给出真实具体错误。

## J. 详细审查与先前讨论原文索引

以下是此前已经存在的详细设计资料，保存在私人临时 Git 仓库 `Tests4gptplay/temp/DSS/`，本文件为集中入口，相关旧主张以本文件的新决定为准。

- [Task/Memory 分离与 Planner/Worker 接续](https://github.com/Tests4gptplay/temp/blob/main/DSS/PLANNER_MEMORY_TASK_SEPARATION_DESIGN_20261025.md)
- [Foreground 每轮 Agent 换代与固定六轮](https://github.com/Tests4gptplay/temp/blob/main/DSS/FOREGROUND_PER_TURN_AGENT_ROTATION_20261025.md)
- [Foreground 日期原文归档](https://github.com/Tests4gptplay/temp/blob/main/DSS/FRONTEND_DAILY_CHAT_HISTORY_DESIGN_20261025.md)
- [取消 Helper 与原角色错误重启](https://github.com/Tests4gptplay/temp/blob/main/DSS/ROLE_ERROR_RESTART_NO_HELPER_DESIGN_20261025.md)
- [Task 终态 records.md 与自动清理](https://github.com/Tests4gptplay/temp/blob/main/DSS/TASK_TERMINAL_RECORD_CLEANUP_DESIGN_20261025.md)
- [统一 deepseek_servant 存储域](https://github.com/Tests4gptplay/temp/blob/main/DSS/UNIFIED_DEEPSEEK_SERVANT_STORAGE_DOMAIN_20261025.md)
- [本次记录 UI 左长期／右任务方案](https://github.com/Tests4gptplay/temp/blob/main/DSS/RECORD_STORAGE_UI_TWO_COLUMN_DESIGN_20261025.md)
- [CAH 到 DSS 原始差异审查](https://github.com/Tests4gptplay/temp/blob/main/DSS/CAH_TO_DSS_CONTINUITY_GAP_AUDIT_20261025.md)
