# DeepSeek Servant 架构

DeepSeek Servant 基于 DeepSeek Harness 的原生 Agent、Session、工具和 Jobs，使用统一 Framework 连接 Local 与 Git 两种业务存储。

## 编程约束

优先通过实机测试发现并修复问题。对于不是实机测试发现的极端情况，修补前须核实真实生产入口与触发条件，证明问题在没有人为夹具时也确实可以发生；仅有模拟夹具失败不能证明修补必要性。不做没有真实入口依据的人为极端场景测试，保留针对真实行为和已确认故障的必要回归测试。尚未证实不等于不可能，应继续核实并与已确认的真实故障区分。不要修补不可能在实机复现的错误，不得仅为通过测试夹具而添加生产补丁、制造机制或损害正常路径性能。

## 结构与责任

| 层次 | 当前实现 | 责任 |
| --- | --- | --- |
| Host / Client | `src/host.ts`、`src/client.tsx` | 宿主服务、页面与侧栏入口 |
| 服务与通信 | `src/framework/service.ts`、`transport.ts` | 按模式和存储范围提供访问、命令与下载 |
| 存储与事务 | `physical-local-files.ts`、`local-record-files.ts`、`transactions.ts`、`command-transactions.ts` | Local 实际文件及业务接续；Git 快照、提交与原操作核对 |
| 原生执行 | `native-executions.ts`、`role-runtime.ts` | 六角色运行、实际执行观察与恢复 |
| 长期资料 | `artifacts.ts`、`knowledge.ts`、`cleaner.ts` | 成果附件、知识和任务临时资料清理 |
| 旧数据接续 | `legacy-migration.ts` 及现有显式历史资料读取入口 | 保留原来源、身份、历史和待接续事项 |

表中未写目录前缀的模块位于 `src/framework/`。

## 角色协作

记录账本保存业务事实，状态机信号表达待办。角色之间通过账本和信号协作，不依赖彼此同时在线、直接握手或对端回执；执行中断后从权威记录接续。这个解耦原则同时适用于 Local 与 Git，区别是权威存储的位置。 业务结果以实际文档和留档记录判断，不以自建回执或 SHA 配对代替。重构中的断点必须通过修正实现解决，不得为了通过测试而改变此设计或恢复旧握手。

Foreground 与用户交流；Organizer 协调多用户、多实例、多个独立并行任务的资源归属、成员与 Planner 分派，防止任务间串扰，并汇总与验收任务包的整体成果；Planner 负责单目标任务内部的实际规划与验收；Worker 执行任务；Recorder 编写长期记录与技能；Helper 处理异常恢复。角色通过 DSH 原生能力执行。Host 观察状态机信号并唤醒对应角色；角色先消费本次唤醒对应的信号，再读取权威存储中的内容、执行工作并写回。Host 不以对话正文、发送回执或本地 SHA 配对作为唤醒依据。

Foreground 首次对话唤醒由 `dss_conversation_read` 先消费该次 exact wake，再读正文。Host 只发现状态信号：未激活时沿原流程唤醒，已激活时通过原生非唤醒 inbox 通知有消息，不中断工具或强制改变阅读节奏。前台在处理过程中自主选择何时用普通 `dss_claim` 消费后续顶层 `state/Foreground_*` 通知，再读实际来源；需要最新待办时可读 fresh snapshot。最终回复前，前台必须用 fresh snapshot 检查后续通知；若有则消费并处理实际内容后再复查，无待办时继续最终回复。累计已接管来源和空通知列表都不是业务完成证明。Host 不在 turn-stopping 强制 claim/read/改稿，也不以待办阻挡显式发送，不增加 Host 发送门禁、发布前检查或握手。所有用户可见回复，包括最终答复，只由前台明确调用 `dss_conversation_send` 发布，沿各模式的既有发布接续保存正文与该次原操作身份；native final 即使非空也不写 Conversation，旧 capture 也不自动补发。未知结果先对账，不改原稿或换身份重发。已发回复不撤回；未消费信号保留，供前台稍后处理或退出后原唤醒流程接续。在线通知仅作提示，原生 inbox 的消费及 Agent step/status 转换不等于业务信号消费。通知去重只在当前执行内使用，成功消费或观察到路径消失后重新允许同名空信号通知，不把空 blob SHA 当永久代际。Cache 暂存草稿不是必需；若用了，现有 send 确认成功后重新读 Cache，通过现有 record 工具只删除本次用过的草稿，保留其他事实和记录，之后结束原生轮次；native final 不再是发布路径。不新增草稿字段、标记、文件、角色或工具。

