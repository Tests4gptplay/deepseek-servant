# 当前实现与验证边界

> 本文件描述工作分支候选，不是发布公告。候选版本为 `0.5.0`，发布状态见 [版本说明](docs/releases/0.5.0.md)。

## 入口和模块

| 范围 | 当前源码 | 责任 |
| --- | --- | --- |
| Host / Client | `src/host.ts`、`src/client.tsx` | 注册正式宿主服务、页面及侧栏入口；沿用现有美术 |
| 服务与通信 | `src/framework/service.ts`、`transport.ts` | 按模式和存储范围访问、命令与下载端点 |
| 客户端 | `client-contracts.ts`、`client-page.tsx`、`client-notices.ts` | 保留原发送身份、历史导航、任务/知识界面及本地完成提示 |
| 存储与事务 | `physical-local-files.ts`、`local-record-files.ts`、`transactions.ts`、`command-transactions.ts` | Local 物理文件与业务接续；Git 固定快照、原子提交及未知结果核对 |
| Git 远端 | `src/experimental/private-git/remote-git-repository.ts`、`dulwich-git-backend.ts`、`dulwich-helper.py` | 单一 Dulwich 远端树/blob及分支头条件提交，无本地业务镜像 |
| 访问和参与 | `connection.ts`、`instances.ts` | 纯存储访问与后台登记分离，实际账号和实例身份 |
| 六角色 | `role-runtime.ts`、`role-tools.ts`、`role-prompts.ts` | Foreground / Organizer / Planner / Worker / Recorder / Helper |
| 原生执行 | `native-executions.ts`、`execution-observation.ts`、`execution-control.ts` | DSH Agent / Session / Jobs、实际进展和停止证据 |
| 任务和恢复 | `task-files.ts`、`task-index.ts`、`recovery.ts`、`host-loop.ts` | 任务初始化、信号、持久状态与接续 |
| 对话 | `conversation.ts`、`conversation-context.ts`、`role-runtime.ts` | 原文、来源、回复关系、长文分页、显式回复阶段及六组上下文 |
| Local 维护 | `manual-cleanup.ts`、`maintenance.ts`、`record-move.ts`、`local-location.ts` | 显式清理、完整记录导出、核验搬家与逻辑范围接续 |
| 成果 | `artifacts.ts`、`recorder-retention.ts`、`cleaner.ts` | 授权读取真实字节、Recorder 保留归档、Cleaner 固定范围清理 |
| 知识 | `skills.ts`、`knowledge.ts` | 摘要目录、原生技能 provider、正文编辑及停用控制 |
| 旧数据迁移 | `legacy-migration.ts` 及现有显式历史资料读取入口 | 保留旧记录来源和身份，核对迁移与待接续事项 |

未带前缀的模块均位于 `src/framework/`。退役执行器及旧 Git Consumer 不再作为生产 fallback；保留的数据格式兼容和迁移，不等于恢复旧业务协议。

## 一套规则、两种存储

Local 的普通入口使用 `PhysicalLocalFiles.open`，逻辑类别直接映射到配置根目录下的实际文件与目录。`LocalRecordFiles` 提供覆盖、追加、创建、删除及单文件读改写；视图只管理生存期与取消，每次读取实际指定文件，不保持全目录快照。不同文件独立执行，不经全局 writer 或 SQL 事务。

跨文件的业务交接由各自的生产者、通知与现有执行接续记录承接，不把顺序文件写入称为原子事务。原生路径附件由授权 DSH 文件接口读入实际字节，Local 文件正文不采用 Git 的分块布局。Git 继续使用自己的固定视图、远端树/blob、条件 ref 更新及原操作核对，不建立本地业务镜像。

旧 `dss-files.sqlite` 及 WAL 只由 `legacy-sqlite-reader.ts` 等一次性升级读取入口访问。已保留源数据、旧清单及其实际导出/接续入口继续保全；成功转换或安装不授权删除源数据。产品不再包含 SQL Local writer。迁移回归所需的真实旧生产器冻结在测试专用目录，按原清单哈希校验，不能作为产品后端。

Local 的业务操作与执行接续使用本地持久记录；Git 的命令结果与执行恢复事实由 `git-authority.ts` 保存到远端，进程内会话缓存不作重启权威或持久历史。设置和实例 UUID 仍属本机配置与身份资料。客户端只把实际 Git 读取的正文放入 Git 消息记录，提交确认与正文读回分别表达。

