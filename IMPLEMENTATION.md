# 当前实现与验证边界

> 本文件描述工作分支候选，不是发布公告。包版本仍为 `0.4.1`；历史同版本安装链接不能代表当前源码已发布。

## 入口和模块

| 范围 | 当前源码 | 责任 |
| --- | --- | --- |
| Host / Client | `src/host.ts`、`src/client.tsx` | 注册正式宿主服务、页面及侧栏入口；沿用现有美术 |
| 服务与通信 | `src/framework/service.ts`、`transport.ts` | 按模式和存储范围访问、命令与下载端点 |
| 客户端 | `client-contracts.ts`、`client-page.tsx`、`client-notices.ts` | 保留原发送身份、历史导航、任务/知识界面及本地完成提示 |
| 存储与事务 | `local-files.ts`、`transactions.ts`、`command-transactions.ts` | 固定快照、原子提交、冲突与未知结果核对 |
| Git 远端 | `src/experimental/private-git/git-repository.ts` | 原生远端树/blob及分支头条件提交，无本地镜像 |
| 访问和参与 | `connection.ts`、`instances.ts` | 纯存储访问与后台登记分离，实际账号和实例身份 |
| 六角色 | `role-runtime.ts`、`role-tools.ts`、`role-prompts.ts` | Foreground / Organizer / Planner / Worker / Recorder / Helper |
| 原生执行 | `native-executions.ts`、`execution-observation.ts`、`execution-control.ts` | DSH Agent / Session / Jobs、实际进展和停止证据 |
| 任务和恢复 | `task-files.ts`、`task-index.ts`、`recovery.ts`、`host-loop.ts` | 任务初始化、信号、持久状态与接续 |
| 对话 | `conversation.ts` | 按模式/协作范围保存正文、来源、回复关系与提交顺序 |
| 成果 | `artifacts.ts`、`cleaner.ts` | 授权读取真实字节、验证归档、固定范围清理 |
| 知识 | `skills.ts`、`knowledge.ts` | 摘要目录、原生技能 provider、候选及停用控制 |
| 旧数据迁移 | `legacy-migration.ts`、`migration-lifecycle.ts` | 保留旧记录来源和身份，核对迁移与待接续事项 |

未带前缀的模块均位于 `src/framework/`。退役执行器及旧 Git Consumer 不再作为生产 fallback；保留的数据格式兼容和迁移，不等于恢复旧业务协议。

## 一套规则、两种存储

Local 将逻辑文件存入 `dss-files.sqlite`，以真实 SQLite 快照和事务保存文本及二进制。逻辑 `archives/...` 不代表宿主文件系统有同名目录。Git 使用远端树和 blob，不建立本地 Git 镜像。双方共享 `FilesStore` / `FrameworkTransactions` 接口。

读取固定快照后，多个正文及相关通知可在同一事务提交。并发冲突要求重新判断；未知结果保留原 operation 身份和内容摘要，先核实原操作。不能通过更换 ID、静默换 parent 或清空恢复记录伪造成功。

纯授权存储访问不登记成员、不运行角色；后台参与通过独立连接建立。保存设置属于明确参与动作。Git 账号变更在参与写入前检查，旧身份和未知提交不自动重置。详情见 [Git 说明](PRIVATE_GIT.md)。

## 原生执行与业务边界

六角色运行在 DSH 原生 Agent / Session / Jobs 之上，使用真实工具权限。P 与 O 任务分别交给 Planner 和 Organizer 路径；O 即使只有一个成员也不机械改成 P。角色负责规划、验收、恢复判断和长期记录，Host 负责身份、事务、固定初始化和机械清理。

进展观察使用实际输出、工具和 Job 事件，心跳不算工作进展。分阶段的 5 / 5 / 30 分钟观察不等于给模型添加自动成功超时。停止执行先持久保存原执行、会话和 Job 证据，再请求原生停止；没有真实确认时保持不确定。异常接续可读取正式会话事件，不能仅凭重启后空 registry 宣称旧任务已停。

Foreground / Organizer / Recorder / Helper 已认领输入后的中断，依据原会话、接手记录和操作回执恢复，不盲目唤醒普通等待中的 Organizer。代次和 execution 身份防止晚到旧事件覆盖新执行。

任务整体 complete 与前台通知、Recorder 整理并行推进，不引入阅读 ACK。客户端完成提示只根据实际任务变化显示，本地清标记不写业务状态。Recorder 的正文由 AI 生成；Cleaner 不机械生成记录或替角色总结。

## 知识和附件

技能目录按需读取摘要，选择技能时才加载正文；正式原生 pre-step 边界失效缓存，而非每秒扫描全部正文。新技能要求正式 `SKILL.md` 格式，普通 `.md` 不自动注册。旧 Local 技能保留原 scope、验证状态及 activeVersion；旧 Git 技能保持实际 participant 范围，不伪造 Local 版本语义。

知识编辑保存候选，不默认激活。停用/退役控制保存在独立元数据中，重建目录不清除它们；正文和来源仍可追溯。缺少宿主 skills 能力会报告实际诊断，不增加任意最低版本门槛。

附件从宿主授权文件接口读取实际字节，和清单/回执一起事务保存，再按 SHA-256 与长度读回核验。下载端点返回原二进制。目录或外部链接不会自动变成已归档文件；本机附件引用也不冒充跨端永久链接。

## 迁移与保留

迁移保留旧任务、知识、来源、版本、等待事项及成果证据；来源不因迁移被删除。无法确认原生执行归属的事项保留 unresolved，不批量伪装为完成。迁移回读成功不等于全部任务已在真实 Host 自动接续。具体资料范围和清理条件见 [RETENTION](RETENTION.md)。

## 构建与测试

在已有依赖的开发环境中：

```sh
npm run typecheck
npm test
npm run build
npm run test:package
```

`npm test` 运行当前框架回归；`npm run test:historical` 单独运行固定基线 `0acd3ba39a2ae23d66759279b3c54c4637cd0ad5` 的历史测试。历史成功不算当前实现通过。迁移测试可从该基线在内存加载真实旧 writer，不把旧执行源码放回生产路径。

构建生成 `lib/host.js` 与 `lib/client.js`。Client 使用宿主 ModuleLoader factory，不能用普通浏览器 ESM 入口代替宿主接线。候选打包后还需核对包文件、构建结果与被测试源码一致；打包不等于发布或安装验收。

已开展的验证包括真实 SQLite、多文件事务、已安装官方原生技能 registry、受控 HTTP Git API 及客户端控制器/组件回归。具体命令、当前结果和覆盖边界见 [测试说明](docs/TESTING.md)，不在此固定容易过期的测试总数。

**尚未完成当前候选的真实 Host 模型执行、Desktop / Web 实机交互及公网专用 Git 账号最终验收。** 原生接口源码核证、seam 和受控 HTTP 均不能冒充这些验证。历史 Windows rc.5 等结果见[旧公开证据](https://github.com/Tests4gptplay/deepseek-servant/blob/d28a4d8538abc966608761bcfd60d568dec11cc9/docs/testing/EVIDENCE.md)，仅适用于对应旧版本。

许可证、素材署名及第三方声明见 [README](README.md#来源与开源许可)、[NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。
