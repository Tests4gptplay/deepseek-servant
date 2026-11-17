# Targeted Foreground guide migration

The packaged Foreground template includes the task-control section below. During
role-guide initialization, a missing guide is created from the current template.
An existing Foreground guide is examined by `upgradeForegroundGuide`: exact known
obsolete protocol sentences in a recognized generated template are replaced. The
exact previous default that differs solely by the missing
`foregroundStorageRecoveryNote` receives that note. Custom text, original line
endings and unrecognized instructions are preserved; unreviewed sections are
reported rather than guessed at or overwritten. Existing empty guides and guides
without the template anchors are not replaced.

The upgrade runs in existing initialization: physical Local updates the exact guide file and Git uses its initialization transaction. It does not replace
the whole authoritative `technical/role-guides/Foreground.md` with a packaged copy
or introduce a separate remote migration command. The source file itself is not
evidence that a particular installation has completed its next initialization.

The section below documents the matching controlled `dss_record` capability.
It is not an instruction to append duplicate sections or to edit the persisted
control envelope directly.

## Explicit user pause and resume
When the user explicitly asks to pause or resume an existing Task, identify the exact Task in this collaboration scope from the conversation and authoritative Task metadata. Clarify an ambiguous target before acting; a question, old conversation or generic progress request is not permission. Open dss_snapshot with that taskId and read tasks/<taskId>.json. Only a running Task in this Host member's execution domain can receive this reversible control. Copy its exact lifecycleId when present; omission identifies only the original lifecycle.
Use the existing dss_record at the exact sourceLocations.taskControlPath supplied by this Foreground binding, with that snapshotId, append:false and text containing only the JSON request {"taskId":"<selected taskId>","lifecycleId":"<current lifecycleId>","intent":"paused"} or intent "running" for resume. Omit lifecycleId only when the Task has none. This special record address accepts a validated request, not literal replacement file contents. Do not append to, manually overwrite, reconstruct or edit the control envelope, other tasks, executions, commands or any other technical JSON path. Ordinary Foreground record writes remain limited to its bound records and Foreground_List.md / Foreground_Cache.md; reading another file never grants write permission.
The existing scoped control store persists the same intent and command receipt used by the buttons. In Git the repository path is <repositoryDirectory>/technical/authority/<sha256("shared")>/framework-user-controls/<sha256(scope)>.json; repositoryDirectory can be empty and otherwise defaults to dss-coop. The tool path is logical and excludes repositoryDirectory. Its envelope is {version:1,key:"framework-user-controls/<sha256(scope)>",value:{version:1,tasks,executions,commands}}. Task entries are keyed by sha256(taskId), or sha256(taskId + ":" + lifecycleId) for a restored lifecycle, and contain taskId, optional lifecycleId, intent, commandId and requestedAt. Commands are keyed by sha256(commandId) and hold the existing signature/value receipt. Local controls use exact Task/lifecycle, execution and command records in the existing scoped StoragePort; this tool address is a validated request address, not a literal file-write destination. These details explain the existing record, not permission to edit its schema or choose another scope.
Keep the original native tool-call identity and identical request after UNKNOWN while its outcome is reconciled. Do not create a replacement command, alter requestedAt, clear another control or treat an uncertain result as success. A pause or resume result confirms successful submission of its required writes, not proof that native execution has finished stopping or resuming. Resume reuses the button's existing UserResume publication and tracked scheduleTaskResume/resumeTask continuation of preserved work, not restoration or a new Task. Do not add a control or page readback merely to verify this write; describe it as submitted and use the Host's existing observed execution records for actual progress. Ancestor pauses and independent child pauses retain their existing effect. Report observed state, not assumed completion. The Host's existing observation, stopping, admission and continuation mechanism remains authoritative.
Cancellation remains dss_task_cancel and its existing mode-specific Task-status and addressed-notification publication: physical Local uses its owned continuation, and Git keeps its atomic transaction. Child Tasks notify their parent; the total Task owns Recorder/Foreground notification. Cancelled is terminal, not a pause, and cannot be resumed by writing running. Follow the cancellation and explicit restoration rules below without inventing another signal, acknowledgement, control tool or repair Task.
