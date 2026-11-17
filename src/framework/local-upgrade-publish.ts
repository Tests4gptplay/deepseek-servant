import { isAbsolute, win32 } from 'node:path'
import { getSystemErrorName } from 'node:util'

export type UpgradePublish = (source: string, target: string) => Promise<'published' | 'exists'>
interface NativeLibrary { func(...signature: unknown[]): (...args: any[]) => number }
interface KoffiRuntime { load(name: string): NativeLibrary; errno(): number }

/** One same-volume rename without replacement. These are existing OS primitives,
 * not a store lock, copy fallback, hardlink requirement or resident service.
 * Kept separate from native-cleaner's ownership/locking protocol. */
export function bindUpgradePublish(runtime: KoffiRuntime, platform: NodeJS.Platform = process.platform): UpgradePublish {
  if (platform === 'win32') {
    const kernel = runtime.load('kernel32.dll')
    const move = kernel.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint32_t'])
    const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32_t', [])
    return async (source, target) => {
      if (!win32.isAbsolute(source) || !win32.isAbsolute(target) || source.includes('\0') || target.includes('\0')) throw new Error('Upgrade publication requires exact absolute paths.')
      // MOVEFILE_WRITE_THROUGH only. No REPLACE_EXISTING and no COPY_ALLOWED:
      // the already-complete sibling must move atomically on this same volume.
      if (move(win32.toNamespacedPath(source), win32.toNamespacedPath(target), 8)) return 'published'
      const errno = lastError()
      if (errno === 80 || errno === 183) return 'exists'
      throw Object.assign(new Error('MoveFileExW could not publish the prepared upgrade file (Win32 ' + errno + '). Its source was retained.'),
        { code: ({ 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 17: 'EXDEV', 32: 'EBUSY' } as Record<number, string>)[errno] ?? 'EWIN32', win32Code: errno })
    }
  }
  if (platform === 'linux') {
    const libc = runtime.load('libc.so.6')
    const rename = libc.func('renameat2', 'int', ['int', 'str', 'int', 'str', 'uint'])
    return async (source, target) => {
      if (!isAbsolute(source) || !isAbsolute(target) || source.includes('\0') || target.includes('\0')) throw new Error('Upgrade publication requires exact absolute paths.')
      if (rename(-100, source, -100, target, 1) === 0) return 'published' // AT_FDCWD, RENAME_NOREPLACE
      const errno = runtime.errno()
      if (errno === 17) return 'exists'
      throw Object.assign(new Error('renameat2 could not publish the prepared upgrade file (' + getSystemErrorName(-errno) + '). Its source was retained.'), { code: getSystemErrorName(-errno), errno })
    }
  }
  if (platform === 'darwin') {
    const system = runtime.load('/usr/lib/libSystem.B.dylib')
    const rename = system.func('renamex_np', 'int', ['str', 'str', 'uint'])
    return async (source, target) => {
      if (!isAbsolute(source) || !isAbsolute(target) || source.includes('\0') || target.includes('\0')) throw new Error('Upgrade publication requires exact absolute paths.')
      if (rename(source, target, 4) === 0) return 'published' // RENAME_EXCL, macOS 10.12+
      const errno = runtime.errno()
      if (errno === 17) return 'exists'
      throw Object.assign(new Error('renamex_np could not publish the prepared upgrade file (' + getSystemErrorName(-errno) + '). Its source was retained.'), { code: getSystemErrorName(-errno), errno })
    }
  }
  throw new Error('Atomic no-replace upgrade publication is not bound for this operating system; prepared source material was retained.')
}
let native: Promise<UpgradePublish> | undefined
/** Koffi is already a declared plugin dependency. Load it only when a one-time
 * prepared publication is actually requested, never on ordinary file access. */
export async function publishPreparedUpgradeFile(source: string, target: string): Promise<'published' | 'exists'> {
  const publication = await (native ??= import('koffi').then(module => bindUpgradePublish((module.default ?? module) as unknown as KoffiRuntime)))
  return publication(source, target)
}
