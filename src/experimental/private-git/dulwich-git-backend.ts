import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gitRuntimeEnvironment } from './git-runtime-environment.js'
import type { GitCommandOptions } from './git-object-backend.js'
import { GitBackendError, type GitBackendErrorKind, type GitBackendFailureDetails, type GitObjectBackend, type GitObjectCommand } from './git-object-backend.js'

export interface DulwichGitOptions {
  /** Existing supported Python/venv executable. Never install or find credentials. */
  pythonExecutable?: string
  helperPath?: string
  onHelperEvent?: (event: { status: 'started' | 'stopped'; pid?: number }) => void
}
interface Pending {
  discarded?: boolean
  resolve(value: unknown): void
  reject(error: unknown): void
  cleanup(): void
  acceptInput?: () => void
  json: Buffer[]
  body?: Buffer
  offset: number
}
// Transport window only. Any number of chunks may belong to one operation.
const CHUNK_BYTES = 64 * 1024
const HEADER_BYTES = 13
const JSON_PART = 74, JSON_END = 77, BYTES = 66, BYTES_END = 69, INPUT_READY = 65, CANCEL = 67
interface Packet { kind: number; id: number; body: Buffer; resolve(): void; reject(error: unknown): void }

/** A lane owns one resident process; retired stores are immutable generations in
 * that process. Killing/cancelling a helper never kills a different lane. */
