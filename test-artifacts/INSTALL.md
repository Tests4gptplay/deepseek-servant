# 候选9安装与本机验收

版本：`0.3.6-uiqa.20261030.9`。下载本目录的 [安装包](deepseek-servant-0.3.6-uiqa.20261030.9-copyclarity.tgz)，完整校验表见 [manifest.json](manifest.json)。

SHA256：`11c4647101bcfb18a27e3a45095636ddaefd94b4c1cfd467f860c0357c3cbe08`（5,600,155字节）。

Windows PowerShell 校验：

```powershell
Get-FileHash .\deepseek-servant-0.3.6-uiqa.20261030.9-copyclarity.tgz -Algorithm SHA256
```

在 DeepSeek Harness 的插件管理中选择本地安装包，安装此 TGZ；按宿主提示重载插件。使用已有 DSH 模型、工作区和权限设置。模式及 Git 配置说明见 [使用指南](../docs/USAGE.md) 和 [Git 模式](../PRIVATE_GIT.md)。如当前宿主使用命令行管理插件，请沿用其官方本地包安装流程，包名和版本以本目录 manifest 为准。

## 本机验收入口

1. 确认插件版本，进入 Local 模式，用独立测试工作区提交一个可检查产物的目标；观察规划、Worker执行、Planner验收、最终交付。
2. 检查暂停/恢复、取消、修订，以及关闭重开后的同任务接续；保留已有成果。
3. Git 模式使用已获授权的测试仓库和配置，检查同步、任务进度、成果与归档；计划或结果更新时应显示更新中，随后回到已确认成果。
4. 记录操作系统、宿主版本、模型和 Git 传输类型、实际结果；错误内容去除账号、令牌和私人路径后反馈。

本候选的云端实际宿主结果见 [验收报告](../docs/testing/ACCEPTANCE.md)。Windows、macOS及公网 GitHub 传输是后续独立验收项。
