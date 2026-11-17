import { win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EXACT_FILE_OPEN_POLICY } from './exact-file.mjs';
import { fileOpen } from './win32-file-signatures.mjs';

const FILE_ID_INFO = 18;
const FILE_DISPOSITION_INFO = 4;
const invalid = message => Object.assign(new Error(message), { code: 'EWIN32CONTRACT', retainRecoveryEvidence: true });

// Buffers have explicit Windows fixed-width layouts, not host C long layouts.
export const layouts = Object.freeze({ basicBytes: 52, idBytes: 24, dispositionBytes: 1, readCountBytes: 4 });
export const bindingSpecs = Object.freeze({
  CreateFileW: ['intptr', ['str16', 'uint32_t', 'uint32_t', 'void *', 'uint32_t', 'uint32_t', 'intptr']],
  ReadFile: ['int', ['intptr', 'void *', 'uint32_t', 'void *', 'void *']],
  GetFileInformationByHandle: ['int', ['intptr', 'void *']],
  GetFileInformationByHandleEx: ['int', ['intptr', 'int', 'void *', 'uint32_t']],
  SetFileInformationByHandle: ['int', ['intptr', 'int', 'void *', 'uint32_t']],
  CloseHandle: ['int', ['intptr']],
  GetLastError: ['uint32_t', []],
});

export const storageBindingSpecs = Object.freeze({
  WriteFile: ['int', ['intptr', 'void *', 'uint32_t', 'void *', 'void *']],
  FlushFileBuffers: ['int', ['intptr']],
  ReplaceFileW: ['int', ['str16', 'str16', 'str16', 'uint32_t', 'void *', 'void *']],
  MoveFileExW: ['int', ['str16', 'str16', 'uint32_t']],
});
export function bindWindowsStorageFunctions(kernel32) {
  return { ...bindWindowsFunctions(kernel32), ...Object.fromEntries(Object.entries(storageBindingSpecs)
    .map(([name, [result, args]]) => [name, kernel32.func('__stdcall', name, result, args)])) };
}

/** These checks use Koffi type metadata only; they call no Windows function. */
export function verifyKoffiLayouts(koffi) {
  const time = koffi.struct({ low: 'uint32_t', high: 'uint32_t' });
  const basic = koffi.struct({ attributes: 'uint32_t', creation: time, access: time, write: time,
    volume: 'uint32_t', sizeHigh: 'uint32_t', sizeLow: 'uint32_t', links: 'uint32_t', indexHigh: 'uint32_t', indexLow: 'uint32_t' });
  const id = koffi.struct({ volume: 'uint64_t', id: koffi.array('uint8_t', 16) });
  const disposition = koffi.struct({ deleteFile: 'uint8_t' });
  const actual = {
    basicBytes: koffi.sizeof(basic), idBytes: koffi.sizeof(id), dispositionBytes: koffi.sizeof(disposition),
    readCountBytes: koffi.sizeof('uint32_t'), pointerBytes: koffi.sizeof('intptr'), boolBytes: koffi.sizeof('int'),
    writeOffset: koffi.offsetof(basic, 'write'), sizeHighOffset: koffi.offsetof(basic, 'sizeHigh'),
    sizeLowOffset: koffi.offsetof(basic, 'sizeLow'), linksOffset: koffi.offsetof(basic, 'links'), idOffset: koffi.offsetof(id, 'id'),
  };
  const expected = { ...layouts, pointerBytes: actual.pointerBytes, boolBytes: 4,
    writeOffset: 20, sizeHighOffset: 32, sizeLowOffset: 36, linksOffset: 40, idOffset: 8 };
  if (![4, 8].includes(actual.pointerBytes) || !isDeepStrictEqual(actual, expected))
    throw invalid('Koffi Windows structure layout assumptions do not match');
  return Object.freeze(actual);
}

/** Can be exercised with a fake library without loading a native DLL. */
export function bindWindowsFunctions(kernel32) {
  return Object.fromEntries(Object.entries(bindingSpecs).map(([name, [result, args]]) =>
    [name, kernel32.func('__stdcall', name, result, args)]));
}

