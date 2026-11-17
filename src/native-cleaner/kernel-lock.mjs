import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {acquireSemaphore} from './windows-semaphore.mjs';
let posix,windows,koffi;
async function lockPosix(fd,wait,deadline){
 if(!posix){koffi=(await import('koffi')).default;const libc=koffi.load(null);posix=libc.func('int flock(int fd, int operation)');}
 // Never park native workers in blocking flock: fs operations needed by the
 // holder share that pool. The kernel remains the arbiter; waiting yields JS.
 do {
  const code=posix(fd,6);
  if(code===0)return;
  const errno=koffi.errno();
  if(errno!==koffi.os.errno.EAGAIN&&errno!==koffi.os.errno.EWOULDBLOCK&&errno!==koffi.os.errno.EINTR)throw Object.assign(new Error('Native lock failed: errno '+errno),{code:'ELOCK',errno});
  if(!wait||Date.now()>=deadline)throw Object.assign(new Error('Native lock unavailable'),{code:'EBUSY'});
  await delay(10);
 } while(true);
}
async function win32(){if(windows)return windows;const api=(await import('koffi')).default.load('kernel32.dll');
 return windows={create:api.func('__stdcall','CreateSemaphoreW','intptr',['void*','int','int','str16']),
 wait:api.func('__stdcall','WaitForSingleObject','uint',['intptr','uint']),release:api.func('__stdcall','ReleaseSemaphore','int',['intptr','int','void*']),close:api.func('__stdcall','CloseHandle','int',['intptr']),error:api.func('__stdcall','GetLastError','uint',[])};}
/** Same POSIX flock / Windows semaphore namespace as the official JSONL lease.
 * Non-blocking native acquisition plus yielding delay avoids native-pool starvation. */
export async function acquireKernelLock(path,{wait=false,create=false,timeoutMs=5000}={}){
 const deadline=Date.now()+timeoutMs;
 if(process.platform==='win32'){
  const api=await win32(),name='Local\\dsh-session-lock-'+createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');
  return acquireSemaphore(api,name,{wait,deadline});
 }
 if(process.platform!=='linux'&&process.platform!=='darwin')throw new Error('Native platform lock is unavailable');
 const fd=await open(path,constants.O_RDWR|(create?constants.O_CREAT:0)|(constants.O_NOFOLLOW??0),0o600);
 try{await lockPosix(fd.fd,wait,deadline);const held=await fd.stat(),current=await lstat(path);
  if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1||held.dev!==current.dev||held.ino!==current.ino)throw new Error('Lock path changed or is unsafe');
  return{close:()=>fd.close()};
 }catch(error){await fd.close();throw error;}
}
