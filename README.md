# DeepSeek Servant

<p align="center">
  <img src="https://raw.githubusercontent.com/Tests4gptplay/deepseek-servant/v0.3.0/docs/images/deepseek-servant-maids-duo.webp" alt="DeepSeek Servant 短裙与长裙女仆角色设计">
</p>

基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的自主 AI 助理与多 Agent 协作插件。围绕持久目标进行规划、执行、成果评价、方法调整、任务接续和技能积累。当前提供 Local 持续任务模式与实验性 DSS-cah Git 模式，让需求、任务进展、已有成果与长期经验在持续工作中保持连贯。

## 技术评述与项目实践 / Review & project practice

**摘要：** 当 AI 从回答问题走向承担工程、研究和创作任务，系统需要解决的问题也随之变化：工作怎样跨越会话边界，成果怎样被后继执行者继承，遇到中断怎样恢复，原有方案失效后怎样重新选择路线。

[Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness) 与 [DeepSeek Servant（DSS）](https://github.com/Tests4gptplay/deepseek-servant) 围绕这些问题形成了一条持续演进的技术路线：以持久任务为中心，将模型推理、角色协作、工作记忆、状态调度与执行环境分离。CAH 提供了长期任务和技术路线调整的实际案例，DSS 则将同一架构原则迁移到 DeepSeek Harness 的原生 Agent 环境。

两者共同探索的是：**让执行者可以更换、工作方法可以调整，而用户目标、已有成果和后续责任保持连续。**

**[阅读全文：让 AI 持续完成工作——CAH / DSS 的技术框架与工程实践](https://github.com/Tests4gptplay/deepseek-servant/blob/7f499a83433481844c9643be93ff3a986a65e22b/docs/reviews/CAH-DSS-TECHNICAL-FRAMEWORK.zh-CN.md)**

## 独立实践与架构趋同 / Independent work, convergent architecture

DSS 的 [v0.2.0（2026-10-26）](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.2.0) 已公开多角色协作、持久任务记录与异常接续，早于 DeepSeek 团队于 2026-10-31 公开的 [Super-agent 研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype)。这条独立工程路线延续自 [CAH v1.0.4（2026-09-20）](https://github.com/Tests4gptplay/chat-agent-harness/releases/tag/v1.0.4) 中的 Git 任务记录与可替换 Worker。

从双方公开实现看，交互与执行分工、任务状态持久化、中断恢复呈现**架构趋同**。DSS 的 [0.5.0-rc.2 测试版](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.5.0-rc.2) 沿自己的 Local／Git 协作路线采用六类原生角色；Super-agent 原型围绕 GitHub／飞书事件和 Ticket／Executor 模型运作。公开的 [CAH 运行记录](https://github.com/Tests4gptplay/chat-agent-harness-records)展示了 [Helper 恢复与 Planner 重新规划](https://github.com/Tests4gptplay/chat-agent-harness-records/blob/76646cc709375b1d8d262d809d76b3156698e796/showcase-observer/world-execute-chatgpt-20261017/backfills/2026-10-19T10-05Z-helper-image-replanning.md)的实际过程。

DSS [v0.2.0 (2026-10-26)](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.2.0) already included multi-role collaboration, persistent task records and recovery before the DeepSeek team's [Super-agent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) was published on 2026-10-31. This independent engineering path continues the Git-backed task records and replaceable Workers published in [CAH v1.0.4 (2026-09-20)](https://github.com/Tests4gptplay/chat-agent-harness/releases/tag/v1.0.4).

The two independently developed projects show **architectural convergence** in separating interaction from execution, persisting task state and recovering interrupted work. DSS's [0.5.0-rc.2 test release](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.5.0-rc.2) follows its own Local/Git collaboration path with six native roles; the Super-agent prototype centers on GitHub/Feishu events and Ticket/Executor. Public [CAH run records](https://github.com/Tests4gptplay/chat-agent-harness-records) include a [Helper recovery and Planner replanning case](https://github.com/Tests4gptplay/chat-agent-harness-records/blob/76646cc709375b1d8d262d809d76b3156698e796/showcase-observer/world-execute-chatgpt-20261017/backfills/2026-10-19T10-05Z-helper-image-replanning.md).

## 核心能力

- **目标驱动的多 Agent 工作**：前台交流需求，后台按任务需要进行规划、分工、并行执行与阶段检查，支持长任务接续和最终交付。
- **Local 持续任务模式**：在当前 DSH 实例中保存任务状态，支持暂停、继续、取消、目标修订、接续恢复及最终交付。
- **实验性 DSS-CAH 模式**：让多个参与者在各自工作区执行任务，通过私有仓库共享对话、计划、进度、成果与归档，并支持任务控制和接续；本端后台可按需加入或退出协作。
- **共用操作界面**：模式切换后分别显示对话和任务；模型、预设、工作区及 Worker 席位可配置。
- **对话、历史与成果**：在工作期间持续交流、补充要求，按日期回看对话、浏览任务历史，查看结果及已保存的成果附件。
- **工作记忆与技能**：保存和回查任务记录、工作规划随记与知识，支持技能积累；Local 提供分类记录清理与显式任务重置。

## 安装与使用

安装来源、Desktop / Web 操作和升级说明见 [安装与升级](docs/INSTALLATION.md)。

### 第一次使用

1. 安装并启用后，从侧栏打开 **DeepSeek Servant**，选择可用模型和工作区。
2. 在对话中说明目标、交付物和验收要求。前台与你确认需求，Planner 拆分和检查工作，Worker 在指定工作区执行。
3. 到任务页查看进度、结果和需要你补充的信息；可以继续交流、调整目标，或按需暂停、继续和取消。
4. 需要多个参与者通过私有 Git 仓库协作时，再启用 DSS-cah 并按[协作指南](PRIVATE_GIT.md)连接仓库；标准模式不需要 Git 协作配置。

[使用指南](docs/USAGE.md) · [Git 协作说明](PRIVATE_GIT.md) · [数据保留与清理](RETENTION.md) · [版本说明](docs/releases/0.5.0.md)

模型提供者、工具及工作区权限由 DSH 管理。Git 仓库中的协作内容对获授权的参与者共享，请选用适合协作范围的仓库。

## 来源与开源许可

DeepSeek Servant 由 [Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness) 的 Agent 设计体系延伸而来，并通过 DeepSeek Harness 的原生能力实现持续任务执行。

项目代码沿用 CAH 的 **[GNU AGPL v3.0 only（AGPL-3.0-only）](LICENSE)** 许可证。

角色美术与衍生图标单独采用 **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**，保留署名链 **上善无形 → ZipZipPipe**；本项目的图标与页面素材由 Tests4gptplay 提供并适配。再利用这些美术素材时请保留署名、注明修改，并遵守非商业性使用及相同方式共享条款。

项目版权声明见 [NOTICE](NOTICE)，美术范围、来源与第三方依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 支持项目 / Support

[GitHub Sponsors](https://github.com/sponsors/Tests4gptplay) · [Ko-fi](https://ko-fi.com/kou392350) · [支付宝 / Alipay](SPONSOR.md)
