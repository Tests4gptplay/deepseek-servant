# DeepSeek Servant

**基于 DeepSeek Harness 的自主 AI 助理与多 Agent 持续任务插件。**

围绕长期任务协调规划、执行与成果评价，保存进展、成果和经验，支持后续接续与方法调整。

[安装与使用](#安装与使用) · [0.5.3 正式发布](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.5.3) · [0.5.2 更新说明](docs/releases/0.5.2.md) · [0.5.1 更新说明](docs/releases/0.5.1.md) · [0.5.0／0.5.1 对比测试](docs/testing/0.5.1.md) · [English](https://github.com/Tests4gptplay/deepseek-servant/blob/main/README.en.md)

<p align="center">
<img src="https://raw.githubusercontent.com/Tests4gptplay/deepseek-servant/v0.3.0/docs/images/deepseek-servant-maids-duo.webp" width="480" alt="DeepSeek Servant 短裙与长裙女仆角色设计">
</p>

## 工作方式

DSS 是独立安装的社区插件，使用 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的原生 Agent、模型与工具能力。用户通过前台对话提出需求，Planner 规划并检查成果，Worker 在所选工作区执行。

任务目标、执行进展、已接受成果与工作记忆持续保留，为后续执行和任务接续提供依据。

### 核心能力

- **规划、执行与评价**：按目标拆分工作，支持并行执行、阶段检查、方法调整和最终交付。
- **任务控制与接续**：暂停、继续、取消和修订目标；查看需要补充的信息与已接受成果。
- **对话、历史与附件**：工作期间持续交流，按日期回看对话，浏览任务历史及已保存的成果。
- **工作记忆与技能**：保存和回查任务记录、工作规划随记与知识，积累可复用的技能。
- **可配置的工作环境**：选择模型、预设、工作区与 Worker 席位；模型提供者、工具权限和凭据沿用 DSH 配置。

## 工作模式

### Local

在当前 DSH 实例中保存任务状态并持续执行。对话、任务进度与成果可在同一界面中查看和管理。

### DSS-cah （实验性）

继承自 [CAH](https://github.com/Tests4gptplay/chat-agent-harness) 的远程作业模式，通过 Git 仓库传递任务、进展及成果，在相应 DSH 实例的工作区中执行，也支持多人共同开展工作。

试用时需配置专用私有仓库，并确认参与者的访问权限。

[操作指南](https://github.com/Tests4gptplay/deepseek-servant/blob/main/PRIVATE_GIT.md) · [已测场景与限制](docs/testing/0.5.0.md)

## 0.5.3 的改进

- **换人不丢席位**：同一任务线更换 Worker 时延续原席位，避免候补工作在两席仍占满时提前领工。
- **断点后接续**：交接中重启或后继唤起失败后重试，仍按原任务线接续，不重投。

[完整更新说明与下载](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.5.3)

## 0.5.2 的改进

- **任务与成果检索**：按标题或任务 ID 搜索当前任务和成果档案。
- **新任务优先显示**：有创建时间的任务按时间从新到旧排列。
- **原任务接续**：执行轮次结束却没有有效交接时，针对原任务排查；Worker 换人时沿用原工作线的席位，从已有进度继续。

[完整更新说明](docs/releases/0.5.2.md) · [增量验收](docs/testing/0.5.2.md)

## 0.5.1 的改进

- 优化前台响应、后台协作及归档收尾，减少 Git 协作中的重复访问和推送冲突。
- 修复连接状态指示，改善文件夹选择和记录搬迁；搬迁失败时可在设置页直接重试或放弃。

[完整更新说明](docs/releases/0.5.1.md) · [测试环境与同场景对比](docs/testing/0.5.1.md)

## 0.5.0 的改进

- **任务交付与后续整理分开**：成果先交付，记录整理随后继续。
- **历史记录与内容更新**：完善原文保留、按日期回看和任务历史，修正部分更新后仍显示旧内容的问题。
- **分类记录管理**：明确不同记录的清理范围，保留需要长期使用的技能与成果。
- **实验性远程作业**：完善 DSS-cah 的数据读写和状态更新。
- **Windows 启动兼容性**：默认 Python 不可用时，利用已有的可用环境恢复启动。

[完整更新说明 →](docs/releases/0.5.0.md) · [实验结果与计时口径 →](docs/testing/0.5.0.md)

## 安装与使用

在 DSH 中打开 **插件 → 添加插件**，输入 npm 包名：

```text
deepseek-servant
```

固定安装 0.5.3 时，可填写 `deepseek-servant@0.5.3`，或使用 GitHub 地址 `github:Tests4gptplay/deepseek-servant#v0.5.3`。

### 第一次使用

1. 安装并启用后，从侧栏打开 **DeepSeek Servant**，选择可用模型与工作区。
2. 说明目标、交付物和验收要求。前台确认需求，Planner 拆分和检查工作，Worker 在指定工作区执行。
3. 在任务页查看进度、结果和需要补充的信息；继续交流、调整目标，或按需暂停、继续和取消。
4. 使用 DSS-cah 进行远程作业时，按操作指南连接仓库。

[Desktop / Web 安装与升级](https://github.com/Tests4gptplay/deepseek-servant/blob/main/docs/INSTALLATION.md) · [使用指南](https://github.com/Tests4gptplay/deepseek-servant/blob/main/docs/USAGE.md) · [下载 0.5.3](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.5.3)

### 环境与依赖

Python 解释器使用 DSH 配置或环境中已有版本。Node 依赖由 DSH 官方安装流程处理，包括 koffi。

Git 能力使用开源项目 **Dulwich**。Dulwich **1.2.21** 与 urllib3 **2.8.0** 随包提供，分别按 Apache-2.0 和 MIT 许可分发；随包第三方组件保留各自的版权及许可声明，详见[第三方声明](THIRD_PARTY_NOTICES.md)。Python 低于 3.12 时另需满足 `typing_extensions` 条件依赖。

已测环境与覆盖范围见[测试记录](docs/testing/0.5.1.md)。

## 记录与数据管理

任务、工作记忆、知识、完整对话和历史档案保存在所选记录位置。可通过 **Servant 记录管理**迁移记录，迁移不改变任务工作区。

记录统计和分类清理用于区分任务历史、聊天、工作规划随记等内容。清理前请确认所选类别。DSH 自身的会话日志仍由宿主设置管理。

[数据保留与清理](https://github.com/Tests4gptplay/deepseek-servant/blob/main/RETENTION.md)

## 技术评述与项目实践

当 AI 从回答问题走向工程、研究和创作任务，需要解决的不只是单次推理：工作如何跨越会话边界，成果如何被接续，遇到中断如何恢复，以及方法失效后如何重新选择路线。

[CAH](https://github.com/Tests4gptplay/chat-agent-harness) 与 DSS 围绕这些问题持续演进：以持久任务为中心，将模型推理、角色协作、工作记忆与执行环境分开考虑。CAH 提供长期任务和路线调整的实践，DSS 将这条技术路线带入 DSH 原生 Agent 环境。

**共同目标是让执行者可以更换、工作方法可以调整，任务接续时保留目标、进展与已有成果。**

[CAH / DSS 的技术框架与工程实践](https://github.com/Tests4gptplay/deepseek-servant/blob/7f499a83433481844c9643be93ff3a986a65e22b/docs/reviews/CAH-DSS-TECHNICAL-FRAMEWORK.zh-CN.md)

### 独立实践与架构趋同

DSS [v0.2.0（2026-10-26）](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.2.0) 已公开多角色协作、持久任务记录与异常接续。这条独立路线延续自 [CAH v1.0.4（2026-09-20）](https://github.com/Tests4gptplay/chat-agent-harness/releases/tag/v1.0.4)。

DeepSeek 于 2026-10-31 公开的 [Super-agent 研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype) 在交互与执行分工、任务持久化和中断恢复等方面呈现相近方向。双方沿各自的工程路线，探索持续任务执行。

[CAH 公开运行记录](https://github.com/Tests4gptplay/chat-agent-harness-records)

## 验证与进一步了解

0.5.2 的长跑记录与 0.5.3 的席位回归分开统计，详见[0.5.2 测试记录](docs/testing/0.5.2.md)和[0.5.3 版本说明](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.5.3)。历史资料按版本单独列出。

- [0.5.0 更新说明](docs/releases/0.5.0.md)
- [使用指南](https://github.com/Tests4gptplay/deepseek-servant/blob/main/docs/USAGE.md)
- [实现与验证记录](https://github.com/Tests4gptplay/deepseek-servant/blob/main/IMPLEMENTATION.md)
- [0.4.1 公开验证资料](https://github.com/Tests4gptplay/deepseek-servant/blob/d28a4d8538abc966608761bcfd60d568dec11cc9/docs/testing/EVIDENCE.md)

<details>
<summary>历史设计与开发资料</summary>

设计与验收资料：

- [v0.3.0 架构资料](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/DESIGN.md)
- [统一设计基线](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/docs/DSS_MASTER_DESIGN_20261025.md)
- [早期架构资料](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/docs/history/architecture-20261024.md)
- [alpha.40 验收](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/docs/acceptance-private-git-20261026.md)
- [alpha.39 验收](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/docs/acceptance-20261026.md)

</details>

### 长线压测案例：《鲸骨以北》

以网页游戏制作为负载，观察 DSS 在环境和模型中断后能否续做同一个任务。整轮历时 **41 小时 46 分 42 秒**，包含等待和恢复；原规划者实际读到 **71 次**成果交接。报告逐项区分了外部中断、DSS 内部卡点和人工介入。

[阅读完整测试报告](docs/testing/0.5.2/work-long-run/REPORT.md) · [时间轴与证据索引](docs/testing/0.5.2/work-long-run/README.md)

## 来源与开源许可

DeepSeek Servant 由 CAH 的 Agent 设计体系延伸而来，并通过 DSH 的原生能力实现持续任务执行。

代码采用 **AGPL-3.0-only**。商业许可另行商议。

角色美术与衍生图标单独采用 **CC BY-NC-SA 4.0**，保留署名链 **上善无形 → ZipZipPipe**；本项目图标与页面素材由 Tests4gptplay 提供并适配。再利用时请保留署名、注明修改，并遵守非商业性使用及相同方式共享条款。

[LICENSE](https://github.com/Tests4gptplay/deepseek-servant/blob/main/LICENSE) · [NOTICE](https://github.com/Tests4gptplay/deepseek-servant/blob/main/NOTICE) · [第三方声明](https://github.com/Tests4gptplay/deepseek-servant/blob/main/THIRD_PARTY_NOTICES.md)

## 支持项目 / Support

[GitHub Sponsors](https://github.com/sponsors/Tests4gptplay) · [Ko-fi](https://ko-fi.com/kou392350) · [支付宝 / Alipay](https://github.com/Tests4gptplay/deepseek-servant/blob/main/SPONSOR.md)