Git 读取固定快照后，多个正文及相关通知可在同一事务提交。其他任务或心跳的无关更新不使这次业务失效；实际相关输入改变时才按调用者策略重新判断。Git 发布仍使用协议规定的原子分支更新，已证明冲突后可以在相关依赖不变时基于配置分支的最新远端状态重建提交。未知结果保留原 operation 身份和内容摘要，先核实原操作，不能更换 ID、静默改写原尝试的 parent 或清空恢复记录伪造成功。

纯授权存储访问不登记成员、不运行角色；后台参与通过独立连接建立。保存设置属于明确参与动作。Git 账号变更在参与写入前检查，旧身份和未知提交不自动重置。详情见 [Git 说明](PRIVATE_GIT.md)。

## 原生执行与业务边界

六角色运行在 DSH 原生 Agent / Session / Jobs 之上，使用真实工具权限。P 与 O 任务分别交给 Planner 和 Organizer 路径；O 即使只有一个成员也不机械改成 P。角色负责规划、验收、恢复判断和长期记录。Host 观察状态机信号并唤醒对应角色；角色先消费本次信号，再读取权威存储的内容。内容读取和调度不等待本地回执或 SHA 配对。

进展观察使用实际输出、工具和 Job 事件，心跳不算工作进展。分阶段的 5 / 5 / 30 分钟观察不等于给模型添加自动成功超时。停止执行先持久保存原执行、会话和 Job 证据，再请求原生停止；没有真实确认时保持不确定。异常接续可读取正式会话事件，不能仅凭重启后空 registry 宣称旧任务已停。

