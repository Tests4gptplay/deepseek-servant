# DeepSeek Servant

> 候选测试分支：[`安装包与安装步骤`](test-artifacts/INSTALL.md) · [`验收报告`](docs/testing/ACCEPTANCE.md) · [`变更依据`](docs/testing/CHANGES.md) · [`文档索引`](docs/testing/README.md)。本分支用于候选安装与下一轮本机验收，main 保持原发布版本。

<p align="center">
  <img src="https://raw.githubusercontent.com/Tests4gptplay/deepseek-servant/v0.3.0/docs/images/deepseek-servant-maids-duo.webp" alt="DeepSeek Servant 短裙与长裙女仆角色设计">
</p>

基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的自主 AI 助理与多 Agent 协作插件。围绕持久目标进行规划、执行、成果评价、方法调整、任务接续和技能积累。当前提供 Local 持续任务模式与实验性 DSS-cah Git 模式；多 Agent 指前台、Planner 与 Worker 的角色协作。

**设计逻辑源自 [Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness)。** DeepSeek Servant 延续 CAH 以目标为中心的 Agent 工作闭环：理解需求、制定计划、执行工作、评价成果、调整方法、跨会话接续、故障恢复与技能积累。Servant 将这套持续工作机制整合到 DeepSeek Harness 运行环境，复用宿主的模型、工具、Session、作业与 Skill 能力。

**当前候选版本：** `0.3.6-uiqa.20261030.9` · **测试宿主：** DSH `0.2.1-rc.3` · **项目形态：** 独立安装的社区插件

## 核心能力

- **目标驱动的多 Agent 工作**：前台理解要求，Planner 规划与验收，Worker 在所选工作区执行，支持并行席位、评审与任务换代。
- **Local 持续任务模式**：在当前 DSH 实例中保存任务状态，支持暂停、继续、取消、目标修订、接续恢复及最终交付。
- **实验性 DSS-cah Git 模式**：通过 Git 保存任务、角色记录、绑定结果与归档，读回已提交状态后推进本实例的原生角色。
- **共用操作界面**：模式切换后分别显示对话和任务；模型、预设、工作区及 Worker 席位可配置。
- **工作记忆与技能**：保存和回查任务记录、工作规划随记与知识，支持技能积累；Local 提供分类记录清理与显式任务重置。

### 当前协作范围

当前 Git 模式提供参与者与实例分工、任务及角色记录提交、读回消费、控制、接续和归档；Worker 在各自 DSH 实例的工作区运行。外部 Markdown（`inbox/`）和按目标参与者、实例绑定的 `conversations/` + `intents/` 远程输入已完成前台交流实验。仅写入 `conversations/` 的普通共享聊天尚未自动接入该消费流程；同步聊天记录与触发前台消费是不同环节。

## 已完成的运行验证

`alpha.40` 完成 88 项源码回归覆盖，以及 Windows / DSH `0.2.1-rc.3` 原生协作运行：两代 Worker 保留并续写产物、原生 Job 收尾、Planner 验收、前台交付与 Git 封存清理；实际进程树中断后的同任务接续也已完成。该场景使用受控模型及 Git API 对端，实际执行由原生 DSH 服务完成。详见[协作开发验收](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/docs/acceptance-private-git-20261026.md)。

`alpha.39` 已通过 73 项源码回归及实际页面组件测试。当前宿主经 GPT 完成连续 **1860.2037818 秒（31 分钟）**的原生静默 Job，退出码 **0**，随后完成 Planner 验收、前台主动交付、完整 records 封存与临时状态清理。详见[alpha.39 验收记录](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/docs/acceptance-20261026.md)。

在隔离的 Windows / DSH 0.2.1-rc.3 原生宿主中，强制终止执行中的进程树后，同一 Task 的第二代 Worker 继续原分配、保留先前文件并完成剩余成果；前台继续原消息，随后完成交付、档案封存与临时记录清理。该场景使用受控模型响应。

`alpha.37` 已在隔离的 **Windows / DSH 0.2.1-rc.3** 中完成原生 Agent、Session、文件工具与存储 Domain 的集成运行：16 个工作报告、5/10/15 段周期评审、两次 Worker 换代、原生错误后的同角色接续、前台完成留言、完整 records 封存与临时清理。重启后完整档案可读，Worker 席位设置和记录目录迁移通过原生接口保存与应用。该轮使用受控模型响应验证程序链路。

此前 `alpha.2` 功能基线在隔离的 **Linux / DSH 0.2.1-rc.2** 环境中，已完成短任务从实际执行到成果验收、前台交付的完整流程，以及技能生成、加载和后续复用。

长任务验证处理了 **16 批、64 条合成事件**，包括 **3 次周期评审、2 次正常 Worker 换代**、跨代历史回查和最终独立核对。32 行最终账本与 16 批累计快照均与预先保存的独立答案一致；任务完成后执行了正式清理，成果文件哈希保持一致。

更多实测过程、运行条件及清理结果见[实现与验证记录](IMPLEMENTATION.md)；历次候选与整理范围见[版本摘要](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.6/CHANGELOG.md)。

## 架构

采用嵌入 DSH 的模块化单体：

`TaskService / TaskKernel` 管理持久化任务事实与确定性状态变更；`RuntimeCoordinator / AgentSupervisor` 负责派发、运行所有权与接续；`KnowledgeService` 管理知识及技能版本。

