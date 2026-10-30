# DSS-cah 私有 Git 协作

当前使用说明。“对话 / 任务”旁的菜单在 `local` 与 `DSS-cah` 之间选择当前模式；对话、任务、分页和发送上下文按模式分开显示及使用，由前台理解目标后投递任务。既有后台工作继续运行。

## 当前可用范围

当前 Git 模式提供参与者与实例分工、任务及角色记录提交、读回消费、控制、接续和归档；Worker 在各自 DSH 实例的工作区运行。外部 Markdown（`inbox/`）和按目标参与者、实例绑定的 `conversations/` + `intents/` 远程输入已完成前台交流实验。仅写入 `conversations/` 的普通共享聊天尚未自动接入该消费流程；同步聊天记录与触发前台消费是不同环节。

## 连接与设置

1. 在页面齿轮或全局设置的 DeepSeek Servant 中启用 DSS-cah。
2. 填写私有仓库 `owner/repo`。仓库内目录留空、填 `.` 或 `/` 使用根目录；也可填写 `Maid`、`Maid/Sub`、`./Maid` 等子目录。本实例工作目录、模型、预设和 Worker 席位按需选择。
3. 准备 Git（`git`）与 GitHub CLI（`gh`），执行 `gh auth login --hostname github.com` 登录。DSS 直接使用当前 GitHub CLI 登录连接；安装命令和配置步骤见[依赖说明](docs/INSTALLATION.md#dss-cah-依赖)。
4. 点击“连接私有仓库”。首次连接自动创建所选目录、协作说明和参与者／实例基础配置；空仓库同时建立默认分支。
5. 在原对话框继续交流；前台确认执行需求后投递任务。外部投递可另行启用“接收远端任务与控制指令”。
6. 连接后，所选 Git 目录自动生成 README，说明外部 Markdown 投递、任务状态、中间记录、结果与各文件用途；已有 README 的自有内容保留。

**任务记忆将直接写入 Git。** 对话、计划、状态、记忆、结果与归档保存在选择的目录及提交历史中，仓库成员可以读取。协作者的权限覆盖整个仓库；请使用授权的专用私库。凭据和本机工作目录保留在本机。成员区支持查看协作者、邀请及撤销邀请；受邀方在 GitHub 接受。

## 记录路径与归档读取

仓库内目录是所有实际 Git 路径的前缀。目录留空时，记录位于仓库根目录下的 `records/`、`history/`、`assistants/` 等目录；设为 `Maid/Sub` 时则位于 `Maid/Sub/records/` 等目录。

`dss-coop/` 是 DSS 工具引用的固定前缀。`coop_read` 默认读取这种引用，也支持 `pathKind=repository` 读取实际仓库路径；结果中的 `repositoryPath` 和 `url` 可直接用于远端索引。归档及历史索引的 `repositoryPaths` 给出完整仓库相对路径。完成任务的旧工作记录引用会自动解析到归档 `sourceHead`，原始记录与固定提交链接继续可读。

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

Planner 为当前参与范围内、明确分配给本实例的工作写入 `participant_plan` 时，同步记录工作接受信息；`claim` 可单独记录更具体的范围，不是创建 Worker 前的额外步骤。同一目标的继续请求直接交给 Planner，并保留正在执行的 Worker。真正修改目标后，Planner 按新目标复核或更新方向，正常提交 `done` / `rework` 即可继续。

已发布但尚未评审的 Worker 结果会随暂停与恢复保留，Planner 获得其精确结果和正文引用。只保存了中间回复的执行仍是未完成状态；后继通过先前执行记录检查实际产物后接续。

AI 业务正文、操作记录与启动/完成状态以新文件追加；两份 Foreground 工作随记维护可改写的当前内容。Host 维护当前 action、计划及指派索引；结束消费不再重写 AI Result。状态的工具引用位于 `dss-coop/status/` 对应任务/执行目录，任务封存时一并收入 records，再清理热记录。

| 角色 | 信号与下一步 |
| --- | --- |
| Worker | `continue` 接续下一代；`complete`、`blocked`、`error` 交给 Planner 检查 |
| Planner | `done`、`rework` 派发已规划的子任务；`handoff` 换代；`wait` 等待；`need_user` 向前台提出问题；`error` 通知前台；`complete` 完成已验收任务 |
| Foreground | `respond` 完成本次答复；`handoff_planner` 交给对应任务的 Planner |

正常 Git 同步读到已绑定的最终信号后推进调度，不等待原生聊天回复结束。Worker 的完成信号进入 Planner 的子任务验收。原生执行收尾期间继续保留实际运行归属和席位，收尾记录写入 Git 后再归档。旧版已提交结果仍可消费；未结束的旧执行沿用原绑定，先补写新版远端启动状态，再使用新版角色契约续作。

## 模型与缓存

DSS-cah 前台跟随原对话框的模型、思考强度、预设与工作区；初次衔接可按需读取最近六次 Local 讨论的引用。后台模型和工作区使用协作设置，后台 Auto 跟随 Host 默认模型。

两种前台均提供 Foreground_List 和 Foreground_Cache，在记录管理中称为“工作规划记录 / Work Planning Notes”。Local 的独立目录、统计与清理关系见 [记录管理](RETENTION.md)；协作模式的正文继续由以下 Git 路径保存。List 保存重要交代及任务、对话、证据路径，完成项更新状态并保留；正常交流时检查 7 天无进展的提醒（每周最多一次）与 30 天搁置的确认，用户指定复查时间优先。Cache 可整理和更新，不设字数上限；记忆默认保留，不因结束、完成、陈旧或长期未提及而自动删除。仅按用户要求删除或清空，手动清理与一键清空入口保留。系统只告知用途和入口，正文由前台按需读取。Git 文档位于 `assistants/<participant>/<instance>/Foreground_List.md` 与 `Foreground_Cache.md`，通过 `coop_read` 读取、`coop_commit op=foreground_memory` 改写；空文本删除当前文档。

任务结束后保留完整记录、成果和 Git 历史，释放已完成动作、读取投影及重试缓存。切换仓库或子目录时清理退役的本地 Git 缓存。未提交草稿及仍运行或暂停等待的工作保留。

安装方式见 [安装指南](docs/INSTALLATION.md)。
