# DeepSeek Servant

> 正式版本 **0.4.1** · [安装与升级](docs/INSTALLATION.md) · [版本摘要](CHANGELOG.md) · [验证记录](https://github.com/Tests4gptplay/deepseek-servant/blob/d28a4d8538abc966608761bcfd60d568dec11cc9/docs/testing/EVIDENCE.md)。

<p align="center">
  <img src="https://raw.githubusercontent.com/Tests4gptplay/deepseek-servant/v0.3.0/docs/images/deepseek-servant-maids-duo.webp" alt="DeepSeek Servant 短裙与长裙女仆角色设计">
</p>

基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的自主 AI 助理与多 Agent 协作插件。围绕持久目标进行规划、执行、成果评价、方法调整、任务接续和技能积累。当前提供 Local 持续任务模式与实验性 DSS-cah Git 模式；多 Agent 指前台、Planner 与 Worker 的角色协作。

**当前版本：** `0.4.1` · **最近测试宿主：** Windows Desktop `0.2.1-rc.5` · **项目形态：** 独立安装的社区插件

## 核心能力

- **目标驱动的多 Agent 工作**：前台理解要求，Planner 规划与验收，Worker 在所选工作区执行，支持并行席位、评审与任务换代。
- **Local 持续任务模式**：在当前 DSH 实例中保存任务状态，支持暂停、继续、取消、目标修订、接续恢复及最终交付。
- **实验性 DSS-cah Git 模式**：让多个参与者在各自工作区执行任务，通过私有仓库共享对话、计划、进度、成果与归档，并支持任务控制和接续。
- **共用操作界面**：模式切换后分别显示对话和任务；模型、预设、工作区及 Worker 席位可配置。
- **工作记忆与技能**：保存和回查任务记录、工作规划随记与知识，支持技能积累；Local 提供分类记录清理与显式任务重置。

## 安装与升级

当前版本：**0.4.1**。安装包与固定标签均已包含运行文件，无需编译。

**首次安装（Desktop）：** 打开侧栏 **插件 → 添加插件**（箭头菜单的 **安装第三方插件** 也可进入），把下面一整行填入 **包名或地址**，点击 **安装**，核对版本后点击 **立即启用**。

```text
github:Tests4gptplay/deepseek-servant#v0.4.1
```

**升级已有插件：** 同样填写上面的新版来源，成功后核对版本并启用；已有设置与用户文件保留。若宿主提示已安装或要求先卸载，再按提示仅卸载该插件条目并安装新版，不清除 DSH 数据或手工删除插件目录。是否需要重启以 DSH 提示为准；需要时完全退出并重新打开（Desktop 包括托盘）。

启用后从侧栏打开 DeepSeek Servant，选择模型和工作区；DSS-cah 按需启用。

**备用安装包：** 将下面的 `.tgz` 直链填入同一个 **包名或地址**；也可下载后填写文件的完整绝对路径，无需解压。该路径应属于运行 DSH 的电脑。

```text
https://github.com/Tests4gptplay/deepseek-servant/releases/download/v0.4.1/deepseek-servant-0.4.1.tgz
```

**Web：** 在运行服务的环境中执行。升级前停止对应 Web profile，成功后重新启动；Web 与 Desktop 分别安装。

```sh
dsh plugin --profile web add 'github:Tests4gptplay/deepseek-servant#v0.4.1'
```

备用时将命令中的来源换成上面的 `.tgz` 直链或下载文件的完整绝对路径。

模型提供者、工具权限和凭据沿用 DSH 配置。进入侧栏 DeepSeek Servant，选择前台模型与工作区即可开始；后台 `Auto` 跟随本页前台模型，Worker 席位默认 2，可在设置中调整。

### 第一次使用

1. 安装并启用后，从侧栏打开 **DeepSeek Servant**，选择可用模型和工作区。
2. 在对话中说明目标、交付物和验收要求。前台与你确认需求，Planner 拆分和检查工作，Worker 在指定工作区执行。
3. 到任务页查看进度、结果和需要你补充的信息；可以继续交流、调整目标，或按需暂停、继续和取消。
4. 需要多个参与者通过私有 Git 仓库协作时，再启用 DSS-cah 并按[协作指南](PRIVATE_GIT.md)连接仓库；标准模式不需要 Git 协作配置。

- [安装、升级与开发构建](docs/INSTALLATION.md)：固定版本安装、升级与显式开发命令。
- [使用指南](docs/USAGE.md)：任务提交与修订、聊天答复、并发控制、历史阅读、重启接续和记录管理。

### 当前协作范围

Git 模式支持参与者分工、任务控制、接续及归档，Worker 在各自 DSH 实例的工作区执行。远端交流需使用协作指南约定的消息投递入口；仅同步普通聊天记录不会自动发起前台回复或任务。


## DSS-cah 实验性 Git 模式

需要通过私有 Git 仓库协作时，可启用 DSS-cah。每个参与者都有自己的前台、Planner 和 Worker，在各自工作区执行任务；对话、计划、执行记录、成果与归档通过授权仓库共享。任务页显示参与者的执行进度和已接受成果，支持远端任务输入、控制、接续及归档读取。

连接前需准备 Git、GitHub CLI 和有读写权限的专用私有仓库。远端消息可使用约定的投递目录；普通共享聊天记录的同步不等于自动触发任务。具体入口、协作范围和数据可见性见协作指南。

操作步骤和数据位置见 [Private Git 使用说明](PRIVATE_GIT.md)。

## 兼容性与数据存储

**已验证宿主版本：** 最近模型设置增量在 Windows Desktop `0.2.1-rc.5` 完成；此前任务与原生 SDK 验证使用 Windows / DSH `0.2.1-rc.3`，早期功能基线使用 Linux / DSH `0.2.1-rc.2`。插件从宿主获取 DSH 组件，按实际接口运行，无 DSH 版本号硬性准入限制。已确认的 Desktop UI、侧栏行为和美术资源继续保留。

任务、助理、知识、完整对话与历史档案保存在你设置的记录目录中。在“Servant 记录管理”中可迁移整个记录目录；迁移完成后立即使用新位置，不改变任务工作区。大小统计按记录目录内真实文件字节计量，包含 JSON 封装、格式化和备份；其他文件与备份单列。历史任务索引计入“已完成任务档案”；“工作规划记录 / Work Planning Notes”单独统计工作规划索引与缓存，并提供独立清理入口。清理聊天保留规划记录。相对所选记录存储位置，规划记录位于 `deepseek_servant/work-planning/`，完整档案及历史索引位于 `deepseek_servant/archives/`。DSH 自身的会话日志使用宿主设置的保存位置。详见 [数据保留与清理](RETENTION.md)。

## 运行验证与进一步了解

已完成的验证涵盖实际任务交付、多 Worker 协作、长任务接续、进程中断恢复、工作记忆与技能复用，以及模型设置保存和重开。各轮宿主环境与覆盖范围分别记录，方便按自己的环境查阅。

- [实现与验证记录](IMPLEMENTATION.md)
- [版本与验收摘要](CHANGELOG.md)
- [具体用例与公开验证资料](https://github.com/Tests4gptplay/deepseek-servant/blob/d28a4d8538abc966608761bcfd60d568dec11cc9/docs/testing/EVIDENCE.md)

## 开发文档

- [当前架构](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/DESIGN.md)
- [版本与验收摘要](CHANGELOG.md)
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

## 本版能力与近期更新

- Git 任务页显示已提交的执行进度与成果，在新计划或结果发布期间显示更新中。
- 修复任务生命周期、恢复及重复结果判定问题，Git 输出改为流式接收。
- DSS-cah 模型切回 Auto 后，保存会清除旧 provider、model、reasoningEffort 覆盖；切换到不提供推理强度的模型时清除旧强度。Local 模型行为不变。
- Windows Desktop `0.2.1-rc.5` 的六项设置增量验证通过，包括保存重开、插件重载及实际进程重启；这轮仅验证设置，没有发起模型推理请求。

0.4.1 让安装包中的版本摘要、使用资料与发行说明都能直接打开；任务、设置和 Git 协作的使用方式与 0.4.0 相同。详见 [0.4.1 发布说明](docs/releases/0.4.1.md) 与[历史候选修改及验证记录](https://github.com/Tests4gptplay/deepseek-servant/blob/d28a4d8538abc966608761bcfd60d568dec11cc9/docs/testing/MODEL-AUTO-CANDIDATE10.md)。

## 支持项目 / Support

[GitHub Sponsors](https://github.com/sponsors/Tests4gptplay) · [Ko-fi](https://ko-fi.com/kou392350) · [Patreon](https://www.patreon.com/cw/Kou848) · [爱发电 / Afdian](https://afdian.com/a/kkt_ifd1) · [支付宝 / Alipay](SPONSOR.md)


[查验具体用例、实际结果与公开净化证据](https://github.com/Tests4gptplay/deepseek-servant/blob/d28a4d8538abc966608761bcfd60d568dec11cc9/docs/testing/EVIDENCE.md)。
