# Dulwich memory Git backend

This source tree uses one product Git transport: Dulwich, beneath the existing repository authorization, transactions and receipts. There is no Native Git client, backend choice or disk fallback.

## Install prerequisites explicitly

- Python with the TLS support required by its installed packages. Required packages: Dulwich and urllib3.
- Use an existing supported Python or install official Python yourself: https://www.python.org/downloads/ . DSS never installs Python, packages, drivers, certificates, or OS settings on the user's machine.
- Product Git content transport and object operations do not require a Git executable. The existing `gh` login and permission provider remains required; this change does not uninstall Git or gh.

Create a dedicated virtual environment and install the dependencies from the official Python package index:

```sh
python3 -m venv .dss-git-venv
.dss-git-venv/bin/python -m pip install -r python/requirements.txt
.dss-git-venv/bin/python -m pip check
```

Windows PowerShell, after official Python is installed:

```powershell
py -3 -m venv .dss-git-venv
.\.dss-git-venv\Scripts\python.exe -m pip install -r python/requirements.txt
.\.dss-git-venv\Scripts\python.exe -m pip check
```

pip resolves the dependencies required by the selected Python and upstream packages. Official package information: https://pypi.org/project/dulwich/ and https://pypi.org/project/urllib3/ .

Configure the existing DSH plugin entry:

```yaml
gitPythonExecutable: /absolute/path/to/.dss-git-venv/bin/python
```

Use the absolute Windows `.venv\Scripts\python.exe` path there on Windows. Omitting the executable uses `python3` on POSIX or `python` on Windows; no argument string or shell is accepted. Configure Python and the dependencies before Git use. Missing imports or unavailable runtime interfaces report their actual operation error. There is no disk fallback.

## Lifecycle and authority

Construction does not spawn Python. The existing Host service owns startup, cancellation and disposal. Only configured Git access obtains the existing credential provider, checks its owned helper dependencies locally, then obtains repository/account authority approval before network Git work. Missing Python/dependencies fail before identity/repository REST inspection; a later explicit operation can retry after setup is corrected. This does not add activation-time blocking work, an independent timer, automatic repository initialization, or an unrequested write. Only the existing explicit write setup may initialize an empty branch.

Each repository/authority instance has at most seven bounded lanes, each with its own resident process when used: background read/write, foreground read/write, UI refresh, fixed Host polling, and periodic heartbeat publication. Authority is shared within the repository scope. A Host may own separate foreground-access and background-connection instances, so seven is not a Host-wide process limit; total active helper RSS must be added across those instances. A change in repository, branch, directory, account or token invalidates that scope and drains every lane. Each helper retains multiple immutable cache generations only while snapshots, active operations, or unresolved publication owners need them.

Every snapshot observes the remote branch afresh. The cached tip is a negotiation hint, never branch authority. Metadata uses smart HTTP v2 with `blob:none` and a known have-tip. Exact tree-confirmed blobs use v1 with no filter and an empty have walker; this is not an unfiltered commit/tree traversal. Missing commit objects for receipt verification use v2 `tree:0`. Unsupported filters and unsupported object formats fail explicitly. GitHub's current SHA-1 format is supported; SHA-256 repositories are not supported by this product transport.

The TypeScript path still owns exact-H CAS, author identity, retained original operation ID/time/hash, original UNKNOWN reconciliation, same-operation replay and input validation. Calls for the same operation remain ordered. Independent publications use their selected writer without a shared publication tail; updates to the same branch still resolve through the existing expected-head CAS and actual read dependencies. Within one cache, missing-object reads share work only for overlapping object identities. Unrelated object reads and fresh branch observations do not wait for that object work. Cache and transport lanes remain separate. Python does not retry a write, change the expected head, or create replacement operation IDs. Publication requires complete unpack success and an explicit successful target-ref acknowledgement. Missing/malformed ACKs remain uncertain and enter original-operation reconciliation, without an extra HEAD request on the ordinary fully acknowledged path.

## Cancellation and failure

The helper has a private stdin control reader and four network workers plus two local-object workers per lane. Additional requests queue without a pending-count admission limit; a running worker grants input-body transfer. Queued and active requests remain cancellable. Individual cancellation marks only that request and shuts down only physical sockets still owned by it, including the transport beneath nested TLS. Ownership is rechecked before shutdown so a keep-alive socket reused by another owner cannot be cancelled by an earlier request. Separate local-object workers can continue already-hot immutable reads while network workers are occupied. Staged pack promotion rechecks cancellation under the promotion guard.

Each DNS lookup runs in a short-lived child receiving only host, port and address family over its pipe, with an allowlisted runtime environment and no repository token or proxy credentials. Cancellation kills that request's resolver child and its worker reaps it; loss of the parent pipe also ends the child. TCP connection waits are explicitly wakeable, and sockets are tracked before connecting or performing a TLS handshake. The transport sets no fixed deadline: it waits for completion, an actual failure, or cancellation. Cancellation returning to the caller does not mean every worker has finished cleanup or that credential bytes have been immediately erased from memory.

