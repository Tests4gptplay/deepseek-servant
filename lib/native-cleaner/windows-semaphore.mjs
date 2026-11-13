import {setTimeout as delay} from 'node:timers/promises';

const nativeFailure=(api,operation)=>Object.assign(new Error(`Native semaphore ${operation} failed`),{code:'ELOCK',operation,nativeError:api.error?.()});
function closeHandle(api,handle){if(!api.close(handle))throw nativeFailure(api,'close');}
function closeAfterFailure(api,handle,failure){
 try{closeHandle(api,handle);}catch(cleanup){throw new AggregateError([failure,cleanup],'Native semaphore operation and cleanup failed');}
 throw failure;
}

/** Match the official JSONL one-shot semaphore acquisition. A waiting process
 * must not keep a timed-out handle alive after the owner dies. */
export async function acquireSemaphore(api,name,{wait=false,deadline=Date.now()+5000,sleep=delay}={}){
 for(;;){
  const handle=api.create(null,1,1,name);
  if(!handle)throw nativeFailure(api,'create');
  let result;try{result=api.wait(handle,0);}catch(error){closeAfterFailure(api,handle,error);}
  if(result===0){
   let closePromise;
   return{close:()=>closePromise??=Promise.resolve().then(()=>{
    let failure;
    try{if(!api.release(handle,1,null))failure=nativeFailure(api,'release');}catch(error){failure=error;}
    if(failure)closeAfterFailure(api,handle,failure);
    closeHandle(api,handle);
   })};
  }
  // Capture the failing API's error before CloseHandle can overwrite it.
  if(result!==258)closeAfterFailure(api,handle,nativeFailure(api,'wait'));
  closeHandle(api,handle);
  if(!wait||Date.now()>=deadline)throw Object.assign(new Error('Native semaphore unavailable'),{code:'EBUSY'});
  await sleep(Math.min(10,Math.max(0,deadline-Date.now())));
 }
}
