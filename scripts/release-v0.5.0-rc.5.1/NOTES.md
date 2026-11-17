# DeepSeek Servant 0.5.0 RC5.1

RC5 的 Windows Python 启动适配修复版。保留既有 RC5 标签和附件，不改变任务调度、Git 业务协议和界面。

- 默认 Windows `python` 不存在或命中 WindowsApps 9009 假别名时，自动尝试已安装的 DSH 官方 Python、`py -3`、`python3`，不修改系统 PATH、不自动安装依赖。
- 健康解释器直接启动，无额外探测；发现结果在当前插件模块生命周期复用，后续 helper 直接使用已确认解释器。
- 保留显式解释器配置；真实 helper 错误不通过换解释器掩盖，取消后不启动替代 helper。
- Linux 完整类型检查、构建和 21 项 Git 取消回归通过；Windows 实机验证真实 9009 恢复、并发初始化、缓存复用、明确配置和取消边界。

安装来源：`github:Tests4gptplay/deepseek-servant#v0.5.0-rc.5.1`

本次发布 GitHub 预发布，不发布 npm，不自动替换用户正在运行的插件。
