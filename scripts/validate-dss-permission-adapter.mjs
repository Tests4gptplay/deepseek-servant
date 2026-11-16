import { hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
import assert from 'node:assert/strict'
const { DshRolePermissions } = await import('../src/adapters/dsh/permissions.ts')
const checks=[];const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push(name)}
let preference;const calls=[],writes=[];const valid=new Set(['read-only','workspace-write']);
const native={current:s=>s.preset,resolve:p=>{if(!valid.has(p))throw Error('unknown preset')},set(s,p){this.resolve(p);s.preset=p;writes.push(s.id)}}
const commands={async execute(agent,line){calls.push(agent.session.id);native.set(agent.session,line.slice(12));return {result:{kind:'success'}}}}
const ctx={get:name=>name==='permissionPresets'?native:commands};const scope=()=>{const cleanup=[];return {effect(fn){cleanup.push(fn())},close(){cleanup.forEach(fn=>fn())}}};const agent=id=>({session:{id,preset:'workspace-write'}})
try {
 const group=new DshRolePermissions(ctx,()=>preference),a=agent('foreground'),b=agent('worker'),outside=agent('unrelated');const sa=scope(),sb=scope();
 group.attach(sa,a);group.attach(sb,b);check('unset preference has zero native writes',writes.length,0);check('unset preference has zero extra commands',calls.length,0)
 preference='read-only';await group.select(preference);check('one explicit group choice reaches owned roles', [a.session.preset,b.session.preset],['read-only','read-only']);check('unowned session unchanged',outside.session.preset,'workspace-write');check('native command once per changed live role',calls,['foreground','worker'])
 await group.select(preference);check('unchanged role has no duplicate command',calls.length,2)
 const c=agent('new-worker');group.attach(scope(),c);check('new role has selected permission synchronously',c.session.preset,'read-only');check('new role no command or await',calls.length,2)
 sb.close();preference='workspace-write';await group.select(preference);check('disposed role not modified',b.session.preset,'read-only');check('remaining roles changed',[a.session.preset,c.session.preset],['workspace-write','workspace-write'])
 const resumed=agent('resumed-worker');resumed.session.preset='read-only';group.attach(scope(),resumed);check('resumed role follows explicit group choice',resumed.session.preset,'workspace-write')
 await assert.rejects(group.select('unknown'),/unknown/);check('unknown choice leaves effective roles unchanged',a.session.preset,'workspace-write')
 const normalExecute=commands.execute;let failedOnce=true;commands.execute=async(agent,line)=>{if(agent.session.id==='new-worker'&&failedOnce){failedOnce=false;throw Error('role closed during command')}return normalExecute(agent,line)};preference='read-only';await assert.rejects(group.select(preference),AggregateError);check('partial native failure leaves successful roles changed',a.session.preset,'read-only');check('failed role remains honestly unchanged',c.session.preset,'workspace-write');const beforeRetry=calls.length;await group.select(preference);check('explicit same target retry applies remaining role',c.session.preset,'read-only');check('retry skips already applied roles',calls.slice(beforeRetry),['new-worker'])
 console.log(JSON.stringify({status:'passed',checks,...evidence(),limits:'Controlled narrow adapter test with virtual role sessions and native-service-shaped test doubles. Not an actual DSH permission grant, UI test, or model test.'},null,2))
} finally { hooks.deregister() }
