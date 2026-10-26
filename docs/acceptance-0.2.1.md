# 0.2.1 完成信号修订验收

日期：2026-10-27。环境沿用 Windows / DSH 0.2.1-rc.3 / Node 24.21.0。

## 实现与来源

参考 CAH `local_bridge/planner_runtime.py` 的 `observe_semantic_turn`、`planner_runtime_tick` 以及 `docs/task-cell/WORKER.md`、`PLANNER.md`：先写语义成果，最后写绑定结果中的 `turn_signal`，由正常 Git 同步消费。DSS 保留 DSH 原生 Agent、Session、Jobs；Host 注入并核对绑定 ID，不解析聊天结束语。

## 本次结果

- TypeScript 检查和 Host / Client 生产构建通过。
- 协作、缓存和稳定性回归 45/45 通过。其中新增覆盖错误任务/执行 ID、缺少信号、旧结果兼容、Worker 三种结束信号、Worker/Planner 换代、Planner done/rework/wait/need_user、原生回复尚未结束时的调度、重启去重、席位收尾与最终原文保留。
- 真实私库的隔离目录验证：错误执行 ID 被忽略；修改后的协议正文实际读取，正确识别 Worker `complete` 并映射为待验收结果。读取过程实际发生 3 次正文命令；两个临时协议文件均已删除。沿用 0.2.0 已通过的 A/M/D、父版本读取与无关路径合入结果。
- 内部协议变更不会生成通用 Foreground 通知；业务文档仍只通知 A/M/D，由 AI 按需阅读正文。
- 原生插件管理器将 0.2.0 升级为 0.2.1，结果 `application: applied`、无警告。既有 UI 布局和美术未修改，沿用用户提供的实际设置页确认。
- 安装包包含 17 个白名单文件。Host / Client、说明和 6 张图片与源码文件逐字节相同；package.json 经包管理器字段重排后语义相同。

## 提示成本比较

同一角色绑定和首条输入，以 `o200k_base` 计量 DSS 角色正文和三个工具的真实定义；未重复计入未变的 Host preset，也不是供应商账单计数。

| 角色 | 0.2.0 | 0.2.1 | 变化 |
| --- | ---: | ---: | ---: |
| Foreground | 1680 | 1687 | +7 |
| Planner | 2698 | 2705 | +7 |
| Worker | 1091 | 1087 | -4 |

## 安装包

- `deepseek-servant-0.2.1.tgz`
- 5,547,595 字节
- SHA-256：`0d0c89ca0b1e5901ea468fdd3d2a68afd03e3d028b8b7044cb53d9a91c53bdeb`
- 固定安装来源：`github:Tests4gptplay/deepseek-servant#v0.2.1`
