# Current-design validation

The accumulated legacy suites, assertions and fixtures are retired. They are not
acceptance criteria, must not drive product behavior, and must not be restored as
compatibility requirements. Historical evidence remains preserved outside ordinary product APIs for traceability.
The narrowly scoped frozen v44 producer under scripts/test-support/historical-v44
only constructs real old SQL/WAL inputs for the one-time read-only migration
regressions. Its original hashes are verified; it does not define current behavior.

## Establish the expected behavior first

For each current validation case, record the applicable current design and user
correction, the real production entrypoint, the triggering inputs, and the
observable outcome. Do not infer intended behavior from a prior test result.
A synthetic scenario demonstrates its own conditions; distinguish it from a
real-device observation. Do not add a production mechanism merely to satisfy a
fixture or reduce normal-path performance to cover an unreachable scenario.

## Source checks and delivery

The source checkout currently exposes this check:

```sh
npm run typecheck
```

Create focused validation from the current source and current requirements.
Record the exact source inventory SHA-256 and dependency versions. Distinguish
source-level checks, physical Local operations, old SQL read-only migration,
controlled native execution, actual Git
transport, and user-device/end-to-end testing. Never add historical counts to a
current candidate's results or describe an unrun stage as passed.

Preserve the exact editable source and its validation evidence in the destination
authorized for the current work. A later source edit invalidates the affected
results and requires a new source checkpoint and rerun of those cases. Saving
source, testing, building, publishing and deployment are separate outcomes;
report which actions were actually performed and authorized.

## Tests using the actual Host SDK

The following checks load the real Cordis, Storage, Domain and JSON backend from
an explicitly selected DSH Host dependency tree:

- `scripts/validate-local-record-concurrency.mjs`
- `scripts/validate-record-entry-isolation.mjs`
- `scripts/validate-upgrade-record-categories.mjs`
- `scripts/validate-physical-record-move.mjs`
- `scripts/validate-local-upgrade-relocation.mjs`

Set `DSS_SDK_HOST_ROOT` to the absolute Host folder containing `node_modules`,
then run each script with Node. The shared support under `scripts/test-support`
records the loaded package versions and source hashes. It does not download
packages or silently replace the SDK with test doubles. The SDK itself is not
included in the source archive. Missing dependencies are an unrun check, not a
pass or a reason to weaken assertions. These cloud filesystem/SDK checks do not
replace full type checking, a complete Host/model run, or Windows verification.

The focused Local upgrade relocation check covers 118 assertions and three
deliberate subprocess exits, including owned/custom directory layouts, exact-key
relocation and restart recovery without global technical-record scans. Its
non-SDK `mdast-util-from-markdown` import has an explicit fail-if-used boundary:
the covered scenarios do not invoke Markdown parsing, and any parser call throws
instead of returning fabricated output. This result does not validate Markdown
parsing; that coverage requires the actual parser dependency.

## Necessary coverage for changed behavior

Use the actual implementation and fresh data. Cover the changed successful path,
repeated requests and relevant concurrent/interrupted paths. Verify that writes
preserve existing user content, that Git authority remains on Git, and that true
native stop or unresolved write outcomes are neither fabricated nor discarded.
Report exact limitations and unresolved decisions without turning them into new
business admission rules.
