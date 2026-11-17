import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {evidence,hash} from './test-support/dsh-sdk-runtime.mjs'
const {Context}=await import('@deepseek-ai/cordis')
const {SkillRegistry}=await import('@deepseek-ai/dsh-skill')
const {createScope}=await import('@deepseek-ai/dsh-scope')
const {FileSystemSkillProvider}=await import('@deepseek-ai/dsh-skill-filesystem')
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {installFrameworkSkillProvider}=await import('../src/framework/skills.ts')
const variant='applied',candidate=true
const output=process.env.DSS_SKILL_FORMAT_RESULT_DIR
if(output)await fs.mkdir(output,{recursive:true})
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-camelcase-audit-'))
const names=[],cases=[],observations=[]
const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);names.push(name)}
const keys=['disableModelInvocation','modelInvocable','userInvocable']
for(const [index,key]of keys.entries())for(const [label,value,canonical]of [
 ['true','true',''],['false','false',''],['null','null',''],['empty','""',''],
 ['canonical-present','false','disable-model-invocation: false\nuser-invocable: true\n'],
 ['canonical-conflict','true','disable-model-invocation: true\nuser-invocable: false\n'],
])cases.push({name:`top-key-${index}-${label}`,fields:`${key}: ${value}\n${canonical}`,admitted:false,key})
cases.push({name:'metadata-nested-keys',fields:'metadata:\n  disableModelInvocation: true\n  modelInvocable: false\n  userInvocable: false\n',admitted:true,metadata:{disableModelInvocation:true,modelInvocable:false,userInvocable:false}})
cases.push({name:'unknown-invocation-container',fields:'invocation:\n  modelInvocable: false\n  userInvocable: false\n',admitted:true})
cases.push({name:'different-exact-key',fields:'disablemodelinvocation: true\n',admitted:true})
cases.push({name:'canonical-keys',fields:'disable-model-invocation: true\nuser-invocable: false\n',admitted:true,policy:{modelInvocable:false,userInvocable:false}})
const officialRoot=path.join(scratch,'official'),dssRoot=path.join(scratch,'dss')
const put=async(root,name,bytes)=>{const p=path.join(root,name,'SKILL.md');await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,bytes)}
let officialProvider,disposeOfficial,dssProvider,officialScope,dssScope,files
try{
 for(const item of cases){const body=`---\nname: ${item.name}\ndescription: Actual native key boundary fixture\n${item.fields}---\nBody\n`;await put(officialRoot,item.name,body);await put(path.join(dssRoot,'skills'),item.name,body)}
 const ctx=new Context();new SkillRegistry(ctx)
 const officialKey={},dssKey={};officialScope=createScope(ctx,officialKey);dssScope=createScope(ctx,dssKey)
 disposeOfficial=officialScope.ctx.skills.registerProvider(control=>officialProvider=new FileSystemSkillProvider(officialScope.ctx,control,{providerName:'actual-key-oracle',includeDefaultRoots:false,customSkillDirs:[officialRoot],watch:false,dshHome:path.join(scratch,'unused-dsh'),agentsHome:path.join(scratch,'unused-agents')}))
 files=new PhysicalLocalFiles(dssRoot);dssProvider=installFrameworkSkillProvider(dssScope.ctx,dssKey,files)
 for(let i=0;i<20&&!dssProvider.available();i++)await new Promise(resolve=>setImmediate(resolve))
 check('real DSS native provider mounted',dssProvider.available(),true)
 const officialList=await ctx.skills.snapshot({scope:officialKey}),dssList=await ctx.skills.snapshot({scope:dssKey})
 check('official catalog complete',officialList.complete,true);check('DSS catalog complete',dssList.complete,true)
 for(const item of cases){
  const native=await ctx.skills.get(item.name,{scope:officialKey}),dss=await ctx.skills.get(item.name,{scope:dssKey})
  check(item.name+': actual native admission',!!native,item.admitted)
  check(item.name+': DSS matches actual native admission',!!dss,!!native)
  check(item.name+': actual native list admission',officialList.skills.some(s=>s.name===item.name),item.admitted)
  check(item.name+': DSS list admission',dssList.skills.some(s=>s.name===item.name),item.admitted)
  if(native){
   check(item.name+': native returned policy uses camelCase fields',native.invocation,item.policy??{modelInvocable:true,userInvocable:true})
   check(item.name+': DSS normalized policy matches native',dss.invocation,native.invocation)
   if(item.metadata){
    check('nested metadata camelCase keys are native data, not rejected top-level policy',native.metadata,item.metadata)
    check('DSS candidate preserves nested data without treating keys as a gate',dss.metadata,candidate?item.metadata:undefined)
   }
  }
  observations.push({name:item.name,key:item.key,admitted:!!native,location:item.name==='metadata-nested-keys'?'metadata object':'frontmatter root'})
 }
 const result={status:'passed',variant,assertions:names.length,fixtureCases:cases.length,names,observations,...evidence(),scriptHash:hash(readFileSync(fileURLToPath(import.meta.url)))}
 if(output)await fs.writeFile(path.join(output,`camelcase-${variant}-result.json`),JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify(result))
}finally{await dssProvider?.dispose();await files?.close();await dssScope?.dispose();disposeOfficial?.();await officialProvider?.dispose();await officialScope?.dispose();await fs.rm(scratch,{recursive:true,force:true})}
