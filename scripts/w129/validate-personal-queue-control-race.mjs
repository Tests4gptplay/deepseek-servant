import {fixture,check,checks,deferred,until} from './candidate-fixture.mjs'
try {const f=await fixture('queue-control-race');let release,native,work
try {
 const task=await f.task(),w=await f.wake(task);await f.observe();await f.drainMaintenance()
 const orig=f.rt.controls.taskHeld.bind(f.rt.controls),arrived=deferred();release=deferred();let armed=true
 f.rt.controls.taskHeld=async(...args)=>{const v=await orig(...args);if(armed&&args[0]===task.taskId){armed=false;arrived.resolve();await release.promise}return v}
 native=f.pendingOpen(w);work=f.rt.runQueue(false,w.id);await arrived.promise
 await f.userControl('pause-during-queue',task,'paused')
 check('confirmed UI pause stops interval',f.rt.localWakeAdmissions.get(f.key(w)).eligibleSince,undefined)
 release.resolve();await native.arrived.promise
 const state=f.rt.localWakeAdmissions.get(f.key(w));f.clock=145001;f.rt.checkWakeAdmissions()
 check('late old queue observation does not reenable pause timer',[state.held,state.eligibleSince,f.errors.filter(e=>e.origin?.admissionTimeout).length],[true,undefined,0])
}finally{release?.resolve();native?.release.resolve();if(work)await work;await f.close()}}
finally{console.error('QUEUE CONTROL CHECKS: '+checks.length)}
