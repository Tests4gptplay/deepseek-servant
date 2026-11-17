import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, chmod, symlink, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { installedDshPython, probePython, findWindowsPython } from '../.test-build/windows-python-fallback.js'

const scenario = process.argv[2]
if (!scenario) {
  assert.equal(installedDshPython({ DSH_HOME: '/test/host' }), '/test/host/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe')
  assert.equal(installedDshPython({ DSH_HOME: 'relative' }), undefined)
  assert.equal(installedDshPython({}, '/test/home'), '/test/home/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe')
  assert.equal(await probePython({ executable: '/usr/bin/python3', args: [] }, process.env), '/usr/bin/python3')
  assert.equal(await probePython({ executable: '/no/such/python', args: [] }, process.env), undefined)
  const seen = []
  assert.equal(await findWindowsPython({ DSH_HOME: '/absent' }, async c => { seen.push(c.executable); return c.executable === 'python3' ? '/usr/bin/python3' : undefined }), '/usr/bin/python3')
  assert.deepEqual(seen, ['py', 'python3'])
  for (const name of ['healthy', 'fallback', 'explicit', 'missing', 'helper-error', 'cancel', 'posix', 'repair']) {
    process.stdout.write(execFileSync(process.execPath, [import.meta.filename, name], { encoding: 'utf8', timeout: 15000 }))
  }
  console.log('PASS resolver unit checks and eight real Linux-process scenarios (Windows selection simulated, not Windows OS certification).')
} else {
  const dir = await mkdtemp(join(tmpdir(), 'dss-python-test-'))
  const log = join(dir, 'launcher.log')
  try {
    // Platform override exercises Windows-only selection on Linux. No injected
    // helper results: the package's real Python helper and protocol run below.
    if (scenario !== 'posix') Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.PATH = dir
    process.env.DSH_HOME = join(dir, 'missing-runtime')
    if (scenario === 'posix') await symlink('/usr/bin/python3', join(dir, 'python3'))
    if (scenario === 'healthy') await symlink('/usr/bin/python3', join(dir, 'python'))
    if (!['missing', 'repair'].includes(scenario)) {
      await writeFile(join(dir, 'py'), `#!/bin/sh\necho probe >> '${log}'\n${scenario === 'cancel' ? '/bin/sleep 0.2\n' : ''}shift\nexec /usr/bin/python3 "$@"\n`)
      await chmod(join(dir, 'py'), 0o755)
    }
    const { DulwichGitBackend } = await import('../.test-build/dulwich-git-backend.js')
    const events = []
    const helperPath = scenario === 'helper-error' ? join(dir, 'broken.py') : resolve('lib/dulwich-helper.py')
    if (scenario === 'helper-error') {
      await symlink('/usr/bin/python3', join(dir, 'python'))
      await writeFile(helperPath, 'raise RuntimeError("controlled helper startup failure")\n')
    }
    const backend = new DulwichGitBackend({ helperPath, ...(scenario === 'explicit' ? { pythonExecutable: '/missing/explicit-python' } : {}), onHelperEvent: e => events.push(e) })
    const ac = new AbortController()
    const ready = backend.ready(ac.signal)
    if (scenario === 'cancel') setTimeout(() => ac.abort(new Error('cancelled by owner')), 20)
    if (['explicit', 'missing', 'helper-error', 'cancel', 'repair'].includes(scenario)) {
      await assert.rejects(ready, scenario === 'missing' ? /working Python 3/ : undefined)
    } else {
      await ready
      const bytes = await backend.storageBytes()
      assert.equal(typeof bytes, 'number')
      await backend.storageBytes()
      if (scenario === 'fallback') {
        const laterEvents = []
        const later = new DulwichGitBackend({ helperPath, onHelperEvent: e => laterEvents.push(e) })
        await later.ready(ac.signal)
        await later.release()
        assert.equal(laterEvents.filter(e => e.status === 'started').length, 1)
        assert.equal((await readFile(log, 'utf8')).trim(), 'probe')
      }
    }
    await backend.release()
    if (scenario === 'repair') {
      await writeFile(join(dir, 'py'), '#!/bin/sh\nshift\nexec /usr/bin/python3 "$@"\n')
      await chmod(join(dir, 'py'), 0o755)
      const repaired = new DulwichGitBackend({ helperPath })
      await repaired.ready(new AbortController().signal)
      assert.equal(typeof await repaired.storageBytes(), 'number')
      await repaired.release()
    }
    if (scenario === 'cancel') await new Promise(r => setTimeout(r, 350))
    if (['healthy', 'explicit', 'helper-error', 'posix'].includes(scenario)) await assert.rejects(readFile(log))
    if (scenario === 'cancel') assert.equal(events.filter(e => e.status === 'started' && e.pid).length, 0)
    console.log(`PASS ${scenario}: real process/protocol lifecycle`)
  } finally { await rm(dir, { recursive: true, force: true }) }
}
