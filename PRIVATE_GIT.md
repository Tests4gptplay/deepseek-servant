# Git 协作存储（工作分支候选）

本说明针对当前统一框架源码，尚未作为新 Release 发布；历史 `v0.4.1` 不包含这里的全部改造。真实公网专用账号、Host 与 Web 最终验收仍待完成。

## 用途与权限

Git 模式把对话、任务、成员状态、归档和技能等业务资料保存在所选 **GitHub 私有仓库**。推荐专用仓库，并先确认参与者可以看到的内容：私有仓库并不把同一仓库内不同成员的业务正文彼此隔离。不要将凭据或不应共享的文件作为任务资料写入。

当前凭据来源是运行 DSH 的环境中的 GitHub CLI 登录。先通过官方 `gh auth login` 完成授权；插件使用该登录身份，不要求在 DSS 设置中粘贴 token，也不另读环境变量凭据作为降级路径。仓库访问及成员管理仍受 GitHub 实际权限限制。

设置填写 `owner/repo` 和仓库目录；目录可为仓库根或指定子目录。工作区是本实例原生工具执行的位置，与远端业务存储目录不是一回事。其他成员加入同一仓库和目录，并使用各自获授权的工作区；这不会授予远程操纵其他电脑的权限。

前台回复和任务调度由仓库所有者账号的主理实例负责。它是在同一仓库、分支和目录中登记后使用该账号原名的实例，需要在线并已开启后台参与；同账号的其他实例使用带编号的别名。其他有写权限的协作者可以加入协作，但协作域、目录或显示名称不能把协作者变为仓库主理者。

Foreground replies and task scheduling require the repository owner's primary instance to be online with background participation enabled. In a given repository, branch, and directory, this instance uses the owner's exact account name; additional instances of that account receive numbered aliases. Other collaborators with write access can participate. A collaboration, directory, or display name cannot make a collaborator the repository's primary instance.

## 前台访问不等于后台加入

- 授权存储访问可查看历史、保存消息、读取及下载成果，不隐含登记成员、写心跳或启动六角色。
- 保存设置会尝试登记并开始后台参与；也可通过参与开关明确开始或退出。关闭侧栏不退出后台。
- 空仓库的只读访问不创建分支。实际写入或开始参与时，才进行必要的写入初始化。
- 成员列表区分未知、在线、离线和停止。心跳表示实例观察事实，不证明任务有实质进展，也不是前台读取的额外门禁。

## 远端原生事务，不是本地 Git 镜像

`GitHubRepository` 直接通过 GitHub API 读取远端提交、树和 blob；`GitFiles` 提供固定快照及多文件事务。没有常驻 bare clone、工作树、后台 fetch 镜像或旧 Consumer 协议。

每次事务根据读取的分支头提交。分支头变化会返回冲突，调用方必须重新读取并判断，不能仅换一个 parent 后照抄旧业务操作。请求已发送但返回丢失时，保存原 operation ID、正文摘要及预期提交事实，再核查原操作；不能把“未知”当作“没有写入”并重投新消息。

二进制附件使用远端原生 blob；归档逻辑路径在 Local / Git 中一致。Host 本机路径或本机 attachment ID 本身不是跨成员可用的长期成果。Git 平台的实际容量、API 和权限错误会明确返回，不以自造的固定文件大小门槛替代。

## 身份和切换账号

实例 UUID 持久保存；登记别名属于对应仓库、分支、目录范围。技术记录同时保留已核实的 Git 账号 ID。已知账号 A 的登记由账号 B 接手时，在写入或分支初始化前拒绝并保留 A 的原别名、UUID 和待确认操作。旧记录缺少可验证账号事实时会报告 `account-unverified`，不凭别名猜身份、不自动生成新 UUID 或清空旧资料。

账号切换、权限变化及尚未确认的旧提交需要先核实原事实；当前没有自动破坏性重置或账号迁移捷径。账号重登也不能改写未知提交的原作者身份。

## 业务和保留

P 路由进入成员 Planner；O 路由由 Organizer 分派和总验收，成员 Planner / Worker 执行。Foreground、Recorder 与 Helper 使用同一套持久记录和真实原生执行接口。任务整体完成不等待用户阅读回执或 Recorder 模型轮次。

Recorder 生成长期记录并确认保存后，Cleaner 才执行固定清理。删除当前分支中的临时文件不等于删除 Git 历史，也不应当被用作秘密清除机制。详见 [数据保留](RETENTION.md) 和 [使用说明](docs/USAGE.md)。

实现可追溯至 `src/framework/connection.ts`、`transactions.ts`、`instances.ts` 及 `src/experimental/private-git/git-repository.ts`。目前对远端行为的自动验证包含受控 HTTP 服务，不等于真实专用账号公网验证。
