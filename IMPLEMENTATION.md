# DeepSeek Servant 实现说明

版本：`0.2.3`。双模式架构见 [DESIGN.md](DESIGN.md)，协作操作见 [PRIVATE_GIT.md](PRIVATE_GIT.md)，Local 已接受运行记录见[alpha.39 验收](docs/acceptance-20261026.md)。

## 0.2.3 共用前台与工作随记

`SharedForeground` 位于组合层，合并 Local / Git 的对话与任务显示，将新输入交给所选后台。模式菜单保留当前页面和输入草稿；Git 前台沿用输入框模型与前台工作区，任务仍通过独立 Coop Consumer 执行。

`foreground-memory.ts` 共用两份文档的用途与维护约定。Local 通过原生记录存储保存，Git 通过受角色绑定的 `foreground_memory` 操作更新当前 Markdown；空文本删除。安装角色工具时只提供用途、路径与按需读取方法，不加载文档正文。List 的 7 天提醒、30 天确认与 Cache 清理由前台在普通对话轮次执行，无额外定时唤醒。

`repository-guide.ts` 管理所选目录 README 的独立区段，保留自有文案；仅内容版本或仓库范围变化时发布。README 与助手随记属于协议路径，内部更新不触发业务任务通知。

## 0.2.2 角色记录与远端状态