class ResidentHelper {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<number, Pending>()
  private counter = 0
  private failure?: GitBackendError
  private incoming = Buffer.alloc(0)
  private outbound: Packet[] = []
  private pumping = false
  private handles = 0
  private ready?: Promise<void>
  private initialized = false
  private startingOwners = 0
  private stopped?: Promise<void>
  constructor(private readonly options: DulwichGitOptions) {}
  retain(): void { this.handles++ }
  private start(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.ready) return this.ready
    const env = gitRuntimeEnvironment(process.env)
    // -I ignores PYTHONPATH/user site; -B prevents .pyc writes. No shell, secret
    // arguments, credential files, object directories or disk fallback.
    const child = this.child = spawn(this.options.pythonExecutable ?? (process.platform === 'win32' ? 'python' : 'python3'),
      ['-I', '-B', this.options.helperPath ?? fileURLToPath(new URL('./dulwich-helper.py', import.meta.url))],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.stopped = new Promise(resolve => child.once('close', () => resolve()))
    child.on('error', () => this.fail(new GitBackendError('fatal', 'Memory Git helper could not start. Check the configured Python and the required Dulwich and urllib3 packages.')))
    child.on('close', () => {
      this.fail(new GitBackendError('fatal', this.initialized
        ? 'Memory Git helper stopped. Obtain a fresh snapshot; unresolved writes must be reconciled with their original operation.'
        : 'Memory Git helper startup failed. Check Python and the Dulwich and urllib3 packages in the configured environment.'))
      try { this.options.onHelperEvent?.({ status: 'stopped', pid: child.pid }) } catch { /* Diagnostics cannot change lifecycle. */ }
    })
    child.stdin.on('error', () => this.fail(new GitBackendError('fatal', 'Memory Git helper input closed.')))
    // Dependency stderr may contain headers or credentials. Drain and discard.
    child.stderr.resume()
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    try { this.options.onHelperEvent?.({ status: 'started', pid: child.pid }) } catch { /* Diagnostics cannot change lifecycle. */ }
    this.ready = this.send({ op: 'hello' }).then(() => { this.initialized = true })
    return this.ready
  }
  private fail(error: GitBackendError): void {
    if (this.failure) return
    this.failure = error
    this.child?.kill('SIGKILL')
    for (const pending of this.pending.values()) {
      pending.cleanup(); pending.acceptInput?.(); pending.reject(error)
    }
    for (const packet of this.outbound) packet.reject(error)
    this.pending.clear(); this.outbound = []; this.incoming = Buffer.alloc(0)
  }
  private finish(id: number, pending: Pending, response?: { result?: unknown; error?: { kind: GitBackendErrorKind; message: string } & GitBackendFailureDetails }): void {
    this.pending.delete(id); pending.cleanup(); pending.acceptInput?.()
    if (pending.discarded) return
    if (response?.error) pending.reject(new GitBackendError(response.error.kind, response.error.message, response.error))
    else pending.resolve(pending.body ?? response?.result)
  }
  private receive(chunk: Buffer): void {
    if (this.failure) return
    this.incoming = Buffer.concat([this.incoming, chunk])
    try {
      while (this.incoming.length >= HEADER_BYTES) {
        const kind = this.incoming[0]!, identity = this.incoming.readBigUInt64BE(1), size = this.incoming.readUInt32BE(9)
        if (identity > BigInt(Number.MAX_SAFE_INTEGER) || size > CHUNK_BYTES) throw new Error('Invalid packet header')
        if (this.incoming.length < HEADER_BYTES + size) return
        const id = Number(identity), body = this.incoming.subarray(HEADER_BYTES, HEADER_BYTES + size)
        this.incoming = this.incoming.subarray(HEADER_BYTES + size)
        const pending = this.pending.get(id)
        if (!pending) throw new Error('Unexpected response identity')
        if (kind === INPUT_READY) {
          if (size || !pending.acceptInput) throw new Error('Unexpected input grant')
          const accept = pending.acceptInput; pending.acceptInput = undefined; accept()
        } else if (kind === JSON_PART || kind === JSON_END) {
          pending.json.push(Buffer.from(body))
          if (kind !== JSON_END) continue
          const response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pending.json)))
          pending.json = []
          if (response.bytes !== undefined) {
            if (!Number.isSafeInteger(response.bytes) || response.bytes < 0 || pending.body) throw new Error('Invalid byte result')
            if (!pending.discarded) {
              try { pending.body = Buffer.allocUnsafe(response.bytes) }
              catch (error) { pending.discarded = true; pending.reject(error) }
            }
            pending.offset = response.bytes
          } else this.finish(id, pending, response)
        } else if (kind === BYTES) {
          if (size > pending.offset) throw new Error('Byte result exceeded its declared length')
          if (!pending.discarded) {
            if (!pending.body) throw new Error('Unexpected byte result')
            body.copy(pending.body, pending.body.length - pending.offset)
          }
          pending.offset -= size
        } else if (kind === BYTES_END) {
          if (size || pending.offset) throw new Error('Incomplete byte result')
          this.finish(id, pending)
        } else throw new Error('Unknown response packet')
      }
    } catch { this.fail(new GitBackendError('fatal', 'Memory Git helper returned an invalid response.')) }
  }
  private packet(kind: number, id: number, body: Buffer = Buffer.alloc(0)): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const packet = { kind, id, body, resolve, reject }
      // Cancel controls can pass queued data, but never split a physical packet.
      if (kind === CANCEL) this.outbound.unshift(packet)
      else this.outbound.push(packet)
      void this.pump()
    })
  }
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.outbound.length && !this.failure) {
        const packet = this.outbound.shift()!
        const header = Buffer.allocUnsafe(HEADER_BYTES)
        header[0] = packet.kind; header.writeBigUInt64BE(BigInt(packet.id), 1); header.writeUInt32BE(packet.body.length, 9)
        try {
          // At most one window is encoded/in flight. The callback waits until
          // the pipe consumes it; producers cannot build an unbounded write queue.
          await new Promise<void>((resolve, reject) => this.child!.stdin.write(Buffer.concat([header, packet.body]), error => error ? reject(error) : resolve()))
          packet.resolve()
        } catch (error) { packet.reject(error); this.fail(new GitBackendError('fatal', 'Memory Git helper input failed.')) }
      }
    } finally { this.pumping = false }
  }
  private send(message: Record<string, unknown>, signal?: AbortSignal, input?: Buffer): Promise<unknown> {
    signal?.throwIfAborted()
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.counter
    return new Promise((resolve, reject) => {
      let acceptInput: (() => void) | undefined
      const accepted = input === undefined ? undefined : new Promise<void>(resolve => { acceptInput = resolve })
      const abort = () => {
        const pending = this.pending.get(id)
        if (!pending || pending.discarded) return
        pending.discarded = true; pending.cleanup()
        void this.packet(CANCEL, id).catch(() => {})
        pending.reject(signal!.reason ?? new DOMException('Memory Git operation cancelled.', 'AbortError'))
      }
      const cleanup = () => signal?.removeEventListener('abort', abort)
      const pending: Pending = { resolve, reject, cleanup, acceptInput, json: [], offset: 0 }
      this.pending.set(id, pending)
      signal?.addEventListener('abort', abort, { once: true })
      const transmit = async () => {
        const metadata = Buffer.from(JSON.stringify({ ...message, ...(input === undefined ? {} : { inputBytes: input.length }) }), 'utf8')
        for (let offset = 0; offset < metadata.length; offset += CHUNK_BYTES) {
          const end = Math.min(metadata.length, offset + CHUNK_BYTES)
          await this.packet(end === metadata.length ? JSON_END : JSON_PART, id, metadata.subarray(offset, end))
        }
        if (accepted) {
          await accepted
          if (this.failure) throw this.failure
          for (let offset = 0; offset < input!.length && !pending.discarded; offset += CHUNK_BYTES) {
            await this.packet(BYTES, id, input!.subarray(offset, offset + CHUNK_BYTES))
          }
          await this.packet(BYTES_END, id)
        }
      }
      void transmit().catch(error => {
        this.pending.delete(id); cleanup(); reject(error)
      })
      if (signal?.aborted) abort()
    })
  }
  async ensureReady(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.startingOwners++
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal!.reason)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        void this.start().then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
      })
      signal?.throwIfAborted()
    } finally {
      this.startingOwners--
      if (!this.initialized && !this.startingOwners && signal?.aborted) this.fail(new GitBackendError('cancelled', 'Memory Git startup was cancelled by its last waiting owner.'))
    }
  }
  async request(message: Record<string, unknown>, signal?: AbortSignal, input?: Buffer): Promise<unknown> {
    await this.ensureReady(signal)
    return this.send(message, signal, input)
  }
  async release(store: number): Promise<void> {
    if (--this.handles > 0) {
      if (!this.failure && this.child) await this.request({ op: 'release', store }).catch(() => {})
      return
    }
    this.fail(new GitBackendError('fatal', 'Memory Git helper was released.'))
    await this.stopped
  }
}