后续通知领取只在实际选中通知时保存待消费上下文并提交消费。没有后续通知时返回已接手来源，不另建空领取命令或写空领取收据；旧版本保存的空选择保留其上下文，但不再执行收据式结算。原始唤醒和真实后续通知的消费继续沿原有路径处理。

简单问答和可直接完成的短任务由 Foreground 在原生工具范围内完成，不强制创建 P/O 任务、Worker 或附加信号。需要协作分派时才按下述任务语义选择路径。

Helper 的 Host error、主动 help、无进展及整体恢复触发统一通过既有状态信号交给 Host 发现；不另开直接唤醒通道。信号消费与实际修复结果分别保存，不把消费或退出当作恢复成功。 Git 前台已成功原生命令的精确回执清理可附于原完成提交；若仅可选清理读取失败则保留回执并继续原完成，原提交和原生停止错误仍按原职责处理，不新增提交或后台扫描。

### P / O 任务划分

复杂的单目标任务仍以 **P** 为主，由 Planner 努力拆分 Worker 工作、组织多轮执行并验收。复杂度、步骤数量、材料量或 Worker 数量不能单独触发 O；Planner 不因复杂而把任务往上级 Organizer 吐回，不自行升级任务路由。

只有任务包已明确包含**多个独立、可并行的目标任务**时，才选择 **O**，由 Organizer 将单目标任务分派给各 Planner，或将多个独立目标打包为子 O 分派给接收实例的 Organizer，明确各自要求与验收标准。这里的独立是各目标有自身成果和验收，不要求全部同时起跑；包内目标之间的实际成果依赖仍由 Organizer 协调。Planner 交回实际结果，Organizer 承担任务包的总体协调和验收。一个目标内部的步骤、子步骤与 Worker 合同不是多个独立目标。

该原则同时写入 Foreground / Organizer / Planner 角色规则。创建接口保留显式 `route: P | O`：角色依据需求语义选择，不新增程序性复杂度分数、数量阈值或自动分类器。单实例测试只使用实际注册成员，不能通过虚构成员冒充多个 Planner；应报告实际结构及覆盖范围。

旧任务迁移保留真实原始目标、成员工作、等待与成果，不把成员数或工作数视作独立目标。旧格式没有明确 P/O 时，仅向现有 Foreground 写入资料定位信号，由 Foreground 读取原文并通过原有提交工具显式选择 P/O。迁移映射 Task ID 保持不变，原控制与工作不重置；已有明确 P/O 不改路由，不新增回执、在线门槛或用户确认。

### O 的独立 P / O 子任务与完成路由

Organizer 是具有语义理解能力的组织协调者，可划分独立目标的任务包并汇总整体范围，不制定单目标内部步骤、Worker 合同或阶段计划。“带有语义理解能力的防串扰 host”描述 AI 的协调职责，不是将语义决策交给机械 Host，也不要求 Worker 每次执行或接力经过 O。单目标无论多重、多复杂仍由 P 规划。

Host 现有 resources 提供注册成员别名、实例 UUID、记录路径、配置席位、心跳与观察到的 online/offline/stopped/unknown。availableMembers 是注册名单，不等于在线名单；配置席位不是实测空闲容量。O 消费信号后可读取所供事实和已知 instances/ 心跳记录，并结合已有任务分配决定成员、资源归属与分组。Host 不新增上线门槛、复杂度分类器、分组策略或共享全局 Worker 池。

Organizer 使用 dss_planner_dispatch，按稳定 objectiveId 与真实 member 显式选择 route: P | O（省略保持 P）。单目标生成独立 P；多个独立目标可打包生成独立子 O，交给其他用户的实例或同用户另一实例的 O。members 可明确子任务的注册成员范围，不能越出父包范围；子 O 默认继承父包范围，P 默认仅接收成员。已存在分配保持原成员、路由和范围，重复 objectiveId 补充尚未完成的原任务。已完成子任务不重新打开，纠正使用新 objectiveId 并引用已有成果。

