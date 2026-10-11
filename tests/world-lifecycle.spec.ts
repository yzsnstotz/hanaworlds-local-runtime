import {afterEach, expect, it} from 'vitest'
import {createHash} from 'node:crypto'
import {mkdtemp, mkdir, writeFile, lstat, realpath, rm, rename, symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {validateBoundResponse, type LocalWorldsPort} from 'hanaworlds-contracts'
import * as plugin from '../src/index.ts'
import {NativeEngineRuntime} from '../src/engine-runtime.ts'
import {testRoot} from './test-root.ts'

const cleanups: Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup()})
const q={contractVersion:'world-lifecycle/v2' as const,requestId:'test'}
async function rig() {
 expect(typeof (plugin as any).LocalWorldLifecycle).toBe('function')
 const base=await realpath(await mkdtemp(join(testRoot(),'lifecycle-')))
 cleanups.push(()=>rm(base,{recursive:true,force:true}))
 const root=join(base,'worlds');await mkdir(root)
 const worlds=[{worldId:'adapter-a',worldRef:'source-a',displayName:'Same',tags:[] as string[]},
  {worldId:'adapter-b',worldRef:'source-b',displayName:'Same',tags:[] as string[]}]
 const paths=new Map(worlds.map((w,i)=>[w.worldRef,join(root,`world-${i}`)]))
 for(const path of paths.values()){
  await mkdir(path);await writeFile(join(path,'world.mt'),'world_name = Same\ngameid = mineclone2\n')
  await writeFile(join(path,'map_meta.txt'),'mg_name = flat\n')
 }
 let starts=0,sourceReads=0,created=0,stopped=false,live=false
 const facts={private:{notADirectory: '/never/read/from/facts'},supplied:['game','mod']}
 const calls:string[]=[]
 const source:LocalWorldsPort={
  async discover(input){calls.push('discover');return {contractVersion:input.contractVersion,requestId:input.requestId,result:{worlds},error:null}},
  async createWorld(input){created++;return validateBoundResponse('local-worlds/v2','createWorld',input,
   {contractVersion:input.contractVersion,requestId:input.requestId,result:{worldRef:'source-a',templateId:input.templateId,displayName:input.displayName,creationFacts:facts},error:null})},
  async pair(){calls.push('pair');throw Error('PAIR_MUST_NOT_BE_USED')},
  async deleteWorld(){throw Error('OUT_OF_CARD')},
  async describeSourceWorld(input){
   sourceReads++;calls.push('source');const path=paths.get(input.worldRef)!
   let stat
   try {stat=await lstat(path,{bigint:true})}catch(error){
    if((error as any).code!=='ENOENT')throw error
    return {contractVersion:input.contractVersion,requestId:input.requestId,result:null,error:{code:'WORLD_NOT_FOUND',phase:'validate',retryability:'AFTER_NEW_FACTS',mutationState:'NONE',transactionRef:null,causeCode:null,reason:'REQUIRED_FACT_UNKNOWN'}}
   }
   return validateBoundResponse('local-worlds/v2','describeSourceWorld',input,
    {contractVersion:input.contractVersion,requestId:input.requestId,result:{worldRef:input.worldRef,sourceLocator:{
     locatorVersion:'hanaworlds-luanti-source-locator/v1',worldRef:input.worldRef,
     connectionRef:'local:'+createHash('sha256').update(path).digest('hex'),worldPath:path,worldRoot:root,userPath:base,
     directory:{device:String(stat.dev),inode:String(stat.ino)},gameId:'mineclone2',
     payload:{status:'MISSING',payloadVersion:null,payloadDigest:null}}},error:null})
  },
 }
 // Explicit filesystem-backed source fixture; not a real Adapter or engine.
 const engine=new NativeEngineRuntime(async input=>{starts++;calls.push('start');live=true;stopped=false;return {
  worldPath:input.worldPath,processId:42,alive:()=>live,verify:async()=>{if(!live)throw Error('DEAD')},
  stop:async()=>{stopped=true;live=false},assertStopped:async()=>{if(!stopped)throw Error('STOP_UNPROVEN')},close:async()=>{live=false}}})
 cleanups.push(()=>engine.close())
 const content={userPath:base,gameId:()=> 'mineclone2',describe:async()=>[{state:'INSTALLED_VERIFIED'}],ensure:async()=>{calls.push('ensure')}}
 const runtime=new (plugin as any).LocalWorldLifecycle({worldRoots:[root],userPath:base,runtimeRoot:'/not-installed'},()=>source,engine,async()=>content)
 cleanups.push(()=>runtime.close())
 return {runtime,source,engine,paths,root,base,calls,facts,starts:()=>starts,reads:()=>sourceReads,created:()=>created}
}
it('exports the six-operation lifecycle provider',()=>{
 expect(typeof (plugin as any).LocalWorldLifecycle).toBe('function')
})
it('lists same-name worlds by source reference with verified Luanti tags and no path leak',async()=>{
 const r=await rig();const response=await r.runtime.list(q)
 validateBoundResponse(q.contractVersion,'list',q,response)
 expect(response.error).toBeNull();const rows=response.result.worlds
 expect(rows.map((w:any)=>w.displayName)).toEqual(['Same','Same'])
 expect(new Set(rows.map((w:any)=>w.worldId)).size).toBe(2)
 expect(rows.every((w:any)=>w.tags.includes('flat'))).toBe(true)
 expect(JSON.stringify(response)).not.toContain(r.base)
 expect(r.starts()).toBe(0);expect(r.calls).not.toContain('pair')
})
it('declares missing prerequisites and refuses ENTERED without graphical entry proof',async()=>{
 const r=await rig();const description=await r.runtime.describe(q)
 expect(description.result).toMatchObject({templates:[{templateId:'flat'}],canDelete:false,canPlay:false})
 expect(description.result.prerequisites).toContainEqual({prerequisiteId:'graphical-entry',label:expect.any(String),satisfied:false})
 const play=await r.runtime.play({...q,worldId:'anything'})
 expect(play.error.code).toBe('CAPABILITY_UNAVAILABLE');expect(r.starts()).toBe(0)
})
it('forwards template/name and opaque creationFacts without connecting or reading a facts path',async()=>{
 const r=await rig();const input={...q,templateId:'flat',displayName:'Requested'}
 const response=await r.runtime.create(input)
 validateBoundResponse(q.contractVersion,'create',input,response)
 expect(response.result.creationFacts).toEqual(r.facts)
 expect(r.created()).toBe(1);expect(r.starts()).toBe(0);expect(r.reads()).toBe(0)
 expect(r.calls).toEqual(['ensure'])
 expect(response.result.worldId).toBe((await r.runtime.list(q)).result.worlds[0].worldId)
})
it('launches an existing unpaired source only after locator verification, and stops exact engine connection',async()=>{
 const r=await rig();const world=(await r.runtime.list(q)).result.worlds[1]
 const input={...q,worldId:world.worldId};const launched=await r.runtime.launch(input)
 validateBoundResponse(q.contractVersion,'launch',input,launched)
 expect(launched.result.worldRef).toBe('source-b');expect(r.starts()).toBe(1)
 expect(r.calls).not.toContain('pair')
 expect(JSON.stringify(launched)).not.toContain(r.base)
 const stopped=await r.runtime.stop({...q,connectionRef:launched.result.connectionRef})
 expect(stopped.result.state).toBe('STOPPED')
 expect((await r.runtime.stop({...q,connectionRef:'forged'})).error.code).toBe('CONNECTION_NOT_FOUND')
})
it('refuses absent locator capability without pair/start or interpretation of creationFacts',async()=>{
 const r=await rig();delete r.source.describeSourceWorld
 expect((await r.runtime.list(q)).error.code).toBe('ADAPTER_UNAVAILABLE')
 expect(r.starts()).toBe(0);expect(r.calls).not.toContain('pair')
})
it.each(['inode','ref','root','game','symlink','userPath','payload'])('refuses %s locator mismatch before engine start',async kind=>{
 const r=await rig();const listed=await r.runtime.list(q);const id=listed.result.worlds[0].worldId
 const original=r.source.describeSourceWorld!.bind(r.source)
 r.source.describeSourceWorld=async input=>{
  const response=structuredClone(await original(input));const loc=(response.result as any).sourceLocator
  if(kind==='inode')loc.directory.inode='0'
  if(kind==='ref')loc.worldRef='another'
  if(kind==='root')loc.worldRoot=r.base
  if(kind==='game')loc.gameId='another'
  if(kind==='userPath')loc.userPath=null
  if(kind==='payload' && r.reads()%2===0)loc.payload={status:'INSTALLED_UNVERIFIED',payloadVersion:'1',payloadDigest:'a'.repeat(64)}
  if(kind==='symlink'){
   const path=r.paths.get(input.worldRef)!;const link=path+'-link';try{await symlink(path,link)}catch(error){if((error as any).code!=='EEXIST')throw error}loc.worldPath=link
  }
  return response
 }
 const response=await r.runtime.launch({...q,worldId:id})
 expect(response.result).toBeNull();expect(response.error.code).toBe('ADAPTER_UNAVAILABLE');expect(r.starts()).toBe(0)
})
it('does not claim NONE when the source throws after world mutation',async()=>{
 const r=await rig()
 r.source.createWorld=async()=>{await writeFile(join(r.base,'partial-world'),'source wrote before throwing');throw Error('WRITE_FAILED')}
 const response=await r.runtime.create({...q,templateId:'flat',displayName:'Partial'})
 expect(response.error.mutationState).toBe('UNKNOWN')
})
it('refuses deleted worlds and same-name substitutes rather than matching their names',async()=>{
 const r=await rig();const id=(await r.runtime.list(q)).result.worlds[0].worldId
 await rename(r.paths.get('source-a')!,join(r.root,'moved'))
 const response=await r.runtime.launch({...q,worldId:id})
 expect(response.error.code).toBe('WORLD_NOT_FOUND');expect(r.starts()).toBe(0)
})
it('rejects malformed envelopes before content installation and awaits active work on close',async()=>{
 const r=await rig()
 await expect(r.runtime.create({...q,templateId:'flat',displayName:'A',extra:true})).rejects.toThrow()
 expect(r.created()).toBe(0);expect(r.calls).toEqual([])
 await r.runtime.close()
 expect((await r.runtime.list(q)).error.code).toBe('ADAPTER_UNAVAILABLE')
 expect((await r.runtime.stop({...q,connectionRef:'stale'})).error.code).toBe('CONNECTION_NOT_FOUND')
 expect((await r.runtime.play({...q,worldId:'stale'})).error.code).toBe('CAPABILITY_UNAVAILABLE')
})
