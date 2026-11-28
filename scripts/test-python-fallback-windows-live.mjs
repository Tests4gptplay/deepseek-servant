import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DulwichGitBackend } from './dulwich-git-backend.js'
import { findWindowsPython, installedDshPython, probePython } from './windows-python-fallback.js'
assert.equal(process.platform, 'win32')
const helperPath = join(process.env.DSH_HOME, 'profiles', 'desktop', 'node_modules', 'deepseek-servant', 'lib', 'dulwich-helper.py')
const raw = await new Promise(resolve => { const c=spawn('python', ['-I','-B','-c','print(1)'], {windowsHide:true}); c.stdout.resume();c.stderr.resume(); c.on('error',e=>resolve({error:e.code}));c.on('close',code=>resolve({code})); })
console.log(JSON.stringify({defaultPython:raw, runtimeExistsAndValid:!!await probePython({executable:installedDshPython(process.env),args:[]},process.env),launcherValid:!!await probePython({executable:'py',args:['-3']},process.env)}))
const events=[]; const b=new DulwichGitBackend({helperPath,onHelperEvent:e=>events.push(e)})
await Promise.all([b.ready(new AbortController().signal),b.ready(new AbortController().signal)])
const bytes=await b.storageBytes(); assert.equal(typeof bytes,'number')
assert.equal(await b.storageBytes(),bytes)
await b.release()
const later=[]; const b2=new DulwichGitBackend({helperPath,onHelperEvent:e=>later.push(e)})
await b2.ready(new AbortController().signal); await b2.release()
assert.equal(later.filter(e=>e.status==='started').length,1)
const explicit=new DulwichGitBackend({helperPath,pythonExecutable:join(import.meta.dirname,'nonexistent-python.exe')})
await assert.rejects(explicit.ready(new AbortController().signal));await explicit.release()
console.log(JSON.stringify({result:'PASS',scenario:'real WindowsApps fallback, concurrent ready, real installed helper, repeated operations, cached later lane, explicit missing remains failure',events:events.map(e=>e.status),later:later.map(e=>e.status),bytes}))

// An actual Python helper returning 9009 is not a missing interpreter.
const fake = join(import.meta.dirname, 'helper-exit9009.py')
await writeFile(fake, 'import sys; sys.exit(9009)\n')
const fakeEvents=[]
const bad = new DulwichGitBackend({helperPath:fake,onHelperEvent:e=>fakeEvents.push(e)})
await assert.rejects(bad.ready(new AbortController().signal))
await bad.release()
assert.equal(fakeEvents.filter(e=>e.status==='started').length,1)
// Candidate child environment only; leave this host's and system's PATH intact.
await assert.rejects(findWindowsPython({...process.env,PATH:import.meta.dirname,DSH_HOME:join(import.meta.dirname,'absent')}), /working Python 3/)
console.log(JSON.stringify({result:'PASS',scenario:'real helper exit9009 not retried; no runtime/launcher/python3 produces bounded interpreter error'}))