同一 O 包内的独立子目标若存在需求或成果上的先后依赖，由**该 O 的 Organizer**语义协调：辨明哪个上游子任务要向哪个目标子 P/O 提供什么成果、用于什么目的、当前进度及是否必须等待，按实际需要在既有 Organizer_Note、Dispatch 与任务事实中保留可续接信息，不要求重复记账；不必等待的目标可独立并行，必须依赖上游实际结果的目标则在结果可用后再分派，或对已开放的目标使用同一 objectiveId、原 member/route 的 dss_planner_dispatch 补充输入。Organizer 消费上游完成信号，核对上游 Task 身份、状态、实际 resultPaths / workspaceResults 和对应成果，自己掌握准确来源和决策；通过现有 dss_planner_dispatch 的 plan 向目标子任务交付真实完整的用户总目标、属于该子任务的原始要求及所需已核实资料；“总目标完整”不等于逐字转交含平级任务信息的整份原始任务包。Organizer 保留原文，忠实提供目标与适用要求，不暴露兄弟子任务的 Task 身份、路径、状态信号或彼此关系，不令子任务直接读父 O 的 source/metadata、Note 或 Dispatch。目标 P/O 只读自己的原始输入或补充通知，不知道也不直接联系其他平级任务；各自向所属 Organizer 交回结果。不能把预计成果或父包摘要冒充已核实资料。需要文件材料时只使用已有获准渠道，不能为隐藏来源而虚构文件或增设平级通信端口。每个 P 内部的 Worker 步骤和接力仍归其 Planner；不得把一个目标的内部阶段伪装成多个 O 子目标。这是 Organizer 的业务判断与现有输入/状态机路径，不新增硬编码依赖图、Host 自动路由/轮询、子任务 ACK 或统一起跑门槛；不同 O 包照常独立推进。

父 O 的 children 与子任务 parent、原文、初始化和路由对应状态信号由本次分派共同保存：Local 使用既有物理发布接续，Git 使用同一事务。正常发现只读对应 state，不新增父子回执或全树热轮询。确切 owner 对应实例运行其 O，无需成为全局 primary；最外层总任务的 Recorder 与 Cleaner 由其主理实例负责；全局 Foreground 与初始入口仍保持原 primary 职责。同实例的多个 O 按各自 Task ID 隔离执行与通知，逐 Task 保留 Organizer_Note 与 Dispatch，不等待其他 O 的当前轮结束；子 P/O 使用自身 Task ID，并通过 parent/children 关联继承父任务范围，独立推进。Planner / Worker 只执行独立 P；O 的分派和验收通过自身 Organizer 与独立子任务完成。保留的旧成员 Inbox、回复和成果只是可读取的任务资料，不再构成同 O 内的成员派发入口。

子 P 或子 O 完成时只通过现有 dss_complete 保存自身完成事实及实际 resultPaths，并以既有状态信号唤醒直接父 O；不主动构造额外结果包、回执或通知平级/Foreground。若子 P 认为成果尚需后续协调，只在自己的正常任务结果中写清楚实际需求，不向平级发请求或另开协议；完成照常唤醒父 O，由父 O 读结果后决定是否及如何分派或补充。父 O 自行进入确切子任务，核其当前记录和真实成果后验收。子任务不单独启动 Recorder/Cleaner；最外层完成才通知 Foreground 与根 Recorder，根 Cleaner 最后统一清理已知任务树。Organizer 先消费信号，再按当前元数据与权威归档引用读实际成果，不缓存清理前 Reply 路径，不等待 Recorder 模型回执。父 O 必须实际验收当前仍属要求的子任务成果；已取消子任务不能冒充完成或成功，应核其目标是否确已撤销，未撤销的目标仍需安排后续工作。子 O 完成不替代其父包的验收。

取消、失败、暂停不等于完成。父控制仅沿明确双向关联影响后代 O/P，递归关系检查拒绝环和错配，不扩展至无关 Task。恢复父任务不能清除后代自身独立暂停/取消；恢复 O 保持实际实例与 Task 身份。用户恢复时通过原有状态机向其他实例的实际 O/P 负责人写入持久恢复通知，离线实例可后续消费并从原记录继续，不依赖发起端的本地原生恢复调用或对端回执。递归归档读取和成果迁移沿同一权威关系处理，保留每个子任务的身份与成果归属，由根任务承担最终统一清理。

实现状态：上述能力已合入基于 972356 的独立源码候选，已运行 Local/Git 源码级嵌套分派、完成路由、暂停恢复、原生续接、非主实例路由和成果归档回归。Git 测试使用真实 GitFiles/Repository 加受控 HTTP，不代表真实远端账户验收。当前锁定实机候选保持不变；未安装、部署或公开发布此候选，多真实用户/多实例实机 O→O→P 仍待后续验收。

### Worker 持续接力与阶段验收

#### AI 决策、状态机写入、Host 执行的边界

后继角色和下一步信号由正在工作的 AI 根据计划及实际成果选择，不由 Host 的固定角色调用链代替决定。AI 可以直接在当前模式的权威存储写入对应状态机，也可以调用 Host 提供的状态机写入工具；两种方式表达同一调度意图。

