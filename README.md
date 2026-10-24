# DeepSeek Servant

基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的本地自主 AI 助理插件。围绕持久目标进行规划、执行、成果评价、方法调整、任务接续和技能积累。

> 当前版本：**0.1.0-alpha.3**。面向 DSH **0.2.1-rc.2**；已在隔离的 Linux DSH 环境验证，尚未完整验证 Windows Electron 和 Codex 专有模型路由。不属于 DeepSeek 官方项目。

## 能力

- **独立助理入口：**左侧导航独立页面，前台对话与后台任务分离，自选工作区，不随普通聊天窗口切换。
- **持续 Agent 工作：**Foreground 接收目标，Planner 规划并评价，Worker 用宿主工具执行，Helper 处理有具体归属的故障；按需使用角色，不常驻空转。
- **可靠接续：**目标、计划、工作前沿、执行归属、回执与 PendingAction 持久保存；支持有界进度、周期评审、正常 Worker 换代及后端重启后的状态恢复。
- **并行与控制：**多个独立 Worker、依赖调度、暂停、恢复、取消、用户补充要求与优先级；区分停止派发和物理作业停止。
- **学习闭环：**从有证据的结果提炼限定范围的 Skill 版本，复用 DSH 原生技能发现与按需加载，记录实际使用、验证和反馈。
- **完成后清理：**收缩已结束任务的热记忆、保护交付与引用证据；原生 Session 日志的归档不等于释放磁盘空间。

## 架构

采用嵌入 DSH 的模块化单体：TaskService / TaskKernel 负责持久状态和确定性变更；RuntimeCoordinator / AgentSupervisor 持有派发与实际 Agent 所有权；KnowledgeService 与宿主 Skill provider 对接。运行时使用 DSH 的 storageDomain、Agent、Session、tools、jobs 与工作区能力，**不依赖 Git Runner、独立 MCP 执行层或浏览器聊天搬运链**。

## 构建与安装

在已准备好与 DSH 0.2.1-rc.2 兼容的 Node.js / npm 环境中：

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm pack --ignore-scripts
```

在需要安装的 DSH profile 使用宿主提供的插件安装命令：

```sh
dsh plugin --profile <profile> add ./deepseek-servant-0.1.0-alpha.3.tgz --ignore-scripts
```

这会改变目标 DSH profile。建议先使用隔离 profile 验证；模型提供者、凭据和工具权限仍由宿主配置管理。

## 验证范围与已知限制

上一轮隔离环境中，已通过短任务的执行—验收—交付、技能形成与实际复用，以及 16 批 / 64 条合成事件的连续工作场景（3 次周期评审、2 次正常 Worker 换代、窗口外历史回查、最终独立核算与清理）。这不是对所有平台或任意长任务的保证。

当前 DSH 0.2.1-rc.2 提供会话归档，但没有公开的持久 Session 删除或截断接口；本插件不会直接删除宿主日志文件。详见 [清理说明](RETENTION.md)。

## 开发文档

- [开发顶层架构](DESIGN.md)
- [实现与验证记录](IMPLEMENTATION.md)
- [数据保留与清理](RETENTION.md)
- [第三方版权声明](THIRD_PARTY_NOTICES.md)

本仓库只包含插件实现及必要文档；测试模型桥、私有 CAH 研究档案、个人运行记录和临时验证素材不作为运行或发布依赖。
