# 候选测试文档

## 增量交接原则

已通过项采用原证据，不交给下一执行者整套重跑。先核本机已完成结果，划掉重复工作，当前轮适度收尾。Local10、Git10加三种真实Git故障、Local五专项和更新中UI结果直接采用。只补Windows安装/路径/实际运行及真实模型衔接；公网GitHub仅在明确安排该项验证时进行。不重跑模拟双十轮/五专项。

修复仅复验受影响调用链及必要相邻恢复；无变化runtime的有效结果继续采用。报告分 `adopted_evidence` 与 `delta_cases`，不要把引用旧证据冒称本次重测。

- [安装与本机验收](../../test-artifacts/INSTALL.md)
- [安装包精确清单](../../test-artifacts/manifest.json)
- [已完成验收](ACCEPTANCE.md)
- [变更与依据](CHANGES.md)
- [产品使用指南](../USAGE.md)

统一交付结构：`test-artifacts/` 保存候选包、校验清单、安装说明；`docs/testing/` 保存实际验收范围与变更依据；仓库 README 提供入口。其他插件沿用这一结构，各自记录自己的版本和实际结果。


[查验具体用例、实际结果与公开净化证据](EVIDENCE.md)。
