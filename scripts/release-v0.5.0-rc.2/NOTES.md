**安装 RC2 更新：** 在 DSH 的 **插件 → 添加插件 → 包名或地址** 输入 `github:Tests4gptplay/deepseek-servant#485d5062c5eaf1e3a5dba075c5e0f16d747c98f8`，安装后启用。也可输入独立安装包 [deepseek-servant-0.5.0-rc.2-485d5062c5ea.tgz](https://github.com/Tests4gptplay/deepseek-servant/releases/download/v0.5.0-rc.2/deepseek-servant-0.5.0-rc.2-485d5062c5ea.tgz) 的下载地址。包内版本为 **0.5.0**，本次更新由上述完整 commit 和下方 SHA-256 标识。

**已有 RC2 的升级：** 先停止 DSS 任务，使用上面的完整新来源安装。同名 RC2 来源或既有锁文件可能仍解析到旧包；请核对安装来源已变为上述 commit。若宿主提示已安装，先在插件管理中卸载 DeepSeek Servant 插件条目，再用完整新来源安装。保留 DSH 数据目录、Local 库及任务工作区。按宿主提示重启，随后检查原设置、对话、任务记录和归档。

**Web：** 停止对应 profile 后执行，再重新启动该 profile：

```sh
dsh plugin --profile web add 'github:Tests4gptplay/deepseek-servant#485d5062c5eaf1e3a5dba075c5e0f16d747c98f8'
```

Desktop 和 Web 分别管理安装。独立 TGZ 与上述 Git 来源包含相同的 23 个生产文件。

本次更新对齐官方模型选择菜单的位置、样式和展开操作，补齐默认模型变更刷新、键盘操作、长归档路径显示与 Auto 说明，并修正 GitHub 提交请求的 GraphQL 语法。

验证：源码回归 1326 项；独立菜单 58 项、键盘 10 项、受影响回归 130 项；两个真实 Worker 的模型跟随与在途保持；官方 Git 来源覆盖安装后，23 个文件匹配，原 15 条消息、设置和归档保留。Local 模式的 10 场多任务、4 场收尾重启、2 场真实硬中断恢复通过。真实 GitHub 登记、发送提交与读回已完成；实际多实例完整 Git 任务流程待验证。

源码：[`485d5062c5eaf1e3a5dba075c5e0f16d747c98f8`](https://github.com/Tests4gptplay/deepseek-servant/commit/485d5062c5eaf1e3a5dba075c5e0f16d747c98f8)。

安装包：`deepseek-servant-0.5.0-rc.2-485d5062c5ea.tgz`，5,568,525 字节，23 个生产文件。

SHA-256：`247e7fbf644ae287c9e835671cf975bac4e4bda710bad362bc7ff402365b15ea`。

资产中的 `deepseek-servant-0.5.0-rc.2-archive-69630b2.tgz` 为更新前的回退包；`SHA256SUMS-original-69630b2.txt` 保留其发布时的校验记录。更新后的 `SHA256SUMS.txt` 按实际文件名列出当前包和回退包的校验值。

RC2 标签入口为 `github:Tests4gptplay/deepseek-servant#v0.5.0-rc.2`；通用文件名 [deepseek-servant-0.5.0-rc.2.tgz](https://github.com/Tests4gptplay/deepseek-servant/releases/download/v0.5.0-rc.2/deepseek-servant-0.5.0-rc.2.tgz) 与上面的独立安装包字节相同。已有 RC2 的升级请优先使用首段完整 commit 或独立 TGZ 地址。
