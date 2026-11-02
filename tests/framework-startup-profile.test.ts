import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {baselineFixture,loadBaselineModule} from './legacy-baseline.js';
import {FrameworkService} from '../src/framework/service.js';
import {FrameworkRoleRuntime} from '../src/framework/role-runtime.js';
import {captureLocalLegacy,legacyLocalProfile,readLegacyLocalProfile} from '../src/framework/legacy-migration.js';
const {AssistantService}=await loadBaselineModule<any>('tests/profile-audit-entry.ts',`export {AssistantService} from '../src/application/assistant-service.ts'`);
async function source(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'dss-profile-capture-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const old=await baselineFixture('Original producer task whose preserved records must not be scanned just for settings');
 const defaults={name:'Original name',userName:'Original user',presetId:'original-preset',workspaceDirectory:root,foreground:{provider:'original-provider',model:'original-model'},background:{provider:'background-provider',model:'background-model'},showCornerCharacter:false,swapPageIllustrations:true};
 const assistant=new AssistantService({store:old.storage,defaults,resolveWorkspace:async()=>({id:'original-workspace',directory:root}),runtime:{},now:()=> '2026-10-30T12:00:00Z'});
 const profile=await assistant.get('default');
 for(let n=0;n<4;n++)await assistant.conversations.append('default',profile.sessionId,{id:'original-'+n,role:n%2?'assistant':'user',text:('Exact original long conversation '+n+' 😀\n').repeat(3000),at:'2026-10-30T12:0'+n+':00Z'});
 return{root,old,assistant,profile};
}
for(const enabled of [false,true])test('startup profile does not fully capture old conversation bodies '+(enabled?'before actual cutover':'with background disabled'),async t=>{
 const {root,old,profile}=await source(t),settings={name:'new-default',userName:'new-user',localDirectory:join(root,'records'),ownerRepo:'Owner/repo',repositoryDirectory:'',collaborationId:'team',workerSeats:1,workspace:root};
 await old.storage.set('framework-settings/git',{revision:'saved-git',settings});
 await old.storage.set('framework-participation/local',enabled);await old.storage.set('framework-participation/git',false);
 const get=old.storage.get.bind(old.storage),list=old.storage.list.bind(old.storage),set=old.storage.set.bind(old.storage);
 const legacyKeys=new Set([...old.storage.data.keys()].filter(k=>!k.startsWith('framework-')));
 const calls:any[]=[];let savedLocal=false,configProfileReads=0;const gets:string[]=[];
 old.storage.get=async(key:string)=>{gets.push(key);if(!savedLocal&&key==='assistant/default')configProfileReads++;return get(key)};
 old.storage.set=async(key:string,value:unknown)=>{if(key==='framework-settings/local')savedLocal=true;return set(key,value)};
 old.storage.list=async(prefix:string)=>{const rows=await list(prefix);if(prefix===''){
  const legacy=rows.filter(r=>legacyKeys.has(r.key)).sort((a,b)=>a.key.localeCompare(b.key)),json=JSON.stringify(legacy);
  calls.push({phase:savedLocal?'actual-cutover':'configuration-only',rows:legacy.length,serializedBytes:Buffer.byteLength(json),revision:createHash('sha256').update(json).digest('hex')});
 }return rows;};
 const service=new FrameworkService({workspaceRegistry:{create:async(directory:string)=>({id:'framework-workspace',path:directory})},agents:{get:()=>undefined},jobs:{list:()=>[]},get:()=>undefined} as any,old.storage,settings);
 t.mock.method(FrameworkRoleRuntime.prototype,'start',async()=>{});
 try{
  await service.start();
  const saved=await old.storage.get<any>('framework-settings/local');assert.equal(saved.settings.name,profile.settings.name);assert.deepEqual(saved.settings.foreground,profile.settings.foreground);assert.equal(saved.settings.showCornerCharacter,false);assert.equal(saved.settings.swapPageIllustrations,true);
  if(calls.length)assert.equal(new Set(calls.map(c=>c.revision)).size,1,'old source records are actually stable across all full reads');
  assert.equal(calls.filter(c=>c.phase==='configuration-only').length,0,'config import needs only assistant/default + settings/runtime, not complete old business capture');
  assert.equal(calls.length,enabled?2:0,'retain the actual cutover before/after consistency reads only');
  assert.equal(configProfileReads,1,'configuration reads only the selected old profile once');
 }finally{await service.dispose();}
});
test('direct profile helper matches the immutable old profile and captured projection without scanning histories',async t=>{
 const {old,assistant}=await source(t),captured=legacyLocalProfile(await captureLocalLegacy(old.storage)),get=old.storage.get.bind(old.storage),keys:string[]=[];
 old.storage.get=async(key:string)=>{keys.push(key);return get(key)};old.storage.list=async()=>{throw Error('profile contract must not enumerate histories')};
 const exact=await assistant.foregroundProfile('default');
 assert.deepEqual(exact.settings,captured!.settings);assert.deepEqual(exact.workspace,captured!.workspace);assert.deepEqual(keys,['assistant/default']);
 keys.length=0;assert.deepEqual(await readLegacyLocalProfile(old.storage),captured);assert.deepEqual(keys,['assistant/default']);
});

test('direct profile lookup preserves missing and invalid profile behavior without list access', async () => {
 const absent = { get: async <T>() => undefined as T | undefined };
 assert.equal(await readLegacyLocalProfile(absent),undefined);
 const invalid = { get: async <T>() => ({ schemaVersion: 1, id: 'another', settings: {}, workspace: {} }) as T };
 await assert.rejects(readLegacyLocalProfile(invalid),/Invalid legacy assistant profile/);
});