状态机写入工具只保存 AI 明确指定的目标信号及相关材料，不自行选择接收角色，不暗中改成通知 Planner，不直接调用接收角色，也不等待接收、启动或完成回执。基本路径、当前任务归属和实际写入失败的处理保留，但不得借此重新引入业务路由判断或交接证明。

Host 的职责是观察有效状态机信号，按信号对应的角色执行机械调度；不是分析业务成果后决定下一位是谁。角色启动代码仅属于这一状态机执行层。不得存在绕开状态机的角色互调链，也不得要求先经过一次 Planner 派发，才能接受 Worker 写出的 Worker 信号。该职责边界适用于所有语义角色以及 Local/Git 两种模式。

Planner 负责制定计划、明确阶段目标及有意义的中间验收点，并在这些验收点查验该阶段的实际成果；不是每次 Worker 交付或交接都必须启动 Planner。同一 P 内若有独立分配的 Worker child 之间的依赖，Planner 掌握上游、目标、用途、进度，按需记于既有计划或进度记录，不要求多处重复；在阶段验收点核查上游 Reply/handoff 与真实成果，再用现有 dss_worker_assign 将必要的已核实材料与任务要求写入目标 child 的 contract.md；Worker 读取该合同执行，成果经自身 reply.md/handoff 回给 Planner，不把 reply.md 误当 Planner 下发通道。不默认暴露另一个独立 child 的身份、路径或相互关系。不同已分配 child 各向 Planner 交付结果，不直接联系彼此。同一 child 的普通连续执行由 Worker 按计划持续接力，到达计划中的阶段验收位置时，才写入唤醒 Planner 的状态机信号。

Worker 按当前计划/合同在同一工作责任的合法后继间使用既有权威文档和状态机持续接力：写好成果、后继所需合同与交接材料并发信号后结束本轮；后继先消费信号再读材料，不必每步经 Planner，也不等待回执。同一 childId 的下一代可以继承；不同 successorId 本身既不证明也不否定合法继承，应依实际工作资料判断，不能自行串入另一个已独立分配的 child、覆盖其合同或替 Planner 协调。不同已分配 child 间的关系、成果交接和新工作由 Planner 根据实际结果安排。本次不新增执行门禁、预设后继图或握手。

Host 只依据状态机调度，不追溯信号由 Planner 还是 Worker 写入，也不要求此前已有一次 Planner 对该 Worker 的唤醒记录。不得另加来源确认、回执配对或交接证明作为唤醒门槛。

状态机信号可被 Host 立即观察到。下一位已经启动而上一位尚在退出收尾，是正常的短暂重叠，不能据此阻塞接续或等待上一位完全退出。上一位发出交接信号后不再修改已交接材料；退出收尾不能被当成仍在执行业务、继续占住接力席位的理由。每 Task 的业务并发席位规则仍然适用，不因此扩大任务之间的耦合。

交接后旧执行仍由 Host 独立跟踪并异步停止、释放，直到该次原生执行确实结束；释放业务席位不等于放弃退出责任。停止只针对已交接的确切执行身份，不能误停新一轮 Worker 或整个共享 DSH 进程。旧执行尚未结束或停止失败时保留其收尾责任及实际错误，后继业务不等待它。

本节同时适用于 Local 与 Git：Local 的事实在本地权威文档，Git 的事实在 Git；两者均由状态机驱动。上述退出规则针对正常 Worker 接力，不把正常接力改造成故障恢复流程。

实现状态：源码候选已区分普通 Worker 接力与 Planner 阶段验收，并将已交接业务与旧原生执行的退出收尾分开。候选仍在整合验证，须安装锁定版本后从真实 DSH 前台跑完连续接力、阶段验收及完整任务矩阵；此前独立 Worker 往返通过的测试不替代这轮实机验证。

### 每任务 Worker 席位

Worker 席位是本实例对**每个 Task 分别提供的并发容量**，不是所有任务共享的总池。配置 2 席时，4 个有可执行工作的 Task 可各自运行 2 个 Worker，合计最多 8 个；一个 Task 占满席位，不占用其他 Task 的配额。

同一 Task 中仍承担未交接业务的 Worker，与已经取得准入预留、尚未完成原生绑定的 Worker 共同计入业务席位占用，避免并发派发超额；已完成正常交接、仅剩退出收尾的旧执行不据此阻塞后继接力。预留和释放均绑定原 Task 与执行身份，不以无关任务的执行或预留阻塞本任务。Planner 使用本任务的实际配置、占用与可用席位，不自行修改上限；席位也不替代工具权限、作业所有权和写入范围约束。

