# 候选9安装与本机验收

## 增量交接原则

已通过项采用原证据，不交给下一执行者整套重跑。先核本机已完成结果，划掉重复工作，当前轮适度收尾。Local10、Git10加三种真实Git故障、Local五专项和更新中UI结果直接采用。只补Windows安装/路径/实际运行及真实模型衔接；公网GitHub仅在明确安排该项验证时进行。不重跑模拟双十轮/五专项。

修复仅复验受影响调用链及必要相邻恢复；无变化runtime的有效结果继续采用。报告分 `adopted_evidence` 与 `delta_cases`，不要把引用旧证据冒称本次重测。

版本：`0.3.6-uiqa.20261030.9`。下载本目录的 [安装包](deepseek-servant-0.3.6-uiqa.20261030.9-copyclarity.tgz)，完整校验表见 [manifest.json](manifest.json)。

SHA256：`11c4647101bcfb18a27e3a45095636ddaefd94b4c1cfd467f860c0357c3cbe08`（5,600,155字节）。

Windows PowerShell 校验：

```powershell
Get-FileHash .\deepseek-servant-0.3.6-uiqa.20261030.9-copyclarity.tgz -Algorithm SHA256
```

在 DeepSeek Harness 的插件管理中选择本地安装包，安装此 TGZ；按宿主提示重载插件。使用已有 DSH 模型、工作区和权限设置。模式及 Git 配置说明见 [使用指南](../docs/USAGE.md) 和 [Git 模式](../PRIVATE_GIT.md)。如当前宿主使用命令行管理插件，请沿用其官方本地包安装流程，包名和版本以本目录 manifest 为准。

## 实机验证要求

Local10、Git10加三种真实Git故障、Local五专项和更新中UI结果直接采用。只补Windows安装/路径/实际运行及真实模型衔接；公网GitHub仅在明确安排该项验证时进行。不重跑模拟双十轮/五专项。

具体既有覆盖见[验收报告](../docs/testing/ACCEPTANCE.md)。仅做原生平台或真实服务尚缺的项，记录新增结果和当前已完成的本机证据，不重新盘点所有入口、全量双语矩阵或模拟后端。
