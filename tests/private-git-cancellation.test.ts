import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { GitHubClient, GitHubError } from '../src/experimental/private-git/github.js'
import { CoopCredentials, ghToken } from '../src/experimental/private-git/credentials.js'

const token = async () => ({ value: 'synthetic-fixture-only', source: 'fixture' })

test('caller cancellation reaches pending token acquisition before HTTP and a new explicit epoch remains usable', async () => {
  const owner = new AbortController()
  let sourceSignal: AbortSignal | undefined, httpCalls = 0, release!: () => void
  const ready = Promise.withResolvers<void>()
  const client = new GitHubClient(async signal => {
    sourceSignal = signal; ready.resolve()
    await new Promise<void>((resolve, reject) => {
      release = resolve
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    return token()
  }, async () => { httpCalls++; return Response.json({ ok: true }) }, { signal: owner.signal })
  const pending = client.session(session => session.request('GET', '/user'))
  const outcome = pending.then(() => 'resolved', error => error)
  try {
    await ready.promise
    assert.ok(sourceSignal, 'the actual operation owner signal reaches tokenSource')
    owner.abort()
    assert.equal((await outcome).name, 'AbortError')
    assert.equal(httpCalls, 0)
    client.cancel()
    const resumed = client.session(session => session.request('GET', '/user'))
    await Promise.resolve(); release()
    assert.deepEqual(await resumed, { ok: true }, 'explicit cleanup epoch does not inherit cancelled opening signal')
  } finally { client.cancel(); release(); await outcome }
})

test('already-cancelled caller does not start credential acquisition or HTTP', async () => {
  const owner = new AbortController(); owner.abort()
  let reads = 0, calls = 0
  const client = new GitHubClient(async () => { reads++; return token() }, async () => { calls++; return Response.json({}) }, { signal: owner.signal })
  await assert.rejects(client.session(session => session.request('GET', '/user')), { name: 'AbortError' })
  assert.equal(reads, 0); assert.equal(calls, 0)
})

test('credentials preserve cancellation instead of converting it to missing login', async () => {
  const owner = new AbortController()
  let observed: AbortSignal | undefined, reads = 0
  const credentials = new CoopCredentials(async signal => {
    observed = signal; reads++
    owner.abort()
    return undefined
  })
  await assert.rejects(credentials.resolve(owner.signal), { name: 'AbortError' })
  assert.equal(observed, owner.signal)
  await assert.rejects(credentials.resolve(owner.signal), { name: 'AbortError' })
  assert.equal(reads, 1, 'pre-aborted credentials never invoke CLI')
})

for (const explicitReason of [false, true]) for (const phase of ['headers', 'body', 'error-body'] as const) test('actual Node fetch cancels stalled ' + phase + (explicitReason ? ' with exact owner reason' : '') + ' without affecting another client', { timeout: 5_000 }, async () => {
  const received = Promise.withResolvers<void>(), headers = Promise.withResolvers<void>()
  const server = createServer((_request, response) => {
    received.resolve()
    if (phase === 'headers') return
    response.writeHead(phase === 'error-body' ? 403 : 200, { 'content-type': 'application/json' })
    response.write('{"message":"'); response.flushHeaders()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const client = new GitHubClient(token, async (_url, init) => {
    const response = await fetch('http://127.0.0.1:' + port + '/', init)
    const read = response.json.bind(response)
    response.json = () => { headers.resolve(); return read() }
    return response
  })
  const independent = new GitHubClient(token, async (_url, init) => { assert.equal(init?.signal?.aborted, false); return Response.json({ independent: true }) })
  const pending = client.session(session => session.request('GET', '/user'))
  const outcome = pending.then(value => ({ value }), error => ({ error }))
  try {
    await Promise.race([received.promise, outcome.then(result => { throw 'error' in result ? result.error : new Error('Unexpected early response') })])
    if (phase !== 'headers') await headers.promise
    const reason = new DOMException('Connection owner withdrew this operation', 'AbortError')
    client.cancel(explicitReason ? reason : undefined)
    const result = await outcome
    assert.ok('error' in result); assert.equal(result.error.name, 'AbortError')
    if (explicitReason) assert.ok(result.error === reason || result.error.cause === reason, 'native fetch retains this exact owner cause, not merely an AbortError name')
    assert.deepEqual(await independent.session(session => session.request('GET', '/user')), { independent: true })
  } finally { client.cancel(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('progressing response uses only the actual owner signal, not a synthetic total deadline', { timeout: 5_000 }, async t => {
  const timeout = t.mock.method(AbortSignal, 'timeout', () => { throw new Error('No application total deadline is specified for this operation') })
  let ownerSignal: AbortSignal | undefined, chunks = 0
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"value":"')
    for (let i = 0; i < 4; i++) { await delay(5); response.write('x'); chunks++ }
    response.end('"}')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const client = new GitHubClient(async signal => { ownerSignal = signal; return token() }, (_url, init) => {
    assert.equal(init?.signal, ownerSignal, 'HTTP and credential acquisition have the same actual owner')
    return fetch('http://127.0.0.1:' + port + '/', init)
  })
  try {
    assert.deepEqual(await client.session(session => session.request('GET', '/user')), { value: 'xxxx' })
    assert.equal(chunks, 4); assert.equal(timeout.mock.callCount(), 0)
  } finally { client.cancel(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

for (const explicitReason of [false, true]) test('real ghToken execFile cancels only its own synthetic CLI child and does not expose its output' + (explicitReason ? ' with exact owner reason' : ''), { timeout: 8_000, skip: process.platform === 'win32' }, async () => {
  // A private executable on an isolated PATH, never the installed gh or account.
  const directory = await mkdtemp(join(tmpdir(), 'dss-gh-cancellation-'))
  const started = join(directory, 'started.json'), stopped = join(directory, 'stopped')
  const executable = join(directory, 'gh'), oldPath = process.env.PATH
  await writeFile(executable, '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopped)}, 'cancelled'); process.exit(0); });
fs.writeFileSync(${JSON.stringify(started)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('synthetic-output-never-a-real-token');
setTimeout(() => { fs.writeFileSync(${JSON.stringify(stopped)}, 'guard'); process.exit(0); }, 3000);
`)
  await chmod(executable, 0o700)
  const owner = new AbortController()
  async function waitFor(path: string) {
    const deadline = Date.now() + 5_000 // Isolated fixture guard, not a product timeout.
    while (Date.now() < deadline) { const content = await readFile(path, 'utf8').catch(() => undefined); if (content !== undefined) return content; await delay(5) }
    throw new Error('Synthetic CLI did not produce its lifecycle marker')
  }
  try {
    process.env.PATH = directory // No fallback to an installed gh executable.
    const pending = ghToken(owner.signal)
    const outcome = pending.then(value => ({ value }), error => ({ error }))
    assert.deepEqual(JSON.parse(await waitFor(started)), ['auth', 'token', '--hostname', 'github.com'])
    const reason = new DOMException('Credential acquisition owner withdrew this operation', 'AbortError')
    owner.abort(explicitReason ? reason : undefined)
    const result = await outcome
    assert.ok('error' in result, 'cancelled token acquisition must reject, not yield partial output')
    assert.equal(result.error.name, 'AbortError')
    if (explicitReason) assert.ok(result.error === reason || result.error.cause === reason, 'CLI cancellation preserves the exact owner cause')
    assert.equal(String(result.error).includes('synthetic-output-never-a-real-token'), false)
    assert.equal(await waitFor(stopped), 'cancelled', 'the real child_process signal handler ran')
  } finally {
    owner.abort()
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
    await waitFor(stopped)
    await rm(directory, { recursive: true, force: true })
  }
})

test('shared credentials do not share cancellation between two independent clients', async () => {
  const readers: Array<{ signal?: AbortSignal; resolve: (value: string) => void }> = []
  const credentials = new CoopCredentials(signal => new Promise((resolve, reject) => {
    readers.push({ signal, resolve })
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const calls: string[] = []
  const make = (name: string) => new GitHubClient(signal => credentials.resolve(signal), async () => { calls.push(name); return Response.json({ name }) })
  const first = make('closing'), second = make('independent')
  const closing = first.session(session => session.request('GET', '/user'))
  const independent = second.session(session => session.request('GET', '/user'))
  const rejected = assert.rejects(closing, { name: 'AbortError' })
  assert.equal(readers.length, 2)
  first.cancel(); await rejected
  assert.equal(readers[0]!.signal?.aborted, true)
  assert.equal(readers[1]!.signal?.aborted, false)
  readers[1]!.resolve('synthetic-independent')
  assert.deepEqual(await independent, { name: 'independent' })
  assert.deepEqual(calls, ['independent'])
})


test('independent transport AbortError is not reassigned to a later owner cancellation before catch runs', async () => {
  const independent = new DOMException('Independent transport abort, not this owner', 'AbortError')
  const owner = new DOMException('Later owner cancellation', 'AbortError')
  const client = new GitHubClient(token, () => {
    const failed = Promise.reject(independent)
    client.cancel(owner)
    return failed
  })
  await assert.rejects(client.session(session => session.request('GET', '/user')), error => {
    assert.notEqual(error, owner)
    assert.match(String(error), /Independent transport abort/)
    assert.equal((error as Error).cause, undefined, 'no fabricated owner cause')
    return true
  })
})


for (const status of [200, 403]) test('independent response body AbortError remains independent when owner aborts later: ' + status, async () => {
  const independent = new DOMException('Independent body abort, not this owner', 'AbortError')
  const owner = new DOMException('Later body owner cancellation', 'AbortError')
  const client = new GitHubClient(token, async () => {
    const response = Response.json({ message: 'not used' }, { status })
    response.json = () => {
      const failed = Promise.reject(independent)
      client.cancel(owner)
      return failed
    }
    return response
  })
  await assert.rejects(client.session(session => session.request('GET', '/user')), error => {
    assert.notEqual(error, owner)
    assert.match(String(error), /Independent body abort/)
    assert.notEqual((error as Error).cause, owner)
    return true
  })
})

for (const status of [200, 403]) test('independent body TypeError is not reassigned to a later owner cancellation: ' + status, async () => {
  const independent = new TypeError('Independent body transport failed')
  const owner = new Error('Later owner cancellation')
  const client = new GitHubClient(token, async () => {
    const response = Response.json({ message: 'not used' }, { status })
    response.json = () => {
      const failed = Promise.reject(independent)
      client.cancel(owner)
      return failed
    }
    return response
  })
  await assert.rejects(client.session(session => session.request('GET', '/user')), error => error === independent)
})

for (const body of ['', '<html>upstream unavailable</html>']) test('non-JSON error response preserves its actual HTTP status fallback: ' + JSON.stringify(body), async () => {
  const client = new GitHubClient(token, async () => new Response(body, { status: 503, statusText: 'Service Unavailable' }))
  await assert.rejects(client.session(session => session.request('GET', '/user')), error =>
    error instanceof GitHubError && error.status === 503 && error.message.includes('Service Unavailable'))
})

test('actual Node fetch body socket failure retains its TypeError before later owner cancellation', { timeout: 5_000 }, async () => {
  const socket = Promise.withResolvers<import('node:net').Socket>()
  const server = createServer((request, response) => {
    response.writeHead(403, { 'content-type': 'application/json' })
    response.write('{"message":"'); response.flushHeaders()
    socket.resolve(request.socket)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  let observed: unknown
  const owner = new Error('Later body owner cancellation')
  const client = new GitHubClient(token, async (_url, init) => {
    const response = await fetch('http://127.0.0.1:' + port + '/', init)
    const read = response.json.bind(response)
    response.json = () => {
      const pending = read().catch(error => {
        observed = error
        client.cancel(owner)
        throw error
      })
      void socket.promise.then(connection => connection.destroy()) // Only this test's accepted socket.
      return pending
    }
    return response
  })
  try {
    await assert.rejects(client.session(session => session.request('GET', '/user')), error => {
      assert.ok(observed instanceof TypeError, 'the failure was produced by actual native body consumption')
      assert.equal(error, observed)
      assert.notEqual(error, owner)
      return true
    })
  } finally { client.cancel(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('error response body retains a non-AbortError owner reason', async () => {
  const owner = new Error('Custom owner withdrawal')
  const client = new GitHubClient(token, async () => {
    const response = Response.json({ message: 'not used' }, { status: 403 })
    response.json = () => { client.cancel(owner); return Promise.reject(owner) }
    return response
  })
  await assert.rejects(client.session(session => session.request('GET', '/user')), error => error === owner)
})