尚未获得席位或尚待准入的请求属于 pending 等待，不是已经运行的 AI 停滞。5 / 5 / 30 分钟进展观察针对实际执行，不能用于把正常排队判为模型故障。

## 存储与访问

Local 将各逻辑类别直接保存为配置根目录下的实际文件与目录，正文及已归档成果保留原字节，执行接续使用对应的本地持久记录。普通打开不启动 SQL writer；旧 SQLite/WAL 仅供一次性只读转换及已存在原件读取。Git 默认由 Dulwich 常驻内存后端通过标准 Git HTTPS 协议读写所选私有仓库的远端提交、树和 blob，平台 API 只用于连接身份和显式成员管理等 Git 协议不提供的能力；业务资料、命令结果和执行恢复事实以 Git 为唯一权威。两种模式共享角色工具契约，分别使用自己的物理读写和恢复事实。Local 视图只管理生存期，每次读取实际文件；Git 视图固定在对应远端版本。

安装后必要迁移静默、一次性执行；干净安装确认没有可迁移内容时，迁移任务应立即完成并清理自身临时责任后退出，不常驻、不周期检查，不删除插件或用户数据。不为假设的旧残留添加兼容、扫描或门禁；实际出现残留时用户可按需找 AI 协助清理。

Git 模式的用户输入、AI 回复、任务资料和状态机信号直接写入 Git，不先写本地业务库再同步。读取直接来自 Git，本地只保留当前运行所需的临时缓存，不持久化为第二份历史、写回镜像或重启恢复依据。设置和实例 UUID 的本地保存不改变这一边界。

前台界面持续展示 Git 对话内容。回车提交输入；AI 选项卡同时写入 Foreground 信号，群聊选项卡不产生该信号。显示读取独立于发送流程，不等待发送回执，不与本地草稿、回执 SHA 配对。用户与 AI 的写入共用同一远端显示来源；已经显示的内容保留在内存中，远端更新后更新页面。长文历史按需加载和预加载不阻塞当前内容显示，成员及任务面板独立更新。向上滚动阅读可以使用内存或临时文件形式的页面缓存；它可丢弃并在关闭 DSH 时释放，不承担提交记录、任务恢复或本地写回权威。

Git 前台正文按协作域和 UTC 日期保存在固定的 `conversations/git/<collaboration>/YYYY-MM-DD.json` 文件中，每个文件包含该日完整消息及其显示信息。当前内容直接读取该日文件，不经过消息索引、正文清单或分块文件。历史日期只在滚动、选日或明确搜索时按需读取。日期游标仅定位阅读位置，不是提交证明；消费 Foreground 信号不读取或修改正文文件。

角色不先读取正文来证明可以消费信号，也不把完成后的再次读回设为下一步工作的额外证明条件。Git 传输层处理实际请求结果及并发写入冲突；这些机制不成为界面读取、Host 调度或 AI 读取内容的额外配对流程。

存储搬迁与失败的影响范围只属于实际搬迁的目标。Local 物理记录搬迁不得停止 Git Host、取消 Git 连接或阻止 Git 输入、读取和任务执行；迁移失败在对应目标上报告，不通过共享等待或全局错误状态拖停其他模式。已发布的新配置不得等待被替换的旧启动流程。

前台存储访问和后台参与分别管理。用户可以查看历史、保存消息和读取成果，再按设置启用后台参与。任务完成、前台通知和 Recorder 归档分别更新状态；Recorder 通过既有 Cleaner 信号交接后，Cleaner 被唤醒后按固定范围清理对应任务的运行资料，不读取或核验 records.md、retention.json、技能或其他长期文件，不补档或回交 Recorder；技能目录发布与刷新由其自身路径处理，Cleaner 不承接、不等待，也不以此增加清理前提。原生执行的既有实际停止与退出流程保持不变。Local Cleaner 按原信号直接清理已知任务树内固定目录，不等待原生执行释放；同一任务既有文件队列仍按已接收的控制写入顺序执行。原生执行释放独立进行，当前 Task 元数据和 Host 的释放责任保留至该释放完成。原 Host 的实际责任记录保留尚未完成的收尾，其他任务和前台不等待；不等待归档审核或新增审计轮询。Git 清理沿其固定 tree 观察、原子目录删除和各 Host 自身释放事实推进。原生停止和未知结果继续按各自实际执行身份处理，不能以本端停止推定远端停止。

