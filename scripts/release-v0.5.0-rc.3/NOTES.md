# DeepSeek Servant 0.5.0-rc.3 预发布测试版

大规模清理了 GPT 的防御性阻塞代码，重构了内部部分被扭曲的非法设计。

由于系统构建上的更新较大，建议做好备份，并在安装前彻底清理历史文件。

---

# DeepSeek Servant 0.5.0-rc.3 Prerelease

This update focuses on runtime efficiency, task collaboration, and continuity. It removes a substantial amount of GPT-generated defensive blocking code and refactors parts of the internal design that had diverged from their intended purpose.

- Runtime efficiency: Reduces repeated reads, polling, and unnecessary interface refreshes to lower background overhead.
- Task collaboration: Refines task assignment, parallel work, and handoffs, reducing unnecessary waiting and blocking between tasks and between foreground and background work.
- Recovery: Improves error handling and resumption, so work can continue from the original task, existing progress, and results.
- Conversations and history: Improves message sending and retry, history loading, date selection, and navigation, while reducing repeated work and interference from outdated requests.
- Records and cleanup: Improves result archiving, task completion, and cleanup of runtime data, reducing redundant work and unnecessary waiting.

## Upgrade Notice

This release includes substantial changes to the system’s structure. Back up your data before installation, and thoroughly clean up historical files before installing the new version.
