import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';

/** Linux-only prototype: walk from / with held directory descriptors and
 * O_NOFOLLOW, then address children via the pinned directory inode. Parent
 * rename/symlink substitution cannot retarget deletion to a replacement tree. */
export async function pinDirectory(path){
 if(process.platform!=='linux')throw new Error('Pinned-directory cleanup currently requires Linux; Windows/macOS are not validated');
 const handles=[];let closing;
 const close=()=>closing??=(async()=>{
  const errors=[];
  for(const handle of [...handles].reverse())try{await handle.close();}catch(error){errors.push(error);}
  if(errors.length===1)throw errors[0];
  if(errors.length)throw new AggregateError(errors,'Pinned directory handles could not close');
 })();
 try{
  let held=await open('/',constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(held);
  for(const part of resolve(path).split('/').filter(Boolean)){
   held=await open(`/proc/self/fd/${held.fd}/${part}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(held);
  }
  return{path:`/proc/self/fd/${held.fd}`,stat:()=>held.stat(),sync:()=>held.sync(),close};
 }catch(error){
  try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Directory acquisition and cleanup failed');}
  throw error;
 }
}