### 角色逻辑路径地图

以下是 Local / Git 共用的现有逻辑路径，使用绑定或权威元数据中的实际身份，不预读正文、不新增确认或准入条件：

- Task 元数据：`tasks/<taskId>.json`；本任务原始需求跟随其中的 `sourcePath`。`parent.taskId` 用于直系父任务关联及回交，子 P/O 不以此读取父 O 资料；总目标及分配内容由父 O 写入子任务自身输入。
- 成员目录：`task-runs/<taskId>/<member>/`，包含 `Planner_Memory.md`、`Plan_Note.md`、`Plan.md`、`Reply.md`；Inbox 为该目录下 `<member>_Inbox/<member>_<taskId>.md`。
- Organizer：`task-runs/<taskId>/Organizer_Note.md` 与 `Dispatch.md`；独立子 P 成果跟随子任务当前 `resultPaths`。
- Worker：`task-runs/<taskId>/<member>/workers/<childId>/`，包含 `contract.md`、`notes.md`、`reply.md`、`handoff.json` 和 `records/`。目录使用实际 childId 原文，不使用 URI 编码；小写 Worker `reply.md` 与成员 `Reply.md` 不同。检查点信号 `Planner_<encoded-childId>-Worker-G<generation>` 去掉前缀及末尾代数后，对中间身份作 `decodeURIComponent`；generation 不增加目录层级。角色先消费通知，再按此路径读取实际成果及其引用。
- Recorder：`Recorder Cache/<taskId>/links.json` 指向原材料；长期记录使用 `dss_snapshot` / `dss_claim` 返回的 `archiveDirectory` 与 `archiveRecordsPath`，不自行拼接 Task ID；任务正文为 `records.md`；工作 Note 为 `task-runs/<taskId>/Recorder_Note.md`。
- 固定 recovery 标记：`state/<member>/<taskId>/recovery`。仅对应 Planner 按既有正常链路续行规则显式消费；Helper 不消费。任务最终 Cleaner 按现有清理条件清除 Task 状态通道时一并清理剩余标记，不改变恢复责任或提前要求业务验收完成。 对仍未消费的成员恢复链，Helper 实际检查并保存结果后，以对应通知的 recoveryCheckId 主动调用既有 reset；仅回合结束不自动重置，旧周期不能推迟新周期。

绑定中的具体路径优先。`dss_list` 默认只列指定目录的直接文件，不列子目录及嵌套文件；AI 可显式设置 `recursive: true` 查看同一获准目录下的后代文件元数据，不读取正文、不替 AI 选择归档资料；`workers` 父目录返回空列表不表示子 Worker 成果不存在，应使用已知 childId 定位。路径提示只提供固定位置，不让 Host 读取正文或判断业务结果。

## 清理职责与执行生命周期

根任务以自身 sourcePath 的任务名加 Task ID 生成 Windows 安全目录名并固定 archiveFolder；子 P/O 在创建时按已核实的 parent/children 关系固定到父档案目录下，逐层对应任务树。自动子任务源名已经是自身 Task ID 时，叶目录只用该 ID 一次；有真实任务名时仍用任务名加 ID。Worker 不是独立 Task，不增加档案任务层级。子任务可以共用父 O 的本机工作区，但不共用其档案身份。各 Task 保留自己的档案身份；手动清理只处理明确选择的档案范围，排除未选子任务的目录。总任务 Recorder 沿真实父子关系读取已知子任务材料，关联成果按其确切引用读取；最终 Cleaner 由根任务统一承担。未固定字段时程序按当前源文件名和 Task ID 定位，不作持续旧目录回退；不因升级修改旧任务元数据或补路径字段。角色使用工具返回的确切档案路径。历史档案不扫描、不迁移、不改名或补写。档案中的 records.md 由 AI Recorder 撰写，程序从不改正文。Git 的 cleanup 与各 Host 机械事实保存在现有 tasks/<TaskID>.json 的 runtimeState.lifecycles，随原删除或释放提交合并，不读取归档 state.json；Local 保留自己的机械状态位置与清理流程。retention.json 独立保存 Recorder 输出、保留和迁移引用，不兼任终态文件。

清理分为两条边界不同的路径：现有任务资料 Cleaner 消费 Recorder 的既有清理信号，清理任务固定临时逻辑文件范围；原生执行 Cleaner 则是独立的 DSH 适配模块，处理 DSS 所拥有的已关闭执行留下的原生日志及对应缓存索引。后者不依附任务完成、Recorder 调度或 DSS Scheduler，也不是 AI 角色。

