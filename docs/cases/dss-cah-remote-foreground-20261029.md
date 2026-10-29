# DSS-cah 实验案例：两种远程 Git 前台交流入口

测试日期：2026-10-29（日本时间，JST）。协议基线：DeepSeek Servant `v0.3.6` 的 DSS-cah / Private Git 机制。

## 场景与验证方法

在已连接的私有 Git 协作仓库和运行中的 DSS-cah Host 上，由另一端通过 GitHub 提交一条普通问候，验证远程消息能否触发 Foreground AI，并由 AI 将答复提交回 Git。两轮均使用实际 Git 提交、DSS Host 自动生成的角色动作及状态记录核对结果。

检查项包括：远程消息提交、Host 创建 `foreground` Action 和 `started`、AI 写入 `entry(kind=reply)`、`conversations/` 的助手消息索引、`outcome` 中的 `turn_signal=respond`、独立的 `completed` 与 `closed` 状态。原始问候及 AI 回答以简述呈现，保留测试重点。

## 案例一：外部 Markdown 投递（`inbox/`）

**输入方式**：外部端在协作仓库所选目录的 `inbox/` 新增 Markdown，内容是一条远程普通问候，并明确请求直接交流。Host 通过远端变更通知（`gitChanges`）将新增文件交给 Foreground 按需读取。

| Git 记录阶段 | 2026-10-29 JST | 观察结果 |
| --- | --- | --- |
| 远程 Markdown 提交 | 09:31:45 | 新文件进入 `inbox/` |
| Foreground 派发 | 09:31:50 | 新建 `git-…` Action；`started` 与绑定记录入库 |
| AI Reply 提交 | 09:32:11 | 前台回答已收到远程问候，`reply/parts` 可回读 |
| Outcome 与对话索引 | 09:32:19 | `kind=respond`；助手回复登记到 `conversations/` |
| 完成与关闭 | 09:32:24、09:32:31 | 独立 `completed`、`closed` 状态存在 |

**结果**：外部文档成功唤醒真实 Foreground AI，AI 直接回复，没有创建 Planner 任务。输入原文保留在 `inbox/`，助手回复进入 `conversations/` 并指向已保存的 Reply 正文。Action 最终状态为 `closed`。

## 案例二：直接 Git 聊天输入（`conversations/` + `intents/`）

**输入方式**：外部端按现有聊天协议，在同一次 Git 提交中写入用户消息 `conversations/<participant>/<date>/<message>/entry.json`、正文分块与 `text/manifest.json`，以及对应的 `intents/<participant>/<message-id>.json`。消息绑定目标参与者与 DSS 实例。此路径直接进入聊天输入消费流程。

| Git 记录阶段 | 2026-10-29 JST | 观察结果 |
| --- | --- | --- |
| 远程聊天输入提交 | 09:34:47 | 用户消息与 `intents/` 一次提交 |
| Foreground 派发 | 09:35:01 | Host 建立 `input-…` Action，`sourceIntentId` 指向输入 |
| AI Reply 提交 | 09:35:33 | 前台直接确认收到 Git 聊天消息，回复正文可回读 |
| Outcome 与对话索引 | 09:35:42 | `kind=respond`；助手回复登记到 `conversations/` |
| 完成与关闭 | 09:35:47、09:35:54 | `completed`、`closed` 均已提交 |
| 输入消费归档 | 09:36:04 | 已处理的 `intents/` 转为 `inputs/` 记录 |

**结果**：直接聊天输入成功唤醒真实 Foreground AI，并获得正常聊天回复；用户消息和 AI 回复都登记到 `conversations/`。`turn_signal=respond` 完成，未建立 Planner 任务。

## 两种路径的分工

| 机制 | 外部 Markdown | 直接 Git 聊天 |
| --- | --- | --- |
| 外部写入入口 | `inbox/` 业务文档 | `conversations/` 与 `intents/` |
| Foreground 唤醒依据 | Git 非协议文件变更通知 | 已提交的用户 `intent` |
| 用户原文留存 | `inbox/` 文档 | `conversations/` 用户消息 |
| AI 答复留存 | `reply/` 正文 + 对话索引 | `reply/` 正文 + 对话索引 |
| 本次执行结果 | `respond`、完成、关闭 | `respond`、完成、关闭 |

两轮都完成了**远程 Git 输入 → Host 确认消费 → Foreground AI 回复 → Git 记录与完成状态**的闭环。测试沿用现有 DSS-cah 运行与角色协议；通常的直接聊天可使用聊天输入路径，外部需求与文档投递可使用 `inbox/`。

实现入口：[`src/experimental/private-git/service.ts`](../../src/experimental/private-git/service.ts)、[`consumer.ts`](../../src/experimental/private-git/consumer.ts)、[`role-writer.ts`](../../src/experimental/private-git/role-writer.ts)、[`conversation.ts`](../../src/experimental/private-git/conversation.ts)。使用方法见 [DSS-cah 协作说明](../../PRIVATE_GIT.md)。
