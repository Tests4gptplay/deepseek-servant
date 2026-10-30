# 候选10：模型 Auto 保存修复

版本 `0.3.6-uiqa.20261030.10`。本候选沿用候选9，并保留后续文档；只修正 Git 设置模型覆盖清除及相关文案。

- TGZ：[下载 TGZ](deepseek-servant-0.3.6-uiqa.20261030.10.tgz?raw=true)，沿用 DSH 原有本地包安装流程。
- ZIP：[下载 ZIP](DSS-local-0.3.6-uiqa.20261030.10-model-auto-fix.zip?raw=true)，内为同一20文件的 `deepseek-servant/` 目录。
- 完整 SHA256 和文件清单见 `manifest.json`；两种格式内的生产文件逐项相同。包内不含回归脚本或测试替身。

安装后打开 DSS-cah 设置，选择 **Auto／跟随宿主**，点击保存，关闭并重开设置。再重载插件确认仍为 Auto。初始配置本就默认 Auto；升级不会自行覆盖已有显式模型，须主动选择 Auto 并保存。

本轮已通过312项源码回归、5项模型路由/菜单回归、Local输入生命周期回归，以及真实React→JSON传输边界→服务→原生JSON存储→重建服务读回的针对性集成。原候选红对照确实复现旧模型保留。详见[修改与验证报告](../../docs/testing/MODEL-AUTO-CANDIDATE10.md)。

此轮没有触及用户机器、调用真实模型或进行Windows宿主安装；无需为验证此设置缺陷重复长任务或发送模型请求。
