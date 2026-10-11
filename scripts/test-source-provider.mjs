/** Readback through a separately installed published provider; never loads a sibling checkout. */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,writeFile,readdir,lstat,realpath,rename} from 'node:fs/promises'
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
const base=await realpath(await mkdtemp(join(runDirectory,'published-source-'))),root=join(base,'worlds')
await mkdir(root)
for(const name of ['a','b']) {
 const path=join(root,name);await mkdir(path)
 await writeFile(join(path,'world.mt'),'world_name = Same name\ngameid = mineclone2\n')
 await writeFile(join(path,'map_meta.txt'),'mg_name = flat\n')
}
async function snapshot(dir) {
 const rows=[]
 for(const entry of await readdir(dir,{withFileTypes:true})){
  const path=join(dir,entry.name),st=await lstat(path,{bigint:true})
  rows.push({path,device:String(st.dev),inode:String(st.ino),size:String(st.size),mtime:String(st.mtimeNs),ctime:String(st.ctimeNs),mode:String(st.mode),
   ...(entry.isFile()?{sha256:createHash('sha256').update(await readFile(path)).digest('hex')}: {})})
  if(entry.isDirectory())rows.push(...await snapshot(path))
 }
 return rows.sort((a,b)=>a.path.localeCompare(b.path))
}
const before=await snapshot(base),ctx=new Context()
// No listening web server: the provider's unrelated status route is registered to a fixture.
ctx.provide('webServer',{register:()=>()=>{}})
const sourceFork=ctx.plugin(adapter,{localWorldRoots:[root],localUserPath:base,localGameId:'mineclone2'})
await sourceFork
const runtimeFork=ctx.plugin(runtimePlugin,{worldRoots:[root],userPath:base,runtimeRoot:join(base,'not-installed'),stateRoot:join(base,'state')})
await runtimeFork
try {
 const port=ctx.get('hanaworldsWorldLifecycle'),source=ctx.get('hanaworldsLuantiLocalWorlds')
 const q={contractVersion:'world-lifecycle/v2',requestId:'published-source-list'}
 const list=await port.list(q)
 assert.equal(list.error,null)
 assert.equal(list.result.worlds.length,2)
 assert.equal(new Set(list.result.worlds.map(w=>w.worldId)).size,2)
 assert.ok(list.result.worlds.every(w=>w.displayName==='Same name'&&w.tags.includes('flat')))
 assert.ok(!JSON.stringify(list).includes(base))
 assert.deepEqual(await snapshot(base),before)
 const world=list.result.worlds[0]
 const description=await source.describeSourceWorld({contractVersion:'local-worlds/v2',requestId:'real-provider-read',worldRef:world.worldRef})
 assert.equal(description.error,null)
 const launch=await port.launch({...q,requestId:'artifact-missing',worldId:world.worldId})
 assert.equal(launch.error.code,'ADAPTER_UNAVAILABLE')
 // Fresh real-provider observation is required even when launch cannot find an engine.
 assert.deepEqual(await snapshot(base),before)
 await rename(description.result.sourceLocator.worldPath,description.result.sourceLocator.worldPath+'-moved')
 const gone=await port.launch({...q,requestId:'source-disappeared',worldId:world.worldId})
 assert.equal(gone.error.code,'WORLD_NOT_FOUND')
 console.log(JSON.stringify({evidence:'REAL_PROVIDER/SOURCE_FILESYSTEM; constructed worlds, no real Luanti or UI',providerMain:'2d0c8d2fdc1a0733bc9cabf27f1589fe2a38ab63',
  sameNameWorlds:2,treeUnchanged:true,missingEngine:'ADAPTER_UNAVAILABLE',disappearedWorld:'WORLD_NOT_FOUND',retainedEvidence:base}))
}finally{await runtimeFork.dispose();await sourceFork.dispose()}
