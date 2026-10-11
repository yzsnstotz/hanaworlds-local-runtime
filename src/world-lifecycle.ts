/** Neutral lifecycle over the paired Luanti world's published source and engine ports. */
import {createHash, randomUUID} from 'node:crypto'
import {constants} from 'node:fs'
import {lstat, mkdir, open, readFile, realpath} from 'node:fs/promises'
import {dirname, isAbsolute, join} from 'node:path'
import {z} from 'zod'
import {ContractError, describeSourceWorld, validateType, validateRequest, validateBoundResponse, worldLifecycle,
 type OperationMap, type WorldLifecyclePort, type LocalWorldsPort, type EngineRuntimePort,
 type WorldLifecycleWorld, type Error as PublicError, type ErrorCode} from 'hanaworlds-contracts'
import {DesktopLuantiContent} from './luanti-content.ts'

const wire='world-lifecycle/v2' as const
type Operation='describe'|'list'|'create'|'describeDelete'|'delete'|'launch'|'stop'|'play'
export type LocalWorldLifecyclePort=Pick<WorldLifecyclePort,Operation>
/** Engine-side removal guard: no native session may run or start on a directory being deleted. */
export interface WorldRetirement {
 retireWorld<T>(worldPath:string,work:()=>Promise<T>):Promise<T>
 worldInUse(worldPath:string):boolean
}
export interface LifecycleConfig {worldRoots: readonly string[]; userPath?: string; contentBundle?: string; runtimeRoot: string}
type Content=Pick<DesktopLuantiContent,'userPath'|'gameId'|'describe'|'ensure'>
const canonical=z.string().refine(isAbsolute)
const locatorSchema=z.object({locatorVersion:z.literal('hanaworlds-luanti-source-locator/v1'),worldRef:z.string(),
 connectionRef:z.string(),worldPath:canonical,worldRoot:canonical,userPath:canonical.nullable(),
 directory:z.object({device:z.string().regex(/^\d+$/),inode:z.string().regex(/^\d+$/)}).strict(),gameId:z.string().nullable(),
 payload:z.discriminatedUnion('status',[
  z.object({status:z.literal('MISSING'),payloadVersion:z.null(),payloadDigest:z.null()}).strict(),
  z.object({status:z.literal('INSTALLED_UNVERIFIED'),payloadVersion:z.string().min(1),payloadDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 ])}).strict()
type Locator=z.infer<typeof locatorSchema>
const worldId=(ref:string)=>'local-world:'+createHash('sha256').update(ref).digest('hex')
function refusal(code:ErrorCode,causeCode:ErrorCode|null=null):PublicError {
 return {code,phase:'validate',retryability:'AFTER_NEW_FACTS',mutationState:'NONE',transactionRef:null,causeCode,reason:'REQUIRED_FACT_UNKNOWN'}
}
class Refused extends Error {constructor(readonly fact:PublicError, readonly diagnostic:string= fact.code){super(diagnostic)}}
function deny(diagnostic:string,code:ErrorCode='ADAPTER_UNAVAILABLE'):never {throw new Refused(refusal(code),diagnostic)}
function result<T>(response:{result:T|null;error:PublicError|null}):T {
 if(response.error)throw new Refused(response.error)
 if(response.result===null)deny('SOURCE_RESULT_MISSING')
 return response.result
}
/** Independent providers may embed their own SDK. Admit public error facts;
 * never require their private exception constructor to be ours. */
async function peer<T>(call:()=>Promise<T>):Promise<T> {
 try{return await call()}catch(error){
  if(error!==null && typeof error==='object' && 'publicError' in error){
   const fact=validateType('Error',error.publicError)
   throw new ContractError(fact.code,fact.phase,fact.reason,{...fact})
  }
  throw error
 }
}
/** Only the paired world source interprets locators; no locator or engine profile reaches hosts. */
export class LocalWorldLifecycle implements LocalWorldLifecyclePort {
 private closed=false
 private tail:Promise<void>=Promise.resolve()
 private readonly config:LifecycleConfig
 constructor(config:LifecycleConfig,private readonly source:()=>LocalWorldsPort|undefined,
  private readonly engine:EngineRuntimePort&Partial<WorldRetirement>,private readonly content?:()=>Promise<Content>) {
  this.config={...config,worldRoots:[...config.worldRoots]}
 }
 private adapter():LocalWorldsPort {
  const source=this.source()
  if(!source)deny('LOCAL_SOURCE_UNAVAILABLE')
  if(typeof source.describeSourceWorld!=='function')throw new Refused(refusal('CAPABILITY_UNAVAILABLE'),'SOURCE_LOCATOR_CAPABILITY_UNAVAILABLE')
  return source
 }
 private async roots():Promise<string[]> {
  if(!this.config.worldRoots.length)deny('WORLD_ROOTS_REQUIRED')
  const roots=[...new Set(this.config.worldRoots)]
  for(const root of roots)if(!isAbsolute(root)||await realpath(root)!==root||!(await lstat(root)).isDirectory())deny('WORLD_ROOT_NOT_CANONICAL')
  return roots
 }
 private async call<N extends Operation>(operation:N,input:OperationMap[typeof wire][N]['request'],
  work:(q:OperationMap[typeof wire][N]['request'],markMutation:()=>void)=>Promise<OperationMap[typeof wire][N]['response']['result']>):Promise<OperationMap[typeof wire][N]['response']> {
  const q=validateRequest(wire,operation,input) as OperationMap[typeof wire][N]['request']
  const pending=this.tail.then(async()=>{
   let value:OperationMap[typeof wire][N]['response']['result']=null,error:PublicError|null=null
   let mutationStarted=false
   try{if(this.closed)deny('LIFECYCLE_CLOSED');value=await work(q,()=>{mutationStarted=true})}
   catch(failure){
    // Admission is distinct from a provider refusal; never hide malformed peer packets.
    if(failure instanceof ContractError){
     if(mutationStarted)throw new Error('LIFECYCLE_MUTATION_UNPROVEN',{cause:failure})
     throw failure
    }
    if(operation==='stop' && !(failure instanceof Refused))throw failure
    if(operation==='launch' && mutationStarted && !(failure instanceof Refused))throw failure
    const fact=failure instanceof Refused ? failure.fact : refusal('ADAPTER_UNAVAILABLE')
    const declared=worldLifecycle.operations.find(o=>o.wire===wire&&o.operation===operation)!.errors
    // describeDelete/delete declare no ADAPTER_UNAVAILABLE; causeCode keeps the real reason.
    const unavailable=({stop:'CONNECTION_NOT_FOUND',play:'CAPABILITY_UNAVAILABLE',describeDelete:'WORLD_NOT_FOUND',delete:'TRANSACTION_CONFLICT'} as const)[operation as string]??'ADAPTER_UNAVAILABLE'
    error=declared.includes(fact.code)?fact: {...fact,code:unavailable,causeCode:fact.code}
    if(mutationStarted && !(failure instanceof Refused))error={...error,mutationState:'UNKNOWN'}
    console.info('LOCAL_RUNTIME_REJECTED',operation,failure instanceof Refused?failure.diagnostic:'SOURCE_OR_PREREQUISITE_UNAVAILABLE',
     failure instanceof Refused?'':String((failure as Error)?.message??failure))
   }
   return validateBoundResponse(wire,operation,q,{contractVersion:wire,requestId:q.requestId,result:value,error}) as OperationMap[typeof wire][N]['response']
  })
  this.tail=pending.then(()=>undefined,()=>undefined)
  return pending
 }
 private async locate(source:LocalWorldsPort,ref:string,roots:readonly string[]):Promise<Locator> {
  const response=await peer(()=>describeSourceWorld(source,{contractVersion:'local-worlds/v2',requestId:randomUUID(),worldRef:ref}))
  const raw=result(response).sourceLocator,parsed=locatorSchema.safeParse(raw)
  if(!parsed.success)deny('SOURCE_LOCATOR_INVALID')
  const loc=parsed.data
  if(loc.worldRef!==ref||!roots.includes(loc.worldRoot)||dirname(loc.worldPath)!==loc.worldRoot
   ||loc.connectionRef!=='local:'+createHash('sha256').update(loc.worldPath).digest('hex'))deny('SOURCE_LOCATOR_IDENTITY_MISMATCH')
  await this.checkDirectory(loc)
  return loc
 }
 private async checkDirectory(loc:Locator):Promise<void> {
  try{
   const st=await lstat(loc.worldPath,{bigint:true})
   if(!st.isDirectory()||await realpath(loc.worldPath)!==loc.worldPath||await realpath(loc.worldRoot)!==loc.worldRoot
    ||String(st.dev)!==loc.directory.device||String(st.ino)!==loc.directory.inode)deny('SOURCE_LOCATOR_DIRECTORY_MISMATCH')
   if(loc.userPath!==null&&(await realpath(loc.userPath)!==loc.userPath||!(await lstat(loc.userPath)).isDirectory()
    ||this.config.userPath!==undefined&&loc.userPath!==this.config.userPath))deny('SOURCE_LOCATOR_USER_MISMATCH')
  }catch(error){
   if((error as NodeJS.ErrnoException).code==='ENOENT')deny('SOURCE_WORLD_DISAPPEARED','WORLD_NOT_FOUND')
   throw error
  }
 }
 private async metadata(loc:Locator,file:'world.mt'|'map_meta.txt'):Promise<string|null> {
  await this.checkDirectory(loc)
  const path=join(loc.worldPath,file)
  let handle
  try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
  try{
   const before=await handle.stat({bigint:true})
   if(!before.isFile()||await realpath(path)!==path)deny('WORLD_METADATA_NOT_REGULAR')
   const text=await handle.readFile('utf8'),after=await handle.stat({bigint:true}),current=await lstat(path,{bigint:true})
   if(before.dev!==current.dev||before.ino!==current.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs
    ||before.ctimeNs!==after.ctimeNs)deny('WORLD_METADATA_CHANGED')
   await this.checkDirectory(loc)
   return text
  }finally{await handle.close()}
 }
 private async observe(source:LocalWorldsPort,row:WorldLifecycleWorld,roots:readonly string[]) {
  const loc=await this.locate(source,row.worldRef,roots)
  const mt=await this.metadata(loc,'world.mt'),map=await this.metadata(loc,'map_meta.txt')
  const gameId=mt===null?null:/^gameid\s*=\s*(.+)$/m.exec(mt)?.[1]?.trim()??null
  if(gameId!==loc.gameId)deny('SOURCE_LOCATOR_GAME_MISMATCH')
  // The real provider re-reads payload identity; runtime never guesses its disk format.
  const after=await this.locate(source,row.worldRef,roots)
  if(JSON.stringify(loc)!==JSON.stringify(after))deny('SOURCE_LOCATOR_CHANGED')
  if(this.source()!==source)deny('LOCAL_SOURCE_REPLACED')
  const name=mt===null?null:/^world_name\s*=\s*(.+)$/m.exec(mt)?.[1]?.trim()??null
  return {locator:loc,world:{worldId:worldId(row.worldRef),worldRef:row.worldRef,displayName:name||row.displayName,
   tags:[...new Set([...row.tags,...(map!==null&&/^mg_name\s*=\s*flat\s*$/m.test(map)?['flat']:[])])]}}
 }
 private async inventory(source:LocalWorldsPort,roots:readonly string[]) {
  const rows:WorldLifecycleWorld[]=[]
  for(const worldRoot of roots){
   const q={contractVersion:'local-worlds/v2' as const,requestId:randomUUID(),worldRoot}
   const read=result(validateBoundResponse('local-worlds/v2','discover',q,await peer(()=>source.discover(q))))
   rows.push(...read.worlds)
  }
  if(new Set(rows.map(row=>row.worldRef)).size!==rows.length)deny('SOURCE_DUPLICATE_WORLD_REFERENCE')
  return rows
 }
 private async supply():Promise<Content> {
  if(this.content)return this.content()
  if(!this.config.contentBundle||!this.config.userPath)deny('GAME_MOD_SUPPLY_REQUIRED')
  return DesktopLuantiContent.open(this.config.contentBundle,this.config.userPath)
 }
 describe(input:OperationMap[typeof wire]['describe']['request']) {
  return this.call('describe',input,async()=>{
   this.adapter();await this.roots()
   const prerequisites=[{prerequisiteId:'source-locator',label:'Read-only world-source identity locator',satisfied:true}]
   try{
    const content=await this.supply();content.gameId();await content.describe()
    prerequisites.push({prerequisiteId:'game-mod-supply',label:'Game/mod manifest available; installation verifies archive bytes',satisfied:true})
   }catch{prerequisites.push({prerequisiteId:'game-mod-supply',label:'Game/mod supply missing or changed',satisfied:false})}
   // Advertise engine availability only after matching the packaged manifest and binary bytes.
   let installed=false
   try{
    const root=await realpath(this.config.runtimeRoot),manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'))
    const path=manifest.engine.path
    if(typeof path==='string'&&/^[a-zA-Z0-9_./-]+$/.test(path)&&!isAbsolute(path)&&!path.split('/').includes('..')){
     const binary=join(root,path)
     installed=process.platform==='darwin'&&process.arch==='arm64'&&manifest.capabilities?.http===true
      &&await realpath(binary)===binary&&(await lstat(binary)).isFile()
      &&createHash('sha256').update(await readFile(binary)).digest('hex')===manifest.engine.sha256
    }
   }catch{installed=false}
   prerequisites.push({prerequisiteId:'engine-runtime',label:'Verified native engine for this platform',satisfied:installed},
    {prerequisiteId:'graphical-entry',label:'Graphical world entry readback unavailable; spawn is not ENTERED',satisfied:false})
   return {templates:[{templateId:'flat',label:'Flat world'}],canDelete:this.deletable(),canPlay:false,prerequisites}
  })
 }
 /** Deletion needs the source's deleteWorld and an engine that can hold the directory out of use. */
 private deletable():boolean {
  return typeof this.source()?.deleteWorld==='function'&&typeof this.engine.retireWorld==='function'&&typeof this.engine.worldInUse==='function'
 }
 private async selectForDelete(worldIdentity:string) {
  const source=this.adapter(),roots=await this.roots()
  if(!this.deletable())deny('DELETE_CAPABILITY_UNAVAILABLE','TRANSACTION_CONFLICT')
  const row=(await this.inventory(source,roots)).find(row=>worldId(row.worldRef)===worldIdentity)
  if(!row)deny('SOURCE_WORLD_NOT_FOUND','WORLD_NOT_FOUND')
  const {locator}=await this.observe(source,row,roots)
  // The source rechecks its own current name; the hosts' title (world_name) never selects.
  return {source,roots,row,locator}
 }
 list(input:OperationMap[typeof wire]['list']['request']) {
  return this.call('list',input,async()=>{
   const source=this.adapter(),roots=await this.roots(),rows=await this.inventory(source,roots)
   const worlds:WorldLifecycleWorld[]=[]
   for(const row of rows)worlds.push((await this.observe(source,row,roots)).world)
   return {worlds}
  })
 }
 create(input:OperationMap[typeof wire]['create']['request']) {
  return this.call('create',input,async (q,markMutation)=>{
   const source=this.adapter()
   if(q.templateId!=='flat')deny('SOURCE_TEMPLATE_UNAVAILABLE')
   const content=await this.supply()
   if(this.config.userPath!==content.userPath)deny('GAME_MOD_USER_PATH_MISMATCH')
   markMutation();await content.ensure()
   // Migrated Luanti-specific worlds/ setup; selection and connection stay in bridge.
   await mkdir(join(content.userPath,'worlds'),{recursive:true,mode:0o700})
   await this.roots()
   if(this.source()!==source)deny('LOCAL_SOURCE_REPLACED')
   const request={contractVersion:'local-worlds/v2' as const,requestId:q.requestId,templateId:q.templateId,displayName:q.displayName}
   const created=result(validateBoundResponse('local-worlds/v2','createWorld',request,await peer(()=>source.createWorld(request))))
   return {...created,worldId:worldId(created.worldRef)}
  })
 }
 describeDelete(input:OperationMap[typeof wire]['describeDelete']['request']) {
  return this.call('describeDelete',input,async q=>{
   const {row,locator}=await this.selectForDelete(q.worldId)
   const impacts=[`The whole world folder "${row.displayName}" and everything built in it is permanently removed; this cannot be undone.`,
    'The world source refuses deletion while it holds the world open, bound to a session or mid-transaction, or if it cannot prove it created the world.']
   if(this.engine.worldInUse!(locator.worldPath))impacts.push('A local engine is running this world: stop it before deleting.')
   return {worldId:q.worldId,worldRef:row.worldRef,confirmationName:row.displayName,impacts}
  })
 }
 delete(input:OperationMap[typeof wire]['delete']['request']) {
  return this.call('delete',input,async (q,markMutation)=>{
   const {source,roots,row,locator}=await this.selectForDelete(q.worldId)
   if(q.confirmationName!==row.displayName)deny('DELETE_CONFIRMATION_MISMATCH','TRANSACTION_CONFLICT')
   const request={contractVersion:'local-worlds/v2' as const,requestId:q.requestId,worldRef:row.worldRef,confirmationName:q.confirmationName}
   let deleted
   try{
    deleted=await this.engine.retireWorld!(locator.worldPath,async()=>{
     await this.checkDirectory(locator)
     if(this.source()!==source)deny('LOCAL_SOURCE_REPLACED','TRANSACTION_CONFLICT')
     markMutation()
     return result(validateBoundResponse('local-worlds/v2','deleteWorld',request,await peer(()=>source.deleteWorld(request))))
    })
   }catch(error){
    if(error instanceof Error&&error.message==='WORLD_IN_USE')deny('LOCAL_ENGINE_WORLD_IN_USE','TRANSACTION_CONFLICT')
    if(error instanceof Error&&error.message==='CONTROL_CLOSED')deny('LOCAL_ENGINE_CLOSED','TRANSACTION_CONFLICT')
    throw error
   }
   // Readback: the source's fresh inventory must no longer list the world, and its directory must be gone.
   const listed=(await this.inventory(source,roots)).some(other=>other.worldRef===row.worldRef)
   const exists=await lstat(locator.worldPath).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error})
   if(listed||exists)throw Error(`LIFECYCLE_DELETE_READBACK_MISMATCH listed=${listed} exists=${exists}`)
   return {worldId:q.worldId,worldRef:deleted.worldRef,confirmationName:deleted.confirmationName,deleted:true as const}
  })
 }
 launch(input:OperationMap[typeof wire]['launch']['request']) {
  return this.call('launch',input,async (q,markMutation)=>{
   const source=this.adapter(),roots=await this.roots(),rows=await this.inventory(source,roots)
   const row=rows.find(row=>worldId(row.worldRef)===q.worldId)
   if(!row)deny('SOURCE_WORLD_NOT_FOUND','WORLD_NOT_FOUND')
   const {locator}=await this.observe(source,row,roots)
   if(!locator.userPath)deny('SOURCE_USER_PATH_REQUIRED')
   await this.checkDirectory(locator)
   const request={contractVersion:'engine-runtime/v2' as const,requestId:`lifecycle:${q.requestId}`,worldRef:row.worldRef,
    engineProfile:{profileId:'luanti-native/v1',worldPath:locator.worldPath,userPath:locator.userPath,expectedDirectory:locator.directory}}
   markMutation()
   const started=result(validateBoundResponse('engine-runtime/v2','StartWorldRuntime',request,await peer(()=>this.engine.StartWorldRuntime(request))))
   return {worldId:q.worldId,worldRef:row.worldRef,connectionRef:started.connectionRef,connectionIncarnationRef:started.connectionIncarnationRef}
  })
 }
 stop(input:OperationMap[typeof wire]['stop']['request']) {
  return this.call('stop',input,async q=>{
   const request={contractVersion:'engine-runtime/v2' as const,requestId:q.requestId,connectionRef:q.connectionRef}
   return result(validateBoundResponse('engine-runtime/v2','StopWorldRuntime',request,await peer(()=>this.engine.StopWorldRuntime(request))))
  })
 }
 play(input:OperationMap[typeof wire]['play']['request']) {
  return this.call('play',input,async()=>deny('GRAPHICAL_ENTRY_READBACK_UNAVAILABLE','CAPABILITY_UNAVAILABLE'))
 }
 async close():Promise<void>{this.closed=true;await this.tail}
}
