# DeepSeek Servant 0.4.0

本版聚焦运行稳定性、Git 任务进度与成果展示，以及模型设置保存。

## 更新

- 改善 Git 任务的执行进度、成果投影和发布中提示。
- 修复任务生命周期、恢复和重复结果判定，Git 输出采用流式接收。
- 指定模型切回 Auto 后明确清除 provider、model 与 reasoningEffort 覆盖；模型不提供推理强度时清除旧强度。Local 模型行为不变。
- 更新正式版本、安装说明及发布文档；运行代码与已测候选10一致。

## 验证依据

- 候选云端：312/312 源码回归、5/5 模型路由、真实 React 设置持久化集成及 Local 输入生命周期检查通过。
- Windows Desktop 0.2.1-rc.5：模型设置增量6/6通过，包括指定模型→Auto保存、关闭重开、插件重载与实际进程重启。这轮没有模型推理请求。
- 历史任务运行验收见 `docs/testing/`；不把设置增量写成全量任务重测。

现有 Git 协作协议保持；后续状态机重设计及普通共享聊天自动消费不属于本版新增能力。

## 安装

使用 v0.4.0 Release 的 `deepseek-servant-0.4.0.tgz`，或固定来源 `github:Tests4gptplay/deepseek-servant#v0.4.0`。具体步骤见安装指南。代码许可继续为 AGPL-3.0-only，美术许可及署名以 THIRD_PARTY_NOTICES.md 为准。
