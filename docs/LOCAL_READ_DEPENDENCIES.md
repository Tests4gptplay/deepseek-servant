# Local physical reads and publication

Ordinary Local acquisition uses `PhysicalLocalFiles.open`. Each logical category
maps directly below the configured physical root. A view owns its lifetime and
cancellation, not an immutable whole-directory image or SQLite transaction. Every
read observes the actual addressed file; a later read may observe a later write.

Ordinary replace, append, create and delete operations act on their exact files.
A same-file read-modify-write uses that file's existing ownership mechanism.
Different files do not share a global writer queue, database revision gate, or
reader-worker pool. A list reads the requested directory and its explicit
selection; it does not justify scanning unrelated task roots.

## Business publication and consumption

Cross-file handoff uses the owning business operation's actual producer,
notification and execution continuation. Sequential writes are not called an
atomic transaction. Original content, source identity and incomplete ownership
remain until that operation settles. Unknown results are not silently replayed
under a different command. Exact observed-signal consumption keeps the existing
identity check so it cannot consume a later replacement notification.

Manual cleanup acts on the user's reviewed file/Task selection and keeps its
actual pending intent until native reset or physical retirement finishes. The
root Recorder's Cleaner signal selects the known Task tree's fixed directories;
Cleaner removes whole directories without reading archived business contents or
waiting for another audit. Historical identities remain outside live discovery.

## Retained old sources

`legacy-sqlite-reader.ts` retains read-only SQLite/WAL snapshot access for actual
old data. One-time startup conversion, original manifests, old history export
and unresolved continuation read those sources without restoring a product SQL
writer. Source disposition is a separate authorized action; successful conversion
does not delete the original database or WAL.

Tests that need real v44 input use the original hash-verified producer under
`scripts/test-support/historical-v44/`, outside product imports and package files.
They validate old-input preservation, not current SQL command semantics.

Git retains its independent fixed snapshot, related-content dependencies,
conditional branch publication and unknown-operation recovery. The physical Local
switch does not alter those protocol requirements.

Current checks and exact hashes belong to the accompanying validation reports.
Cloud source/fixture success is not full TypeScript, native DSH, Windows-device,
package, installation, or final project acceptance.