运行时复用 DSH 的 `storageDomain`、Agent、Session、tools、jobs、工作区和原生技能能力。Local 持有自己的持续任务链；独立 Private Git 模式以 Git-first 提交、确认消费和角色结果绑定协调多个参与实例。

## DSS-cah 实验性 Git 模式

在统一设置中启用 DSS-cah，设置私有仓库、仓库内目录、模型与本实例工作目录，通过已登录的 GitHub CLI 连接。Host 以 1 秒正常间隔增量同步远端，启动与完成状态使用独立追加记录；AI 按角色保存前台答复、Planner Memory / Plan Note、Worker Child Reply，再单独提交最终信号，由读回的远端状态推进下一角色。普通业务文档、历史和知识按需读取。任务、记忆与结果以远端 Git 为权威，原生 Foreground、Planner 和 Worker 持续执行、评价与交付。

**远程前台实验（2026-10-29）**：在已连接的 DSS-cah 私有 Git 协作仓库中，分别从外部投递 `inbox/` Markdown 消息，以及直接向 `conversations/` + `intents/` 写入聊天消息。两种入口都触发了 Host 的 Git 读回与原生 Foreground 响应；AI 回复、对话索引、`respond` 完成信号和执行关闭均已从 Git 核对。两轮均作为普通聊天处理，没有建立 Planner 任务。详见[远程 Git 前台交流实验案例](docs/cases/dss-cah-remote-foreground-20261029.md)。

操作步骤和数据位置见 [Private Git 使用说明](PRIVATE_GIT.md)。

## 安装与使用

正式版在 DSH Desktop 的“插件 → 添加插件”中输入固定来源 `github:Tests4gptplay/deepseek-servant#v0.3.6`，安装并启用。Web profile 使用：

```sh
dsh plugin --profile web add 'github:Tests4gptplay/deepseek-servant#v0.3.6'
```

模型提供者、工具权限和凭据沿用 DSH 配置。进入侧栏 DeepSeek Servant，选择前台模型与工作区即可开始；后台 `Auto` 跟随本页前台模型，Worker 席位默认 2，可在设置中调整。

- [安装、升级与开发构建](docs/INSTALLATION.md)：固定版本安装、升级与显式开发命令。
- [使用指南](docs/USAGE.md)：任务提交与修订、聊天答复、并发控制、历史阅读、重启接续和记录管理。

## 兼容性与数据存储

**已验证宿主版本：** 当前升级使用 Windows / DSH `0.2.1-rc.3` 原生 SDK profile；此前功能基线使用 Linux / DSH `0.2.1-rc.2`。插件从宿主获取 DSH 组件，按实际接口运行，无 DSH 版本号硬性准入限制。已确认的 Desktop UI、侧栏行为和美术资源继续保留。

任务、助理、知识、完整对话与 records 档案通过原生 `storageDomain` 保存。在“Servant 记录管理”中可迁移整个记录目录；迁移完成后立即使用新位置，不改变任务工作区。大小统计按记录目录内真实文件字节计量，包含 JSON 封装、格式化和备份；其他文件与备份单列。历史任务索引计入“已完成任务档案”；“工作规划记录 / Work Planning Notes”独立统计 Foreground_List 与 Foreground_Cache，并提供单独清理入口。清理聊天保留规划记录。相对所选记录存储位置，规划记录位于 `deepseek_servant/work-planning/`，完整档案及历史索引位于 `deepseek_servant/archives/`。DSH 原生 Session 日志使用宿主单独配置的存储位置。详见 [数据保留与清理](RETENTION.md)。

## 开发文档

- [当前架构](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/DESIGN.md)
- [版本与验收摘要](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.6/CHANGELOG.md)
- [alpha.40 协作开发验收](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/docs/acceptance-private-git-20261026.md)
- [alpha.39 验收记录](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/docs/acceptance-20261026.md)
- [实现与验证记录](IMPLEMENTATION.md)
- [数据保留与清理](RETENTION.md)
- [第三方版权声明](THIRD_PARTY_NOTICES.md)

## 设计

[统一设计基线](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/docs/DSS_MASTER_DESIGN_20261025.md) 保留已接受行为；DSS-cah 的当前架构与操作见 [Git 协作说明](PRIVATE_GIT.md)。早期架构与旧 Helper 契约保留在[历史资料](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/docs/history/architecture-20261024.md)。

## 来源与开源许可

DeepSeek Servant 由 [Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness) 的 Agent 设计体系延伸而来，并通过 DeepSeek Harness 的原生能力实现持续任务执行。

项目代码沿用 CAH 的 **[GNU AGPL v3.0 only（AGPL-3.0-only）](LICENSE)** 许可证。

角色美术与衍生图标单独采用 **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**，保留署名链 **上善无形 → ZipZipPipe**；本项目的图标与页面素材由 Tests4gptplay 提供并适配。再利用这些美术素材时请保留署名、注明修改，并遵守非商业性使用及相同方式共享条款。

项目版权声明见 [NOTICE](NOTICE)，美术范围、来源与第三方依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 支持项目 / Support

[GitHub Sponsors](https://github.com/sponsors/Tests4gptplay) · [Ko-fi](https://ko-fi.com/kou392350) · [Patreon](https://www.patreon.com/cw/Kou848) · [爱发电 / Afdian](https://afdian.com/a/kkt_ifd1) · [支付宝 / Alipay](SPONSOR.md)


[查验具体用例、实际结果与公开净化证据](docs/testing/EVIDENCE.md)。
