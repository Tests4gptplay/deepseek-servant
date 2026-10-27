# DeepSeek Servant

<p align="center">
  <img src="docs/images/deepseek-servant-maids-duo.webp" alt="DeepSeek Servant 短裙与长裙女仆角色设计">
</p>

基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的自主 AI 助理与多 Agent 协作插件。围绕持久目标进行规划、执行、成果评价、方法调整、任务接续和技能积累。

**设计逻辑源自 [Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness)。** DeepSeek Servant 延续 CAH 以目标为中心的 Agent 工作闭环：理解需求、制定计划、执行工作、评价成果、调整方法、跨会话接续、故障恢复与技能积累。Servant 将这套持续工作机制整合到 DeepSeek Harness 运行环境，复用宿主的模型、工具、Session、作业与 Skill 能力。

**当前版本：** `0.2.3` · **测试宿主：** DSH `0.2.1-rc.3` · **项目形态：** 独立安装的社区插件

## 核心能力

- **共用界面、双模式后台**

- **对话呈现**

- **页面插画**

- **独立助理入口**
- **模型与设置**
- **持续 Agent 工作**
- **任务接续与恢复**
- **并行与任务控制**
- **技能积累**
- **工作记忆管理**
- **前台长对话**

## 安装与使用

在 DSH Desktop 的“插件 → 添加插件”中输入固定来源 `github:Tests4gptplay/deepseek-servant#v0.2.3`，安装并启用。Web profile 使用：

```sh
dsh plugin --profile web add 'github:Tests4gptplay/deepseek-servant#v0.2.3'
```

模型提供者、工具权限和凭据沿用 DSH 配置。进入侧栏 DeepSeek Servant，选择前台模型与工作区即可开始；后台 `Auto` 跟随本页前台模型，Worker 席位默认 2，可在设置中调整。

- [安装、升级与开发构建](docs/INSTALLATION.md)：固定版本安装、升级与显式开发命令。
- [使用指南](docs/USAGE.md)：任务提交与修订、聊天答复、并发控制、历史阅读、重启接续和记录管理。

## 兼容性与数据存储

**已验证宿主版本：** 当前升级使用 Windows / DSH `0.2.1-rc.3` 原生 SDK profile；此前功能基线使用 Linux / DSH `0.2.1-rc.2`。插件从宿主获取 DSH 组件，按实际接口运行，无 DSH 版本号硬性准入限制。已确认的 Desktop UI、侧栏行为和美术资源继续保留。

任务、助理、知识、完整对话与 records 档案通过原生 `storageDomain` 保存。在“Servant 记录管理”中可迁移整个记录目录；迁移完成后立即使用新位置，不改变任务工作区。大小统计分为六项长期记录与六项临时记录，按 Domain 实际内容计量。DSH 原生 Session 日志使用宿主单独配置的存储位置。详见 [数据保留与清理](RETENTION.md)。

## 来源与开源许可

DeepSeek Servant 由 [Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness) 的 Agent 设计体系延伸而来，并通过 DeepSeek Harness 的原生能力实现持续任务执行。

项目代码沿用 CAH 的 **[GNU AGPL v3.0 only（AGPL-3.0-only）](LICENSE)** 许可证。

角色美术与衍生图标单独采用 **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**，保留署名链 **上善无形 → ZipZipPipe**；本项目的图标与页面素材由 Tests4gptplay 提供并适配。再利用这些美术素材时请保留署名、注明修改，并遵守非商业性使用及相同方式共享条款。

项目版权声明见 [NOTICE](NOTICE)，美术范围、来源与第三方依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
