# Task button submission boundary

The Task pause, resume and cancel API returns a submission acknowledgement:

```ts
{ submitted: true, commandId, taskId, lifecycleId?, intent }
```

This means the required writes returned successfully. It does not mean that a native execution has finished stopping or resuming. The client obtains displayed Task state from the existing fixed Host observations, not from a post-submit page refresh or an optimistic status change.

## Required writes and business work

- Pause keeps the existing scoped `ExecutionControls.setTask` write, command receipt and Git CAS/UNKNOWN behavior. The button does not call `applyUserControls`, fetch the control again, fetch a view, or issue a generic changed notification. The existing Host observer applies the saved intent.
- Cancellation publishes the terminal Task family state and its addressed notifications through the mode’s existing operation: physical Local uses its owned file-publication continuation; Git keeps its atomic transaction and receipt. Child completion addresses its parent, while the total Task owns Recorder/Foreground notification. The button returns after the required publication. The existing role cancellation tool retains its original readback and `afterCancel` behavior.
- Resume first keeps the original running-control write and addressed `UserResume` publication. Physical Local continues that command's owned file publication; Git retains its signal transaction. The family/control reads that determine the real recipients remain necessary business reads. After successful writes, the existing runtime maintenance owner schedules `resumeTask`; the button does not wait for native continuation.
- The scheduled continuation starts on a later event-loop turn, uses the background read/write channel, is joined on shutdown, and reports its original failure with the original task/control-command context. It is not an unowned promise or a new Host loop.
- The original command must still be the effective running command in `resumeTask`'s existing Task-family snapshot. A later pause, another command, changed lifecycle or terminal Task prevents the queued continuation. No standalone post-submit `controls.task` check is added.
- Existing resume business routing remains intact: stopped accepted input, exact native message identity, Worker note routing and Organizer scope are retained. Generic `UserResume` notification delivery alone does not construct that accepted-input continuation.

## Read/write separation

Git button writes use access-side controls on the foreground-write channel, with existing shared authority CAS. They do not borrow the Host control reader queue. Physical Local controls use their exact Task/lifecycle, execution and command records in the scoped physical record store. The active runtime owns native application of that intent; it is not a SQL whole-document writer.

Within `ExecutionControls`, only mutations advance the write queue. Ordinary readers await writes already accepted when the read was called; a slow reader does not become a barrier for later writes. Returned values are still cloned. Explicit snapshot reads retain the in-transaction validation boundary, including avoiding a mutation waiting for itself. No new global lock is introduced.

## Failures and integration

UNKNOWN remains the original error and original operation. Neither the API nor scheduled continuation automatically resubmits an uncertain write. An explicit retry uses the original command and existing receipt/CAS recovery. A failed required signal publication does not schedule native continuation, even if the preceding running-control write succeeded.

The server changes require the matching client submission-result contract. Host-derived display projection and removal of client reload behavior are separate client changes. Integrate those together; do not interpret `submitted` as an execution status.

Save and read back the final merged source before building an installation package. This change does not update an existing remote Foreground guide, change installation files, or introduce a new control protocol.

If native stop is still pending when resume is submitted, the owned continuation uses the existing exact `stopOperations` promises for that Task family and lifecycle. It releases the locating snapshot before waiting. Only this real wait requires a fresh business snapshot afterwards, so a newer pause, cancellation or lifecycle wins before member scanning. The no-wait path has no additional snapshot. This starts no new stop request and does not rerun `applyUserControls`.

## Exact execution-stop button

`stopExecution` returns `{ submitted: true, commandId, workId, executionId }`
after its durable execution-control write. The matching client does not invoke
its generic view loader or start a post-write read. The Host schedules the exact
execution stop on its existing maintenance owner after the submission path,
using its background channel. Native stop evidence and control outcomes are
still persisted and shown through normal Host observation; `submitted` never
claims that the native producer has stopped. An uncertain control write does
not schedule the stop from the failed submission call.
