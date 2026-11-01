# Test ownership and reproducibility

## Current implementation

Run `node scripts/test.mjs` (the default test entry). `scripts/test-suites.mjs`
explicitly enumerates every current and historical suite. An unclassified new suite,
a missing suite, or duplicate classification fails before compilation. Suites are
not selected by whether they pass. All current framework suites, native execution
adapters, conversation/event adapters, credentials, remote Git contracts and
command transaction regressions remain in the current run.
There are no old role-prompt build definitions in this runner.

`native-model-selection` mounts the official Agent loop, default-model service and
system-prompt registry for all six roles. It checks Auto and explicit model routes
before rendering a persona containing `{{model}}`, then verifies native admission
reaches the deliberately unconfigured provider error. It makes no model API request;
real Web request admission and provider responses are separate validation steps.
The same suite uses the official test-only MockAdapter and JSONL backend to flush
and reopen a real request header: resumed Auto keeps A after the default changes
to B, a new Auto session uses B, and explicit C changes both prompt and request.
It also checks reasoning-effort removal and explicit/default output-token limits.
These responses are controlled fixtures, not paid-model results.

## Historical implementation

Run `node scripts/test-historical.mjs`. It requires local Git commit
`0acd3ba39a2ae23d66759279b3c54c4637cd0ad5`; configure CI checkout with
`fetch-depth: 0`. The command does **not** fetch history or credentials.
It archives that entire fixed commit into a fresh `.validation/historical-*` tree,
then runs that commit's own test runner, tests, source and role prompts. It does not
combine current tests with obsolete implementations or restore obsolete code into
production. All 46 baseline suites are discovered by the baseline runner, including
suites whose current successors have changed. The retained historical classification
names describe old implementation ownership, not exclusions within that full replay.
Tests added or changed in the current checkout are not substituted into the fixed
baseline tree; this replay therefore does not claim to run every current historical
test-file revision.

The replay explicitly shares the already installed `node_modules`; it does not
claim to reproduce a separate historical dependency installation. Node version,
source SHA and dependency location are recorded in `historical-run.json`. Preserve
the process exit code and output. A missing baseline is a failure, never a skip.
The isolated tree remains available for diagnosis and is not a release artifact.

## Preserved regressions and known limits

A previous mixed-implementation run reported **637 tests, 606 passes and 31 failures**: 3 cache serialization,
4 snapshot metadata, 4 platform Unicode paths, 1 background multicycle, 4 repository
initialization, and 15 send-admission cases. Moving obsolete runtime suites to the
historical lane does not turn those failures into passes. Historical replay results
must be reported independently; its failure count can vary with installed dependencies.

Current replacements exercise the following actual interfaces:

- `git-remote-repository`, `framework-connection`:
  independent NFC/NFD directory scopes; empty/existing repositories at root/nested
  paths; overlapping narrow/broad fixed-snapshot listings; failed/cancelled lifecycle
  recovery; expected-HEAD CAS; exact prepared-operation unknown resolution.
- `framework-git-send`, `framework-account-switch`, `framework-service`,
  `framework-client-contracts`, `framework-transport`: original message identity and
  destination, account/scope changes, durable acknowledgement/replay, and RPC behavior.
- `framework-role-runtime`, `native-executions`, `framework-host-loop`:
  role dispatch, native admission/stop evidence, task-domain controls and cleanup.
- `framework-legacy-migration` and `framework-migration-lifecycle`: original historical
  producer data read through fixed-SHA fixtures, without obsolete production fallback.

Fixed review-round counters, mechanical Host record summaries, obsolete bare-Git
mirror behavior and old completion handshakes are not current product protocols.
Their historical tests remain intact. In particular,
`git-cache-ref-serialization` directly asserts removed bare-cache `git`, `environment`
and `fetch` methods, cache directories and ref locks; it belongs to the historical
implementation by assertion ownership, not because a current compile failed. Its
shared fixed-snapshot/concurrency/isolation goals are tested against the current HTTP
repository through CAS, conflict/unknown, overlapping listings and root isolation. Shared safety assertions must instead be
covered at the current interface; removing an obsolete protocol is not permission
to remove CAS, isolation, recovery, permission, or data-preservation checks.

Controlled HTTP tests are not public GitHub verification. Native registry/Cordis
composition tests with explicit runtime seams are not a complete installed Host
or real-model session. A green current run does not establish real-host, public-Git,
user-machine or provider acceptance. Final acceptance must pin the same source
commit, dependencies and installable package, inspect its contents (tests and
historical trees excluded), and record which actual Host checks were performed.

## Offline package checks

`npm run test:package` builds and packs without network access. It checks the explicit package file manifest, regular-file-only entries, bundle byte equality, the packed Host module import/config schema and the client registration envelope. The client factory is not executed. Host import resolves the already-installed repository dependencies; this is not a fresh install or a complete Host/Agent/browser acceptance run. The report records HEAD and whether the working tree was dirty. Final acceptance must use a clean, fixed commit and the intended Host dependency baseline.
