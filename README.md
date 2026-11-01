# DeepSeek Servant

基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的自主 AI 助理与多 Agent 协作插件。前台交流需求，后台协作推进任务、验收成果并整理长期知识。

<p align="center">
  <img src="https://raw.githubusercontent.com/Tests4gptplay/deepseek-servant/v0.3.0/docs/images/deepseek-servant-maids-duo.webp" alt="DeepSeek Servant 短裙与长裙女仆角色设计">
</p>

## 安装与升级

当前分支为 **0.5.0 候选**。收到候选 `.tgz` 后，在 DSH 的 **插件 → 添加插件 → 包名或地址** 填写运行 DSH 的电脑上该文件的完整路径，核对版本并启用。

公开发行包见 [Releases](https://github.com/Tests4gptplay/deepseek-servant/releases)。历史已发布版本为 **0.4.1**；当前候选的发布状态及内容见 [0.5.0 说明](docs/releases/0.5.0.md)。Desktop、Web 和升级步骤见[安装指南](docs/INSTALLATION.md)。

## 统一框架能力

- **六类原生角色**：Foreground 交流需求，Organizer 分派与总验收，Planner 规划与成员验收，Worker 执行，Recorder 整理长期记录与技能，Helper 协助恢复。角色使用 DSH 原生 Agent、Session、工具和 Jobs。
- **Local / Git**：Local 使用 SQLite 文件库；Git 通过 GitHub API 读写私有协作仓库。前台访问与本端后台参与分别管理。
- **持续对话**：Foreground 每轮完成后使用新会话接续，带入最近六个完整对话往返原文；历史支持上滚和日期定位；AI 可检索原文并按字符分页读取长文。
- **成果与知识**：查看任务结果、下载已保存附件，读取旧任务完整原记录、偏好及项目事实；技能支持候选编辑与停用，并保留来源和版本。
- **记录管理**：Local 分别提供任务历史、前台对话和工作规划记录的明确清理操作；记录搬家核验原生执行停止、复制结果和原存储身份，保留任务与会话关联。
- **长期归档**：Recorder 编写记录，Cleaner 核对原资料与保留成果后清理临时文件；结果引用与成果附件继续可用。

## 开始使用

从 DSH 侧栏打开 DeepSeek Servant，设置模型、预设与任务工作区，选择 Local 数据目录或 Git 仓库。保存并连接后，在对话中说明目标、交付物与验收要求。任务页查看进展和成果；参与开关控制本端后台。

模型提供者、工具及工作区权限由 DSH 管理。Git 仓库内容对获授权的协作者共享，请选用适合协作范围的仓库。

[使用说明](docs/USAGE.md) · [Git 设置](PRIVATE_GIT.md) · [数据保留](RETENTION.md) · [实现与构建](IMPLEMENTATION.md) · [开发验证](docs/TESTING.md) · [版本历史](CHANGELOG.md)

## 来源与开源许可

DeepSeek Servant 由 [Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness) 的 Agent 设计体系延伸而来，并通过 DeepSeek Harness 的原生能力实现持续任务执行。

项目代码沿用 CAH 的 **[GNU AGPL v3.0 only（AGPL-3.0-only）](LICENSE)** 许可证。

角色美术与衍生图标单独采用 **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**，保留署名链 **上善无形 → ZipZipPipe**；本项目的图标与页面素材由 Tests4gptplay 提供并适配。再利用这些美术素材时请保留署名、注明修改，并遵守非商业性使用及相同方式共享条款。

项目版权声明见 [NOTICE](NOTICE)，美术范围、来源与第三方依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 支持项目 / Support

[GitHub Sponsors](https://github.com/sponsors/Tests4gptplay) · [Ko-fi](https://ko-fi.com/kou392350) · [Patreon](https://www.patreon.com/cw/Kou848) · [爱发电 / Afdian](https://afdian.com/a/kkt_ifd1) · [支付宝 / Alipay](SPONSOR.md)
