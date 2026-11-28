# DeepSeek Servant 0.4.1

DeepSeek Servant 是基于 DeepSeek Harness 的自主 AI 助理与多 Agent 协作插件：前台与你交流需求，Planner 规划和验收，Worker 执行任务；支持任务持续推进、暂停与接续、故障恢复、工作记忆和技能学习，也提供可选的实验性私有 Git 协作模式。

## 这次更新了什么

- 安装包现在包含版本摘要和本版说明；README 中的历史验证资料也有固定、可访问的链接。
- 首页先说明能做什么、如何安装以及第一次如何交代任务，详细验证和架构资料留在后面，方便新用户上手。
- 保留 0.4.0 的 Git 执行进度与成果展示、任务恢复改进和 Auto 模型设置修复。运行代码、界面和美术资源不变。

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

安装后从侧栏打开 DeepSeek Servant，选择模型和工作区，再在对话中说明目标、交付物与验收要求。任务页可以查看进度和成果，也能暂停、继续或取消任务。需要私有 Git 协作时，再按协作指南启用 DSS-cah。

[安装指南](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.4.1/docs/INSTALLATION.md) · [使用指南](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.4.1/docs/USAGE.md) · [Git 协作指南](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.4.1/PRIVATE_GIT.md)
