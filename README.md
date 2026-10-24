# DeepSeek Servant

基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的本地自主 AI 助理插件。围绕持久目标进行规划、执行、成果评价、方法调整、任务接续和技能积累。

**当前版本：** `0.1.0-alpha.3` · **适配宿主：** DSH `0.2.1-rc.2` · **项目形态：** 独立安装的社区插件

## 核心能力

- **独立助理入口：** 左侧导航的专属页面，前台交流和后台任务分离；助理可选择自己的工作区。
- **持续 Agent 工作：** Foreground 理解目标，Planner 制定计划并评价成果，Worker 执行具体工作，Helper 处理明确的运行故障。按任务需要调用对应角色。
- **任务接续与恢复：** 持久保存目标、计划、工作前沿、执行归属及结果；支持周期评审、Worker 正常换代、进度续作和后端重启后的状态恢复。
- **并行与任务控制：** 独立 Worker 并行、依赖协调、优先级、暂停、继续、取消和用户即时调整目标。
- **技能积累：** 从有证据的实际结果提炼可复用方法，接入 DSH 原生 Skill 系统，追踪适用范围、版本、实际加载和后续反馈。
- **工作记忆管理：** 已完成任务的过程记录按策略精简，交付成果、有效技能和必要证据持续保留。

## 已完成的运行验证

此前 `alpha.2` 功能基线在隔离的 **Linux / DSH 0.2.1-rc.2** 环境中，已完成短任务从实际执行到成果验收、前台交付的完整流程，以及技能生成、加载和后续复用。

长任务验证处理了 **16 批、64 条合成事件**，包括 **3 次周期评审、2 次正常 Worker 换代**、跨代历史回查和最终独立核对。32 行最终账本与 16 批累计快照均与预先保存的独立答案一致；任务完成后执行了正式清理，成果文件哈希保持一致。

更多实测过程、运行条件及清理结果见 [实现与验证记录](IMPLEMENTATION.md)。

## 架构

采用嵌入 DSH 的模块化单体：

`TaskService / TaskKernel` 管理持久化任务事实与确定性状态变更；`RuntimeCoordinator / AgentSupervisor` 负责派发、运行所有权与接续；`KnowledgeService` 管理知识及技能版本。

运行时复用 DSH 的 `storageDomain`、Agent、Session、tools、jobs、工作区和原生技能能力。任务调度与记忆存储直接在本地宿主完成。

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
dsh plugin --profile <profile> add ./deepseek-servant-0.1.0-alpha.3.tgz --ignore-scripts
```

建议先选择独立的 DSH profile 验证。模型提供者、工具权限与凭据使用宿主已有配置。

## 兼容性与数据存储

**当前适配版本：** DSH `0.2.1-rc.2`。`alpha.3` 完成包名、服务和通信标识统一后的源码级核对。后续目标环境验收包括改名版本的宿主安装、Windows Electron 和 Codex 专有模型路由。

任务记录由插件在本地管理。DSH 的原生 Session 归档保留会话日志文件，界面分别显示插件记录的实际回收量与宿主日志的保留量。详见 [数据保留与清理](RETENTION.md)。

## 开发文档

- [开发顶层架构](DESIGN.md)
- [实现与验证记录](IMPLEMENTATION.md)
- [数据保留与清理](RETENTION.md)
- [第三方版权声明](THIRD_PARTY_NOTICES.md)
