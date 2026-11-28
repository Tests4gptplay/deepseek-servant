# DeepSeek Servant

[简体中文](https://github.com/Tests4gptplay/deepseek-servant/blob/main/README.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/Tests4gptplay/deepseek-servant/v0.3.0/docs/images/deepseek-servant-maids-duo.webp" alt="DeepSeek Servant character artwork">
</p>

An autonomous AI assistant and multi-agent collaboration plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It supports planning, execution, review, changes of approach, task continuation and skill accumulation around persistent goals. Local mode and the experimental DSS-cah Git mode keep requirements, progress, results and accumulated experience connected as work continues.

## Review & project practice

As AI takes on engineering, research and creative work, it needs to carry work across conversations, pass results to subsequent participants, recover from interruptions and change approach when a plan stops working.

[Chat Agent Harness (CAH)](https://github.com/Tests4gptplay/chat-agent-harness) and [DeepSeek Servant (DSS)](https://github.com/Tests4gptplay/deepseek-servant) explore these questions through a continuing line of project practice. Their shared aim is to let participants and methods change while **the user's goals, existing results and responsibility for the next steps remain continuous**.

[Read the CAH / DSS technical framework and project review (Chinese)](https://github.com/Tests4gptplay/deepseek-servant/blob/7f499a83433481844c9643be93ff3a986a65e22b/docs/reviews/CAH-DSS-TECHNICAL-FRAMEWORK.zh-CN.md).

## Independent work, convergent architecture

DSS [v0.2.0 (2026-10-26)](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.2.0) already included multi-role collaboration, persistent task records and recovery before the DeepSeek team's [Super-agent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) was published on 2026-10-31. This independent engineering path continues the Git-backed task records and replaceable Workers published in [CAH v1.0.4 (2026-09-20)](https://github.com/Tests4gptplay/chat-agent-harness/releases/tag/v1.0.4).

The two independently developed projects show **architectural convergence** in separating interaction from execution, persisting task state and recovering interrupted work. DSS's [0.5.0-rc.2 test release](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.5.0-rc.2) follows its own Local/Git collaboration path with six native roles; the Super-agent prototype centers on GitHub/Feishu events and Ticket/Executor. Public [CAH run records](https://github.com/Tests4gptplay/chat-agent-harness-records) include a [Helper recovery and Planner replanning case](https://github.com/Tests4gptplay/chat-agent-harness-records/blob/76646cc709375b1d8d262d809d76b3156698e796/showcase-observer/world-execute-chatgpt-20261017/backfills/2026-10-19T10-05Z-helper-image-replanning.md).

## Core capabilities

- **Goal-driven multi-agent work:** Discuss requirements in the foreground while background participants plan, divide work, execute in parallel and review progress at meaningful stages, supporting long-running tasks and final delivery.
- **Local task continuity:** Keep task state in the current DSH instance, with pause, resume, cancellation, goal revisions, recovery and delivery.
- **Experimental DSS-cah Git collaboration:** Participants work in their own workspaces and share conversations, plans, progress, results and archives through a private repository. Each instance can join or leave background participation as needed.
- **A shared interface:** View conversations and tasks for the selected mode, and configure models, presets, workspaces and Worker capacity.
- **Conversations, history and results:** Continue discussing ongoing work, add requirements, revisit conversations by date, browse task history and open results or saved attachments.
- **Working memory and skills:** Save and revisit task records, planning notes and knowledge, and accumulate reusable skills. Local mode provides categorized record cleanup and explicit task reset.

## What’s new in 0.5.5

- Folder browsing and creation continue to use DSH’s native directory-browser component, without a fixed version requirement from DSS.
- Retains the same-line Worker seat handoff fix from 0.5.3.

[Release notes and downloads](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.5.5)

## What changed in 0.5.3 (withdrawn)

- **Worker handoffs retain their seat:** a replacement Worker on the same work line inherits its seat. Queued work waits until a seat is actually free.
- **Handoffs survive interruption:** a restart or a retry after a failed Worker launch continues the original work line without resubmitting it.

## What’s new in 0.5.2

Search tasks and archives by title or ID, with newest tasks first when creation time is available. The candidate also improves recovery from silent rounds and ownership during same-workline handoffs.

[Release notes](docs/releases/0.5.2.en.md) · [Verification status](docs/testing/0.5.2.en.md)

## What’s new in 0.5.1

- Improved task responsiveness, background coordination, archiving, and Git collaboration.
- Restored the green connection indicator and improved folder selection and records relocation. Failed moves can be retried or abandoned without refreshing.

[Release notes](docs/releases/0.5.1.md) · [0.5.0 / 0.5.1 benchmark](docs/testing/0.5.1.md)

## Installation & use

In DSH, choose **Plugins → Add plugin** and enter `github:Tests4gptplay/deepseek-servant#v0.5.5`, or use the TGZ attached to the GitHub release. Version 0.5.5 is not yet published to npm.

See [Installation & upgrade](docs/INSTALLATION.md) for installation sources, Desktop / Web instructions and upgrade guidance. The linked guide is in Chinese.

### Getting started

1. Install and enable the plugin, open **DeepSeek Servant** from the DSH sidebar, and select an available model and workspace.
2. Describe your goal, deliverables and acceptance criteria. The foreground assistant discusses the requirements, the Planner organizes and reviews the work, and Workers execute in the selected workspace.
3. Use the task page to follow progress, inspect results and see requests for more information. Continue the conversation, adjust the goal, or pause, resume and cancel as needed.
4. Enable DSS-cah only when you need collaboration through a private Git repository, then follow the [collaboration guide](PRIVATE_GIT.md). Local mode does not require Git collaboration setup.

[User guide](docs/USAGE.md) · [Git collaboration](PRIVATE_GIT.md) · [Data retention & cleanup](RETENTION.md) · [Release notes](https://github.com/Tests4gptplay/deepseek-servant/releases)

These linked guides are in Chinese. Model providers, tools and workspace permissions are managed by DSH. Repository content is shared with authorized collaborators, so choose a repository appropriate for the intended collaboration.

## Origins & licenses

DeepSeek Servant extends the agent design approach of [Chat Agent Harness (CAH)](https://github.com/Tests4gptplay/chat-agent-harness), using DeepSeek Harness's native capabilities for continuous task execution.

Project code follows CAH's **[GNU AGPL v3.0 only (AGPL-3.0-only)](LICENSE)** license.

Character artwork and derived icons are separately licensed under **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**, retaining the attribution chain **上善无形 → ZipZipPipe**. Tests4gptplay supplied and adapted this project's icons and page artwork. Reuse must retain attribution, identify modifications, and follow the non-commercial and share-alike terms.

See [NOTICE](NOTICE) for project copyright notices and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for artwork scope, sources and third-party dependency licenses.

## Support

[GitHub Sponsors](https://github.com/sponsors/Tests4gptplay) · [Ko-fi](https://ko-fi.com/kou392350) · [Alipay](SPONSOR.md)

## Bundled Python dependencies

The following upstream dependencies for Git collaboration are included in the plugin. Installing them does not require pip or a network download:

| Dependency | Version | Upstream source | License | Purpose |
| --- | --- | --- | --- | --- |
| Dulwich | 1.2.21 | [dulwich/dulwich](https://github.com/dulwich/dulwich), [PyPI](https://pypi.org/project/dulwich/1.2.21/) | Dual-licensed Apache-2.0 / GPL-2.0-or-later; this distribution selects Apache-2.0 | Git objects, protocols and repository operations, with platform-specific native acceleration |
| urllib3 | 2.8.0 | [urllib3/urllib3](https://github.com/urllib3/urllib3), [PyPI](https://pypi.org/project/urllib3/2.8.0/) | MIT | Git HTTP transport |

Complete upstream licenses and distribution metadata remain under `python/vendor/` and `python/licenses/`. See `python/vendor/manifest.json` for file and official wheel checksums, and [Third-party notices](THIRD_PARTY_NOTICES.md) for attribution. The Python interpreter comes from the existing DSH configuration or environment. The plugin does not install system packages, add a postinstall hook, or download these dependencies at runtime. Node dependencies remain managed by the official DSH installation flow.

Bundled native extensions target CPython 3.12/3.13 on Windows x86/x64/ARM64, macOS x64/ARM64, and Linux glibc 2.28+ x64/ARM64. Linux x64 is runtime-tested; other platforms are subject to their native loader checks. Unmatched ABIs use dependencies in the existing Python environment. No Python interpreter is bundled; koffi is handled by DSH’s official Node dependency installation flow.
