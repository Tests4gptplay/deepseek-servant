**安装测试版 RC2：** 在 DSH 的 **插件 → 添加插件 → 包名或地址** 输入 `github:Tests4gptplay/deepseek-servant#v0.5.0-rc.2`，安装后启用。备用安装来源为 [deepseek-servant-0.5.0-rc.2.tgz](https://github.com/Tests4gptplay/deepseek-servant/releases/download/v0.5.0-rc.2/deepseek-servant-0.5.0-rc.2.tgz)，把该下载地址填入同一个输入框即可。包内版本显示 **0.5.0**；本次测试版由固定标签 **v0.5.0-rc.2** 标识。

**从 RC1 升级：** 先停止 DSS 任务并保留原数据。填写 RC2 的完整来源；若宿主提示已安装，先在插件管理中卸载 DeepSeek Servant 插件条目，再使用上述 RC2 来源安装。保留 DSH 数据目录、Local 库及任务工作区，不执行记录清理或手工删除数据。按宿主提示重启；Desktop 需要时完整退出托盘进程再打开。升级后核对安装来源已变为 RC2，并检查原设置、对话、任务记录和成果仍可读取。

**Web：** 在运行 Web 服务的环境停止对应 profile，然后执行：

```sh
dsh plugin --profile web add 'github:Tests4gptplay/deepseek-servant#v0.5.0-rc.2'
```

备用来源为同版 TGZ 直链：

```text
https://github.com/Tests4gptplay/deepseek-servant/releases/download/v0.5.0-rc.2/deepseek-servant-0.5.0-rc.2.tgz
```

完成后重新启动对应 profile。Desktop 和 Web 分别管理安装。

本版为 0.5.0 的测试候选，沿用六类原生角色、Local/Git 协作、持久会话、任务恢复与成果归档。

验证：源码回归 1321/1321、类型检查、官方安装文件核对及 Web 启动与正常冷启动通过。测试覆盖说明见包内 `docs/TESTING.md`。

源码：[`d688ea542c1e194054e8bc0eaa60db15d4933d20`](https://github.com/Tests4gptplay/deepseek-servant/commit/d688ea542c1e194054e8bc0eaa60db15d4933d20)。

安装包：`deepseek-servant-0.5.0-rc.2.tgz`，5,565,610 字节，23 个生产文件。

SHA-256：`85b39854a14ffbfc1322d702e75db5b4711a53c2dbbb1debacbaadff59c47268`。

[安装指南](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.5.0-rc.2/docs/INSTALLATION.md) · [使用指南](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.5.0-rc.2/docs/USAGE.md)
