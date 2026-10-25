import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { TaskArchiveStore } from './task-archive-store.js'

/** User-requested copy only; the sealed Domain document remains authoritative. */
export async function exportTaskRecords(archives: TaskArchiveStore, id: string, workspace: string) {
  const manifest = await archives.manifest(id)
  if (!manifest) throw new Error('Task records have not been sealed yet.')
  const directory = await realpath(workspace)
  const target = path.join(directory, 'records-' + createHash('sha256').update(id).digest('hex').slice(0, 12) + '-' + manifest.sha256.slice(0, 12) + '.md')
  let file
  try { file = await open(target, 'wx') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const hash = createHash('sha256')
    for await (const part of createReadStream(target)) hash.update(part)
    if (hash.digest('hex') !== manifest.sha256) throw new Error('The export path already contains different content: ' + target)
    return { path: target, sha256: manifest.sha256, bytes: manifest.bytes }
  }
  try {
    const hash = createHash('sha256')
    for await (const text of archives.chunks(manifest)) {
      const body = Buffer.from(text, 'utf8')
      await file.writeFile(body)
      hash.update(body)
    }
    if (hash.digest('hex') !== manifest.sha256) throw new Error('Sealed records changed while exporting.')
    await file.close()
    return { path: target, sha256: manifest.sha256, bytes: manifest.bytes }
  } catch (error) {
    await file.close()
    // Only the exact new file opened exclusively above belongs to this failed export.
    await unlink(target)
    throw error
  }
}