原生执行 Cleaner 的规范契约如下：

1. 覆盖 Foreground、Organizer、Planner、Worker、Recorder、Helper 全部 DSS AI 角色。创建执行时即捕获其执行身份和实际原生 Session ID，不能到清理时再按页面名称或任务名称猜测归属。
2. 采用 Kujira 的宿主状态事件驱动模式，但不依赖 Kujira 插件。只有宿主确认该实际执行已关闭时才入队；单轮 idle、关闭对话页面和任务 complete 都不能替代执行关闭。
3. 生产者在移交前已把必要原文、结果与恢复事实保存到所选权威存储：Local 为本地持久记录，Git 为远端 Git。清理模块不读取 Git、不补写业务记录，保存与核验由生产者完成。
4. 按精确执行身份与 Session ID 去重；已接收的不同 Session 独立推进，同一 Session 保留其实际句柄协调。单项失败保留明确错误，不阻塞其他会话；不增加业务轮询器，不占用 Worker 席位，不调用模型。
5. 仅清理该 DSS 执行拥有的原生日志与对应缓存索引；不扫描删除其他 DSH 对话，不删除业务档案、用户工程或其他执行资料。物理日志删除与投影缓存维护分别报告实际结果，缓存失败不改写日志删除结果。单纯 archive 或移除页面条目不等于磁盘清理。

原生磁盘删除和宿主缓存索引由 `src/native-cleaner/` 实现，并通过 `deepseek-servant/cleaner` 独立挂载；原生执行生产者使用实际注册与退役接口。模块已实现不代表所有平台和场景均已验收；`cleaner.ts` 的任务资料清理不替代原生执行清理。保留范围和两条路径的详细条件见 [数据保留与清理](RETENTION.md)。

## 外层 Safety Net

Safety Net 是用户侧运行故障通知之前的一层独立兜底，不替代或破坏已有的局部 Helper 场景、5 / 5 / 30 无响应处理、recovery 标记与周期检查，也不改变状态机、角色决策或记录权威。

以任务延续为中心：报警应包含实际故障来源、可用的任务／执行身份、目录或模型等相关对象，以及原有记录的引用。Helper 在现有权限内诊断并修复相关目录、重启对应执行或使用既有重置恢复，然后沿原任务继续。不得以清空任务资料、重建重复任务或丢弃已完成成果代替修复；没有任务身份的异常也不能捏造任务归属。

任何准备输出到用户前端的运行故障，第一次先保留真实内部诊断和原有业务责任，交给 Helper 做一次抢修或重置。Helper 先积极抢修；抢修不足以恢复时，须由 Helper 判断并明确调用已有重置恢复工具，接续原任务，不能把第一次抢修未成功当作结束或提前报错。实际结果区分修复后继续、热重置后继续，以及仍需处理的问题，均保存到权威记录。需要向用户沟通时，写入 Foreground 状态机信号；Foreground 先消费信号，按其所指的确切任务元数据或报告确认具体事件，再由 AI 自行生成并保存一条自然的短回应，随后结合相关记录和上下文说明结果；短回应不使用 Host 拼接的固定话术。Host 不弹出或拼接“未处理”“恢复待处理”“已修复”“已热重置”等过程、成功或故障通知。仅安排动作、Helper 退出或隐藏错误均不算恢复。抢修期间的重复刷新、同一失败的重复上报和旧执行的迟到回调不能冒充实际恢复结果。

首次故障不显示为用户错误，不等于操作成功。失败的请求、未确认的写入、原输入及恢复责任照常保留；界面不得伪造保存或恢复完成。抢修安排成功、Helper 被唤醒以及实际恢复完成分别记录，不能相互替代。 原生工具修复不要求强制重置；Helper 在现有 debug 记录中明确报告针对原故障已经执行的动作、观察结果和未解决问题。该报告用于保存 AI 已执行动作及原任务可否继续的实际判断，不作为程序独立验证恢复成功的证明。

修复方式、重置范围和后续行动由 Helper 根据实际故障及权威记录判断，并通过已有工具明确发起；这些决策写入角色 Prompt 与当前 Helper 指导，不编码为固定故障分支。Host 不得因 Helper 结束、失败或自身报错就自行选择执行级、任务级或全局重置，也不得新增冷启动失败后自动重建的兜底策略。保留原有局部抢修及已约定的机械超时处理；外层只递送故障、关联实际执行并记录 AI 所请求动作的真实结果。包括 Host 自己发起的唤醒，也必须写入对应状态机信号并走统一调度、消费流程，不得直接调用 AI 或另开调度通道。只针对异常触发，不给正常读取、写入或角色调度增加通讯、轮询、握手或等待，也不使独立任务等待某个故障抢修。故障匹配使用实际模式、存储域及相关任务、执行或操作身份，不能用全局最后一个任务推测归属。