Worker 容量按本实例的每个 Task 独立计算：运行中的 Worker 与同 Task 的准入预留计入该 Task 的席位，不扣减其他 Task 的容量。配置 2 席时，4 个有工作可执行的 Task 最多共运行 8 个 Worker。未准入的 pending 等待不进入实际 AI 执行的 5 / 5 / 30 分钟停滞判断。总纲见 [每任务 Worker 席位](DESIGN.md#每任务-worker-席位)。

Foreground / Organizer / Recorder / Helper 消费信号后的中断，依据权威存储中的任务、笔记、状态及实际执行记录接续，不增加正文读回证明流程，不盲目唤醒普通等待中的 Organizer。代次和 execution 身份防止晚到旧事件覆盖新执行。

总任务整体 complete 后，前台通知与根 Recorder 整理独立推进，不引入阅读 ACK。子 P/O 只通知直接父 O，不单独启动 Recorder 或 Cleaner。根 Recorder 阅读已知任务树的材料，由 AI 保存长期记录并发送原 Cleaner 信号；Cleaner 不读归档、旧哈希或技能，不补档或重唤 Recorder。

Local Cleaner 删除已知树中每个 Task 的固定运行、Cache 和成员状态目录；本端原生执行释放独立启动，Cleaner 不等待释放即可删除；同一任务的既有文件队列仍按已接收控制写入顺序执行，其他任务和前台不等待。原 Host 在现有责任记录中保留该次精确范围，直至目录、当前 Task 元数据和机械状态收尾完成；不逐文件审核、不等待后续审计轮询。Git 使用其自身的固定 tree 观察和原子目录删除，再由各 Host 的既有观察完成自身释放，事实留在远端。两者均不删除其他生命周期的 Conversation、技能、长期成果或本机工作区。

根任务以自身 sourcePath 的任务名加 Task ID 生成 Windows 安全目录名并固定 archiveFolder；子 P/O 在创建时按已核实的 parent/children 关系固定到父档案目录下，逐层对应任务树。自动子任务源名已经是自身 Task ID 时，叶目录只用该 ID 一次；有真实任务名时仍用任务名加 ID。Worker 不是独立 Task，不增加档案任务层级。子任务可以共用父 O 的本机工作区，但不共用其档案身份。各 Task 保留自己的档案身份；手动清理只处理明确选择的档案范围，排除未选子任务的目录。总任务 Recorder 沿真实父子关系读取已知子任务材料，关联成果按其确切引用读取；最终 Cleaner 由根任务统一承担。未固定字段按当前任务源文件名和 Task ID 定位，不作持续旧 ID 回退；不为升级补写旧任务路径字段，历史档案不扫描、搬迁、改名或补写。dss_snapshot / dss_claim 返回 archiveDirectory / archiveRecordsPath；六角色按自身职责使用这些路径。records.md 始终由 AI 写作，程序只更新同目录 state.json 的机械事实；retention.json 仍是独立 Recorder 输出与保留引用目录。状态更新保留其他 Host 和 lifecycle，不加入模型轮次、归档重审、ACK、定时器或读回握手。

这里的 `cleaner.ts` 处理任务临时逻辑资料。`src/native-cleaner/` 通过 `deepseek-servant/cleaner` 独立挂载，随同一个安装包交付；它处理已确认关闭的 DSS 自有原生执行、精确日志和缓存索引，不等待 Task 完成或 Recorder 归档。官方 Loader 的依赖顺序、关闭后接续及平台实现分别验证，具体通过范围以随包证据为准。其所有角色覆盖、生产者保存责任及无额外业务轮询、模型调用、席位和 Git 读取的契约见 [总纲](DESIGN.md#清理职责与执行生命周期)及 [保留说明](RETENTION.md#原生执行-cleaner-的设计契约)。

## 前台会话与记录管理

Foreground 运行时 Markdown 的开头明确优先级：对话唤醒后先按原状态机消费对应信号，读取当前消息及理解它所需的上下文，立即用自己的话给用户简短回应，再由同一前台继续实际处理。后台报告先用 `dss_claim` 消费信号。任务反馈先读取现有任务名和实际状态，再作任务相关的短回应；Helper 报告先读取确切文件中的完整报告。确认实际事件后及时回应，再检查详细成果与验收材料，不强行读取无关对话或虚构当前用户消息。短回应使用当前前台模型和既有 `dss_conversation_send`，不新增短回复模型、独立执行、固定文案或回执握手，也不等研究、详细规划、任务派发或完整历史复查结束。可直接回答的简单问题只答一次；无需 AI 参与的人际讨论不强行回复。

Foreground 首次对话唤醒时直接调用 `dss_conversation_read`：工具先完成本次唤醒对应信号的消费，再打开正文视图，不要求模型另跑一次 `dss_conversation_claim`。后者保留为只消费、不读取正文的可选接口；后台任务结果仍先用 `dss_claim` 消费再检查权威记录。两种入口共用原有 execution/wake 消费身份，Local/Git 的权威存储、重试和信号归属不变。

Foreground 自主决定处理中途的后续通知处理时机。Host 使用已有顶层 STATE 发现结果：未激活时维持原唤醒/准入；已激活时通过 native inject 仅提示有消息，不取消当前工具或要求立刻改变阅读节奏。通知不消费 STATE。前台可在准备好后调用普通 `dss_claim`，再读实际来源；`signals` 与 `binding.claimedNotifications` 保存累计来源。最终回复前，前台必须调用 fresh `dss_snapshot` 检查 `notifications`；若有后续通知则消费并处理实际内容后再复查，无待办时继续最终回复。这是 AI 的既有处理规则，不新增 Host 发送门禁或握手。已删除 Host turn-stopping 自动 steer 及显式 send 的 pending gate，保留执行归属检查。用户可见回复统一由前台明确调用 `dss_conversation_send`，各模式的正文发布、执行归属与 UNKNOWN 同身份接续保持不变。completed event 不再提取或发布 final，停机/冷启动也不补发旧 capture；原生状态只决定原执行的正常退休或责任恢复。`sent:true` 表示成功；未知结果仍核对原操作，不改原稿或换身份重发。在线提示按当前执行去重，消费成功或既有发现列表显示路径消失后清理去重项，因此同名空信号重建仍可再次通知。原生 inbox 自身的接收、下一步消费和状态转换不由 Host 替代，不代表已处理业务。最近六个完整往返原文作为接续材料，长文不以分页长度截断保存。长文搜索和字符分页按需执行，List/Cache 自动注入用途、路径与操作指南，正文由角色显式读取。

Foreground_Cache 可选用于暂存本次草稿，不新增字段或专用格式。若使用，先通过既有 `dss_conversation_send` 成功发出回复，再打开 fresh snapshot、用 `dss_read` 读 Cache，并通过 `dss_record append:false` 只删本次用过的草稿，保留其他需要保留的事实和记录，最后结束原生轮次，native final 本身不产生第二条回复。失败或结果未知不作成功清理；已确认成功后不用再次询问用户，也不把该稿留作记忆。重新读取时草稿已不在则不重建旧内容。没有持久 Cache 草稿时同样通过 `dss_conversation_send` 发布。

Local 日期定位取选中日末尾并在该日分页；Git 日期定位以选中日末尾为初始上界，后续游标可跨日。无日期时保持连续历史分页。

Local 的任务历史、前台对话、工作规划记录及调试记录分别由明确确认操作清理。任务历史清理保留成果引用；取消的任务须有持久取消意图及精确原生生产者停止证据，清理后保持原业务状态而非写成 complete。明确回收回执阻止旧 Task 再次调度或补充，后续业务使用新 Task 身份。

记录搬家先持久原请求，再确认本次搬迁涉及的 Local 执行停止、复制与验证，最后更新设置并重开。逻辑存储范围及原 UUID、命令、会话和消息身份保持；未知结果继续核对原操作。宿主原生日志单独管理。旧任务的完整原记录通过迁移引用读取，Local 可导出现存完整原文。

## 知识和附件

Local 会话附件只保留用户选中的原生路径，从原电脑读取；不另复制到 DSS，不分块，不新建会话附件清单。以下成果归档导入是独立的显式接口，不能与会话附件混为一谈。Git 会话附件保留自己的单一二进制 blob 保存方式。

技能目录按需读取摘要，选择技能时才加载正文；正式原生 pre-step 边界失效缓存，而非每秒扫描全部正文。新技能要求正式 `SKILL.md` 格式，普通 `.md` 不自动注册。旧 Local 技能保留原 scope、验证状态及 activeVersion；旧 Git 技能保持实际 participant 范围，不伪造 Local 版本语义。

知识页显式发现和读取迁移保留的项目事实、偏好正文及范围/来源；这些资料沿只读职责展示。用户显式编辑直接保存原生 SKILL.md，复用 Recorder 的同文件三方合并，并更新派生目录与原生缓存；冲突保留当前正文和草稿，不新建候选。已有候选资料继续只读展示。Git Recorder 将定义和共享目录条目放入同一次条件提交，冲突后沿原基线重评合并；确认后在事务之外刷新本端所有现存 provider scope，其他任务不等待该 Recorder。停用/退役控制保存在独立元数据中，重建目录不清除它们；正文和来源仍可追溯。缺少宿主 skills 能力会报告实际诊断，不增加任意最低版本门槛。

附件从宿主授权文件接口读取实际字节。Local 使用物理文件及该附件既有发布接续；Git 保留自己的事务发布。完整性按实际长度与 SHA-256 核验，Local 不套用 Git 分块正文。下载端点返回原二进制。目录或外部链接不会自动变成已归档文件；本机附件引用也不冒充跨端永久链接。

## 迁移与保留

迁移保留旧任务、知识、来源、版本、等待事项及成果证据；来源不因迁移被删除。无法确认原生执行归属的事项保留 unresolved，不批量伪装为完成。迁移回读成功不等于全部任务已在真实 Host 自动接续。旧协议无明确 P/O 的可接续任务保留为同一映射身份，通过 Foreground_Legacy 状态信号交现有 Foreground 读取原目标、计划、工作及控制记录，再调用 dss_submit_task 的 legacyTask 参数明确选路；原始材料与已有成果自动带入，不按人数或复杂度硬切。暂停或待回答事项仍需原有用户控制，已有明确 P/O 不改变。具体资料范围和清理条件见 [RETENTION](RETENTION.md)。

## 构建与测试

当前 `package.json` 提供 `npm run typecheck` 和 `npm run build`，没有 `npm test` 或 `test:package` 脚本。按 [测试说明](docs/TESTING.md) 运行受影响的 `scripts/validate-*.mjs`，逐项记录源码哈希与边界；源码维护不自动授权构建、打包或发布。

当前回归使用产品物理 Local 源码；一次性 SQL 读取回归只用 `scripts/test-support/historical-v44/` 中按原清单固定的历史生产器生成可丢弃输入。不得把旧 SQL 写入断言重新作为当前运行设计。

构建生成 `lib/host.js` 与 `lib/client.js`。Client 使用宿主 ModuleLoader factory，不能用普通浏览器 ESM 入口代替宿主接线。候选打包后还需核对包文件、构建结果与被测试源码一致；打包不等于发布或安装验收。

历史候选曾开展 SQLite、官方原生技能 registry、受控 Git、客户端及原生宿主验证；这些结果仅属于当时源码及包。当前物理 Local 切换、SQL 退役与后续修改必须分别执行受影响回归，既有历史成功不构成本候选通过。

验证结果按测试层级、源码与包分别记录；跨不同真实账户的公网联合协作尚未执行。最终候选验收状态见 [测试说明](docs/TESTING.md)。历史 Windows rc.5 等结果见[旧公开证据](https://github.com/Tests4gptplay/deepseek-servant/blob/d28a4d8538abc966608761bcfd60d568dec11cc9/docs/testing/EVIDENCE.md)，仅适用于对应旧版本。

许可证、素材署名及第三方声明见 [README](README.md#来源与开源许可)、[NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。


## Historical Child Organizer integration (2026-11-04)

This paragraph records that earlier candidate only. Its independent child archival behavior is superseded by the current root Recorder/Cleaner contract above.

The previously untested source-only patch is reconciled into an isolated candidate based on the locked 972356 source. dss_planner_dispatch accepts explicit P/O route and child member scope; reciprocal O→O→P relations preserve scoped descendant controls and archive references. Nonprimary instances may execute and archive Tasks addressed to their exact member, while global Foreground admission stays primary-only. Role presets keep single-objective planning with P and expose roster/heartbeat facts to O for semantic coordination. Source-level Local/Git regression covers nested completion, member isolation, independent pause/cancel, owner-addressed recovery, native Organizer continuation and both archival orders. Git uses the actual GitFiles/Repository stack over controlled HTTP. Existing locked packages, profiles and configuration are unchanged; no installation, deployment or runtime restart was performed. A candidate-only build/package check is separate from real secondary/other-user instance acceptance, which remains required before release.

### Foreground on-demand role reference

The always-present Foreground section supplies early-response obligations and the exact logical path `technical/role-guides/Foreground.md`. The complete Foreground rule text, including its current notification-loop lifecycle, remains in the on-demand guide. Explicit connection initialization, after account/branch preparation and confirmed instance registration, owns guide creation and recognized migrations. Unfinished work continues under that same initialization owner. It is not loaded automatically by the Host, a wake classifier, a new tool, or an acknowledgement gate. The model uses the existing `dss_read` and fixed snapshots when its next action needs the full rules, including a later interjection in an already active execution.

This path is relative to the authoritative FilesStore. Local stores the actual file below its configured physical root, including the `technical/role-guides` directory. GitFiles and RemoteGitRepository map the same key once to the configured `repositoryDirectory`, whether the repository root or a nested folder. Role tools receive only the logical key and never synthesize a repository prefix or fall back to a package/local copy when Git reading fails.

Initialization fills an absent physical Local guide with its single-file operation; Git uses its transaction/CAS path. A retained exact Local original is preserved for the owning one-time upgrade before creating that same target. Existing guides with recognized generated-template ancestry receive only the exact sentence replacements listed in `foreground-guide-upgrade-rules.ts`. The exact previous default that differs solely by the missing `foregroundStorageRecoveryNote` receives that note; customized guides are not replaced wholesale. Other text, including inline custom sentences, BOM, CRLF and trailing whitespace, remains unchanged. Empty, non-UTF-8 and wholly rewritten guides remain untouched. Quoted, fenced and comment examples are not rewrite targets. The migration does not keep an obsolete Markdown backup or install any old publication mechanism.

The existing initialization read determines whether a write is needed. Already-current and unrecognized guides cause no guide transaction. A proven conflict rereads the authoritative file and reruns exact recognition, preserving concurrent edits instead of reparenting an old full-document replacement. An uncertain outcome retains its original operation and is not retried as a replacement command. Read-only storage access and individual chat reads do not generate or migrate the guide. Existing Host maintenance continues only an unfinished failed initialization; a Local initialization deferred for a retained original resumes when actual one-time materialization or upgrade-work results arrive. Successful initialization leaves no polling responsibility, so a later manual deletion does not cause default regeneration. A new connection still performs its own initial acquisition. The original Git initialization command and transport operation remain owned only by this live connection; their current in-memory state does not provide cross-process UNKNOWN recovery. The connection returns a nonblocking migration report with changed-rule count and preserved/unreviewed sections; an unrecognized section is not automatically classified as incorrect. A guide-specific write error remains a nonblocking connection diagnostic logged by the service. The core protocol governs publication, notification consumption and context grouping regardless of stale or customized reference wording, without introducing another read, acknowledgement, send gate or recovery mechanism. Fully reworded rules need explicit review rather than an automatic semantic rewrite. When the model needs an unavailable guide, it states the precise gap and defers only dependent work.

The fetched document remains reference content within the current user/project/preset and permission boundaries. Its body is never automatically promoted into a system prompt, and repository text does not create user authorization. No business state, route-selection semantics, task admission, storage authority or tool schema is changed by this split.

### 本机成果来源登记

实机 f62 Local 取消测试发现：README 已在指定工作区创建，但 Planner 验收前取消使 Task 尚无 workspaceResults，正文中的真实地址无法确定原电脑。修正在现有 dss_workspace_reference 入口核验并事务性保存四项物理身份，结果与 Task 取消状态独立；继续使用现有 UI 原生打开和 Recorder 引用保留，无产品安装或桥接改写。内部过程记录不作用户成果，无文件输出时回复纯结果。源码回归与后续安装包实机验收分别记录，不将源码测试等同实机修复。
