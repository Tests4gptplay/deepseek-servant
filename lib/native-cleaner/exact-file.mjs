import { isDeepStrictEqual, promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';
import { constants as bufferConstants } from 'node:buffer';

const decodeZstd = promisify(zstdDecompress);

// Exact held-object protocol. The injected API owns native ABI/error conversion.
// No platform loading or namespace durability claim is made by this module.
export const EXACT_FILE_OPEN_POLICY = Object.freeze({
  existingOnly: true, read: true, deleteAccess: true, noFollowFinalReparse: true,
  shareRead: true, shareWrite: false, shareDelete: false, deleteOnClose: false,
});

const refusal = message => Object.assign(new Error(message), { code: 'EEXACTREFUSED' });
function evidenceError(cause, dispositionState) {
  return Object.assign(new Error(cause.message, { cause }), {
    code: cause.code ?? 'EEXACTFILE', dispositionState,
    retainRecoveryEvidence: true,
  });
}
function identity(info) {
  if (!info || info.kind !== 'file' || info.reparse || info.links !== 1)
    throw refusal('Object is not an ordinary single-link file');
  if (typeof info.volumeId !== 'string' || !info.volumeId || typeof info.fileId !== 'string' || !info.fileId)
    throw refusal('Native object identity is unavailable');
  if (typeof info.size !== 'bigint' || info.size < 0n || typeof info.writeTime !== 'bigint')
    throw refusal('Native file metadata is unavailable');
  return Object.freeze({ volumeId: info.volumeId, fileId: info.fileId,
    size: info.size, writeTime: info.writeTime });
}
function assertUnchanged(current, expected) {
  if (!isDeepStrictEqual(current, expected)) throw refusal('Held file changed after validation');
}
function parseJson(bytes) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function validateBound(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit === Number.MAX_SAFE_INTEGER) throw new RangeError('A positive byte limit is required');
}

async function readChunk(api, handle, requested) {
  const chunk = await api.read(handle, requested);
  if (!Buffer.isBuffer(chunk) || chunk.length > requested)
    throw refusal('Read provider violated its bounded-read contract');
  return chunk;
}

// Read exactly the official independent header frame, leaving event frames unread.
// Node's public decoder supplies payload/checksum and resource-limit validation.
async function readZstdHeader(api, handle, { chunkBytes }) {
  const parts = []; let length = 0;
  const take = async count => {
    const chunks = []; let remaining = count;
    while (remaining) {
      const chunk = await readChunk(api, handle, Math.min(chunkBytes, remaining));
      if (!chunk.length) throw refusal('Truncated or missing Zstandard header frame');
      chunks.push(chunk); parts.push(chunk); length += chunk.length; remaining -= chunk.length;
    }
    return Buffer.concat(chunks, count);
  };
  const prefix = await take(5);
  if (prefix.readUInt32LE(0) !== 0xfd2fb528) throw refusal('Invalid Zstandard frame magic');
  const descriptor = prefix[4];
  if (descriptor & 0x18) throw refusal('Reserved Zstandard frame header bits');
  const single = !!(descriptor & 0x20), sizeFlag = descriptor >>> 6, dictionary = descriptor & 3;
  await take((single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary)
    + (sizeFlag ? 1 << sizeFlag : single ? 1 : 0));
  for (;;) {
    const block = (await take(3)).readUIntLE(0, 3), type = (block >>> 1) & 3;
    if (type === 3) throw refusal('Reserved Zstandard block type');
    await take(type === 1 ? 1 : block >>> 3);
    if (block & 1) break;
  }
  if (descriptor & 4) await take(4);
  const plain = await decodeZstd(Buffer.concat(parts, length));
  if (!plain.length || plain.indexOf(10) !== plain.length - 1)
    throw refusal('Zstandard header frame must contain exactly one complete JSONL line');
  return parseJson(plain.subarray(0, -1));
}

async function readJson(api, handle, { mode, maxBytes, chunkBytes }) {
  if (mode === 'cache') validateBound(maxBytes); validateBound(chunkBytes);
  let length = 0; const parts = [];
  // Cache byte length and decoded string length have different units. Decode
  // incrementally so a multibyte document need not also be concatenated into
  // another full Buffer; only the runtime's actual string ceiling applies.
  const decoder = mode === 'cache' ? new TextDecoder('utf-8', { fatal: true }) : undefined;
  let codeUnits = 0;
  const appendText = text => {
    codeUnits += text.length;
    if (codeUnits > bufferConstants.MAX_STRING_LENGTH) throw refusal('JSON text exceeds the runtime string length limit');
    parts.push(text);
  };
  for (;;) {
    // The extra byte establishes overflow; for JSONL it can be the delimiter.
    const requested = mode === 'cache' ? Math.min(chunkBytes, maxBytes + 1 - length) : chunkBytes;
    const chunk = await readChunk(api, handle, requested);
    if (!chunk.length) {
      if (mode === 'jsonl') throw refusal('Missing complete header line');
      appendText(decoder.decode());
      return JSON.parse(parts.join(''));
    }
    const end = mode === 'jsonl' ? chunk.indexOf(10) : -1;
    const consumed = end < 0 ? chunk : chunk.subarray(0, end);
    length += consumed.length;
    if (mode === 'cache' && length > maxBytes) throw refusal('JSON input exceeds the configured byte limit');
    if (decoder) appendText(decoder.decode(consumed, { stream: true }));
    else parts.push(consumed);
    if (end >= 0) return parseJson(Buffer.concat(parts, length));
  }
}