所有恢复仍在现有授权范围内，不绕过权限拒绝或认证要求。运行设施不可达、Helper 自身异常等边界必须保留并处理恢复责任，不能因隐藏首次错误而永久静默，也不能递归生成无穷的 Helper。

实现状态：本节为新增的独立设计要求，当前正核对服务端、传输层与前端的全部故障显示出口，尚未宣称实现或实机通过。

## 文档导航

- [实现映射与构建](IMPLEMENTATION.md)
- [使用说明](docs/USAGE.md)
- [Git 设置与权限](PRIVATE_GIT.md)
- [数据保留与清理](RETENTION.md)
- [开发验证说明](docs/TESTING.md)

## 历史架构

历史资料按当时版本保存，用于旧数据格式和行为追溯：

- alpha.40 架构（2026-10-26）：历史源码中的 `docs/history/architecture-alpha40-20261026.md`。
- 2026-10-25 设计记录：历史源码中的 `docs/history/master-design-20261025.md`。

这两份历史记录不随当前测试快照提供；当前设计以本文及随包实现说明为准。

### Coordination read ownership

The existing one-second Host driver gives each Git coordination round an explicit,
lazy immutable read view. Signal and Task discovery, initial authority-list scans,
resource observation and heartbeat due checks share that round's HEAD, with separate
snapshot leases. Repeated authority-prefix reads in the same round share one result
and return independent copies. This is not a time cache or a new polling limit.
The next round observes the branch again, and a slow maintenance lane does not hold
the independent signal lane. Physical Local views retain lifetime and cancellation ownership only; each addressed read sees its actual file.

Only discovery calls receive the round. Role admission, authority updates,
transactions, conflict re-evaluation and post-write confirmation use current
reads, actual content dependencies and Git protocol atomic ref updates. A round
never persists credentials or becomes write authority. Each lease validates the current repository/account scope;
acquisition ownership ends before discovery schedules independent work. New data
published after a fixed view is acquired appears in the next discovery view.

### Planner continuation facts

Preserved child contracts and historical plans do not establish current native
execution liveness. Full-Task Planner inputs and the existing claim/snapshot tools
include this Host's known Worker execution facts for the bound Task/member, with
exact execution identity, generation, pending admissions and canonical logical
record paths. Their observation time is separate from the fixed business-file
revision. Only confirmed native stop without a surviving owner or producer is
reported as stopped; missing ownership alone remains unknown. A retried native
message keeps its original text, while subsequent claim/snapshot can refresh facts.

The Planner decides how unfinished work continues from real records, using the
existing assignment and notification tools and retaining child identity. Resume
does not itself revive every stopped Worker. This adds no dispatch, business
interpretation, recovery-marker gate, storage read or authority mutation. Existing
note-based recovery routing and per-Task concurrency rules remain unchanged.

### 实际成果与用户链接

用户成果保存在设置指定的本机任务工作区；链接直接使用实际绝对地址，由生产文件的电脑原生软件打开。任务的计划、Note、交接和归档等过程文件不是用户成果，无成果文件时只返回结果，不显示文件、目录或档案链接。

物理成果使用标准 Markdown：`[成果](</真实绝对路径> "DSS source: owner=编码后的成员名; instanceUUID=原Host标识")`。目标地址保持真实位置，来源直接随链接标题保存。角色从现有 snapshot 的 workspaceSource 获取来源标题；`dss_workspace_reference` 核验并记录位置，也返回完整 markdown 链接。登记不是打开前提，不必等待 Recorder。打开、预览和下载仅使用该地址与源 Host，任务和档案已清理仍可工作，不查询 Task ID，也不建立隐藏任务路径索引。同一路径来自不同 Host 时逐链接区分，另一 Host 不会误开本机同名文件。缺少来源的旧裸路径不能自动补来源。

Recorder 保存成果物存放位置。Task 的 workspaceResults 仍可保存 path、owner、instanceUUID 与仅供记录关联的 taskId，既有结构化成果卡片继续使用自带的来源地址。登记不是验收或完成，取消、未验收等状态必须如实说明。Cleaner 不清理本机工作区。打开保留原有源 Host、确切 realpath、文件类型、symlink 和所选 workspace root 边界；切换 root 不迁移文件，也不会静默绕过边界。不把过程文件变成成果。