On stdin EOF, the helper interrupts outstanding operations and waits for its executors to drain. Pack parser workers are joined on completion or abort. A real helper crash invalidates its generations; a later operation starts a fresh lane. Original receipt metadata survives outside Python for remote recovery.

Once a push is in flight, cancellation is an UNKNOWN result until the original operation is reconciled. Closing a socket does not prove that the server rejected a write.

## Memory accounting and transport

The cleanup trigger is **40 MiB retained raw Git object contents per lane per repository/authority instance**, not Python process RSS, total application RAM, or a global cache. Replacements keep current commit/tree metadata and recently used bodies. Active snapshots and unknown writes retain their old generation until released/resolved. This is intentionally a soft bound while protected roots exist, including a single active object larger than the target.

Incoming compressed pack data is consumed through a 64 KiB window with backpressure and bounded decompression chunks, rather than retained as one whole compressed pack. Expanded objects and unresolved delta inputs remain staged until the complete pack checksum, object decoding, declared lengths and pack structure are validated; only then are they atomically promoted, with cancellation rechecked. No default Dulwich spooled temporary files, object directories, disk mirror, OS RAM disk or disk fallback are used.

IPC carries metadata fragments and raw byte bodies in packets with at most 64 KiB of payload, without base64 body encoding. Pipe backpressure and worker input grants control transmission, not total payload size. There is no configured total pack, total IPC message or pending-request-count cap; packet framing and declared body lengths are still checked. These windows do not cap process memory: staged objects and delta work, complete TypeScript input/output buffers, assembled metadata, queued request state, live cache generations and allocator overhead still contribute to peak RAM.

TS preparation records are weakly owned by their original snapshots and operation objects, with a pruned weak scope index. Only unresolved publication metadata remains strongly retained until settlement. Released completed history is collectible; retained original operations remain replayable. These records are not counted as Git object bytes.

## Credentials, TLS and routing

Repository credentials come only from the existing approved provider and travel through the owned stdin pipe. They are not in argv, files, environment variables, persistent client headers, logs, or object contents. Each network request creates a token-bound client, reuses a credential-free connection pool, and explicitly clears client auth references afterward. Structured failures contain only fixed messages/classes; raw third-party errors and stderr are not exposed.

The helper retains the Host's existing proxy/CA selectors. It supports HTTP/HTTPS CONNECT proxies with configured authentication and explicit CA files/directories; TLS and hostname verification are required. Redirects and automatic HTTP retries are disabled. Native libcurl behavior is not assumed identical: NTLM/Kerberos proxies, SOCKS routing, complex NO_PROXY CIDR rules, OS-native trust differences, client certificate flows and untested enterprise proxy policies require a reviewed compatible adapter. Do not bypass them or silently switch to direct routing. No gitconfig or credential files are inspected.

### Fixed Host traffic and business lanes

The seven lazily activated lanes are `read`, `write`, `foreground-read`,
`foreground-write`, `refresh`, `host-poll`, and `host-poll-write`. The existing
one-second Host driver still owns its original timing and single-flight rules.
Its fixed state, Task and authority-directory discovery uses `host-poll`; same
round consumers retain one immutable H with separate snapshot wrappers. Reopened
Task/member scans use that lane without another HEAD observation. UI refresh keeps
its separate lane and is not joined to the Host cadence.

Only the existing due heartbeat tick uses `host-poll-write`. The 30-second due
check is unchanged. Registration, seat changes, disconnect, source initialization,
notification admission, actual observation actions and Cleaner writes stay on the
business writer. Resource observations are read-only. In Git mode the local
5/5/30 observation timing ledger is session memory, not a recurring Git write.

Selecting a poll snapshot does not donate a poll AsyncLocalStorage context to its
callback. Business work started there selects its original foreground/background
lanes. Publication always builds and pushes on the selected writer's actual
transport, even when its immutable base came from another lane. A writer missing
that H imports only the commit/tree metadata once. This can add a metadata request
for a cross-lane borrowed base, but not a fresh HEAD check or unrelated blob
transfer. A writer already holding H needs no import. Original prepared-operation
identity, expected-H CAS and unknown-outcome reconciliation remain unchanged.
Independent helpers and publications do not remove remote same-branch CAS
contention, network limits or shared CPU/memory pressure.

Host discovery uses its existing poll snapshot to observe the Recorder notice,
known Task family and exact working-directory entries. Git Cleaner deletes those
subtrees on the business writer, together with the existing Task retirement facts
in the same commit. It does not enumerate descendant files or inspect archive
and skill completion. A confirmed commit returns without another readback or
resource-release wait; Host resource release proceeds separately. Original
UNKNOWN reconciliation and actual conflict/dependency checks remain in place.
The borrowed snapshot does not merge the poll and writer transports.

The default growth trigger remains 40 MiB per lane, not a hard RAM cap. A lane's
helper starts only when used. Generation replacement protects live snapshots,
active operations and unresolved publications; closing/changing authority drains
all seven lanes. No memory-saving fallback merges lanes or switches Dulwich to
Native Git.
