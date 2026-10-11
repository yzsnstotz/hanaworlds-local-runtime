// Copied into a fresh production consumer and run there: no source/dev imports.
import assert from 'node:assert/strict'
import {readFile,mkdir,lstat,realpath,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import * as plugin from 'hanaworlds-local-runtime'
import {createEngineRuntimeMock,createLocalWorldLifecycleMock} from 'hanaworlds-local-runtime/mock'
import fixture from 'hanaworlds-local-runtime/examples/world-lifecycle.json' with {type:'json'}
import {Context} from '@deepseek-ai/cordis'
const packageRoot=new URL('./',import.meta.resolve('hanaworlds-local-runtime'))
assert.throws(()=>createRequire(packageRoot).resolve('hanaworlds-contracts'),{code:'MODULE_NOT_FOUND'})
assert.equal(plugin.name,'hanaworlds-local-runtime')
const lifecycleMock=createLocalWorldLifecycleMock()
for(const x of fixture.exchanges) {
 const input={...x.request,requestId:'production-consumer'}
 const mock=x.response.error?createLocalWorldLifecycleMock({[`${x.wire}:${x.operation}`]:x.response.error.code}):lifecycleMock
 const result=await mock[x.operation](input)
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{...x.response,requestId:input.requestId})
}
const engineMock=createEngineRuntimeMock()
const engineFixture=JSON.parse(await readFile(new URL('../examples/engine-runtime.json',packageRoot)))
for(const x of engineFixture.exchanges) {
 const input={...x.request,requestId:'engine-examples'}
 const mock=x.response.error?createEngineRuntimeMock({[`${x.wire}:${x.operation}`]:x.response.error.code}):engineMock
 assert.deepEqual(JSON.parse(JSON.stringify(await mock[x.operation](input))),{...x.response,requestId:input.requestId})
}
const request={contractVersion:'engine-runtime/v2',requestId:'engine',worldRef:'fixture-world',engineProfile:null}
assert.ok((await engineMock.StartWorldRuntime(request)).result)
assert.equal((await engineMock.StopWorldRuntime({contractVersion:request.contractVersion,requestId:'unknown',connectionRef:'absent'})).error.code,'CONNECTION_NOT_FOUND')
await assert.rejects(engineMock.StartWorldRuntime({...request,unexpected:true}),e=>e.publicError?.code==='UNKNOWN_REQUIRED_FIELD')
assert.throws(()=>createEngineRuntimeMock({'engine-runtime/v2:StopWorldRuntime':'INVALID_NAME'}))
let live=false,stopped=false,starts=0,closes=0
const runtime=new plugin.NativeEngineRuntime(async input=>{
 starts++;live=true;stopped=false
 return {worldPath:input.worldPath,processId:42,alive:()=>live,verify:async()=>{assert.ok(live)},
  stop:async()=>{live=false;stopped=true},assertStopped:async()=>{assert.ok(!live&&stopped)},close:async()=>{closes++;live=false}}
})
const base=await realpath(process.cwd()),root=join(base,'fixture-worlds'),world=join(root,'one')
await mkdir(world,{recursive:true})
await writeFile(join(world,'world.mt'),'world_name = Packed World\ngameid = fixture-game\n')
await writeFile(join(world,'map_meta.txt'),'mg_name = flat\n')
let deleted=false,created=false
const row={worldId:'provider-private-id',worldRef:'packed-world',displayName:'Packed World',tags:[]}
const envelope=(q,result)=>({contractVersion:q.contractVersion,requestId:q.requestId,result,error:null})
const source={
 describeSourceWorld:async q=>{const st=await lstat(world,{bigint:true});return envelope(q,{worldRef:q.worldRef,sourceLocator:{
  locatorVersion:'hanaworlds-luanti-source-locator/v1',worldRef:row.worldRef,connectionRef:'local:'+createHash('sha256').update(world).digest('hex'),
  worldPath:world,worldRoot:root,userPath:base,directory:{device:String(st.dev),inode:String(st.ino)},gameId:'fixture-game',
  payload:{status:'MISSING',payloadVersion:null,payloadDigest:null}}})},
 discover:async q=>envelope(q,{worlds:deleted?[]:[row]}),
 createWorld:async q=>{created=true;return envelope(q,{worldRef:row.worldRef,templateId:q.templateId,displayName:q.displayName,creationFacts:{opaque:['preserved']}})},
 deleteWorld:async q=>{deleted=true;const {rm}=await import('node:fs/promises');await rm(world,{recursive:true});return envelope(q,{worldRef:q.worldRef,confirmationName:q.confirmationName,deleted:true})},
 pair:async()=>{throw Error('PAIR_NOT_AUTHORIZED')},
}
const content={userPath:base,gameId:()=> 'fixture-game',describe:async()=>[],ensure:async()=>{}}
const lifecycle=new plugin.LocalWorldLifecycle({worldRoots:[root],userPath:base,runtimeRoot:join(base,'not-installed')},()=>source,runtime,async()=>content)
const q={contractVersion:'world-lifecycle/v2',requestId:'lifecycle'}
try {
 assert.equal((await lifecycle.describe(q)).result.canPlay,false)
 const worlds=(await lifecycle.list(q)).result.worlds
 assert.equal(worlds.length,1);assert.ok(worlds[0].tags.includes('flat'))
 const made=await lifecycle.create({...q,templateId:'flat',displayName:'Packed World'})
 assert.ok(created);assert.deepEqual(JSON.parse(JSON.stringify(made.result.creationFacts)),{opaque:['preserved']})
 const worldId=worlds[0].worldId
 assert.equal((await lifecycle.describeDelete({...q,worldId})).result.confirmationName,'Packed World')
 const launched=await lifecycle.launch({...q,requestId:'launch',worldId})
 assert.ok(launched.result);assert.equal(starts,1)
 const selection={contractVersion:'engine-runtime/v2',requestId:'read',connectionRef:launched.result.connectionRef}
 assert.equal((await runtime.ReadRuntimeStatus(selection)).result.state,'RUNNING')
 assert.equal((await lifecycle.delete({...q,worldId,confirmationName:'Packed World'})).error.code,'TRANSACTION_CONFLICT')
 assert.equal((await lifecycle.stop({...q,connectionRef:selection.connectionRef})).result.state,'STOPPED')
 assert.equal((await runtime.ReadRuntimeStatus(selection)).result.state,'STOPPED')
 assert.equal((await lifecycle.play({...q,worldId})).error.code,'CAPABILITY_UNAVAILABLE')
 assert.equal((await lifecycle.delete({...q,worldId,confirmationName:'Packed World'})).result.deleted,true)
 assert.equal((await lifecycle.list(q)).result.worlds.length,0)
 assert.equal((await lifecycle.launch({...q,worldId})).error.code,'WORLD_NOT_FOUND')
 assert.equal((await runtime.ReadRuntimeStatus(selection)).error.code,'CONNECTION_NOT_FOUND')
 // Foreign provider errors are validated through their public error facts.
 const foreign=Object.assign(Error('foreign sdk instance'),{publicError:{code:'SCHEMA_INVALID',phase:'decode',retryability:'NEVER',mutationState:'NONE',transactionRef:null,causeCode:null,reason:'INVALID_SHAPE'}})
 source.discover=async()=>{throw foreign}
 await assert.rejects(lifecycle.list(q),e=>e.publicError?.code==='SCHEMA_INVALID')
 source.discover=async input=>envelope({...input,requestId:'wrong-request'},{worlds:[]})
 await assert.rejects(lifecycle.list(q),e=>!!e.publicError)
} finally {await lifecycle.close();await runtime.close()}
assert.equal(live,false);assert.equal(closes,1)
const ctx=new Context()
const fork=ctx.plugin(plugin,{runtimeRoot:join(base,'not-installed'),stateRoot:join(base,'state')})
await fork
try {
 assert.equal((await ctx.get('hanaworldsWorldLifecycle').describe(q)).error.code,'ADAPTER_UNAVAILABLE')
 assert.equal((await ctx.get('hanaworldsEngineRuntime').ReadRuntimeStatus({contractVersion:'engine-runtime/v2',requestId:'host',connectionRef:'absent'})).error.code,'CONNECTION_NOT_FOUND')
} finally {await fork.dispose()}
assert.equal(ctx.get('hanaworldsEngineRuntime'),undefined)
assert.equal(ctx.get('hanaworldsWorldLifecycle'),undefined)
// Exercise the packaged default content path too, through the public lifecycle
// class. Archives and the source port are synthetic; no real game is launched.
const supply=join(base,'content-supply'),contentWork=join(base,'content-work'),userPath=join(base,'content-user')
await mkdir(supply)
const components=[]
for(const [id,kind,files] of [['fixture-game','game',{'game.conf':'title = Fixture Game\n'}],['fixturemod','mod',{'mod.conf':'name = fixturemod\n','init.lua':'-- fixture only\n'}]]) {
 const tree=join(contentWork,id);await mkdir(tree,{recursive:true})
 for(const [file,bytes] of Object.entries(files))await writeFile(join(tree,file),bytes)
 const archive=id+'.tar.gz'
 execFileSync('/usr/bin/tar',['-czf',join(supply,archive),'-C',contentWork,id])
 const bytes=await readFile(join(supply,archive)),hash=value=>createHash('sha256').update(value).digest('hex')
 components.push({id,kind,name:id,version:'fixture',installName:id.replace('-','_'),license:'MIT',
  source:{url:'https://example.invalid/synthetic',page:'https://example.invalid/',revision:'fixture',archiveSha256:hash(bytes),archiveBytes:bytes.length},
  archive,format:'tar.gz',root:id,files:Object.fromEntries(Object.entries(files).map(([file,value])=>[file,hash(value)]))})
}
await writeFile(join(supply,'supply.json'),JSON.stringify({schemaVersion:1,components}))
const defaultLifecycle=new plugin.LocalWorldLifecycle({worldRoots:[join(userPath,'worlds')],userPath,contentBundle:supply,runtimeRoot:join(base,'not-installed')},()=>source,runtime)
try {
 const made=await defaultLifecycle.create({...q,requestId:'content-create',templateId:'flat',displayName:'Packed Content'})
 assert.ok(made.result)
 assert.equal(await readFile(join(userPath,'games/fixture_game/game.conf'),'utf8'),'title = Fixture Game\n')
 assert.equal(await readFile(join(userPath,'mods/fixturemod/init.lua'),'utf8'),'-- fixture only\n')
 assert.ok((await defaultLifecycle.create({...q,requestId:'content-replay',templateId:'flat',displayName:'Packed Content'})).result)
 await writeFile(join(userPath,'mods/fixturemod/init.lua'),'-- changed fixture\n')
 const refused=await defaultLifecycle.create({...q,requestId:'content-changed',templateId:'flat',displayName:'Packed Content'})
 assert.equal(refused.error.code,'ADAPTER_UNAVAILABLE')
 assert.equal(refused.error.mutationState,'UNKNOWN')
 assert.equal(await readFile(join(userPath,'mods/fixturemod/init.lua'),'utf8'),'-- changed fixture\n')
} finally {await defaultLifecycle.close()}
await writeFile('capabilities.json',JSON.stringify({sdkRuntimeAbsent:true,publicEntriesLoaded:true,engineFixture:['start','read','stop','close'],
 lifecycleFixture:['describe','list','create','describeDelete','delete','launch','stop','play-refusal'],
 defaultContentFixture:['game-install','mod-install','idempotent-verify','changed-file-refusal'],cordisFixtureDisposed:true,nativeWorldStarted:false},null,2)+'\n')
console.log('Packed runtime capabilities and public error consumption passed; fixtures only')
