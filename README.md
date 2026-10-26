# DeepSeek Servant

<p align="center">
  <img src="docs/images/deepseek-servant-mascot.png" alt="DeepSeek Servant 招牌角色全身图" width="420">
</p>

基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的自主 AI 助理与多 Agent 协作插件。围绕持久目标进行规划、执行、成果评价、方法调整、任务接续和技能积累。

**设计逻辑源自 [Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness)。** DeepSeek Servant 延续 CAH 以目标为中心的 Agent 工作闭环：理解需求、制定计划、执行工作、评价成果、调整方法、跨会话接续、故障恢复与技能积累。Servant 将这套持续工作机制整合到 DeepSeek Harness 运行环境，复用宿主的模型、工具、Session、作业与 Skill 能力。

**当前版本：** `0.2.0` · **适配宿主：** DSH `0.2.1-rc.3` · **项目形态：** 独立安装的社区插件

## 核心能力

- **独立双模式：** 标准模式延续现有持续任务体验；DSS-cah 实验模式让各参与者使用自己的前台、Planner 和 Worker，通过私有 Git 记录共同推进任务。两个模式使用独立设置与运行状态，页面切换后既有任务继续运行。

- **对话呈现：** 聊天区展示用户消息与 AI 最终答复；用户居右、助理居左，统一使用透明样式。设置支持助理名称和可留空的用户名称。

- **页面插画：** 对话与任务页使用各自的人物插画；空白时居中，有内容后移至右下角。在“实验性 → 页面插画”中可统一开关右下角人物，也可互换两页插画，设置自动保存。

- **独立助理入口：** 左侧导航保留鲸鱼女仆头饰图标，跟随侧栏文字颜色，适配浅色、深色和自定义皮肤；插件列表和页面标题使用用户选定的鲸尾女仆图标；前台交流和后台任务分离，助理可选择自己的工作区。
- **模型与设置：** 输入框底部直接选择前台模型和思考强度；页面齿轮与全局设置中的 DeepSeek Servant 入口共用设置和经验；可选择已有工作区，或为 DeepSeek Servant 指定独立的自定义文件夹，不改变 DSH 默认工作区及其他会话。设置中的后台模型默认使用 `Auto`，跟随本页前台模型及思考强度，也可单独指定后台模型。已开始的后台任务保持创建时的配置。设置最下方预留实验性功能区域。
- **持续 Agent 工作：** Foreground 理解目标，Planner 分阶段制定计划并评价成果，Worker 执行具体工作。故障保存完整现场，由同一角色的新执行接续；既有 Helper 历史保持可读。
- **任务接续与恢复：** 持久保存目标、计划、工作前沿、执行归属及结果；支持周期评审、Worker 正常换代与进度续作。宿主重启或异常退出后，后台按原角色、原任务接续，前台自动继续未完成回复；保留中断现场、既有成果与用户暂停、取消状态。
- **并行与任务控制：** Worker 席位默认 2，可按实际资源配置正整数席位，即时保存并影响后续调度；降低席位时让当前执行自然结束。支持依赖协调、优先级、暂停、继续、取消和用户即时调整目标；聊天中的实际答复可解除对应任务等待并继续工作。
- **技能积累：** 从有证据的实际结果提炼可复用方法，接入 DSH 原生 Skill 系统，追踪适用范围、版本、实际加载和后续反馈。
- **工作记忆管理：** 完整需求、Planner Memory、Note 版本和 Child Reply 保存在同一原生 Domain，按引用读取原文。任务完成后先封存 records、唤醒前台交付，再释放临时运行记录；records 长期保留，可导出 Markdown。历史入口与旧技能的维护策略支持导入、导出和重置。
- **前台长对话：** 每次交互使用新的物理 Session，带入最近六次完整用户交互；更早的原文按日期保存并可检索。向上滚动提前加载更早消息，保持当前阅读位置；日期筛选使用跟随 DSH 主题的日历。后台完成通知独立保存，侧栏显示原生绿色完成标记。可单独清理前台对话，后台任务继续运行。

## 已完成的运行验证

`alpha.40` 完成 88 项源码回归覆盖，以及 Windows / DSH `0.2.1-rc.3` 原生协作运行：两代 Worker 保留并续写产物、原生 Job 收尾、Planner 验收、前台交付与 Git 封存清理；实际进程树中断后的同任务接续也已完成。该场景使用受控模型及 Git API 对端，实际执行由原生 DSH 服务完成。详见[协作开发验收](docs/acceptance-private-git-20261026.md)。

`alpha.39` 已通过 73 项源码回归及实际页面组件测试。当前宿主经 `codex-local/gpt-6-astra` 完成连续 **1860.2037818 秒（31 分钟）**的原生静默 Job，退出码 **0**，随后完成 Planner 验收、前台主动交付、完整 records 封存与临时状态清理。详见[alpha.39 验收记录](docs/acceptance-20261026.md)。

在隔离的 Windows / DSH 0.2.1-rc.3 原生宿主中，强制终止执行中的进程树后，同一 Task 的第二代 Worker 继续原分配、保留先前文件并完成剩余成果；前台继续原消息，随后完成交付、档案封存与临时记录清理。该场景使用受控模型响应。