export class DulwichGitBackend implements GitObjectBackend {
  private closed = false
  private readonly helper: ResidentHelper
  private readonly store: number
  constructor(options: DulwichGitOptions = {}, owned?: { helper: ResidentHelper; store: number }) {
    this.helper = owned?.helper ?? new ResidentHelper(options)
    this.store = owned?.store ?? 0
    this.helper.retain()
  }
  get lifetime(): object { return this.helper }
  private call(message: Record<string, unknown>, signal?: AbortSignal, input?: Buffer): Promise<unknown> {
    if (this.closed) return Promise.reject(new GitBackendError('fatal', 'Memory Git generation was released.'))
    return this.helper.request({ ...message, store: this.store }, signal, input)
  }
  async ready(signal: AbortSignal): Promise<void> {
    if (this.closed) throw new GitBackendError('fatal', 'Memory Git generation was released.')
    await this.helper.ensureReady(signal)
  }
  async execute(command: GitObjectCommand, options: GitCommandOptions): Promise<Buffer> {
    return await this.call({ op: 'execute', command, token: options.token, fixture: !!options.fixtureTransport },
      options.signal, options.input === undefined ? undefined : Buffer.from(options.input)) as Buffer
  }
  async storageBytes(): Promise<number> { return await this.call({ op: 'storageBytes' }) as number }
  async replacement(roots: readonly { head: string; tree?: string }[], signal: AbortSignal, retainedBlobIds?: ReadonlySet<string>) {
    const result = await this.call({ op: 'replacement', roots, blobs: [...retainedBlobIds ?? []] }, signal) as {
      store: number; objects: number; packBytes: number; rawBytes: number; roots: { head: string; tree: string }[]
    }
    return { ...result, transport: new DulwichGitBackend({}, { helper: this.helper, store: result.store }) }
  }
  async release(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.helper.release(this.store)
  }
}
