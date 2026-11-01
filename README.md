# DeepSeek Servant

> **当前工作分支：Local / Git 统一框架候选，尚未 Release。** 包内版本号仍为 `0.4.1`，不能据此认定候选已发布或已通过用户实机验收。

<p align="center">
  <img src="https://raw.githubusercontent.com/Tests4gptplay/deepseek-servant/v0.3.0/docs/images/deepseek-servant-maids-duo.webp" alt="DeepSeek Servant 短裙与长裙女仆角色设计">
</p>

基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的社区协作助理插件。沿用原有界面与角色美术，当前候选将 Local 和 Git 接入同一套任务、记录、恢复和归档规则。

## 当前候选能力

- **六类原生角色**：Foreground 与用户交流，Organizer 分派和总验收，Planner 规划与成员验收，Worker 执行，Recorder 整理长期记录与技能，Helper 处理异常恢复。执行使用 DSH 原生 Agent、Session、工具和 Jobs，不另造模型执行器。
- **两种存储模式**：Local 用本实例的 SQLite 文件库；Git 直接读写所选私有仓库的远端树和 blob，不在本地维护 Git 镜像或工作树。协作权限不等于访问其他参与者的电脑。
- **前台访问与后台参与分开**：查看历史、发送消息和读取成果不自动登记后台成员或启动角色。后台参与可显式开始和退出；保存设置也会尝试登记并开始参与。关闭页面不等于停止后台。
- **可核对的成果**：任务完成、前台回复、Recorder 归档各有实际状态，不以阅读回执互相阻塞。附件通过授权文件能力保存真实字节并校验，再提供下载。
- **持久记录与知识**：AI Recorder 编写归档，固定 Cleaner 在核实保留资料后清理本任务临时文件。知识页支持读取、候选编辑及停用；候选不默认成为已验证技能。
- **明确的不确定性**：冲突需要重读和重新判断；响应丢失保留原写入身份。停止执行缺少真实确认时不会显示为已成功停止。

使用说明见 [USAGE](docs/USAGE.md)，Git 设置见 [PRIVATE_GIT](PRIVATE_GIT.md)，数据范围见 [RETENTION](RETENTION.md)。

## 安装与升级

### 已发布的历史版本

以下链接固定指向 **历史发布版 0.4.1，不包含本工作分支的统一框架改造**。安装步骤的历史说明见 [安装与升级](docs/INSTALLATION.md)，发行内容见 [0.4.1 发布说明](docs/releases/0.4.1.md)。

Desktop：打开 **插件 → 添加插件**，在 **包名或地址** 填入：

```text
github:Tests4gptplay/deepseek-servant#v0.4.1
```

备用发行包（可填同一输入框，或下载后使用运行 DSH 的电脑上的完整路径）：

```text
https://github.com/Tests4gptplay/deepseek-servant/releases/download/v0.4.1/deepseek-servant-0.4.1.tgz
```

Web 在运行服务的环境中安装，和 Desktop 分别管理：

```sh
dsh plugin --profile web add 'github:Tests4gptplay/deepseek-servant#v0.4.1'
```

升级前保留 DSH 数据及用户文件；若宿主要求卸载后重装，只处理插件条目，不手工清除数据目录。是否重启依宿主提示。模型提供者、工具和工作区权限仍由 DSH 管理。

### 当前候选

当前分支需要构建并核对候选包，不能用上述历史标签代替。构建入口、实现映射与验证边界见 [IMPLEMENTATION](IMPLEMENTATION.md)。尚未完成当前候选的真实 Host 模型执行、Desktop / Web 实机交互及公网专用 Git 账号最终验收；受控 HTTP 和组件测试不代表这些环境已通过。

## 实现与验证资料

- [当前源码架构与构建](IMPLEMENTATION.md)
- [当前测试说明](docs/TESTING.md)
- [数据保留与清理](RETENTION.md)
- [版本历史](CHANGELOG.md)
- [旧版本公开验证资料](https://github.com/Tests4gptplay/deepseek-servant/blob/d28a4d8538abc966608761bcfd60d568dec11cc9/docs/testing/EVIDENCE.md)
- [历史架构](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/DESIGN.md)、[历史设计稿](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/docs/DSS_MASTER_DESIGN_20261025.md)：仅用于追溯，不是当前候选的运行协议。

旧 Windows `0.2.1-rc.5` 等验收结论仅属于相应历史版本，不外推为本次重构通过。

## 来源与开源许可

DeepSeek Servant 由 [Chat Agent Harness（CAH）](https://github.com/Tests4gptplay/chat-agent-harness) 的 Agent 设计体系延伸而来，并通过 DeepSeek Harness 的原生能力实现持续任务执行。

项目代码沿用 CAH 的 **[GNU AGPL v3.0 only（AGPL-3.0-only）](LICENSE)** 许可证。

角色美术与衍生图标单独采用 **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**，保留署名链 **上善无形 → ZipZipPipe**；本项目的图标与页面素材由 Tests4gptplay 提供并适配。再利用这些美术素材时请保留署名、注明修改，并遵守非商业性使用及相同方式共享条款。

项目版权声明见 [NOTICE](NOTICE)，美术范围、来源与第三方依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 支持项目 / Support

[GitHub Sponsors](https://github.com/sponsors/Tests4gptplay) · [Ko-fi](https://ko-fi.com/kou392350) · [Patreon](https://www.patreon.com/cw/Kou848) · [爱发电 / Afdian](https://afdian.com/a/kkt_ifd1) · [支付宝 / Alipay](SPONSOR.md)
