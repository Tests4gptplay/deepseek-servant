import { hooks, evidence } from './test-support/dsh-sdk-runtime.mjs'
import assert from 'node:assert/strict'
const { Context } = await import('@deepseek-ai/cordis')
const { HostConnectionService, Peer } = await import('@deepseek-ai/dsh-client-connection')
const checks=[];const check=(name,a,b)=>{assert.deepEqual(a,b,name);checks.push(name)}
const ctx=new Context()
// This test calls the actual post-authentication carrier dispatcher, never its token/cookie methods.
const connection=new HostConnectionService(ctx,[],{})
let reached=0
const off=connection.fetch.register({path:'/api/dss-permission-scope-test',methods:['POST'],requestBody:'buffered',fetch:async()=>{reached++;return new Response('owner-route')}})
const handler=connection.createSharedFetchHandler('/api')
try {
 for(const kind of ['viewer','unknown-test-principal']) {
  const peer=new Peer(ctx,{principal:{kind}})
  try {const response=await handler.fetch(new Request('http://localhost/api/dss-permission-scope-test',{method:'POST'}),peer);check(kind+' denied by official exact route',response.status,403)} finally {await peer.dispose()}
 }
 check('no denied caller reaches business handler',reached,0)
 const owner=new Peer(ctx,{principal:{kind:'owner'}})
 try {const response=await handler.fetch(new Request('http://localhost/api/dss-permission-scope-test',{method:'POST'}),owner);check('official owner reaches route',response.status,200);check('one owner call dispatched',reached,1)} finally {await owner.dispose()}
 console.log(JSON.stringify({status:'passed',checks,...evidence(),limits:'Actual installed rc3 Connection and Peer classes with controlled principals after authentication. No credentials read, no live profile modified, no permission mutation, no claim to test HTTP cookie authentication or prove a physical user click.'},null,2))
} finally {await off();await connection.browserPeer.dispose();hooks.deregister()}
