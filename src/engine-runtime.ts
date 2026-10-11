/** C-engine-runtime provider. Engine-specific inputs belong to this source, never the host. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {lstat,realpath} from 'node:fs/promises'
import { z } from 'zod'
import { validateRequest, validateBoundResponse, requestDigest, type EngineRuntimePort, type EngineRuntimeStartRequest,
 type EngineRuntimeStopRequest, type EngineRuntimeReadStatusRequest, type NativeControlInput,
 type NativeControlQuery, type EngineRuntimeStarted } from 'hanaworlds-contracts'
import { NativeCleanupFailure } from './native-cleanup.ts'
import { NativeEngineControl, type NativeControlSession } from './engine-control.ts'

const wire = 'engine-runtime/v2' as const
const profile = z.object({ profileId: z.literal('luanti-native/v1'),
 worldPath: z.string().refine(isAbsolute), userPath: z.string().refine(isAbsolute),
 expectedDirectory:z.object({device:z.string().regex(/^\d+$/),inode:z.string().regex(/^\d+$/)}).strict().optional() }).strict()
export interface DirectoryIdentity {device:string;inode:string}
interface RuntimeRecord { query: NativeControlQuery; started: EngineRuntimeStarted; state: 'RUNNING' | 'STOPPED' }
function refusal(code: 'ADAPTER_UNAVAILABLE' | 'WORLD_NOT_FOUND' | 'CONNECTION_NOT_FOUND') {
 return { code, phase: 'validate' as const, retryability: 'AFTER_NEW_FACTS' as const, mutationState: 'NONE' as const,
  transactionRef: null, causeCode: null, reason: 'REQUIRED_FACT_UNKNOWN' as const }
}
export class NativeEngineRuntime implements EngineRuntimePort {
 private readonly control: NativeEngineControl
 private readonly records = new Map<string, RuntimeRecord>()
 private readonly requests = new Map<string, {digest:string; connectionRef:string}>()
 private readonly starting = new Set<string>()
 private readonly startingWorlds = new Set<string>()
 private readonly worldBindings = new Map<string,string>()
 private readonly expectedDirectories = new Map<string,DirectoryIdentity>()
 private closed = false
 private cleanupFailure: {cause: unknown} | undefined
 private readonly queues = new Map<string, Promise<void>>()
 constructor(start: (input: NativeControlInput, expectedDirectory?:DirectoryIdentity) => Promise<NativeControlSession>) {
  this.control = new NativeEngineControl(async input => {
   const expected=this.expectedDirectories.get(input.operationRef)
   const check=async()=>{
    if(!expected)return
    let st
    try{st=await lstat(input.worldPath,{bigint:true})}catch(error){
     if((error as NodeJS.ErrnoException).code==='ENOENT')throw Error('WORLD_NOT_FOUND')
     throw error
    }
    if(!st.isDirectory()||await realpath(input.worldPath)!==input.worldPath
     ||String(st.dev)!==expected.device||String(st.ino)!==expected.inode)throw Error('LOCAL_WORLD_CHANGED')
   }
   await check()
   let session: NativeControlSession
   try { session = await start(input,expected) } catch (error) {
    if (error instanceof NativeCleanupFailure) this.cleanupFailure ??= {cause:error.failure}
    throw error
   }
   const close = async () => {
    try { await session.close() } catch (error) { this.cleanupFailure ??= {cause:error}; throw new NativeCleanupFailure(error) }
   }
   try{await check()}catch(error){await close();throw error}
   if (session.worldPath !== input.worldPath || !Number.isSafeInteger(session.processId) || session.processId < 1) {
    await close(); throw Error('ENGINE_BINDING_MISMATCH')
   }
   return { worldPath:session.worldPath, processId:session.processId, endpoint:session.endpoint,
    alive:()=>session.alive(),verify:()=>session.verify(),stop:()=>session.stop(),
    assertStopped:()=>session.assertStopped(),close }

  })
 }
 async StartWorldRuntime(input: EngineRuntimeStartRequest) {
  const q = validateRequest(wire, 'StartWorldRuntime', input)
  let result: EngineRuntimeStarted | null = null
  let error: ReturnType<typeof refusal> | null = null
  const digest = requestDigest(wire, 'StartWorldRuntime', q)
  try {
   if (this.cleanupFailure) throw new NativeCleanupFailure(this.cleanupFailure.cause)
   if (this.closed || this.starting.has(q.requestId)) throw Error('CONTROL_CLOSED')
   const previous = this.requests.get(q.requestId)
   if (previous) {
    result = await this.serial(previous.connectionRef, async () => {
     const row = this.records.get(previous.connectionRef)
     if (previous.digest !== digest || !row || row.state !== 'RUNNING') throw Error('CONTROL_MISMATCH')
     await this.control.inspect(row.query)
     return row.started
    })
   } else {
    if (this.startingWorlds.has(q.worldRef) || [...this.records.values()].some(row=>row.started.worldRef===q.worldRef&&row.state==='RUNNING')) throw Error('WORLD_ALREADY_RUNNING')
    this.starting.add(q.requestId)
    this.startingWorlds.add(q.worldRef)
    try {
     const selected = profile.parse(q.engineProfile)
     if(selected.expectedDirectory)this.expectedDirectories.set(q.requestId,selected.expectedDirectory)
     const bound = this.worldBindings.get(q.worldRef)
     if (bound && bound !== selected.worldPath) throw Error('ENGINE_BINDING_MISMATCH')
     const native = { worldPath: selected.worldPath, userPath: selected.userPath,
      requesterRef: 'local-runtime', operationRef: q.requestId }
     const lease = await this.control.acquire(native)
     const query = { ...native, controlRef: lease.controlRef }
     await this.control.inspect(query)
     if (this.closed) throw Error('CONTROL_CLOSED')
     // References are minted after native readback, never copied from the request.
     result = { worldRef: q.worldRef, connectionRef: lease.controlRef,
      connectionIncarnationRef: randomUUID(), state: 'RUNNING' }
     for (const [ref, old] of this.records) if (old.query.worldPath === query.worldPath) this.records.delete(ref)
     this.worldBindings.set(q.worldRef,query.worldPath)
     this.records.set(result.connectionRef, {query, started: result, state:'RUNNING'})
     this.requests.set(q.requestId, {digest, connectionRef:result.connectionRef})
    } finally { this.expectedDirectories.delete(q.requestId); this.starting.delete(q.requestId); this.startingWorlds.delete(q.worldRef) }
   }
  } catch (failure) {
   if (failure instanceof NativeCleanupFailure) throw failure.failure
   result = null
   error = refusal(failure instanceof Error && failure.message === 'WORLD_NOT_FOUND'
    ? 'WORLD_NOT_FOUND' : 'ADAPTER_UNAVAILABLE')
  }
  return validateBoundResponse(wire, 'StartWorldRuntime', q, { contractVersion: wire, requestId:q.requestId, result, error })
 }
 private serial<T>(connectionRef: string, work:()=>Promise<T>): Promise<T> {
  const pending = (this.queues.get(connectionRef) ?? Promise.resolve()).then(work)
  // This settled tail serializes independent requests; it does not retry any operation.
  const tail = pending.then(()=>undefined,()=>undefined)
  this.queues.set(connectionRef,tail)
  void tail.then(()=>{if(this.queues.get(connectionRef)===tail)this.queues.delete(connectionRef)})
  return pending
 }
 async StopWorldRuntime(input: EngineRuntimeStopRequest) {
  const q = validateRequest(wire, 'StopWorldRuntime', input)
  return this.serial(q.connectionRef,async()=>{
   const row = this.closed ? undefined : this.records.get(q.connectionRef)
   if (!row) return validateBoundResponse(wire,'StopWorldRuntime',q,
    {contractVersion:wire,requestId:q.requestId,result:null,error:refusal('CONNECTION_NOT_FOUND')})
   // An unproved native exit rejects; it can never supply STOPPED.
   try { await this.control.withStoppedWorld(row.query, async () => { row.state = 'STOPPED' }) }
   catch (error) { if(error instanceof NativeCleanupFailure) throw error.failure; throw error }
   return validateBoundResponse(wire,'StopWorldRuntime',q,
    {contractVersion:wire,requestId:q.requestId,result:{connectionRef:q.connectionRef,state:'STOPPED'},error:null})
  })
 }
 async ReadRuntimeStatus(input: EngineRuntimeReadStatusRequest) {
  const q = validateRequest(wire,'ReadRuntimeStatus',input)
  return this.serial(q.connectionRef,async()=>{
   const row = this.closed ? undefined : this.records.get(q.connectionRef)
   if (row) {
    try {
     if (row.state === 'STOPPED') await this.control.withStoppedWorld(row.query, async () => {})
     else await this.control.inspect(row.query)
     return validateBoundResponse(wire,'ReadRuntimeStatus',q,{contractVersion:wire,requestId:q.requestId,
      result:{...row.started,state:row.state},error:null})
    } catch (error) {
     if (error instanceof NativeCleanupFailure) throw error.failure
     this.records.delete(q.connectionRef)
    }
   }
   return validateBoundResponse(wire,'ReadRuntimeStatus',q,
    {contractVersion:wire,requestId:q.requestId,result:null,error:refusal('CONNECTION_NOT_FOUND')})
  })
 }
 async close(): Promise<void> {
  this.closed = true
  await Promise.all([...this.queues.values()])
  try { await this.control.close() } catch (error) { if(error instanceof NativeCleanupFailure) throw error.failure; throw error }
  if (this.cleanupFailure) throw this.cleanupFailure.cause
  this.records.clear(); this.requests.clear(); this.worldBindings.clear()
 }
}
