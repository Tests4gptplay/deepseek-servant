# DeepSeek Servant 0.5.0 预发布说明

**以下更新说明对应待验收的新包；当前下载仍为既有 RC2 占位包。**

本次更新围绕运行效率、任务协作与持续工作能力进行集中整理，大规模清理了 GPT 的防御性阻塞代码，并重构了内部部分被扭曲的非法设计。

## 这次更新了什么

- **运行效率**：合并重复读取，减少轮询与页面刷新中的重复工作，优化后台运行开销。
- **任务协作**：梳理任务分派、并行推进与工作接续，减少任务之间以及前后台不必要的等待与相互阻塞。
- **异常恢复**：改进异常处理与中断接续，围绕原任务、已有进展和成果继续推进。
- **对话与历史**：优化消息发送与重试、历史加载、日期选择和翻阅体验，减少重复处理及旧请求对当前页面的干扰。
- **记录整理**：完善成果归档、任务收尾和运行资料清理，减少重复处理与不必要的等待。

## 升级提示

由于本次系统构建更新较大，建议安装前先备份数据，并彻底清理历史文件后再安装。

以上为本次更新的说明，修复后的安装包尚未替换。

## 当前占位包

当前安装包暂为 **0.5.0 RC2 占位版本**，并非本次修复完成后的安装包。

- 安装包：[deepseek-servant-0.5.0-rc.2-archive-69630b2.tgz](https://github.com/Tests4gptplay/deepseek-servant/releases/download/v0.5.0-rc.2/deepseek-servant-0.5.0-rc.2-archive-69630b2.tgz)
- 包内版本：`0.5.0`；候选标识：`0.5.0-rc.2`。
- 文件大小：5,565,610 字节。
- SHA-256：`85b39854a14ffbfc1322d702e75db5b4711a53c2dbbb1debacbaadff59c47268`

[安装与升级](https://github.com/Tests4gptplay/deepseek-servant/blob/release/0.5.0-rc.2/docs/INSTALLATION.md) · [使用指南](https://github.com/Tests4gptplay/deepseek-servant/blob/release/0.5.0-rc.2/docs/USAGE.md)
