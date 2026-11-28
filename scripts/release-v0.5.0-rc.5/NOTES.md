# DeepSeek Servant 0.5.0 RC5

本 RC5 采用已验证的 `0.5.0-rc.4-candidate.4` 实现，发布版本号规范为 `0.5.0-rc.5`。任务执行与调度沿用该候选；本次同版本补齐 Python 依赖及随包引导，host/client 预构建文件不变。

## 相对 RC4 的改进

- 恢复前台原生停止入口，保留后台任务页的停止方案。
- 修复知识编辑切换时的过期读取覆盖，并补充历史任务提交反馈。
- Git 同 authority 同轮读取聚合保留独立通道；同 work 已有排队写入时，等待后重新读取，修复复用过期 HEAD 导致的 CAS 冲突。

## 本轮验证

- 云端 Linux 原生 DSH Local P/W 两轮完成写入、独立验收、成果交付及归档。
- 双 Host、真实 Git 混合 O/O/P 与嵌套任务链完成，34 项核验通过；本次运行未触发额外运行时冲突 Helper。
- 两 Host 共 16 项受控等待专项通过，保留自身及必要写入等待、无关写入解耦。
- 候选源码类型检查、构建及交付包一致性已核验。

## 安装

DSH 插件添加来源：

```text
github:Tests4gptplay/deepseek-servant#v0.5.0-rc.5
```

这是 RC 预发布。附件包含安装包、完整源码快照及校验和。此次仅发布 GitHub，不发布 npm。

## RC5 同版本依赖补全（2026-11-17）

当前四个标准名称附件及 `v0.5.0-rc.5` 安装来源已更新：随包提供 Dulwich、urllib3 及对应平台的原生扩展，并修正包内安装指南的旧 RC3 地址。无 postinstall、pip、运行期下载或系统依赖修改；Python 解释器沿用 DSH 配置。既有 host/client 编译文件不变。

Linux Python 3.12 / 3.13 的原生安装器 API、Git 读写、构建和依赖许可核验完成。Windows 实际 UI 安装验收将在此次发布后进行。

旧文件以 `superseded-021ddb63-` 前缀保留，仅供追溯，不要用于当前安装。原包 SHA256：`998759d6c7968a0aec261424dc964605a11a2b5bcda9aaa95151fe8264a3a3d6`；新包 SHA256：`cf0938471a900555fee2d932f8fa36558ae437cc1ea9d7c0dc30a3e542d8e04d`。