export function checkedWindowsPath(path, { directory = false } = {}) {
  if (typeof path !== 'string' || path.includes('\0')) throw invalid('A non-NUL local absolute file path is required');
  const plain = path.startsWith('\\\\?\\') ? path.slice(4) : path;
  // Initial supported route is a drive-rooted local file, not a device, ADS or UNC share.
  if (!/^[a-zA-Z]:[\\/]/.test(plain) || plain.slice(2).includes(':') || !directory && /[\\/]$/.test(plain)
    || plain.slice(3).split(/[\\/]/).some(part => part === '.' || part === '..'))
    throw invalid('Unsupported Windows path form; source retained');
  return win32.toNamespacedPath(plain);
}

function validNativeHandle(handle) {
  return typeof handle === 'bigint' ? handle !== 0n && handle !== -1n
    : typeof handle === 'number' && Number.isSafeInteger(handle) && handle !== 0 && handle !== -1;
}

/** A normalized synchronous native API; callers may safely await its results. */
export function createWindowsFileApiFromBindings(native) {
  for (const name of Object.keys(bindingSpecs)) if (typeof native[name] !== 'function') throw invalid(`Missing binding ${name}`);
  const handles = new WeakMap();
  function nativeFailure(operation) {
    // No await, logging, allocation of buffers, or second native API before this.
    const win32Code = native.GetLastError();
    const code = ({ 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 6: 'EBADF', 32: 'EBUSY', 33: 'EBUSY', 50: 'ENOTSUP', 87: 'EINVAL' })[win32Code] ?? 'EWIN32';
    return Object.assign(new Error(`${operation} failed (Win32 ${win32Code})`), { code, operation, win32Code, retainRecoveryEvidence: true });
  }
  function success(result, operation) {
    if (result === 0) throw nativeFailure(operation);
    if (typeof result !== 'number' || !Number.isInteger(result)) throw invalid(`${operation} returned a non-BOOL value`);
  }
  function held(token) {
    const entry = token && typeof token === 'object' ? handles.get(token) : undefined;
    if (!entry) throw invalid('Unknown file HANDLE token');
    if (entry.closeAttempted) throw entry.closeError ?? invalid('File HANDLE is already closed');
    return entry;
  }
  function openWith(path, access, share, creation, flags, directory = false) {
    const handle = native.CreateFileW(checkedWindowsPath(path, { directory }), access, share, null, creation, flags, 0);
    if (handle === -1 || handle === -1n) throw nativeFailure('CreateFileW');
    if (!validNativeHandle(handle)) throw invalid('CreateFileW returned an invalid HANDLE representation');
    const token = Object.freeze({}); handles.set(token, { handle, closeAttempted: false, role: directory ? 'directory' : creation === 1 ? 'new' : 'legacy' }); return token;
  }
  function storageCall(name, ...args) {
    if (typeof native[name] !== 'function') throw invalid(`Missing storage binding ${name}`);
    success(native[name](...args), name);
  }
  return Object.freeze({
    // Directory handles pin ancestor names by omitting FILE_SHARE_DELETE.
    openDirectory(path) { return openWith(path, 0x80, 3, 3, 0x02200000, true); },
    // Only legacy replacement may share delete, to permit ReplaceFileW. Reads
    // and validation still use this handle; a held writer cannot coexist.
    openLegacy(path) { return openWith(path, 0x80000000, 5, 3, 0x00200000); },
    // CREATE_NEW must never truncate an existing source or recovery artifact.
    createNew(path) { return openWith(path, 0xC0010000, 1, 1, 0x00200000); },
    write(token, bytes) {
      const entry = held(token), { handle } = entry;
      if (entry.role !== 'new') throw invalid('Write requires a newly created temporary file');
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 1024 * 1024) throw invalid('Write must be 1 byte to 1 MiB');
      const count = Buffer.alloc(4); storageCall('WriteFile', handle, bytes, bytes.length, count, null);
      const written = count.readUInt32LE(0);
      if (!written || written > bytes.length) throw invalid('WriteFile returned an invalid byte count');
      return written;
    },
    flush(token) { const entry = held(token); if (entry.role !== 'new') throw invalid('Flush requires a writable temporary file'); storageCall('FlushFileBuffers', entry.handle); },
    replace(path, replacement, backup) {
      // No unsupported REPLACEFILE_WRITE_THROUGH or ACL-ignore flag.
      storageCall('ReplaceFileW', checkedWindowsPath(path), checkedWindowsPath(replacement), checkedWindowsPath(backup), 0, null, null);
    },
    moveNew(source, target) {
      // No REPLACE_EXISTING: unknown destination bytes are never overwritten.
      storageCall('MoveFileExW', checkedWindowsPath(source), checkedWindowsPath(target), 8);
    },
    open(path, policy) {
      if (!isDeepStrictEqual(policy, EXACT_FILE_OPEN_POLICY)) throw invalid('Exact-file open policy cannot be weakened');
      const nativePath = checkedWindowsPath(path);
      const handle = native.CreateFileW(nativePath, fileOpen.desiredAccess, fileOpen.shareMode, null,
        fileOpen.creationDisposition, fileOpen.flagsAndAttributes, 0);
      if (handle === -1 || handle === -1n) throw nativeFailure('CreateFileW');
      if (!validNativeHandle(handle)) throw invalid('CreateFileW returned an invalid HANDLE representation');
      const token = Object.freeze({}); handles.set(token, { handle, closeAttempted: false, role: 'exact' }); return token;
    },
    info(token) {
      const { handle } = held(token), basic = Buffer.alloc(layouts.basicBytes), id = Buffer.alloc(layouts.idBytes);
      success(native.GetFileInformationByHandle(handle, basic), 'GetFileInformationByHandle');
      success(native.GetFileInformationByHandleEx(handle, FILE_ID_INFO, id, id.length), 'GetFileInformationByHandleEx');
      const attributes = basic.readUInt32LE(0);
      return Object.freeze({ kind: attributes & 0x10 ? 'directory' : attributes & 0x40 ? 'device' : 'file',
        reparse: !!(attributes & 0x400), links: basic.readUInt32LE(40),
        volumeId: id.readBigUInt64LE(0).toString(16).padStart(16, '0'), fileId: id.subarray(8, 24).toString('hex'),
        size: (BigInt(basic.readUInt32LE(32)) << 32n) | BigInt(basic.readUInt32LE(36)),
        writeTime: basic.readBigUInt64LE(20) });
    },
    read(token, requested) {
      const { handle } = held(token);
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > 1024 * 1024) throw invalid('Read request is outside the 1 MiB per-call bound');
      const data = Buffer.alloc(requested), count = Buffer.alloc(layouts.readCountBytes);
      const result = native.ReadFile(handle, data, requested, count, null);
      if (result === 0) {
        const failure = nativeFailure('ReadFile');
        if (failure.win32Code === 38) return Buffer.alloc(0); // ERROR_HANDLE_EOF
        throw failure;
      }
      success(result, 'ReadFile');
      const read = count.readUInt32LE(0); if (read > requested) throw invalid('ReadFile exceeded its output buffer');
      return data.subarray(0, read);
    },
    disposition(token, options) {
      const entry = held(token);
      if (entry.role !== 'exact') throw invalid('Disposition requires an exact-file HANDLE');
      if (!isDeepStrictEqual(options, { deleteFile: true })) throw invalid('Only explicit file disposition is supported');
      if (entry.dispositionAttempted) {
        if (entry.dispositionError) throw entry.dispositionError;
        return;
      }
      const data = Buffer.from([1]); entry.dispositionAttempted = true;
      try { success(native.SetFileInformationByHandle(entry.handle, FILE_DISPOSITION_INFO, data, layouts.dispositionBytes), 'SetFileInformationByHandle'); }
      catch (error) { entry.dispositionError = error; throw error; }
    },
    close(token) {
      const entry = token && typeof token === 'object' ? handles.get(token) : undefined;
      if (!entry) throw invalid('Unknown file HANDLE token');
      if (entry.closeAttempted) { if (entry.closeError) throw entry.closeError; return; }
      entry.closeAttempted = true;
      try { success(native.CloseHandle(entry.handle), 'CloseHandle'); }
      catch (error) { entry.closeError = error; throw error; }
    },
  });
}

/** The platform check occurs before importing Koffi or loading kernel32. */
export async function loadWindowsFileApi({ importKoffi = () => import('koffi') } = {}) {
  if (process.platform !== 'win32') throw Object.assign(new Error('Native Windows file API is unavailable on this platform'), { code: 'ENOTSUP' });
  const module = await importKoffi(), koffi = module.default ?? module;
  const layout = verifyKoffiLayouts(koffi);
  const api = createWindowsFileApiFromBindings(bindWindowsStorageFunctions(koffi.load('kernel32.dll')));
  return Object.freeze({ api, layout, koffiVersion: koffi.version });
}
