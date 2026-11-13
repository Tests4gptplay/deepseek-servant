# Physical Task reconstruction publication

> 历史证据更正（2026-11-11）：下文保留当时源码、命令和测试记录，不是现行设计或验收要求。直接移除尚未发布的内部 stage、或强制让底层写入抛错，只能证明所构造场景；这里没有建立失败本身的真实产品触发条件，不能据此恢复目标版本、收件回执或额外发布证明门禁。当前已准备操作按现行生产调用链接续，已消费通知不重发；真实目标冲突、原始资料和未完成责任仍按各自职责保留。下文历史通过数量不证明当前源码通过。

> 生命周期更正：总任务 complete 后的新需求或纠错使用新 Task ID；下文笼统的 terminal reopen 不能用于同 ID 重开已完成任务。明确取消后的用户授权恢复仍是单独保留的现行职责。

This is internal implementation and validation evidence. It is not plugin README content or a production cutover statement.

## Observed failure and selected scope

`FrameworkRoleRuntime.recoverMissingTask` calls `reconstructPhysicalTask` for an explicit restoration of the original stopped execution. Running Tasks fill missing support files; an explicitly reopened terminal Task preserves its original material and publishes new lifecycle metadata last. The original source already had a reconstruction-specific fact and full staged bodies.

The frozen implementation (`7573b0b4b1f4ff5685a2e95b1e6f0c885289c2779d48c538e978b57f26c47c21`) treated `files.rename(...) === false` as success. Its fill-only branch also returned successfully when the stage was missing. The actual runtime probe removed an accepted source or Task stage and observed `complete: true`. Both source scenarios left the required source absent. The Task scenario left the earlier Task metadata in place, rather than publishing the accepted reconstructed metadata.

Only `src/framework/physical-task-recovery.ts` changes runtime behavior in this correction. Its dedicated validation is `scripts/validate-physical-task-reconstruction-publication.mjs`. Cleaner, native release, Helper wake/signal order, Git, default storage selection and ordinary write behavior are unchanged.

## Corrected publication

- Each accepted full body stores its actual staged-file observation and its accepted destination observation in the existing reconstruction fact. These are the existing local file identities, not a new random content version or lasting file lock.
- Authorized replacement uses the existing `publishPreparedReport` single-file primitive with that already prepared body. It does not rebuild accepted bytes from a later input. A changed target/stage is retained, and a missing stage requires the exact original publication identity at the target.
- Fill-only publication uses `renameIfAbsent`. A successful rename confirms publication. An existing target is intentionally retained, with that preservation decision saved before deleting only the observed unused stage. A missing source is not confirmation, including when the target happens to contain equal text in another physical file.
- Each confirmed body is recorded before continuing. Later edits or removal of a completed body are not reverted because another body is still pending. Task metadata remains last; overall completion follows every required publication or intentional fill-only preservation.
- Lifecycle originals use no-replace handoff and retain the existing exact byte-count/SHA256 archive verification. A different existing archive file is not overwritten.

No new scanner, global queue, journal, ACK, cleaner prerequisite, background replay or implicit restoration is added. The existing per-command queue remains scoped to that Task reconstruction. Only an unfinished handoff uses the saved observations; normal subsequent reads/writes remain live.

## Validation and reproducibility

The test loads the actual TypeScript source, including the complete `FrameworkRoleRuntime` class. It invokes the actual `recoverMissingTask` method and installed `dss_snapshot`/`dss_read` tools. Native session/technical-record ports, schema parsing and unrelated skill/native imports are explicitly controlled. It does not substitute the publication implementation.

The before/after probe uses the same `--probe` entrypoint. `DSS_RECONSTRUCTION_BASELINE` selects only the frozen old reconstruction module. `DSS_RECONSTRUCTION_SOURCE_ROOT` selects an exact frozen source tree for every imported TypeScript module. Each result reports the hashes of the source actually loaded, including child process hash sets.

The scenario matrix covers missing accepted stages for source, inbox, member status, cache and Task; live fills and explicitly reopened terminal Tasks; existing user files; changed stages and destinations; exact known prior renames; deleted/edited unknown prior publications; saved preservation before stage cleanup; saved publication before later edits; unavailable legacy identities; no-replace lifecycle originals; missing explicit restoration input; and unrelated Tasks proceeding independently.

The default run exits real subprocesses before and after every addressed mutation on the actual running-Task and reopened-terminal runtime paths. Each continuation starts a fresh process using only persisted files and records. This is process-interruption evidence, not OS power-loss testing.

Run:

```sh
node --disable-warning=ExperimentalWarning scripts/validate-physical-task-reconstruction-publication.mjs
node --disable-warning=ExperimentalWarning scripts/validate-physical-task-reconstruction-publication.mjs --probe
node --disable-warning=ExperimentalWarning scripts/validate-physical-task-recovery.mjs
```

The existing focused recovery regression passed 323 assertions and 38 interruption cases. The initial dedicated run passed 2,371 assertions, 36 scenario groups and 98 subprocess-exit continuations. It records multiple imported-source hash sets because an independent worker changed `physical-local-files.ts` during that run. The final frozen-source run passed 2,481 assertions, 39 scenario groups and the same 98 subprocess-exit continuations. All parent and child source hashes match one frozen set. Its exact source diff and before/after failures are retained together in the cloud review evidence.

Full `npm run typecheck` was attempted and returned exit 127 because `tsc` is not installed in this checkout. Source execution strips TypeScript and is not a substitute for full typechecking. No native DSH, Windows, power-loss durability, cross-process atomic no-replace/compare-and-swap, release packaging, installation or production cutover is asserted. Portable Node rename retains the existing documented external-process check-to-syscall boundary.

## Existing fact boundary

An unfinished older fact without the original publication identity is preserved and reported as unknown; current files are not relabelled as proof and original full stages are not silently rebuilt. Already completed old facts keep their existing completion behavior. This change does not retrospectively audit or repair earlier completed reconstruction records.
