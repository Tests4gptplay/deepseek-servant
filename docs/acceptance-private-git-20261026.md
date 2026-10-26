# alpha.40 Private Git 开发验收

日期：2026-10-26。候选版本：`0.1.0-alpha.40`。设计基线：[temp / DSS-git](https://github.com/Tests4gptplay/temp/tree/b44fd5ec2e23045d8ea4822bc5942466228ce12a/DSS-git)。

## 交付内容

- 独立 Local / Private Git 模式、持久选择与后台并存。
- 私库及实际账户识别、原生凭据来源、成员列表与显式邀请操作。
- Git-first 输入与结果提交、不可变读回、非强推 CAS、冲突重算、草稿与回执去重。
- 每个参与者自己的 Foreground、Planner、Worker；主动协助、提案、指派、认领与参与计划。
- 原生模型、预设、目录、工具、Session、Jobs 与 Skill 接入。
- 完整原文分页、目标修订、前台提问、Worker 换代及接续、五部分评审、交付与封存清理。

## 源码验证

TypeScript 类型检查通过。完整源码回归通过 87 项；随后针对连续原生错误增加 1 项回归，更新后的协作专项 15 项全部通过，累计覆盖 88 项。已有 73 项 Local 用例保留。

协作专项覆盖模式隔离、三参与者独立协作、提交读回、并发冲突、丢失响应、Unicode 原文、凭据脱敏、邀请状态、伪造动作、离线草稿、过期指派、历史分页、参数错误退出重试、冷消费与暂停、前台问题、目标修订、设置往返保存及有界原生错误恢复。

## 原生双代执行

环境：Windows、DSH `0.2.1-rc.3` 原生 SDK profile、候选安装包。模型响应与 GitHub Git Data API 使用隔离受控对端；Agent、Session、Credentials、文件工具、PowerShell Job 和 storageDomain 使用实际 DSH 服务。

1. 默认 Local 页面读取保持零 Git 请求；在 Private Git 保存原生凭据并连接受控私库。
2. 用户目标提交、读回，Foreground 建立任务并交给 Planner。
3. Planner 提交指派、认领和参与计划；Worker 第一代写入第一段文件，执行并收取原生 Job。
4. 第一代保存检查点并交接；第二代读取已有文件，保留第一段和 Job 输出，再完成第二段。
5. Planner 读取实际文件及当前 Git 结果，完成评审、参与者报告和根任务验收。
6. Foreground 交付路径，完整 records 封存后，活动任务目录通过单独提交清理。
7. 此过程页面选择已切回 Local，协作后台继续运行。

该场景共 29 次受控模型请求，最终文件为三行 `segment-one`、`job-done`、`segment-two`，档案 30,384 字符，原生 Credentials 保存成功，Git 内容检查未出现凭据正文。

## 实际进程中断与恢复

另一个隔离 SDK profile 在 Worker 写完第一段、提交检查点并启动原生后台 Job 后，强制终止该 SDK 进程及其拥有的进程树；随后重新启动同一 profile，并恢复相同的受控 Git 仓库状态。

- 页面仍选择 Local，已启用的 Coop 后台自动恢复。
- Worker 沿用原 taskId、executionId 和 sessionId，读取已有文件，继续未完成工作。
- 原生 Job 重新完成并收取结果；文件保留第一段，随后追加第二段。
- Planner 读取文件及 Git 结果，完成验收、前台交付、封存与活动记录清理。
- 全程 32 次受控模型请求，最终产物与预期三行完全一致。

本次参数说明变更后的首个 Foreground 请求为 5,744 tokens，上一轮为 5,707 tokens；计数包含当时原生工具、系统提示与输入，由同一 tokenizer 记录。

## 真实环境协作准备

多人跨网络联调使用参与者各自的 GitHub 账户、专用私有协作仓库和 DSH 设备。进入该阶段时，由参与者确认仓库与本机工作范围，再从各自前台主动加入任务。

本次交付范围为源码、开发候选包和上述隔离原生运行；现用 Desktop 安装、已接受 alpha.39 候选与美术资源保留。
