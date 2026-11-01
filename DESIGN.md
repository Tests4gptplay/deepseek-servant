# DeepSeek Servant 架构

DeepSeek Servant 基于 DeepSeek Harness 的原生 Agent、Session、工具和 Jobs，使用统一 Framework 连接 Local 与 Git 两种业务存储。

## 结构与责任

| 层次 | 当前实现 | 责任 |
| --- | --- | --- |
| Host / Client | `src/host.ts`、`src/client.tsx` | 宿主服务、页面与侧栏入口 |
| 服务与通信 | `src/framework/service.ts`、`transport.ts` | 按模式和存储范围提供访问、命令与下载 |
| 存储与事务 | `local-files.ts`、`transactions.ts`、`command-transactions.ts` | 快照、多文件提交、冲突和原操作核对 |
| 原生执行 | `native-executions.ts`、`role-runtime.ts` | 六角色运行、实际执行观察与恢复 |
| 长期资料 | `artifacts.ts`、`knowledge.ts`、`cleaner.ts` | 成果附件、知识和任务临时资料清理 |
| 旧数据接续 | `legacy-migration.ts`、`migration-lifecycle.ts` | 保留原来源、身份、历史和待接续事项 |

表中未写目录前缀的模块位于 `src/framework/`。

## 角色协作

Foreground 与用户交流；Organizer 分派与验收整体工作；Planner 规划并验收成员工作；Worker 执行任务；Recorder 编写长期记录与技能；Helper 处理异常恢复。角色通过 DSH 原生能力执行，Host 管理身份、事务、调度与固定范围清理。

## 存储与访问

Local 使用 `dss-files.sqlite` 保存逻辑文件、附件字节与事务事实。Git 通过 GitHub API 读写所选私有仓库的远端提交、树和 blob。两种模式共用快照与事务接口。

前台存储访问和后台参与分别管理。用户可以查看历史、保存消息和读取成果，再按设置启用后台参与。任务完成、前台通知和 Recorder 归档分别更新状态；Cleaner 在核验保留资料与执行状态后清理对应任务的临时资料。

## 文档导航

- [实现映射与构建](IMPLEMENTATION.md)
- [使用说明](docs/USAGE.md)
- [Git 设置与权限](PRIVATE_GIT.md)
- [数据保留与清理](RETENTION.md)
- [开发验证说明](docs/TESTING.md)

## 历史架构

历史资料按当时版本保存，用于旧数据格式和行为追溯：

- [alpha.40 架构（2026-10-26）](docs/history/architecture-alpha40-20261026.md)
- [2026-10-25 设计记录](docs/history/master-design-20261025.md)
