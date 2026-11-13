# DeepSeek Servant

基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的自主 AI 助理与多 Agent 协作插件。前台交流需求，后台协作推进任务、验收成果并整理长期知识。

<p align="center">
  <img src="https://raw.githubusercontent.com/Tests4gptplay/deepseek-servant/v0.3.0/docs/images/deepseek-servant-maids-duo.webp" alt="DeepSeek Servant 短裙与长裙女仆角色设计">
</p>

## 技术评述与项目实践 / Review & project practice

**摘要：** 当 AI 从回答问题走向承担工程、研究和创作任务，系统需要解决的问题也随之变化：工作怎样跨越会话边界，成果怎样被后继执行者继承，遇到中断怎样恢复，原有方案失效后怎样重新选择路线。

[Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness) 与 [DeepSeek Servant（DSS）](https://github.com/Tests4gptplay/deepseek-servant) 围绕这些问题形成了一条持续演进的技术路线：以持久任务为中心，将模型推理、角色协作、工作记忆、状态调度与执行环境分离。CAH 提供了长期任务和技术路线调整的实际案例，DSS 则将同一架构原则迁移到 DeepSeek Harness 的原生 Agent 环境。

两者共同探索的是：**让执行者可以更换、工作方法可以调整，而用户目标、已有成果和后续责任保持连续。**

**[阅读全文：让 AI 持续完成工作——CAH / DSS 的技术框架与工程实践](docs/reviews/CAH-DSS-TECHNICAL-FRAMEWORK.zh-CN.md)**

## 独立实践与架构趋同 / Independent work, convergent architecture

DSS 的 [v0.2.0（2026-10-26）](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.2.0) 已公开多角色协作、持久任务记录与异常接续，早于 DeepSeek 团队于 2026-10-31 公开的 [Super-agent 研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype)。这条独立工程路线延续自 [CAH v1.0.4（2026-09-20）](https://github.com/Tests4gptplay/chat-agent-harness/releases/tag/v1.0.4) 中的 Git 任务记录与可替换 Worker。

从双方公开实现看，交互与执行分工、任务状态持久化、中断恢复呈现**架构趋同**。DSS 的 [0.5.0-rc.2 测试版](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.5.0-rc.2) 沿自己的 Local／Git 协作路线采用六类原生角色；Super-agent 原型围绕 GitHub／飞书事件和 Ticket／Executor 模型运作。公开的 [CAH 运行记录](https://github.com/Tests4gptplay/chat-agent-harness-records)展示了 [Helper 恢复与 Planner 重新规划](https://github.com/Tests4gptplay/chat-agent-harness-records/blob/76646cc709375b1d8d262d809d76b3156698e796/showcase-observer/world-execute-chatgpt-20261017/backfills/2026-10-19T10-05Z-helper-image-replanning.md)的实际过程。

DSS [v0.2.0 (2026-10-26)](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.2.0) already included multi-role collaboration, persistent task records and recovery before the DeepSeek team's [Super-agent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) was published on 2026-10-31. This independent engineering path continues the Git-backed task records and replaceable Workers published in [CAH v1.0.4 (2026-09-20)](https://github.com/Tests4gptplay/chat-agent-harness/releases/tag/v1.0.4).

The two independently developed projects show **architectural convergence** in separating interaction from execution, persisting task state and recovering interrupted work. DSS's [0.5.0-rc.2 test release](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.5.0-rc.2) follows its own Local/Git collaboration path with six native roles; the Super-agent prototype centers on GitHub/Feishu events and Ticket/Executor. Public [CAH run records](https://github.com/Tests4gptplay/chat-agent-harness-records) include a [Helper recovery and Planner replanning case](https://github.com/Tests4gptplay/chat-agent-harness-records/blob/76646cc709375b1d8d262d809d76b3156698e796/showcase-observer/world-execute-chatgpt-20261017/backfills/2026-10-19T10-05Z-helper-image-replanning.md).

## 安装

下载插件 TGZ 后，在运行 DSH 的电脑上保留该文件。在 **插件 → 添加插件 → 包名或地址** 中填写其完整绝对路径，无需解压。安装后启用插件，按宿主提示重启。

**升级与资料保留：** 先正常停止 DSS 执行并保留原数据备份。若宿主提示已安装，先卸载插件条目，再从 TGZ 安装。保留 DSH 数据目录、Local 记录目录及任务工作区，不手工删除记录或数据。Desktop 需要时完整退出托盘进程后再打开；升级后检查设置、对话、任务记录与成果可读取。

**Web：** 先停止对应 profile，在运行该服务的环境执行，之后重启：

```sh
dsh plugin --profile web add '/absolute/path/deepseek-servant-0.5.0.tgz'
```

将示例替换为安装包在运行 DSH 的电脑上的实际绝对路径。Desktop 与 Web 分别管理安装。模型提供者与工具权限仍由 DSH 管理。

Git 模式需要 Python、Dulwich、urllib3 与已授权的 GitHub CLI；插件不会静默安装或磁盘回退。请先按 [安装与依赖](docs/INSTALLATION.md) 配置虚拟环境的完整路径。Local 模式不启动 Git helper。

## 统一框架能力

- **六类原生角色**：Foreground 交流需求，Organizer 分派与总验收，Planner 规划与成员验收，Worker 执行，Recorder 整理长期记录与技能，Helper 协助恢复。角色使用 DSH 原生 Agent、Session、工具和 Jobs。
- **Local / Git**：Local 将任务资料和长期记录分类保存在所选本机目录；Git 统一以 Dulwich 常驻内存后端通过标准 Git HTTPS 协议读写私有协作仓库，连接身份与显式成员管理保留必要的平台 API。前台访问与本端后台参与分别管理。
- **持续对话**：Foreground 每轮完成后使用新会话接续，带入最近六个完整对话往返原文；历史支持上滚和日期定位；AI 可检索原文并按字符分页读取长文。
- **成果与知识**：查看任务结果、下载已保存附件，读取旧任务完整原记录、偏好及项目事实；技能正文可直接编辑保存，支持停用，并保留已有来源和历史资料。
- **记录管理**：Local 提供任务历史、前台对话、工作规划和故障记录的查看与明确清理操作；记录搬家保留原件及任务、会话关联。
- **长期归档**：总任务完成后，Recorder 整理需要保留的记录，Cleaner 清理该任务的临时工作目录；子任务随总任务统一收尾，长期成果与独立工作区继续保留。

## 开始使用

从 DSH 侧栏打开 DeepSeek Servant，设置模型、预设与任务工作区，选择 Local 数据目录或 Git 仓库。保存并连接后，在对话中说明目标、交付物与验收要求。任务页查看进展和成果；参与开关控制本端后台。

模型提供者、工具及工作区权限由 DSH 管理。Git 仓库内容对获授权的协作者共享，请选用适合协作范围的仓库。

[使用说明](docs/USAGE.md) · [Git 设置](PRIVATE_GIT.md) · [数据保留](RETENTION.md)

## 来源与开源许可

DeepSeek Servant 由 [Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness) 的 Agent 设计体系延伸而来，并通过 DeepSeek Harness 的原生能力实现持续任务执行。

项目代码沿用 CAH 的 **[GNU AGPL v3.0 only（AGPL-3.0-only）](LICENSE)** 许可证。

角色美术与衍生图标单独采用 **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**，保留署名链 **上善无形 → ZipZipPipe**；本项目的图标与页面素材由 Tests4gptplay 提供并适配。再利用这些美术素材时请保留署名、注明修改，并遵守非商业性使用及相同方式共享条款。

项目版权声明见 [NOTICE](NOTICE)，美术范围、来源与第三方依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 支持项目 / Support

[GitHub Sponsors](https://github.com/sponsors/Tests4gptplay) · [Ko-fi](https://ko-fi.com/kou392350) · [支付宝 / Alipay](SPONSOR.md)
