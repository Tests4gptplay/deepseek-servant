# DeepSeek Servant

<p align="center">
  <img src="docs/images/deepseek-servant-mascot.png" alt="DeepSeek Servant 招牌角色全身图" width="420">
</p>

基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的自主 AI 助理与多 Agent 协作插件。围绕持久目标进行规划、执行、成果评价、方法调整、任务接续和技能积累。

**设计逻辑源自 [Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness)。** DeepSeek Servant 延续 CAH 以目标为中心的 Agent 工作闭环：理解需求、制定计划、执行工作、评价成果、调整方法、跨会话接续、故障恢复与技能积累。Servant 将这套持续工作机制整合到 DeepSeek Harness 运行环境，复用宿主的模型、工具、Session、作业与 Skill 能力。

**当前版本：** `0.1.0-alpha.24` · **适配宿主：** DSH `0.2.1-rc.2` · **项目形态：** 独立安装的社区插件

## 核心能力

- **独立助理入口：** 左侧导航的专属页面使用用户选定的鲸尾女仆图标：图标跟随侧栏文字颜色，适配浅色、深色和自定义皮肤，插件列表保留独立的角色图标；前台交流和后台任务分离，助理可选择自己的工作区。
- **模型与设置：** 输入框底部直接选择前台模型和思考强度；页面齿轮与全局设置中的 DeepSeek Servant 入口共用设置和经验；可选择已有工作区，或为 DeepSeek Servant 指定独立的自定义文件夹，不改变 DSH 默认工作区及其他会话。后台模型使用同一选择器。默认 `Auto` 跟随 DSH 主对话框当前的模型选择，已开始的后台任务保持原配置。设置最下方预留实验性功能区域。
- **持续 Agent 工作：** Foreground 理解目标，Planner 制定计划并评价成果，Worker 执行具体工作，Helper 处理明确的运行故障。按任务需要调用对应角色。
- **任务接续与恢复：** 持久保存目标、计划、工作前沿、执行归属及结果；支持周期评审、Worker 正常换代、进度续作和后端重启后的状态恢复。
- **并行与任务控制：** 独立 Worker 并行、依赖协调、优先级、暂停、继续、取消和用户即时调整目标。
- **技能积累：** 从有证据的实际结果提炼可复用方法，接入 DSH 原生 Skill 系统，追踪适用范围、版本、实际加载和后续反馈。
- **工作记忆管理：** 默认不限期、数量或容量保留记录；可选策略支持导入、导出与重置，只在用户设置后精简已完成任务的过程记录，交付成果、有效技能和必要证据持续保留。

## 已完成的运行验证

此前 `alpha.2` 功能基线在隔离的 **Linux / DSH 0.2.1-rc.2** 环境中，已完成短任务从实际执行到成果验收、前台交付的完整流程，以及技能生成、加载和后续复用。

长任务验证处理了 **16 批、64 条合成事件**，包括 **3 次周期评审、2 次正常 Worker 换代**、跨代历史回查和最终独立核对。32 行最终账本与 16 批累计快照均与预先保存的独立答案一致；任务完成后执行了正式清理，成果文件哈希保持一致。

更多实测过程、运行条件及清理结果见 [实现与验证记录](IMPLEMENTATION.md)。

## 架构

采用嵌入 DSH 的模块化单体：

`TaskService / TaskKernel` 管理持久化任务事实与确定性状态变更；`RuntimeCoordinator / AgentSupervisor` 负责派发、运行所有权与接续；`KnowledgeService` 管理知识及技能版本。

运行时复用 DSH 的 `storageDomain`、Agent、Session、tools、jobs、工作区和原生技能能力。当前模式由单个 DSH 实例负责任务调度和持久记录，后续可扩展由多个实例共同协作的执行模式。

## 实验性跨设备协作方向

计划提供可选的 GitHub 协作模式：由用户在插件界面配置授权 Token 和协作仓库，让不同设备或平台上的 DeepSeek Harness 实例共享目标、任务进度和执行成果，使用各自的原生后台 Agent 完成工作与接续。GitHub 承担跨实例状态交换，实际工具操作仍由参与实例的 DSH 宿主执行。该模式以独立实验功能推进，现有单实例任务能力保持可用。

## 构建与安装

在兼容的 Node.js / npm 环境中，从仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm pack --ignore-scripts
```

将生成的插件包安装到指定 DSH profile：

```sh
dsh plugin --profile <profile> add ./deepseek-servant-0.1.0-alpha.24.tgz --ignore-scripts
```

建议先选择独立的 DSH profile 验证。模型提供者、工具权限与凭据使用宿主已有配置。

## 兼容性与数据存储

**已验证宿主版本：** DSH `0.2.1-rc.2`。插件从宿主获取 DSH 组件，按宿主的实际插件接口运行。`alpha.3` 完成包名、服务和通信标识统一后的源码级核对。后续目标环境验收包括改名版本的宿主安装、Windows Electron 和 Codex 专有模型路由。

任务、助理、知识与技能记录通过原生 `storageDomain` 保存。在设置的“记录保留与清理”中可选择记录文件夹并迁移已有记录；迁移完成后立即使用新位置，不改变任务工作区。原生前台、后台 Session 日志仍使用 DSH 单独配置的存储位置，不随插件记录迁移。DSH 的原生 Session 归档保留会话日志文件，界面分别显示插件记录的实际回收量与宿主日志的保留量。详见 [数据保留与清理](RETENTION.md)。

## 开发文档

- [开发顶层架构](https://github.com/Tests4gptplay/deepseek-servant/blob/main/DESIGN.md)
- [实现与验证记录](IMPLEMENTATION.md)
- [数据保留与清理](RETENTION.md)
- [第三方版权声明](THIRD_PARTY_NOTICES.md)

## 设计

[DeepSeek Servant 统一架构与已确认设计基线](docs/DSS_MASTER_DESIGN_20261025.md) 汇总前台、记忆、后台角色、异常恢复、records.md 留档与记录管理 UI；区分已实现与待实施。

来源与开源许可

DeepSeek Servant 由 [Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness) 的 Agent 设计体系延伸而来，并通过 DeepSeek Harness 的原生能力实现持续任务执行。

项目代码沿用 CAH 的 **[GNU AGPL v3.0 only（AGPL-3.0-only）](LICENSE)** 许可证。

角色美术与衍生图标单独采用 **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**，保留署名链 **上善无形 → ZipZipPipe**；本项目的图标与页面素材由 Tests4gptplay 提供并适配。再利用这些美术素材时请保留署名、注明修改，并遵守非商业性使用及相同方式共享条款。

项目版权声明见 [NOTICE](NOTICE)，美术范围、来源与第三方依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
