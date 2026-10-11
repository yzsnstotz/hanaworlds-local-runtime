import { afterEach, expect, it } from 'vitest'
import { NativeEngineRuntime } from '../src/engine-runtime.ts'
import type { NativeControlSession } from '../src/engine-control.ts'
const q = { contractVersion: 'engine-runtime/v2' as const, requestId: 'start', worldRef: 'world-1',
 engineProfile: { profileId: 'luanti-native/v1', worldPath: '/fixture/world', userPath: '/fixture/user' } }
const owned: NativeEngineRuntime[] = []
afterEach(async () => { await Promise.all(owned.splice(0).map(r => r.close())) })
function rig() {
 let live = true, valid = true, stopped = false, starts = 0, closes = 0
 const session: NativeControlSession = { worldPath: '/fixture/world', processId: 42,
  alive: () => live, verify: async () => { if (!live || !valid) throw Error('LOCAL_WORLD_CHANGED') },
  stop: async () => { if (!valid) throw Error('LOCAL_WORLD_CHANGED'); live = false; stopped = true },
  assertStopped: async () => { if (live || !stopped || !valid) throw Error('STOPPED_WORLD_UNPROVEN') },
  close: async () => { closes++; live = false } }
 const runtime = new NativeEngineRuntime(async () => { starts++; return session })
 owned.push(runtime)
 return { runtime, starts: () => starts, closes: () => closes, replace: () => { valid = false }, die: () => { live = false } }
}
it('publishes RUNNING only after native verification and STOPPED only after native exit evidence', async () => {
 const r = rig(), start = await r.runtime.StartWorldRuntime(q)
 expect(start.error).toBeNull(); expect(start.result?.state).toBe('RUNNING')
 const selector = { contractVersion: q.contractVersion, requestId: 'status', connectionRef: start.result!.connectionRef }
 expect((await r.runtime.ReadRuntimeStatus(selector)).result).toEqual(start.result)
 expect((await r.runtime.StopWorldRuntime({...selector, requestId:'stop'})).result?.state).toBe('STOPPED')
 expect((await r.runtime.ReadRuntimeStatus(selector)).result?.state).toBe('STOPPED')
 r.replace()
 expect((await r.runtime.ReadRuntimeStatus(selector)).error?.code).toBe('CONNECTION_NOT_FOUND')
})
it('refuses malformed profiles without starting and validates wire before side effects', async () => {
 const r = rig()
 for (const engineProfile of [null, {}, { ...q.engineProfile, worldPath: '../world' }, { ...q.engineProfile, extra:true }])
  expect((await r.runtime.StartWorldRuntime({...q,engineProfile})).error?.code).toBe('ADAPTER_UNAVAILABLE')
 await expect(r.runtime.StartWorldRuntime({...q, contractVersion:'engine-runtime/v1'} as never)).rejects.toThrow()
 expect(r.starts()).toBe(0)
})
it('refuses unknown connections and never supplies a running fact for a dead child', async () => {
 const r = rig(), start = await r.runtime.StartWorldRuntime(q)
 const selector = {contractVersion:q.contractVersion,requestId:'status',connectionRef:start.result!.connectionRef}
 r.die()
 expect((await r.runtime.ReadRuntimeStatus(selector)).error?.code).toBe('CONNECTION_NOT_FOUND')
 expect((await r.runtime.StopWorldRuntime(selector)).error?.code).toBe('CONNECTION_NOT_FOUND')
 expect((await r.runtime.ReadRuntimeStatus({...selector,connectionRef:'forged'})).error?.code).toBe('CONNECTION_NOT_FOUND')
})
it('refuses a native session for another directory and disposes it', async () => {
 const session: NativeControlSession={worldPath:'/wrong',processId:5,alive:()=>true,verify:async()=>{},stop:async()=>{},assertStopped:async()=>{},close:async()=>{closed=true}}
 let closed=false
 const runtime=new NativeEngineRuntime(async()=>session); owned.push(runtime)
 expect((await runtime.StartWorldRuntime(q)).error?.code).toBe('ADAPTER_UNAVAILABLE')
 expect(closed).toBe(true)
})
it('maps a missing world to WORLD_NOT_FOUND without manufacturing a process', async () => {
 const runtime = new NativeEngineRuntime(async()=>{throw Error('WORLD_NOT_FOUND')});owned.push(runtime)
 expect((await runtime.StartWorldRuntime(q)).error?.code).toBe('WORLD_NOT_FOUND')
})
it('distinguishes a missing runtime artifact from a missing world', async () => {
 const runtime=new NativeEngineRuntime(async()=>{throw Object.assign(Error('missing engine'),{code:'ENOENT'})});owned.push(runtime)
 expect((await runtime.StartWorldRuntime(q)).error?.code).toBe('ADAPTER_UNAVAILABLE')
})
it('replays the exact start against fresh native proof and refuses changed input for that request', async () => {
 const r=rig(), first=await r.runtime.StartWorldRuntime(q)
 expect(await r.runtime.StartWorldRuntime(q)).toEqual(first)
 expect((await r.runtime.StartWorldRuntime({...q,worldRef:'different'})).error?.code).toBe('ADAPTER_UNAVAILABLE')
 expect(r.starts()).toBe(1)
 r.die()
 expect((await r.runtime.StartWorldRuntime(q)).error?.code).toBe('ADAPTER_UNAVAILABLE')
 expect(r.starts()).toBe(1)
})
it('does not report STOPPED when the native shutdown cannot prove exit', async () => {
 const runtime=new NativeEngineRuntime(async input=>({worldPath:input.worldPath,processId:42,alive:()=>true,
  verify:async()=>{},stop:async()=>{throw Error('ENGINE_EXIT_UNPROVEN')},assertStopped:async()=>{throw Error('unproved')},close:async()=>{}}));owned.push(runtime)
 const started=await runtime.StartWorldRuntime(q)
 await expect(runtime.StopWorldRuntime({contractVersion:q.contractVersion,requestId:'stop',connectionRef:started.result!.connectionRef})).rejects.toThrow('ENGINE_EXIT_UNPROVEN')
})
it('serializes status behind stopping and preserves simultaneous stopped reads',async()=>{
 let release!:()=>void,entered!:()=>void,live=true
 const gate=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{entered=r})
 const runtime=new NativeEngineRuntime(async input=>({worldPath:input.worldPath,processId:42,alive:()=>live,
  verify:async()=>{if(!live)throw Error('closed')},stop:async()=>{entered();await gate;live=false},
  assertStopped:async()=>{if(live)throw Error('unproved')},close:async()=>{live=false}}));owned.push(runtime)
 const started=await runtime.StartWorldRuntime(q),selector={contractVersion:q.contractVersion,requestId:'status',connectionRef:started.result!.connectionRef}
 const stopping=runtime.StopWorldRuntime({...selector,requestId:'stop'});await ready
 const reading=runtime.ReadRuntimeStatus(selector);release()
 expect((await stopping).result?.state).toBe('STOPPED')
 expect((await reading).result?.state).toBe('STOPPED')
 const results=await Promise.all([runtime.ReadRuntimeStatus(selector),runtime.ReadRuntimeStatus(selector)])
 expect(results.map(r=>r.result?.state)).toEqual(['STOPPED','STOPPED'])
})
it.each(['acquire','inspect','binding'])('propagates %s cleanup failure and cannot claim a successful unload',async stage=>{
 let checks=0,closes=0
 const cleanup=Error('ENGINE_EXIT_UNPROVEN')
 const runtime=new NativeEngineRuntime(async input=>({worldPath:stage==='binding'?'/wrong':input.worldPath,processId:42,alive:()=>true,
  verify:async()=>{if(++checks===(stage==='acquire'?1:2))throw Error('LOCAL_WORLD_CHANGED')},stop:async()=>{},assertStopped:async()=>{},
  close:async()=>{closes++;throw cleanup}}))
 await expect(runtime.StartWorldRuntime(q)).rejects.toBe(cleanup)
 await expect(runtime.close()).rejects.toBe(cleanup)
 expect(closes).toBe(1)
})
it('refuses two directories or simultaneous native starts for the same world reference',async()=>{
 let release!:()=>void,entered!:()=>void,starts=0
 const gate=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{entered=r})
 const runtime=new NativeEngineRuntime(async input=>{starts++;entered();await gate;return {worldPath:input.worldPath,processId:42,alive:()=>true,
  verify:async()=>{},stop:async()=>{},assertStopped:async()=>{},close:async()=>{}}});owned.push(runtime)
 const first=runtime.StartWorldRuntime(q);await ready
 const otherPending=runtime.StartWorldRuntime({...q,requestId:'other',engineProfile:{...q.engineProfile,worldPath:'/fixture/other'}})
 release();const other=await otherPending;expect((await first).result?.state).toBe('RUNNING')
 expect(other.error?.code).toBe('ADAPTER_UNAVAILABLE');expect(starts).toBe(1)
})
it('preserves each operations own cleanup cause across two simultaneous world failures',async()=>{
 const causes={a:Error('cleanup-a'),b:Error('cleanup-b')}
 let release!:()=>void,count=0,entered!:()=>void
 const gate=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{entered=r})
 const runtime=new NativeEngineRuntime(async input=>{let checks=0;const key=input.operationRef as 'a'|'b';return {
  worldPath:input.worldPath,processId:key==='a'?41:42,alive:()=>true,verify:async()=>{if(++checks===2)throw Error('LOCAL_WORLD_CHANGED')},
  stop:async()=>{},assertStopped:async()=>{},close:async()=>{if(++count===2)entered();await gate;throw causes[key]}}})
 const a=runtime.StartWorldRuntime({...q,requestId:'a',worldRef:'a',engineProfile:{...q.engineProfile,worldPath:'/fixture/a'}})
 const b=runtime.StartWorldRuntime({...q,requestId:'b',worldRef:'b',engineProfile:{...q.engineProfile,worldPath:'/fixture/b'}})
 const outcomes=Promise.allSettled([a,b]);await ready;release()
 const results=await outcomes
 expect(results[0]).toMatchObject({status:'rejected',reason:causes.a})
 expect(results[1]).toMatchObject({status:'rejected',reason:causes.b})
 await expect(runtime.close()).rejects.toBe(causes.a)
})
it('unload waits for an in-flight stop and drains queued status without losing its cleanup',async()=>{
 let release!:()=>void,entered!:()=>void,live=true,closes=0
 const gate=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{entered=r})
 const runtime=new NativeEngineRuntime(async input=>({worldPath:input.worldPath,processId:42,alive:()=>live,
  verify:async()=>{},stop:async()=>{entered();await gate;live=false},assertStopped:async()=>{if(live)throw Error('unproved')},close:async()=>{closes++;live=false}}))
 const start=await runtime.StartWorldRuntime(q),selector={contractVersion:q.contractVersion,requestId:'status',connectionRef:start.result!.connectionRef}
 const stopping=runtime.StopWorldRuntime({...selector,requestId:'stop'});await ready
 const status=runtime.ReadRuntimeStatus(selector),closing=runtime.close()
 expect(closes).toBe(0);release()
 expect((await stopping).result?.state).toBe('STOPPED')
 expect((await status).error?.code).toBe('CONNECTION_NOT_FOUND')
 await closing;expect(closes).toBe(1)
})
