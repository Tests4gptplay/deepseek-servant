import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { canonicalLocalLocation } from './local-location.js'

/** Only an explicitly selected output/workspace directory is created here.
 * Existing files are never replaced, and canonical parents retain their boundary.
 * This is not a database recovery helper or a general write-retry wrapper. */
export async function ensureWriteDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error('Choose an absolute local output directory.')
  const canonical = await canonicalLocalLocation(directory)
  try {
    const info = await lstat(canonical)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Output path is not an ordinary directory: ' + directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(canonical, { recursive: true })
  }
  const actual = await realpath(canonical), info = await lstat(canonical)
  if (actual !== canonical || !info.isDirectory() || info.isSymbolicLink()) throw new Error('Output directory changed while preparing it: ' + directory)
  return actual
}

/** ENOENT from an exclusive open proves this attempt did not create a file.
 * Repair only its missing parent, once. Never retry writes, rename/fsync failures,
 * permissions, collisions, or another failure with an uncertain write outcome. */
export async function openNewOutput(path: string): Promise<FileHandle> {
  try { return await open(path, 'wx') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    let missing = false
    try { await lstat(parent) }
    catch (reason) { if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason; missing = true }
    if (!missing) throw error
    if (await ensureWriteDirectory(parent) !== parent) throw new Error('Output parent changed before retry: ' + parent, { cause: error })
    return open(path, 'wx')
  }
}
