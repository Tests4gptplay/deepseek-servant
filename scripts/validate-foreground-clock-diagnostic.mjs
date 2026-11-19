import {fixture,check,checks,evidence} from './w129/candidate-fixture.mjs'
const f=await fixture('foreground-admission-service-only');let native,work
try {
 f.rt.config.primary=true;const wake={id:'pure-foreground-45s',role:'Foreground',reason:'notification',sources:[]};await f.rt.wake(wake);await f.observe();await f.drainMaintenance()
 native=f.pendingOpen(wake);work=f.rt.runQueue(false,wake.id);await native.arrived.promise
 // Native open is an explicit held port; advance the existing local observation
 // clock, not an injected failure. This checks the configured 45-second contract.
 f.clock=145001;f.rt.checkWakeAdmissions();f.rt.checkWakeAdmissions();await f.drainSafety()
 const durable=(await f.records.list(f.rt.prefix+'wakes/')).find(row=>row.value.request.id===wake.id)?.value
 check('45s original diagnostic is durable',durable.admission.reportedAt,145001)
 check('durable diagnostic owns exact pending wake',durable.admission.diagnosticContext.wakeId,wake.id)
 check('one Service admission report',f.errors.filter(e=>e.origin?.admissionTimeout).length,1)
 const faults=[...f.service.safetyNet.byId.values()].map(x=>x.fault)
 check('same original wake owns the fault',faults[0]?.admissionTimeout?.context.wakeId,wake.id)
 const rows=await f.records.list(f.rt.prefix+'wakes/')
 const original=rows.filter(x=>x.value.request.id==='admission-timeout:'+wake.id)
 check('Service reuses the existing admission Helper ID',original.length,1)
 check('original wake retains Service fault ownership',original[0].value.safetyFaults.map(x=>x.id),[faults[0].id])
 native.release.resolve();await work
 check('delayed original native admission is still allowed',f.sends.some(x=>x.identity.role==='Foreground'),true)
 console.log(JSON.stringify({status:'passed',checks,limits:'Actual SDK and local Git CLI; controlled native-open delay and observation clock, no model or real-world incident claimed.',...evidence()},null,2))
} finally {native?.release.resolve();if(work)await work;await f.close()}
