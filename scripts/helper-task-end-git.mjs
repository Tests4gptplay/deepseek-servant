// Installed native SDK/JSONL and real Runtime/Host/Cleaner. Git object/CAS
// transport uses a local bare repository, not Dulwich, GitHub or Service login.
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {fixture as localFixture,hash,mark} from './helper-service-sdk.mjs'
process.env.DSS_AUDIT_SOURCE_ROOT ??= fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'')
const {gitFixture}=await import('./test-support/real-git-async-fixture.mjs')
const {FrameworkRoleRuntime}=await import('../src/framework/role-runtime.ts')
const {GitAuthorityStore}=await import('../src/framework/git-authority.ts')
const {withSnapshot}=await import('../src/framework/transactions.ts')
export async function fixture(name,reopen=false){
 const f=await localFixture(name,reopen);await f.service.participation({mode:'local',enabled:false})
 const originalClose=f.close.bind(f),git=gitFixture(path.join(f.dir,'actual.git'),'sha1',{create:!reopen})
 const scope='task-claims-git',records=new GitAuthorityStore(git.files,'task-claims'),sharedRecords=new GitAuthorityStore(git.files,'shared')
 const rt=new FrameworkRoleRuntime(f.sdk.ctx,git.files,records,{scope,mode:'git',member:'Evidence',primary:true,collaborationId:'po-native',workerSeats:1,workspace:path.join(f.dir,'workspace'),instanceUUID:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',foreground:{provider:'isolated-wire',model:'controlled'},background:{provider:'isolated-wire',model:'controlled'}},{sharedRecords,members:()=>['Evidence'],resources:()=>[],heartbeat:async()=>{},error:(e,c)=>{mark('git-runtime-error',{error:String(e),context:c});return true}})
 f.rt=rt;f.prefix=rt.prefix;f.active={connection:{records,files:git.files}};f.row=r=>records.get(f.prefix+'roles/'+hash(r.identity.workId))
 f.publish=(p,text)=>withSnapshot(git.files,s=>git.files.commit(s,[{path:p,content:text}],'Controlled normal user Task input'))
 f.read=p=>withSnapshot(git.files,s=>git.files.read(s,p));f.gitEvents=git.events
 f.close=async()=>{await rt.dispose();await Promise.allSettled(rt.nativeRetirementOperations?.values()??[]);await records.close();await sharedRecords.close();await git.repo.releaseCache();await originalClose()}
 await rt.start();return f
}
