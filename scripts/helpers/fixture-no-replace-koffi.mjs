// Controlled Linux test bridge: exercises the production binding signature and
// actual libc renameat2 through Python ctypes, not a fake rename/copy algorithm.
// This is NOT validation of Koffi's native addon or Windows execution.
import { spawnSync } from 'node:child_process'
let lastError = 0
export default {
  load(name) {
    if (name !== 'libc.so.6') throw Error('Fixture supports actual Linux libc only')
    return { func(name, result, args) {
      if (name !== 'renameat2' || result !== 'int' || JSON.stringify(args) !== JSON.stringify(['int', 'str', 'int', 'str', 'uint'])) throw Error('Unexpected production binding signature')
      return (fromFd, source, toFd, target, flags) => {
        const run = spawnSync('python3', ['-c', `import ctypes,sys,json\nlib=ctypes.CDLL(None,use_errno=True)\nf=lib.renameat2\nf.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]\nf.restype=ctypes.c_int\nr=f(int(sys.argv[1]),sys.argv[2].encode(),int(sys.argv[3]),sys.argv[4].encode(),int(sys.argv[5]))\nprint(json.dumps([r,ctypes.get_errno()]))`, String(fromFd), source, String(toFd), target, String(flags)], { encoding: 'utf8' })
        if (run.status !== 0) throw Error(run.stderr || 'Native fixture bridge failed')
        const [result, errno] = JSON.parse(run.stdout); lastError = errno; return result
      }
    } }
  },
  errno() { return lastError },
}
