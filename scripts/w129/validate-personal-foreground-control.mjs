import {fixture,check,checks,deferred,until} from './candidate-fixture.mjs'
try {const f=await fixture('foreground-control');let release
try {
 f.rt.config.primary=true
 const task=await f.task(),w=await f.wake(task);await f.observe();await f.drainMaintenance()
 const fw={id:'foreground-control-input',role:'Foreground',reason:'notification',sources:[]};await f.rt.wake(fw);await f.rt.runQueue(false,fw.id)
 const fg=f.rt.roleRecords.get(f.rt.roleKey('Foreground'));check('actual foreground admission exists',!!fg?.delivery?.confirmed,true)
 const binding=f.rt.binding(fg,fg.delivery.request)
 const orig=f.rt.controls.taskHeld.bind(f.rt.controls),arrived=deferred();release=deferred();let armed=true
 f.rt.controls.taskHeld=async(...args)=>{const v=await orig(...args);if(armed&&args[0]===task.taskId){armed=false;arrived.resolve();await release.promise}return v}
 await f.observe();await arrived.promise
 const result=await f.rt.services().taskControl.write(binding,{taskId:task.taskId,lifecycleId:task.lifecycleId,intent:'paused'},'actual-foreground-pause',new AbortController().signal)
 check('actual foreground task control persisted pause',result.intent,'paused')
 check('foreground pause immediately stops eligible interval',f.rt.localWakeAdmissions.get(f.key(w)).eligibleSince,undefined)
 release.resolve();await f.drainMaintenance()
}finally{release?.resolve();await f.close()}}
finally{console.error('FOREGROUND CONTROL CHECKS: '+checks.length)}
