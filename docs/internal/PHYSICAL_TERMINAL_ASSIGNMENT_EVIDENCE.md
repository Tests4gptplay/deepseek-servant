# Physical terminal and Worker assignment publication evidence

> 历史证据更正（2026-11-11）：下文保留当时源码、命令和测试记录，不是现行设计或验收要求。直接移除尚未发布的内部 stage、或强制让底层写入抛错，只能证明所构造场景；这里没有建立失败本身的真实产品触发条件，不能据此恢复目标版本、收件回执或额外发布证明门禁。当前已准备操作按现行生产调用链接续，已消费通知不重发；真实目标冲突、原始资料和未完成责任仍按各自职责保留。下文历史通过数量不证明当前源码通过。

This is engineering evidence from the frozen physical Local terminal/assignment validation. That run did not switch the default backend. Ordinary Local has since switched to PhysicalLocalFiles in the current working source; this note does not establish that later cutover or installed DSH acceptance. Its original validation facts and hashes remain scoped to their tested source. It is not plugin-facing README content or a release.

## Fixed boundaries

The earlier terminal/assignment implementations persisted `prepared: true`, then ignored `PhysicalLocalFiles.rename()` returning `false`. Root handoff retirement also treated an absent prepared stage as proof that Recorder had consumed its notice. A missing source can instead mean lost material; the earlier code could report success without publishing the contract or notice.

The candidate now saves the stage's physical identity in the existing operation fact. It uses `publishPreparedPhysicalFile`: a successful rename returns immediately, with no target reread. Only an unavailable stage needs the exact target identity or the recipient's existing accepted wake/claim source. A consumed signal is not recreated. If neither fact establishes the result, the original operation and remaining bytes stay in place and the caller receives an unconfirmed result.

Worker contract publication has its own `contractPublished` fact, so later notification retries do not reread or overwrite a confirmed contract after an ordinary edit. The prepared decision append and its completion fact remain the separate append implementation. There is no new signal ACK, queue, generic journal, global scan, or long-lived content/version lock.

Root Foreground and Recorder publication remain independent. The global branch cannot infer Recorder success from the missing stage. After the exact Recorder source has legitimately disappeared with runtime retirement, the existing root Task history plus the program-owned root retention catalog can establish that Recorder's downstream business responsibility has already completed. The history must match the closed root's identity, owner, lifecycle, route, source and archive. The catalog must carry its actual Recorder command/request, matching lifecycle and root records output. History alone, a missing catalog, or another lifecycle does not settle the responsibility. This marks only the handoff as finished; it does not fabricate a `published` fact for a particular empty signal. Neither Cleaner nor native release waits for this observation.

A terminal child still notifies only its actual parent Organizer. An already-completed child can resume its interrupted publication after that parent has legitimately processed the notification and completed; a still-running child continues to require its actual open parent assignment. Child Recorder/Cleaner work was not added.

Repeated `dss_worker_assign` preserves the existing current-contract update semantics. The pre-existing tool replaces that Child's current contract and notifies the same Worker; it does not create a job queue. A previously accepted wake cannot consume a newly published notification. These checks do not add a product-level refusal of a new continuation.

A new Planner command also resumes any unfinished accepted assignment for that same Worker before accepting its latest contract. The old contract stage/identity and separate decision text remain the original sources. The only production caller derives all delivery targets from the same Task/member/ChildID `workerPaths` and state mapping, so no new target inventory or copied body is needed. The old decision is appended once, its notification is completed or recognized from the existing consumed source, and then the new command updates the current contract. A different command with equal text remains a new continuation, rather than being mistaken for a retry. Same-command changed arguments and different Task lifecycles retain their existing checks. Missing original material or genuinely unconfirmed publication still preserves the old responsibility; it does not allow the new request to overwrite it. Only the same Worker lane waits. Shared ordinary Planner Memory writes retain their normal same-file ordering.

## Actual call paths exercised

- Installed `dss_worker_assign` → physical assignment → contract/decision/empty Worker signal.
- Installed `dss_complete` → physical terminal → parent Organizer or root Recorder, plus the independent Host global Foreground branch.
- `cancelTask` → physical cancellation, including storage-only `physicalControlSignalSources` parity with the Runtime's exact role keys and sources.
- Existing Runtime `roleKey`, `physicalSignalSources`, `addressedSignals`, `assertOrganizerBusiness` and `consumeWakeSignals`, extracted verbatim from the source under test. Controlled technical-store fixtures persist RoleRecord-shaped sources before the actual consumption method deletes a signal.
- Installed `dss_recorder_save` → physical Recorder archive/history/retention/Cleaner publication → actual Host/`FrameworkCleaner` fixed-tree removal → cold global handoff retirement after source-record removal.

`validate-physical-terminal-assignment-evidence.mjs` covers missing contract, Worker, Recorder, Foreground and child stages; a stale accepted source with the same path but another physical identity; restart after real rename or consumption; a parent completed before child publisher continuation; ordinary confirmed-contract edits; current-contract reassignment and stale wake consumption; and successful renames without target rereads. Its single-Host Local fixtures use the actual same-member receiver scope, not a fabricated cross-Host lookup.

The larger terminal regression now uses actual receiver consumption for consumed-before-save cases and actual Recorder publication for the cleanup boundary. A previously optimistic test that appended to the Note after an interrupted unconfirmed append publication now expects the correct unconfirmed outcome and checks that both authored contents and the original responsibility remain intact.

## Verification and limits

Commands:

- `node scripts/validate-physical-worker-assignment-continuation.mjs`
- `node scripts/validate-physical-terminal-assignment-evidence.mjs`
- `node scripts/validate-physical-task-terminal.mjs`
- `node scripts/validate-physical-worker-assignment.mjs`
- `node scripts/validate-physical-publication-evidence.mjs`
- `node scripts/validate-physical-worker-runtime.mjs`
- `node scripts/validate-physical-signal-consumption.mjs`

The continuation-specific script exercises the installed Planner tool across eight interrupted old-assignment phases, new requests, consumed old signals, same-text new commands, actual cold process exits, UNKNOWN preservation and independent Worker/Task progress. Restoring the immediately preceding assignment module reproduces its unconditional unfinished-request refusal.

Each report includes the actual loaded source hashes. The focused baseline mode accepts `DSS_BASELINE_SOURCE` and optional `DSS_BASELINE_COMPONENT=worker|terminal`. Restoring either pre-fix module reproduces `Missing expected rejection` at its missing-stage boundary. Those saved modules are the exact pre-edit candidate, not a claim that the physical rewrite existed in original v44.

Native Agent admission, technical storage and schemas/Markdown parsing remain explicitly controlled test ports. No installed DSH UI/native Agent factory, Windows filesystem, power-loss durability, cross-process writers, full dependency/typecheck/build/package or user-machine verification is claimed. The current environment has no `tsc` command on PATH. These focused scripts transpile the actual source and do not replace a full typecheck.

An accepted signal source that is later overwritten/retired before publisher recovery can leave the result unconfirmed if no existing downstream business result is available. Worker/child/Foreground do not get a new journal or ACK to erase that uncertainty. Cross-member receiver ownership remains the existing real Host/storage boundary; the tests do not imply that one Local Host can read another Host's private records. Unknown responsibility is preserved rather than inventing a successful handoff.