`alpha.37` 已在隔离的 **Windows / DSH 0.2.1-rc.3** 中完成原生 Agent、Session、文件工具与存储 Domain 的集成运行：16 个工作报告、5/10/15 段周期评审、两次 Worker 换代、原生错误后的同角色接续、前台完成留言、完整 records 封存与临时清理。重启后完整档案可读，Worker 席位设置和记录目录迁移通过原生接口保存与应用。该轮使用受控模型响应验证程序链路。

此前 `alpha.2` 功能基线在隔离的 **Linux / DSH 0.2.1-rc.2** 环境中，已完成短任务从实际执行到成果验收、前台交付的完整流程，以及技能生成、加载和后续复用。

长任务验证处理了 **16 批、64 条合成事件**，包括 **3 次周期评审、2 次正常 Worker 换代**、跨代历史回查和最终独立核对。32 行最终账本与 16 批累计快照均与预先保存的独立答案一致；任务完成后执行了正式清理，成果文件哈希保持一致。

更多实测过程、运行条件及清理结果见[实现与验证记录](IMPLEMENTATION.md)；历次候选与整理范围见[版本摘要](CHANGELOG.md)。

## 架构

采用嵌入 DSH 的模块化单体：

`TaskService / TaskKernel` 管理持久化任务事实与确定性状态变更；`RuntimeCoordinator / AgentSupervisor` 负责派发、运行所有权与接续；`KnowledgeService` 管理知识及技能版本。

运行时复用 DSH 的 `storageDomain`、Agent、Session、tools、jobs、工作区和原生技能能力。Local 持有自己的持续任务链；独立 Private Git 模式以 Git-first 提交、确认消费和角色结果绑定协调多个参与实例。

## DSS-cah 实验协作

在统一设置中启用 DSS-cah，选择私有仓库、仓库子目录、已有 GitHub 授权、模型与本实例工作目录。Host 增量检测指定目录的新增、修改和删除，只通知变更元数据；AI 按需读取正文、历史和知识，决定目标、修订及控制。任务、记忆与结果以远端 Git 为权威，原生 Foreground、Planner 和 Worker 持续执行、评价与交付。

操作步骤和数据位置见 [Private Git 使用说明](PRIVATE_GIT.md)。

## 安装与使用

在 DSH Desktop 的“插件 → 添加插件”中输入固定来源 `github:Tests4gptplay/deepseek-servant#v0.2.0`，安装并启用。Web profile 使用：

```sh
dsh plugin --profile web add 'github:Tests4gptplay/deepseek-servant#v0.2.0'
```

模型提供者、工具权限和凭据沿用 DSH 配置。进入侧栏 DeepSeek Servant，选择前台模型与工作区即可开始；后台 `Auto` 跟随本页前台模型，Worker 席位默认 2，可在设置中调整。

- [安装、升级与开发构建](docs/INSTALLATION.md)：固定版本安装、升级与显式开发命令。
- [使用指南](docs/USAGE.md)：任务提交与修订、聊天答复、并发控制、历史阅读、重启接续和记录管理。

## 兼容性与数据存储

**已验证宿主版本：** 当前升级使用 Windows / DSH `0.2.1-rc.3` 原生 SDK profile；此前功能基线使用 Linux / DSH `0.2.1-rc.2`。插件从宿主获取 DSH 组件，按实际接口运行，无 DSH 版本号硬性准入限制。已确认的 Desktop UI、侧栏行为和美术资源继续保留。

任务、助理、知识、完整对话与 records 档案通过原生 `storageDomain` 保存。在“Servant 记录管理”中可迁移整个记录目录；迁移完成后立即使用新位置，不改变任务工作区。大小统计分为六项长期记录与六项临时记录，按 Domain 实际内容计量。DSH 原生 Session 日志使用宿主单独配置的存储位置。详见 [数据保留与清理](RETENTION.md)。

## 开发文档

- [当前架构](DESIGN.md)
- [版本与验收摘要](CHANGELOG.md)
- [alpha.40 协作开发验收](docs/acceptance-private-git-20261026.md)
- [alpha.39 验收记录](docs/acceptance-20261026.md)
- [实现与验证记录](IMPLEMENTATION.md)
- [数据保留与清理](RETENTION.md)
- [第三方版权声明](THIRD_PARTY_NOTICES.md)

## 设计

[统一设计基线](docs/DSS_MASTER_DESIGN_20261025.md) 保留已接受行为；DSS-cah 的当前架构与操作见 [Git 协作说明](PRIVATE_GIT.md)。早期架构与旧 Helper 契约保留在[历史资料](docs/history/architecture-20261024.md)。

## 来源与开源许可

DeepSeek Servant 由 [Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness) 的 Agent 设计体系延伸而来，并通过 DeepSeek Harness 的原生能力实现持续任务执行。

项目代码沿用 CAH 的 **[GNU AGPL v3.0 only（AGPL-3.0-only）](LICENSE)** 许可证。

角色美术与衍生图标单独采用 **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**，保留署名链 **上善无形 → ZipZipPipe**；本项目的图标与页面素材由 Tests4gptplay 提供并适配。再利用这些美术素材时请保留署名、注明修改，并遵守非商业性使用及相同方式共享条款。

项目版权声明见 [NOTICE](NOTICE)，美术范围、来源与第三方依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