`protocol.ts` 的 `roleCommandSchema` 同时用于模型工具参数与 RoleWriter 校验；实际角色 Markdown 位于 `src/experimental/private-git/prompts`。Foreground 保存用户答复，Planner 保存 Memory、按需更新 Plan Note 并执行计划/评审操作，Worker 保存 Child Reply。操作与返回路径见 [角色写入顺序](PRIVATE_GIT.md#git-完成信号)。

`status.ts` 为每次执行追加 started、completed、closed 或 replaced 状态。Consumer 先写启动状态，再由后续快照启动原生执行；RoleWriter 先保存角色正文，随后保存 Result 引用，再独立追加 completed。消费端按远端完成状态推进，保留 AI 原文。正文已提交而最终状态中断时，可从远端 Result 恢复最后一步；旧的已完成结果继续可读，旧的未完成 action 在续作前升级启动契约。

正常同步间隔为 1 秒，保留单轮合并与网络退避。未改变的 HEAD 复用元数据、目录与缺失路径缓存；账户/仓库验证结果按配置及凭据身份复用，实际写入重新核对私有性与权限。任务状态和指派的本地消费以发布者最终远端状态为准。封存包含独立状态记录。

## 0.2.1 DSS-cah

Host 使用独立 bare partial clone 增量 fetch，检测选定目录的路径、A/M/D 状态、提交和父提交。Consumer 读取相关任务的绑定、计划、控制及结果正文，按当前执行的 `turn_signal` 派发；普通业务文档才生成 Foreground 变更通知，由 AI 使用 `coop_changes` / `coop_read` 按需读取。自身写入带实例 trailer，内部协议路径不触发通用通知。变更通知与已消费游标在同一 Git 提交保存，冷启动从 Git 恢复调度；UI 打开时按需读取展示页。

完成信号参考 CAH `local_bridge/planner_runtime.py` 的 `observe_semantic_turn` / `planner_runtime_tick` 及 `docs/task-cell/WORKER.md`、`PLANNER.md`。DSS 的 `outcome.ts` 将角色信号转为内部状态，精确匹配当前 action 的任务、执行及输出路径。`coop_commit` 自动注入绑定，新工具参数只显示当前角色的信号。Consumer 在 Git 确认后推进角色，不以原生 turn/end 作为前提；仍在收尾的原生执行由现有事件回收，并在归档前保存记录。旧版 kind/resultStatus 结果继续兼容。

Git 操作使用显式 GIT_DIR，缓存目录与任何上级工程隔离。写入在临时索引构造，仅比较受影响的读写路径；无关远端更新直接保留并合入。GitHub API 用于核对账户、实际私有性、权限与成员；凭据复用 DSH Credentials、环境及已有 CLI 登录。

## alpha.41 稳定性修复

单条损坏记录、任务或协作原文分别报告，健康数据继续可读写；损坏原件保留，修复后沿正常操作恢复。目录派生标记损坏时先备份原字节再重建。模型设置修正和重新连接可恢复原有失败任务，旧连接和界面响应按当前上下文收束。任务列表提供完整分页，席位、记录策略及标识长度按实际数据表示能力处理。

## alpha.40 独立协作实现

`src/mode-router` 只路由新输入与界面选择；`src/experimental/private-git` 独立拥有设置、Git I/O、角色提示、状态机、调度、原生 Agent、页面和封存。GitJournal 以稳定回执和非强推 CAS 提交；Consumer 读取不可变提交后兑现动作，NativeAgents 使用实际 Session、工具操作身份和 Jobs。用户主动参与与当前指派共同决定本机工作范围。

协作使用 `deepseek_servant_coop` 原生 Domain。GitHub 凭据来自原生 Credentials、环境或已登录 CLI；完整协作记录写入专用私库。原生存储键采用路径安全摘要，保留逻辑键用于投影与恢复。协议参数错误转为可读证据，网络失败保持待提交草稿。当前代码的协作验收见[alpha.40 开发验收](docs/acceptance-private-git-20261026.md)。

下文保留 Local 的实现与历次运行记录。

**设计来源：**[Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness)，在 DSH 中实现其持续任务、Agent 角色分工、工作接续与知识积累机制。

## 模块交付与宿主集成

本仓库提供插件生产源码、构建配置和开发说明。`build`、`typecheck` 为显式工程命令；`npm pack --ignore-scripts` 使用正式文件白名单收录 Host/Client JS、许可证、NOTICE 和必要说明；发行构建关闭 source map。模型转接与实验素材在隔离验证环境中使用。

任务和知识持久化在 DSH 的 `storageDomain`。模型调用、文件与命令工具、Session、jobs 和 Skills 使用宿主现有服务；当前模式的任务流转在所属 DSH 实例的后端完成。Client 通过宿主已认证的 Connection/RPC 与流事件通道交互。

当前 Windows 运行验收使用 DSH `0.2.1-rc.3`。此前 API 基线为官方源码标签 `dsh-v0.2.1-rc.2`、提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。DSH API 适配集中在 `src/adapters/dsh`，插件按实际服务接口运行，不以宿主版本字符串拦截启动。

## 插件标识与存储域

显示名称为 **DeepSeek Servant**，包名及插件 ID 为 `deepseek-servant`，持久化 domain 为 `deepseek_servant`。原生消息来源、RPC 路径、会话前缀和 scoped Skill 前缀使用统一的 Servant 标识。升级继续使用原存储域与目录指针，旧版内嵌字段按稳定身份迁移。

## 文件与模块

| 模块 | 入口 | 负责的工作 |
| --- | --- | --- |
| Host | `src/host.ts` | 装配服务、持有后台生命周期、接入宿主、关闭时收敛拥有的资源 |
| 用户接入 | `application/assistant-service.ts`、`api.ts` | 消息持久接纳、前台 Session、独立设置、稳定交付与用户控制 |
| 任务权威 | `application/task-service.ts`、`servant-store.ts`、`domain/task.ts` | 唯一任务写入口、命令去重、纯状态转换、同记录提交动作 |
| 运行协调 | `runtime/coordinator.ts`、`scheduler.ts` | 依赖、席位、写域、等待、派发、恢复与本地幂等兑现 |
| 实际所有权 | `runtime/agent-supervisor.ts` | 创建/持有/停止/释放确切 Agent，观察其模型回合和精确作业 |
| 工作原文与上下文 | `application/record-journal.ts`、`task-records.ts`、`task-record-access.ts`、`runtime/context-assembler.ts` | 同域独立原文、当前机器状态、工作前沿与作用域分页读取 |
| 知识与技能 | `application/knowledge-service.ts`、`adapters/dsh/skills.ts` | 候选、验证、版本、真实加载和结果反馈，发布原生 scoped provider |
| 角色工具 | `roles/tools.ts`、前台及后台角色契约 | 实际 Agent 绑定的能力；Planner 判断方法和质量，代码检验身份和状态 |
| 读取与界面 | `application/query-service.ts`、`client.tsx`、`client/` | 原生独立页面、对话、任务、产物、知识、设置与清理操作 |
| 封存与清理 | `application/task-archive-store.ts`、`retention-service.ts`、`storage-usage.ts`、`domain/retention.ts` | 完整 records、精确临时清理、历史入口与技能维护、实际容量统计 |

## 正常任务调用链

用户的消息先在 Assistant 保存稳定 messageId 和正文指纹，再进入独立前台 Session。Foreground 理解原消息，用实际已接纳的用户来源提交 GoalContract。通知类消息不能借用早先用户消息生成新的用户授权。

模型无需编造消息编号。服务端从当前原生回合已消费的用户输入绑定来源，自动构造稳定命令身份。前台未消费的消息或交付在关闭后按原生 inbox 记录恢复；失活的未消费 claim 使用原消息身份重新接纳。已消费但被宿主中断的输入恢复原 Session，以隐藏的接续消息继续回复，并将完成结果归于原始输入。明确取消与终结错误按原流程收尾。用户仍可调整配置或正常发送新的消息。

`TaskService.submit` 将 Task、命令回执和 `plan` 动作一次提交。RuntimeCoordinator 收到提交事件，在满足用户控制和资源条件后保存 `action.claim`。Supervisor 再保存 execution/session 身份，最后创建原生 Agent、装入所选 preset 和角色能力、注入该动作的稳定输入。没有保存成功就没有原生派发。

Planner 用 `planning.commit` 保存正式 Plan 和子任务。Worker 席位默认两个，可在设置页保存为 1–32，已有 Host 配置用于初始化。持久设置立即影响后续调度与新 Planner 的容量快照；降低席位不停止当前所有者。该配置独立于 DSH 的全局模型并发限制。每个 Worker 仍由其原生 Agent 串行处理自己的模型回合。Worker `execution_report` 通过 executionId、assignmentVersion 和 resultId 核对，不让正常并发报告竞争一个旧 Task revision。

终结报告关闭该 Worker 的业务能力，持久成功后通过原生 `concludeTurn` 结束当前模型回合；后续业务提交按有效执行归属处理。实际 Agent 如仍有本机 jobs，则继续保有其物理归属；业务结果和作业退出分别记录。

Planner 读取实际产物和证据后，通过 `planning.decide` 接受、返工或继续。代码只检查当前目标、计划、子任务结果及动作条件，不代替 Planner 判断质量。完整交付需当前计划全部验收，随后由持久 `deliver` 动作交给前台，并保存稳定通知标识。

界面页面关闭只移除订阅。Backend 仍持有任务与 Agent。关闭 Backend 会停止其实际拥有的资源并保存中断位置，后端再次启动时从本地状态恢复。

## 原生能力与权限边界

角色工具从宿主的真实 Agent 对象和绑定记录获得身份；模型参数不能指定自己的角色或执行所有权。用户可从已认证 Client 回答等待问题，也可在当前聊天中答复，由 `task_answer` 绑定实际消息身份并转交原文。未知执行的人工核对仍由已认证 Client API 提供。

普通角色沿用所选 preset 的模型和本机工具。会在 Servant 所有权之外另起 Agent 的 `subagent`、`subagent_fork`、`workflow`，以及单独排程工具，暂不允许绕过本插件的协调器。已有全局工具通过原生限制隐藏；作用域工具在原生执行前入口拒绝。需要并行工作时，由正式 Plan 产生可跟踪的 Child 和 Worker。

Client 使用 DSH 原生模块加载器格式和共享组件，不另装一套应用路由。侧边栏顺序为 20，位于自动化任务之后。工作区设置独立于当前普通聊天，默认取宿主默认目录。改变前台模型/preset/工作区时，如果前台仍在执行，会返回明确的忙状态；在空闲边界保存新配置并轮换 Session，历史仍可读取。既有后台 Task 保持其创建时的工作区和模型快照。

任务详情可以暂停、恢复、取消、停止确切执行、回答问题、修改目标和优先级。优先级默认为 0，较大整数优先选择，不抢占正在执行的工作。只有旧执行物理状态为 unknown 时才出现人工核对入口，要求填写已核实的事实；正常派发不经过此入口。

## 当前实例的任务工作记忆

任务接续借鉴 CAH 的角色责任、目标约定、工作前沿和结果评价思想，在 DSH 内使用本地持久记录实现，不依赖 Git 提交或外部 Task Cell。

权威顺序是当前用户目标、正式 Plan、已保存工作事实和评价。原始要求及其修订记录可回查；旧计划或可变 Note 不能覆盖当前目标。Planner 的结构化记录包含选择、返工理由、失败方法、假设变化和恢复依据。`planning.checkpoint` 可以保存有意义的规划进度，且不触发派发；Plan Note 自己带 revision，并在同一次 Task 提交记录其修改或采用理由。

Worker checkpoint 保存已完成部分、失败方法/观察/证据、剩余工作、下一动作与下一读取位置。同一 Child 的工作、评审、恢复原文由同一 Domain 的分离记录保存，TaskService 组装当前事实及引用。新 Worker 通过这些记录继续同一个业务子任务。

ContextAssembler 为角色提供有限的当前工作输入，近期工作、失败及已回答等待默认各 6 条、Planner 热子任务摘要最多 24 条、作用域事实最多 24 条。省略的内容附有精确引用；`memory_query` 只分页读取本地已保存的记录，每页最多 50 条。Worker 只能读取自己的工作、相关依赖和恢复记录。用户回答包含问题、答案、恢复条件和确切原所有者；同一 waitId 再次使用也不会覆盖先前回答快照。角色输入不会复制全部聊天或所有任务历史，原生 Skill 正文仍由宿主按需加载。

## 技能积累与纠正

实际结果或有证据的失败可以产生候选。失败来源不会直接获得可用状态；激活必须绑定准确版本内容哈希、当前作用域、已接受结果和其中实际存在的产物引用。修订带 expectedVersion，不继承旧版的验证结论。用户编辑形成新候选，旧版可用状态保留至新版本真正验证。

原生 Skill provider 发布当前作用域中的可用版本。仅在原生 `skill` 工具成功加载后记录实际使用；目录预览不算一次使用。结果评价产生持久反馈动作，将同一个 execution 的真实加载与后续成功/失败联系起来。任务可以不产生任何新技能。

## 正常 Worker 换代

`0.1.0-alpha.2` 增加明确的 `handoff` 报告。它是仍有剩余工作的正常接续：同一记录保存 checkpoint 和前驱执行引用，关闭旧语义权限，保留 Child、assignmentVersion 和累计工作段数。后继复用现有 `dispatch` 动作；只有精确前驱的物理所有者与作业收束后，才绑定新的 execution、Session 和 generation。新实例直接收到当前目标、保存前沿、相关历史与精确回查引用，第一轮即开始实际工作。

`continue` 仍在原 Worker 中续作；`handoff` 才请求新的 Worker 上下文。正常换代不伪装成失败或返工，也不重建已接受成果。正在运行的作业仍属于旧 Agent，不能保存 jobId 后销毁旧 Agent并宣称迁移成功。

默认每 5 个有效 `continue/handoff` 工作段触发 Planner 周期评审，计数跨 generation 保留；`progress` 不计段，`complete/failed` 立即评价。`handoff` 正好落在评审点时，先由新的 Planner 判断实际进展和方法，`continue` 决策才允许后继派发。暂停、目标修订及相同任务规格的重规划不能绕过已经到期的评审。这个计数不是 token 门槛或原生模型回合数；本插件没有为此增加一套历史压缩器或固定时间轮换器。

Worker 报告可以先于原派发动作的完成回执到达。原派发仍为 running 时，新派发会被去重规则暂时合并；原动作完成或恢复核对结束后，协调器再次检查已保存的派发条件，使正常后继继续兑现。这里沿用现有事件与动作通道。

## 恢复与失败

恢复读取保存的 Task、原生 Session、当前租约、Agent 和运行中的 Job。仍有实际所有者时保留其归属；原生回合已经正常结束、Inbox 为空且报告和作业状态收束的 Worker，可恢复同一个空闲 execution/session。

保存了派发 claim 但尚无 execution binding 的动作可重新排队。原运行已经消失时，保存未收尾工具、排队输入与旧 Job 等 `interruption` 现场，退休失活身份，从原工作前沿建立同角色后继。历史中断记录随恢复输入交给后继核对 Session 与实际产物，恢复本身可直接推进。

同角色新 generation 保留 Child、assignmentVersion、有效段计数与工作前沿；保存过的最终结果直接进入评价。普通工具报错继续由原执行处理。相同配置故障且没有新进展时进入具体等待，宿主中断独立处理。既有 Helper 历史可读，当前运行角色为 Foreground、Planner 和 Worker。

后台动作失败会保存明确等待或不确定状态，并向界面暴露原因；没有无上限自动重试、定时催模型继续或后台测试守护程序。持续推进来自已提交结果、作业事件、用户输入和满足等待条件后的动作。

## 完成后的清理

详见 [RETENTION.md](RETENTION.md)。当前版本先在同一 Domain 封存完整 records，唤醒前台交付，再自动释放终态 Task 的临时运行记录。封存内容落盘重读后发布清单；永久身份先保存，Task 热状态最后删除。

完整原始需求、规划与执行正文、成果证据和前台原文长期保留。手动清理和可选历史策略收起任务入口，旧技能按用户设置维护；清理中断后按已封存的准确键列表继续。records 可通过前台工具和任务详情导出 Markdown，原记录引用在清理后继续有效。

DSH 原生 Session 日志保存在宿主配置的目录。页面按 Domain 实际内容分别统计六项长期记录和六项临时记录，并提供原生日志目录入口。

## 构建与安装

统一入口见[安装、升级与开发构建](docs/INSTALLATION.md)。Node 版本、候选安装、固定 GitHub 来源约定及按改动选择的开发检查在该文档维护；包版本与依赖以 `package.json` / `package-lock.json` 为准。运行包采用明确白名单，历史文档和开发测试保留在源码库。

本次私有仓库整理仅维护文档及停用文件，复用已验收的 alpha.39 运行代码和候选包。

## 历史版本验证结果

以下为此前 alpha.2 / alpha.3 的运行记录；当前升级验收另列于文末。

功能场景运行于 DSH `0.2.1-rc.2`、Node `24.19.0` 的隔离 Web profile。此前 `alpha.2` 功能构建由 GPT 承担角色模型判断，实际文件操作、Agent、Session、持久化、派发和交付由 DSH 与插件执行；`alpha.3` 完成项目标识与接口命名调整，已进行源码级一致性核对。

| 场景 | 实际运行结果 |
| --- | --- |
| 单目标到实际交付 | 原生读取四行 CSV；第一次 shell 操作被宿主拒绝，Worker 保存失败前沿；新 Planner 改法，新 Worker 用允许的文件工具完成整数分报告，独立 Planner 再读原文和产物验收，前台交付总额 37.50 |
| 技能形成及后续复用 | 第一项 accepted 结果形成有边界的版本；第二项 Worker 通过原生 skill 加载该版本，生成并独立验收总额 1.40 的报告；真实加载与对应 success 反馈准确关联，技能加载与对应 success 反馈以 Worker 的真实执行为依据 |
| 两 Worker 并行 | 同一 Task 的 Alpha、Beta 在两个独立原生 Agent 中同时处于 running，各有独立写域；Alpha 先验收，Beta 保持其确切 owner |
| 提问及回答接续 | Planner 保存问题后结束该角色；用户答复进入正式等待记录，新 Planner 可从任务记忆读取“两条中文要点”，不依赖已退出 Planner 的对话 |
| 暂停、后端退出与恢复 | 暂停期间 Beta 保存 continue checkpoint，没有继续派发；实际停止并重启独立后端后，恢复同一 Beta execution/session，已验收 Alpha 文件哈希不变 |
| 修改目标与依赖派发 | 追加总览目标后，新 Plan 保留 Alpha、保留 Beta 原 assignment；Beta 从原前沿接续并验收后，依赖两个 accepted Child 的总览才派发；最终三个实际文件一起验收并交付 |
| 前台排队恢复 | 前台有一个已消费回合和第二条排队消息时退出后端；重启后第二条保持原身份和正文，只进入一次模型输入并产生真实回复，没有新增任务 |
| 任务记忆清理 | 第一轮归档前两项终态 Task，Servant 记录净回收 49,264 字节，仍活动的第三项受到保护；第三项完成后再次执行，归档再删除其详情，只留 294 字节身份记录，净回收 76,319 字节。全部 9 个工作区文件哈希不变，技能及成功反馈保留；两轮合计归档 18 个旧原生 Session，宿主日志回收如实为 0 |
| 优先级与偏好纠正 | 实际 API 将已完成任务优先级由 0 改为 3，没有产生新执行或改变交付；两条真实前台消息先保存、再读取并修正同一工作区偏好，版本从 1 到 2，来源准确指向第二条用户消息 |
| 原生 Client | 实际浏览器检查对话、任务、详情、知识、设置与清理页；独立入口位置正确，明暗主题和窄屏可用，未出现浏览器运行错误 |

第三项任务交付时三个 Child 均 accepted，待兑现动作、不确定动作、活动后台所有者和作业均为 0。重启前被明确退役的旧 Planner 保留 lost 历史事实，不改写成 stopped。三个场景结束均有真实前台交付消息。

第二轮清理后，Servant 自有记录总计 25,537 字节：包含两个仍受技能证据引用保护的瘦归档、当前技能与偏好、助手记录及最小任务身份。临时缩短的清理周期已恢复为默认值。原生后台 Session 日志仍占 509,902 字节，前台日志另计 127,055 字节；这些是实测保留量，不计为本插件释放的空间。

开发临时区的有限检查还覆盖单记录保存失败、正常并发报告、旧执行迟到结果、重复回执、作业 exact owner、暂停/回答接续、Helper 失败收敛、知识版本及清理引用。它们不进入插件启动、安装或运行流程。生产源代码严格类型检查与构建通过。

### 16 批长任务的实际结果

任务 `task-55898cc5d6f68506b47b917a3bbd9269` 使用 16 个有序批次、64 条合成事件，逐批处理真实文件。每批形成审计、更新账本和累计快照、通过原生工具读回，再保存正式报告。模型判断由相互隔离的 GPT 角色上下文承担；官方 DSH 执行工具、持有 Agent/Session、保存任务并兑现后续动作。

后台任务于 2026-10-24 07:29:01.670 UTC 创建，08:48:50.317 UTC 正式完成并送入前台交付，用时 **79 分 49 秒**。前台模型回复在 11:18:37.496 UTC 实际写入会话；两者之间等待本次验证端提供模型响应，分别记录时间。前台对话已回读确认，包含全部成果链接。

| 检查项 | 原生运行证据 |
| --- | --- |
| 连续工作 | 16 个正式报告：13 个 continue、2 个 handoff、1 个 complete；始终一个 Child，Goal/Plan revision 1、assignmentVersion 1 |
| 三次周期评审 | 默认 reviewEvery=5，在第 5、10、15 批实际派发 evaluate，新的 Planner 独立检查来源和产物后保存 continue |
| 第一次正常换代 | 第 6 批 handoff 后，旧 Worker closed/stopped 且 jobs 为空；第二代以新 execution/session 从第 7 批接续 |
| 评审与换代顺序 | 第 10 批 handoff 先持久为 reviewRequired=true；实际观察到仅 Planner 在评审、第三代尚未建立；continue 决定保存后，第三代才从第 11 批开始 |
| 同代继续 | 第 5 批评审后沿用第一代 Worker；第 15 批评审时第三代 idle 等待，评审后原 execution/session 恢复执行第 16 批 |
| 新上下文与旧记忆 | 第二、三代首个请求均没有旧 assistant/tool 消息，分别携带第 6、10 批的精确前驱与工作前沿。第三代开始时历史共 12 条，仅注入最近 6 条；第 11 批实际查询 report 02/03/05，第 16 批再次查询 02/09，原生结果均成功返回准确引用及历史条目 |
| 最终接受与交付 | 第五个 Planner 读取全部 19 项必需成果及恢复记录，核对最后一批、历史例外和此前三次正式评价，再保存 accept 与 Delivery。Task 为 completed，Child accepted，Delivery delivered |
| 所有权收束 | 三代 Worker 和五个 Planner 均 closed/stopped，owned jobs 为空；待兑现动作、不确定动作和未响应模型请求均为 0 |

独立计算答案在启动前保存在模型工作区外。32 行最终账本逐单元格一致；16 个累计快照在按 manifest 对齐批次标识后，金额与全部处置计数逐项一致。原规则只指定 batch 列，产物使用 `batch-01` 等文件名形式，检查脚本最初预设序号 `1`；保留了该次比较记录，并仅在临时检查脚本按 manifest 的序号/文件名关系对应。业务文件和预存答案保持原样，16 份原始批次数据 SHA-256 未变。

最终净额为 **2171.35 CNY**（books 280.58、tools 768.95、services 842.30、travel 279.52），32 笔交易中 28 笔 active、4 笔 void；60 个唯一事件已应用，3 条精确重放、1 条同 ID 冲突单独保留，待匹配为 0。早到退款的后续匹配、换代后的重放、已退款交易作废、类别迁移和合法更正均有原始位置及审计依据。前 6、10 批审计在后续换代中的文件哈希保持不变。

最终独立计算、正式运行记录和原生工具结果共同完成核对。离线轨迹检查通过 36 个条件，覆盖身份、报告顺序、评审、冷上下文接续、真实历史查询、产物保持和终态。开发区另有 7 个有限的换代边界检查，覆盖报告先于派发回执、晚到作业、恢复、暂停与到期评审等场景；这些检查均按次结束，保留在临时区。

长任务完成后通过正式清理 API，将其 246,638 字节任务记录归档并替换为 294 字节身份记录，净回收 **246,344 字节**。47 个工作区文件的哈希和已有知识记录保持一致，8 个原生后台 Session 完成归档。清理策略恢复默认后，整个临时 profile 的 Servant 自有记录为 28,334 字节；原生后台日志共 2,296,081 字节、前台日志 151,023 字节，原生日志物理回收为 0。详见 [RETENTION.md](RETENTION.md)。

后台进程的四个节点 RSS 采样约为 178、188、196、217 MiB，进程记录的 VmHWM 为 288 MiB。它们是本次有限运行的观测值。验证结束后临时后端正常退出，退出码 0；该次运行使用 `alpha.2` 功能构建；`alpha.3` 的源码级命名与接口调整另行核对。

### 历史实测环境与当时的后续项目

该轮实测环境为 Linux / DSH 0.2.1-rc.2，覆盖原生文件工具、长任务周期评审、两次正常 Worker 换代、最终交付和清理。当时列出的后续项目包括 Windows Electron、Codex 专有路由、跨天运行、原生 token 阈值压缩及活动 OS 作业的跨代处理。Linux 测试中的 shell 操作受到宿主沙箱限制，Worker 已采用原生文件工具完成相应业务。64 MiB 为当时的记录维护目标，宿主 Session 日志及工作区成果另行计量。

## alpha.39 恢复、历史阅读与长作业验收（2026-10-26）

- 冷启动检查当前原生 Agent、Session 租约和 Job 注册表。历史未收尾工具与 Job 保存为 interruption 现场，交给原角色后继继续工作。多次中断保持 Child、assignmentVersion、工作前沿和有效段计数；用户暂停、取消与实际存活所有者继续生效。
- 前台失活 claim 和已消费的中断回合均自动恢复；隐藏接续消息关联原始输入及其工具来源，稳定 task_submit 身份维持同一 Task。
- 用户在聊天中回答等待问题时，task_answer 直接转交当前用户原文，解除对应等待并接续规划；后台通知仍按结果交付处理。
- 删除 SSE 定时保活与重复席位检查，维持原生事件驱动调度。
- 历史上翻预加载、消息去重、失败重试和阅读锚点通过源码与真实组件测试；日历复用官方 ui-schedule 设计、官方 UI primitives 与主题变量，支持键盘导航、选择及清空日期。
- 73 项源码回归通过；实际 React 页面与官方 primitives 的 jsdom 测试通过。独立原生 SDK 场景在前台和 Worker 均执行期间，强制结束宿主及其子进程树；重新启动后保留旧文件，第二代 Worker 完成剩余文件，原 Task 完成 Planner 验收、前台主动交付和 records 封存清理。模型端为受控 SSE，Agent、Session、文件工具和后台 PowerShell Job 为原生实现。
- 当前宿主由真实对话入口经 `codex-local/gpt-6-astra` 路由完成原生静默 Job：持续 **1860.2037818 秒**、退出码 **0**，同一 Worker 持有同一 Job 直到完成。Planner 接受成果后前台主动交付，档案封存，临时 Task 清理，Jobs 列表为空。
- 候选包已通过原生插件管理器安装并应用；完整时间、执行身份、包清单与 SHA-256 见[alpha.39 验收记录](docs/acceptance-20261026.md)。

## alpha.37 升级验收（2026-10-26）

生产源码 `npm run typecheck`、`npm run build` 均退出 0。源码回归 `npm test` 通过 59 项；随后新增的 Domain 分类统计检查单独通过 1 项。覆盖完整记录与迁移、增量规划、工作段和评审、故障归属、席位调整、六次完整交互、归档失败与恢复、导出冲突、旧维护操作和已确认的 UI 状态逻辑。

### Windows 原生集成

在独立 DSH_HOME 与 SDK profile 中，用 DSH `0.2.1-rc.3` 的原生插件命令安装 `alpha.37` 候选。只有外部模型响应被替换为受控 SSE；Agent、Session、Inbox、工具执行、事件、配置和 Windows JSON storageDomain 均由真实宿主管理。测试没有访问生产 profile 或用户凭据，也没有开启浏览器。

| 场景 | 观测结果 |
| --- | --- |
| 前台接续 | 8 次问答逐条保存并进入不同物理 Session；随后种子只保留最近 6 次完整交互 |
| 长任务 | 同一 Child、3 代 Worker、16 份正式报告；13 次 continue、2 次 handoff、1 次 complete，即 15 个有效接续段；在 5/10/15 段评审，最终第 16 份报告验收 |
| 实际文件 | Worker 经原生 read/write 写出 16 行 `segment-1` 至 `segment-16`，最终逐字节符合预期 |
| 原生故障 | 第一代 Worker 收到真实原生模型错误；事故保存后第二代 Worker 接续，assignmentVersion 不变，产物为 `recovered`；两个任务均无新 Helper |
| 完成交付 | 完整 records 封存后程序唤醒前台，各产生一次结果留言；Delivery 为 delivered，最终档案为 ended，Task 热键删除 |
| records 导出 | 长任务 409,262 字节，SHA-256 `4df3594fbe0b7f18c02a90b9da6cf5035fc9d2dfe7301c62a0eb608d8791e726`；恢复任务 114,576 字节，SHA-256 `4a2a2cf385f9704320b27b399ee67c26fd53b1cf64ef1037ed1399f7de9bc8c6`；导出文件哈希与封存清单相同 |
| 后端重启 | 两项已清理 Task 的完整档案仍可回读，旧热键未复活，Domain 更新后的值及席位 3 保持 |
| 原生配置及迁移 | 新安装默认席位 2；实际 API 保存 3，重启读取 3，再保存 1、4、32，Scheduler 即时一致；迁移整个 records 目录后 probe 数据保持 |
| Domain 统计 | 迁移后逐键求和 1,675,454 字节，与服务统计一致；长期加临时等于总量，临时为 0，原生 Session 日志另存 |

隔离驱动的 `continue`、`restart` 命令均退出 0。长任务初次检查把最终 complete 也计入有效接续段，产生 15/16 的断言差异；仅修正验证脚本，随后直接读取已完成档案继续验收，未重跑任务或改动产物。Jobs/未知副作用、跨日期记录及错误重试边界由针对性源码回归覆盖。此处保留 alpha.37 当时的覆盖范围；后续 Codex 路由的 31 分钟原生静默作业已在 alpha.39 完成。已被用户接受的 Desktop 外观、透明插画、设置和 alpha.36 侧栏隐藏规则继续沿用。

### 首轮上下文比较

同一原生宿主、standard preset 与首次问候输入，按实际发送的 `system`、`tools`、`messages` JSON 使用 `o200k_base` 统一计数：alpha.36 为 **6,101**，alpha.37 为 **4,696**，减少 **1,405（约 23.0%）**；可见工具由 30 个降为 20 个。该计数用于相同输入的比较，不是模型供应商账单 Token。角色正文和旧原文按需读取，完整永久记录没有缩短。

