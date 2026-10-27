# 0.2.2 关键升级验收

日期：2026-10-27。环境：Windows，DSH 0.2.1-rc.3，Node 24.21.0。

## 实现与回归

- TypeScript 检查通过；本次受影响范围回归 54/54 通过。
- Foreground / Planner / Worker 冷启动恢复用例经过实际 CoopConsumer 与 CoopNativeAgents，受控 Host 接口记录了原 Session 的 resume、对应角色预设、保存进度引用、一次 followup 排队及 flush。重复同步保持一次启动；暂停参与保持暂停。
- 角色正文、Result 与最终状态分开写入；远端读回状态后推进角色。完成消费保留原 Result。
- 旧未完成执行沿原绑定先升级启动状态再续作；已完成的旧结果继续可读。
- 前台交付正文在任务热记录清理后仍可从对话中读取。

## 实际 Git 验证

在用户指定私库的指定目录内，以独立临时参与者执行两个 GitRepository 实例的读写：启动、正文、Result、独立完成状态顺序通过；仅正文或未补齐最终状态时不推进；中断最终提交后可从远端 Result 恢复，原 Result SHA 保持不变。相同 HEAD 的后续检查仅执行 fetch 与 rev-parse，账户/仓库 API 读取为 0。临时创建的 12 条路径已精确清理。

## 安装包与原生升级

- 包：deepseek-servant-0.2.2.tgz，5,550,527 bytes。
- SHA-256：`81fae7d6edd08d3783ca8338b45f88b36acb3c3f21e76a29e0ede7dd379fe7ce`。
- 17 个生产文件符合白名单，包内正文与构建源一致；编译后的三份 DSS-cah 角色 Markdown 与源文件逐字匹配。
- 通过 DSH 原生插件管理器升级，结果为 application=applied，安装版本 0.2.2；实际安装的 Host / Client 与候选构建文件 SHA-256 一致。沿用已有配置和数据，未重启 DSH。
