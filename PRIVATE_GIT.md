# DSS-cah 私有 Git 协作

版本：`0.2.2`。在标准模式之外按需启用的实验性协作模式；两种模式独立保存设置与运行状态，切换页面后已开始的任务继续运行。

## 连接与设置

1. 在页面齿轮或全局设置的 DeepSeek Servant 中启用 DSS-cah。
2. 选择已授权的私有仓库 `owner/repo`、仓库内子目录、本实例工作目录、模型、预设和 Worker 席位。
3. 使用已有 GitHub 集成凭据、DSH Credentials 或已登录的 GitHub CLI。系统需要可执行的 Git；DSS 复用已有授权。
4. 点击“连接私有仓库”。程序核对实际账户、私有性和权限；空仓库在首次提交时建立默认分支。
5. 从 DSS-cah 对话提交目标，或启用“接收远端任务与控制指令”。

**任务记忆将直接写入 Git。** 对话、计划、状态、记忆、结果与归档保存在选择的目录及提交历史中，仓库成员可以读取。协作者的权限覆盖整个仓库；请使用授权的专用私库。凭据和本机工作目录保留在本机。成员区支持查看协作者、邀请及撤销邀请；受邀方在 GitHub 接受。

## 远端变更通知

启用远端接收或存在活动工作时，Host 每轮同步结束后以 1 秒正常间隔增量 fetch。并发请求合并为同一轮，网络错误沿用退避；空闲检查无需启动模型、Session 或浏览器。相同 HEAD 复用已读取的路径、目录和缺失记录缓存。Host 消费当前执行的独立状态记录；普通业务文档的新增、修改和删除只提供路径、提交及父提交，由 AI 按需读正文并判断下一步。

- 新增任务文档可成为新目标；修改用于调整已有工作；删除也是通知事件。
- 文档采用项目适合的格式，无须遵循固定 inbox JSON。
- AI 通过 `coop_changes` 分页列出变更，使用 `coop_read` 按路径和版本读取正文。删除内容需要时从父提交回查。
- 任务、历史、对话与知识按需读取；UI 在打开相关页面时读取显示内容。
- 实例自己的输出带提交标记，避免自身写入反复唤醒模型。

## 协作与控制

Foreground 理解目标与修订；Planner 拆分、协调、检查并验收成果；Worker 在本实例工作区执行。每个参与者使用自己的 DSH Agent、Session、Jobs、模型与席位。可从前台发起任务，或指明要协助的任务和本机范围；暂停、继续、退出、取消与修订均写入 Git。

Git 保存任务状态、角色动作、执行绑定及操作回执。本地保存实际运行归属、缓存和待提交草稿。正常重启从 Git 与原生 Session 接续；明确的暂停和取消继续生效。并发修改只核对受影响路径，无关更新保留并合入。

## Git 完成信号

DSS-cah 参照 [CAH 角色分工](https://github.com/Tests4gptplay/chat-agent-harness/tree/main/docs/task-cell)，通过自身的原生工具、写入器与 Consumer 实现以下顺序：

1. Host 先提交远端启动状态与执行绑定，后续同步读回后才启动原生角色。
2. AI 使用 `coop_commit` 保存自己负责的业务内容。每次 `entry` 返回已提交记录的 `textPath`。
3. AI 最后调用 `outcome`，仅传已保存的角色记录引用及 `turn_signal`。Host 保存绑定 Result，另一次远端事务读到 Result 后追加最终状态。
4. Consumer 从后续远端快照读取状态，再推进本地调度。提交回执、正文保存或原生聊天结束只请求同步；最终状态提交中断时从草稿或已保存的远端 Result 续接。

| 角色 | 先保存的业务内容 | 最后提交的引用 |
| --- | --- | --- |
| Foreground | `root` 的需求与初始计划，或 `join/revise/control`；`entry kind=reply` 保存用户答复 | `replyPath`；托管交接另带 `taskId` |
| Planner | `root_plan/proposal/claim/participant_plan/review/report/accept`；`entry kind=memory` 保存本轮决策；需要更新分解和待办时使用 `kind=note` | `memoryPath`，以及本轮新增的 `notePath` |
| Worker | 实际产物；`entry kind=reply` 保存 Child Reply，其中包含进度、证据、剩余工作及交接内容 | `replyPath` |

Planner 的子任务评审和纠正指令由 `review` / `participant_plan` 写入。三个角色的预设、工具 schema 和写入端共用这些职责约定。

AI 正文、操作记录与启动/完成状态以新文件追加。Host 维护当前 action、计划及指派索引；结束消费不再重写 AI Result。状态位于 `dss-coop/status/` 对应任务/执行目录，任务封存时一并收入 records，再清理热记录。

| 角色 | 信号与下一步 |
| --- | --- |
| Worker | `continue` 接续下一代；`complete`、`blocked`、`error` 交给 Planner 检查 |
| Planner | `done`、`rework` 派发已规划的子任务；`handoff` 换代；`wait` 等待；`need_user` 向前台提出问题；`error` 通知前台；`complete` 完成已验收任务 |
| Foreground | `respond` 完成本次答复；`handoff_planner` 交给对应任务的 Planner |

正常 Git 同步读到已绑定的最终信号后推进调度，不等待原生聊天回复结束。Worker 的完成信号进入 Planner 的子任务验收。原生执行收尾期间继续保留实际运行归属和席位，收尾记录写入 Git 后再归档。旧版已提交结果仍可消费；未结束的旧执行沿用原绑定，先补写新版远端启动状态，再使用新版角色契约续作。

## 模型与缓存

DSS-cah 的 Auto 统一跟随 Host 默认模型，界面显示与后台执行一致。标准模式的已接受模型选择行为保持原样。

任务结束后保留完整记录、成果和 Git 历史，释放已完成动作、读取投影及重试缓存。切换仓库或子目录时清理退役的本地 Git 缓存。未提交草稿及仍运行或暂停等待的工作保留。

安装方式见 [安装指南](docs/INSTALLATION.md)。
