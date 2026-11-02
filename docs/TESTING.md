# Tests and reproducibility

Run tests from a source checkout with its declared dependencies installed.
Record the source commit, Node and Host dependency versions, and package SHA-256
with release test results.

## Commands

```sh
npm run typecheck
npm test
npm run build
npm run test:package
```

## Current implementation

`npm test` runs the current suites listed in `scripts/test-suites.mjs`.
The runner checks for missing, duplicate and unclassified suites before compilation.
The suites cover:

- Local SQLite and native JSON storage, persistence, reopening and migration.
- Git repository operations, concurrent updates, cancellation, account and scope
  changes, message identity and acknowledgement recovery.
- Role dispatch, native execution admission and stopping, task controls and cleanup.
- Complete conversation text, history navigation, Foreground continuity, record
  export, preference and project-fact discovery, and skill operations.
- Record relocation, retained artifact bytes and references, and cleanup boundaries.

`native-model-selection` mounts the official Agent loop, default-model service and
system-prompt registry for all six roles. It checks Auto and explicit model selection,
including selection before persona rendering. Its controlled adapter and JSONL
backend exercise persisted selection across resume and changes to provider defaults.
The test adapter retains its upstream MIT notice and is excluded from installation
packages.

Tests using official-service compositions and controlled model responses exercise
role handoff, rework, pause/resume, graceful shutdown/restart and artifact readback.
Real-provider tasks, browser interaction, operating-system termination and
collaboration between different real accounts are separate acceptance scenarios.

## Historical implementation

```sh
node scripts/test-historical.mjs
```

This command runs the baseline commit named in `scripts/test-suites.mjs`, using that
commit's source, prompts, tests and runner in a separate tree. The baseline must be
available locally; CI checkout uses `fetch-depth: 0`.

The historical run reuses the checkout's installed `node_modules`. Record its
dependency versions and results separately from the current implementation.

## Package and installation checks

`npm run test:package` builds and packs offline. It verifies the explicit production
file list, regular-file entries, compiled bundle bytes, Host module import and
configuration schema, and client registration envelope. Host import uses the
checkout's installed dependencies; client registration checks capture the factory
without executing it.

Installation acceptance uses the final archive and fixed Git tag with the official
DSH installer. Check installed file hashes, plugin enablement, restart behavior,
and preservation of existing settings, conversations, tasks and artifacts. Record
the actual Host version, platform and installation source with each result.
