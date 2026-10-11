/** Delete readback through a separately installed published provider; never loads a sibling checkout. */
import assert from 'node:assert/strict'
import {mkdir,mkdtemp,readFile,writeFile,lstat,realpath} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import * as runtimePlugin from '../dist/index.js'
const [providerInstall,runDirectory]=process.argv.slice(2)
if(!providerInstall||!runDirectory)throw Error('Expected independent provider install and card run directory')
const lock=JSON.parse(await readFile(join(providerInstall,'package-lock.json'),'utf8'))
assert.ok(lock.packages['node_modules/hanaworlds-adapter-luanti'].resolved.endsWith('#2d0c8d2fdc1a0733bc9cabf27f1589fe2a38ab63'))
const adapter=await import(pathToFileURL(resolve(providerInstall,'node_modules/hanaworlds-adapter-luanti/src/index.mjs')))
await mkdir(runDirectory,{recursive:true})
const base=await realpath(await mkdtemp(join(runDirectory,'published-delete-'))),root=join(base,'worlds')
await mkdir(root)
// Constructed game fixture (game.conf only) so the source's own flat creation can run; no real game content.
await mkdir(join(base,'games','mineclone2'),{recursive:true})
await writeFile(join(base,'games','mineclone2','game.conf'),'title = Fixture game\n')
// A world the source did not create: the source must refuse to delete it.
await mkdir(join(root,'foreign'))
await writeFile(join(root,'foreign','world.mt'),'world_name = foreign\ngameid = mineclone2\n')
// Peer fixtures, not local-runtime evidence: a DSH home for the source's journal and a Canvas
// selection inventory where no session selects any world (the precondition desktop-bridge establishes).
const home=join(base,'dsh-home');await mkdir(home);process.env.DSH_HOME=home
const canvasCalls=[]
const canvas={async call(name,q){
 canvasCalls.push(name)
 const result=name==='ListWorldSelections'?{worldRef:q.worldRef,inventoryRevision:'r1',sessionRefs:[],retirementReservationRef:null}
  :name==='ReserveWorldRetirement'?{worldRef:q.worldRef,reservationRef:'fixture-reservation',inventoryRevision:q.expectedInventoryRevision}
  :{worldRef:q.worldRef,reservationRef:q.reservationRef,outcome:q.outcome,inventoryRevision:'r1'}
 return {contractVersion:q.contractVersion,requestId:q.requestId,result,error:null}
}}
const ctx=new Context()
ctx.provide('webServer',{register:()=>()=>{}})
ctx.provide('dshHomePath',(...segments)=>join(home,...segments))
ctx.provide('hanaworldsCanvasV5',canvas)
const sourceFork=ctx.plugin(adapter,{localWorldRoots:[root],localUserPath:base,localCreationRoot:root,localGameId:'mineclone2'})
await sourceFork
const runtimeFork=ctx.plugin(runtimePlugin,{worldRoots:[root],userPath:base,runtimeRoot:join(base,'not-installed'),stateRoot:join(base,'state')})
await runtimeFork
try {
 const port=ctx.get('hanaworldsWorldLifecycle'),source=ctx.get('hanaworldsLuantiLocalWorlds')
 const q={contractVersion:'world-lifecycle/v2',requestId:'published-delete'}
 assert.equal((await port.describe(q)).result.canDelete,true)
 // Setup only: the source's own createWorld writes its ownership marker.
 const made=await source.createWorld({contractVersion:'local-worlds/v2',requestId:'setup-create',templateId:'flat',displayName:'Doomed'})
 assert.equal(made.error,null,JSON.stringify(made.error))
 const listed=(await port.list(q)).result.worlds
 const doomed=listed.find(w=>w.worldRef===made.result.worldRef),foreign=listed.find(w=>w.worldRef!==made.result.worldRef)
 assert.ok(doomed&&foreign)
 const description=await port.describeDelete({...q,worldId:doomed.worldId})
 assert.equal(description.error,null,JSON.stringify(description.error))
 assert.ok(!JSON.stringify(description).includes(base))
 const wrong=await port.delete({...q,requestId:'wrong-name',worldId:doomed.worldId,confirmationName:description.result.confirmationName+'x'})
 assert.equal(wrong.error.code,'TRANSACTION_CONFLICT')
 const refused=await port.delete({...q,requestId:'foreign',worldId:foreign.worldId,
  confirmationName:(await port.describeDelete({...q,worldId:foreign.worldId})).result.confirmationName})
 assert.equal(refused.error.code,'TRANSACTION_CONFLICT')
 const deleted=await port.delete({...q,requestId:'real-delete',worldId:doomed.worldId,confirmationName:description.result.confirmationName})
 assert.equal(deleted.error,null,JSON.stringify(deleted.error))
 assert.equal(deleted.result.deleted,true)
 const after=(await port.list(q)).result.worlds.map(w=>w.worldId)
 assert.deepEqual(after,[foreign.worldId])
 const path=join(root,description.result.confirmationName)
 assert.equal(await lstat(path).then(()=>true,()=>false),false)
 console.log(JSON.stringify({evidence:'REAL_PROVIDER/SOURCE_FILESYSTEM; source-created and constructed worlds, no real Luanti or UI',
  providerMain:'2d0c8d2fdc1a0733bc9cabf27f1589fe2a38ab63',confirmationName:description.result.confirmationName,impacts:description.result.impacts,
  canvasCalls,wrongName:wrong.error.code,foreignWorld:{code:refused.error.code,reason:refused.error.reason},deleted:true,listAfter:after.length,retainedEvidence:base}))
}finally{await runtimeFork.dispose();await sourceFork.dispose()}
