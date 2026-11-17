# Foreground conversation context

Every visible reply is an explicit `dss_conversation_send`. Its required
`responsePhase` is `interim` or `final`. This is message metadata only: original
text, Markdown, attachments and rendered user conversation are not decorated.
An interim does not close a group. A final closes the continuous AI-directed
user inputs received before its authoritative publication, along with intervening
explicit replies. This is chronological grouping, **not** a claim that every
input was read, answered or handled. Different authenticated senders share the
same collaboration ordering. `replyTo` remains its explicit semantic reference.
Human-to-human discussion is still available in full history, but is not an
AI-directed input or a fabricated complete group.

## Storage and reading

`conversation-context/<mode>/<collaboration>/index.json` stores publication
positions, current original references and the latest six complete groups. The
current group is not capped. Finals carry the exact preceding references in
message metadata. Text is never copied into the context index.

Physical Local stores a complete readable `.txt` original under its participant
and UTC date, plus a stable per-message `entry.json`. The entry retains the first
send's identity and original body location across retries. Ordinary physical
text edits remain readable through message, page, search, text and context ports;
replaying the original send does not overwrite those later edits.

Independent message originals are prepared without a conversation-wide writer
queue. Only their shared index/context publication coordinates within this
conversation. A genuinely unfinished body/metadata → context/index → original
Foreground signal handoff is named in the index until it finishes. It is not a
command receipt, acknowledgment or complete-history copy. Original files exist
before visible references and the signal. A restart continues that exact named
handoff; consumed signals are not reconstructed from their later absence. The
signal retains its username/timezone/timestamp name and a stable scope/message
identity suffix so independent same-millisecond publications cannot overwrite
one another. No global scan or extra wake service is added.

Git keeps its separate complete daily records and atomic ref publication. Retained
old SQLite sources are read only during the one-time Local upgrade; they are
not an ordinary conversation write backend.
Publication order is the successful shared-index order, not client-clock order
or the preceding model request. Sending does not wait for signal consumption.

`dss_conversation_read` defaults to `context`; `recent` selects the same view.
It reads the context metadata first, then only the selected original paths.
Physical Local observes those actual files, not an immutable multi-file snapshot.
Git reads complete authoritative daily records at its snapshot, including
multiple UTC days when selected. Old Local chunks are an upgrade input, not the
new physical text writer. The returned messages occur once,
with reference-only group boundaries. There is no additional persistent or
cross-request RAM body cache and no automatic pre-wake history injection.
Existing first-wake signal consumption still occurs before the read tool. The
context reader itself never changes signals or writes storage.

Explicit `page`, `message`, `search` and `text` reads retrieve older originals
when requested. UI pagination is unchanged and independent of the six-group
model context. A read returning fewer groups does not promise fewer Git bytes
when selected originals share a daily file with older text. This feature does
not change branch CAS or establish a measured conflict/performance improvement.

## Boundaries and recovery

- Empty text is still a valid send, including an attachment-only message. An
  explicit empty `final` retains the caller's final designation. A final with
  no current user input is saved, but does not invent a complete human/AI group.
- A physical Local retry uses the original message identity and, when present,
  its exact unfinished publication. It neither creates a second message nor
  reemits an already consumed notice. Git keeps its own command recovery.
  Equal text with a new message identity is not a replay.
- Old messages without explicit publication grouping are not retroactively
  paired by timestamps, process-display metadata or `replyTo`. Their complete
  originals remain available through explicit history reads. If a notification
  originates from an older writer, inspect that history rather than pretending
  the new context window proves all input is present.
- Accurate ongoing groups require all concurrent writers to implement this
  protocol. An old writer may append a message without updating the context;
  readers do not manufacture a boundary or automatically inject old bodies.
  The metadata version is validated, not silently overwritten on incompatibility.
- A missing context file has no provable current grouping and returns no inferred
  groups. The originals and explicit history remain intact. Positions and exact
  final references are retained for an explicit future repair, but this feature
  does not start an automatic scan, reconstruction or extra write on a read.
- Physical Local clear-history retains the exact user-confirmed selection in
  its existing cleanup plan. It removes selected context/index references before
  deleting their known entry/body files and exact observed signals. It does not
  delete the shared message directory, Foreground List/Cache or independent Task
  notices. Partial deletion resumes that same selection; later messages survive.
  Git history disposal is not added.

The cross-day different-tool-call/same-message-ID limitation of the previous Git
daily writer is tracked separately in the implementation report. Do not treat
same-command UNKNOWN guarantees as a claim that every arbitrary legacy identity
reuse is globally deduplicated.
