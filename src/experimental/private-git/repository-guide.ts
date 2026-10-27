import type { CoopSettings } from './contracts.js'

const start = '<!-- DSS-CAH GUIDE START -->', end = '<!-- DSS-CAH GUIDE END -->'
export function repositoryGuide(settings: CoopSettings): string {
  const root = settings.repositoryDirectory
  return `${start}
# DSS-cah 协作目录 / Collaboration directory

这里是 DSS-cah 的任务投递、协作状态与结果目录。桌面上仍使用同一套“对话 / 任务”界面；选择 local 或 DSS-cah 只改变新输入的后端。前台 AI 先交流理解要求，再提交需要后台执行的任务。仓库投递是额外入口。

## 从外部投递任务

1. 在 DSS-cah 配置中连接此私有仓库，并开启“接收远端任务与控制指令”。运行中的 Host 正常每 1 秒增量同步一次。
2. 在 \`${root}/inbox/\` 下新建一份名称唯一的 Markdown 文件并提交到当前连接分支。比如 \`${root}/inbox/design-review.md\`。
3. 写清原始要求、目标、保留内容、交付物、必要的验收标准；需要指定参与者或实例时，写明其 ID。可附项目文件和参考路径。
4. 前台会读取变更及相关原文，讨论或创建任务，再由 Planner 分解并交给 Worker。补充和纠正优先修改原投递文件并注明任务 ID，避免同一目标重复投递。

示例正文：

> # 整理项目安装说明
> 请检查 docs/install.md，保留已经确认的安装方式，更新当前版本的操作步骤。
> 交付：修改后的文档与具体修改摘要。
> 依据：README.md、实际安装配置。
> 如需改变既定安装方式，先通过前台提问。
> 目标参与者 / 实例：填写需要接收此项任务的 ID，或注明由协作成员认领。

暂停、恢复、取消和目标修正也可放在 inbox 下的新文件，注明任务 ID、目标参与者和清楚的操作要求。前台依据原文处理。协议目录由运行时维护；外部投递使用 inbox 或其他业务文档目录。

## 查看执行状态和中间结果

| 路径（相对此目录） | 内容与可了解的信息 |
| --- | --- |
| \`inbox/*.md\` | 外部原始要求、补充和控制说明。 |
| \`participants/<participant>/profile.json\` | GitHub 参与者身份。 |
| \`instances/<instance>/status.json\` | 实例身份、Worker 席位和模型配置。 |
| \`instances/<instance>/watch.json\` | 已处理的远端变更位置。 |
| \`assistants/<participant>/<instance>/identity.json\` | 前台所属参与者、实例和模式。 |
| \`assistants/<participant>/<instance>/Foreground_List.md\` | 前台的重要交代索引，含任务、原话、证据和快速查阅路径；普通闲聊不入列。 |
| \`assistants/<participant>/<instance>/Foreground_Cache.md\` | 前台可整理和更新的持久随记；默认保留，按需读取，仅按用户要求删除或清空。 |
| \`conversations/<participant>/<date>/*/entry.json\` | 对话作者、时间和正文 textPath。 |
| \`intents/<participant>/*.json\`、\`inputs/<participant>/*.json\` | 待处理与已消费的用户输入，含正文和可选 contextPath 引用。 |
| \`origins/<task>/request/\`、\`origins/<task>/goal/<revision>/\` | 原始要求及各次确认目标，可核对需求变化。 |
| \`tasks/<task>/contract.json\` | 任务 ID、标题、目标版本、协调参与者及 active / waiting / accepted / cancelled 状态。 |
| \`tasks/<task>/plan.json\`、\`assignments/*.json\` | 跨参与者分工、方向与验收要求。 |
| \`tasks/<task>/participants/<participant>/instances/<instance>/join.json\` | 本实例参与范围、目标版本及 active / paused / left 状态。 |
| 同级 \`plan.json\` | 本实例子任务、依赖、执行方向和 Planner 验收结论。 |
| \`tasks/<task>/actions/\`、\`foreground/actions/\` | 绑定的角色、原生 Session、执行身份和动作状态。 |
| \`tasks/<task>/executions/\`、\`foreground/executions/\` | 中间业务记录、角色输出及原生执行收尾信息。 |
| 执行目录中的 \`entries/\` | Foreground Reply、Planner Memory / Note、Worker Child Reply，以及交接、证据和成果路径。 |
| 执行目录中的 \`outcome.json\` | 指向业务正文的结果引用和角色信号。 |
| \`status/tasks/<task>/\`、\`status/foreground/\` | 独立的 started、completed、closed、replaced 状态记录；completed 关联 outcomePath 和 turn_signal。 |
| \`history/<task>.json\` | 已完成任务的简要索引和完整归档路径。 |
| \`records/<task>/records.md\`、\`manifest.json\` | 汇总原始要求、计划、过程、评价与结果；manifest 指向完整分块正文。 |
| \`knowledge/<participant>/\` | 有来源的知识、偏好和技能记录。 |
| \`events/\`、\`incidents/\` | 操作提交回执和中断 / 迟到写入等具体诊断线索。 |

正文目录中的 \`manifest.json\` 按 chunks 顺序列出 \`parts/*.txt\`，将分块顺序连接即可读完整文本。大记录的完整入口以 manifest 为准。

角色执行顺序：提交启动状态 → 远端读回 → 原生执行 → 保存业务正文 → 单独提交最终状态 → 远端读回 → 下一步调度。Foreground 的 respond / handoff_planner、Planner 的规划与交接信号、Worker 的执行结果各有职责；从状态引用继续打开对应正文即可查看具体进度和依据。

## 前台随记

Foreground_List 保存重要交代和可追溯索引，完成事项更新状态并保留。在前台处理对话时检查：7 天无进展可简短提醒，每周最多一次；30 天无实质进展或用户确认时询问继续、保持 pending、暂缓跟踪或结束。用户指定等待期限则按该期限；确认后刷新状态和复查时间，提醒本身不重置搁置时间。Foreground_Cache 是可整理和更新的持久随记，不设字数上限；默认保留记忆，任务完成、话题结束、陈旧或长期未提及都不触发删除。仅按用户明确要求删除或清空，手动清理入口保留。两者都只告知用途与路径，由前台按需读取。普通对话原文仍在 conversations 中。

## Reading from another tool

Commit a plain-language task or control document under \`${root}/inbox/\` on the connected branch. Follow contract.json for task identity, status/* for the independent role signal, and outcome.json / entries/* for work records and intermediate results. Completed tasks are indexed in history and collected under records. The two Foreground memory documents are optional-to-read working notes, maintained by the Foreground rather than injected in full.

此目录保存任务相关对话、计划、状态和结果，仓库成员可以读取。凭据通过本机 GitHub 授权管理。
${end}
`
}

/** Maintain our guide section while preserving the repository owner's surrounding text. */
export function mergeRepositoryGuide(previous: string | undefined, settings: CoopSettings): string {
  const guide = repositoryGuide(settings)
  if (!previous) return guide
  const from = previous.indexOf(start), to = previous.indexOf(end, from)
  if (from >= 0 && to >= from) return previous.slice(0, from) + guide + previous.slice(to + end.length).replace(/^\r?\n/, '')
  return previous.trimEnd() + '\n\n' + guide
}
