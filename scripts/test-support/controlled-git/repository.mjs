import {createHash} from 'node:crypto'
const sha=x=>createHash('sha256').update(x).digest('hex')
export class Repository {
 head='h0';bodies=new Map();history=new Map([['h0',new Map()]]);views=new WeakMap();outcomes=[];calls=[];accepted=new Map();sequence=0;resolution
 withReadOperation(fn){return fn()} withWriteOperation(fn){return fn()}
 view(head=this.head){const bodies=new Map(this.history.get(head));const value={head,tree:'tree-'+head,files:new Map([...bodies].map(([path,body])=>[path,sha(body)]))};this.views.set(value,bodies);return value}
 async snapshot(){return this.view()} async at(head){return this.view(head)} async prefetch(){} releaseSnapshot(){}
 async read(snapshot,path){const value=this.views.get(snapshot).get(path);return value instanceof Uint8Array?Buffer.from(value).toString('utf8'):value}
 async readBytes(snapshot,path){const v=this.views.get(snapshot).get(path);return v===undefined?undefined:Buffer.from(v)}
 async list(snapshot,prefix){return undefined} async listDirectory(snapshot,prefix){return [...this.views.get(snapshot)].filter(([p])=>p.startsWith(prefix)).map(([path,body])=>({path,type:'blob',sha:sha(body)}))}
 prepareCommit(snapshot,changes,message){const writes=changes.map(c=>({path:c.path,sha256:c.content===null?null:sha(c.bytes??c.content)})),requestHash=sha(JSON.stringify([writes,message]));return{version:1,id:sha(snapshot.head+requestHash),expectedHead:snapshot.head,repositoryId:1,repository:'owner/repo',branch:'main',directory:'dss',authorId:1,writes,requestHash,preparedAt:0}}
 async commitPrepared(snapshot,changes,message,operation){
  this.calls.push({snapshot,changes,message,operation});const step=this.outcomes.shift();if(step?.gate)await step.gate.promise
  if(step?.before) await step.before(this);if(step?.error)throw step.error
  if(this.accepted.has(operation.id))return{commit:this.accepted.get(operation.id),replay:true}
  for(const c of changes){if(c.content===null)this.bodies.delete(c.path);else this.bodies.set(c.path,c.content??Buffer.from(c.bytes))}
  this.head='h'+ ++this.sequence;this.history.set(this.head,new Map(this.bodies));this.accepted.set(operation.id,this.head);return{commit:this.head,replay:false}
 }
 async resolveCommit(operation){return this.resolution??(this.accepted.has(operation.id)?{status:'confirmed',commit:this.accepted.get(operation.id),head:this.head}:{status:'unknown'})}
 async dependenciesEqual(base,current,dependencies){
  const before=this.views.get(base), after=this.views.get(current)
  return dependencies.files.every(path=>(before.has(path)?sha(before.get(path)):undefined)===(after.has(path)?sha(after.get(path)):undefined))
 }
 takeConflictSnapshot(){return this.view()}
}

export const put=(repo,path,value)=>{if(value===undefined)repo.bodies.delete('dss-coop/'+path);else repo.bodies.set('dss-coop/'+path,value instanceof Uint8Array?Buffer.from(value):typeof value==='string'?value:JSON.stringify(value)+'\n')}
export const head=repo=>{repo.head='h'+ ++repo.sequence;repo.history.set(repo.head,new Map(repo.bodies))}