export async function readSessionHeader(api, handle, compressed, chunkBytes = 8192) {
  validateBound(chunkBytes);
  return compressed ? readZstdHeader(api, handle, { chunkBytes })
    : readJson(api, handle, { mode: 'jsonl', chunkBytes });
}

/**
 * api.open(path, policy), info(HANDLE), read(HANDLE, maxBytes),
 * disposition(HANDLE, {deleteFile:true}), close(HANDLE).
 * All methods may be async. Native failures must throw with captured errors.
 * The caller already holds the cooperating session lease and recovery marker.
 */
export async function prepareExactFile(api, path, {
  mode, maxBytes, chunkBytes = 8192, validate, expectedIdentity,
} = {}) {
  if (!['jsonl', 'jsonl-zstd', 'cache'].includes(mode)) throw evidenceError(refusal('Unsupported encoding; retain source'), 'not-requested');
  if (typeof validate !== 'function') throw evidenceError(refusal('Identity validator is required'), 'not-requested');
  if (mode === 'cache') validateBound(maxBytes); validateBound(chunkBytes);
  let handle, acquired = false;
  let nativeClosePromise;
  const closeNative = () => nativeClosePromise ??= Promise.resolve().then(() => api.close(handle));
  try {
    handle = await api.open(path, EXACT_FILE_OPEN_POLICY); acquired = true;
    const initial = identity(await api.info(handle));
    if (expectedIdentity) assertUnchanged(initial, expectedIdentity);
    if (mode === 'cache' && initial.size > BigInt(maxBytes)) throw refusal('Cache document exceeds the configured byte limit');
    const document = mode === 'jsonl-zstd'
      ? await readZstdHeader(api, handle, { chunkBytes })
      : await readJson(api, handle, { mode, maxBytes, chunkBytes });
    if (await validate(document) !== true) throw refusal('Header or cache lifecycle did not match');
    assertUnchanged(identity(await api.info(handle)), initial);
    let phase = 'prepared', dispositionState = 'not-requested';
    let deletionPromise, closePromise;
    return Object.freeze({
      identity: initial,
      // This must not be interpreted as completed cleanup or durable absence.
      deleteExact() {
        if (deletionPromise) return deletionPromise;
        if (phase !== 'prepared') return Promise.reject(evidenceError(refusal('File lease is closed'), dispositionState));
        phase = 'deleting';
        deletionPromise = (async () => {
          let failure;
          try {
            assertUnchanged(identity(await api.info(handle)), initial);
            dispositionState = 'attempted';
            await api.disposition(handle, { deleteFile: true });
            dispositionState = 'requested';
          } catch (error) { failure = error; }
          try { await closeNative(); }
          catch (cleanup) { failure = failure ? new AggregateError([failure, cleanup], 'Exact operation and handle close failed') : cleanup; }
          phase = 'closed';
          if (failure) throw evidenceError(failure, dispositionState);
          return Object.freeze({ status: 'disposition-requested', identity: initial,
            retainRecoveryEvidence: true, namespaceDurability: 'unverified' });
        })();
        return deletionPromise;
      },
      close() {
        if (closePromise) return closePromise;
        if (!deletionPromise) phase = 'closed';
        // A concurrent close never invalidates an in-flight check/disposition.
        const settled = deletionPromise ? deletionPromise.then(() => {}, () => {}) : Promise.resolve();
        closePromise = settled.then(closeNative).catch(error => { throw evidenceError(error, dispositionState); });
        return closePromise;
      },
    });
  } catch (error) {
    let failure = error;
    if (acquired) try { await closeNative(); }
    catch (cleanup) { failure = new AggregateError([error, cleanup], 'Exact validation and handle close failed'); }
    throw evidenceError(failure, 'not-requested');
  }
}

export function sessionHeaderMatches(actual, expected) {
  if (!actual || actual.type !== 'session' || !expected || typeof expected.id !== 'string' || !expected.id) return false;
  if (!Number.isSafeInteger(expected.version) || expected.version < 0 || !Number.isFinite(expected.createdAt)) return false;
  const fields = h => ({ id: h.id, version: h.version, createdAt: h.createdAt, cwd: h.cwd,
    parentSession: h.parentSession, isSeeded: h.isSeeded ?? false,
    delegationDepth: h.delegationDepth ?? 0, agentPreset: h.agentPreset });
  return isDeepStrictEqual(fields(actual), fields(expected));
}
