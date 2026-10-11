import {build,version as bundlerVersion} from 'esbuild'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFile,writeFile,mkdir,copyFile,readdir,unlink} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {verifySupply,sha256} from './contract-supply.mjs'
const root=resolve(import.meta.dirname,'..')
const supply=await verifySupply()
await mkdir(join(root,'dist'),{recursive:true})
// Keep user-built native-control; remove only stale generated JS/declarations.
for(const name of await readdir(join(root,'dist')))if(/\.(js|d\.ts|json)$/.test(name))await unlink(join(root,'dist',name))
execFileSync('node',[join(root,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json','--emitDeclarationOnly'],{cwd:root,stdio:'inherit'})
const manifest=JSON.parse(await readFile(join(root,'package.json')))
assert.equal(bundlerVersion,manifest.devDependencies.esbuild,'Incorrect bundler supply')
const result=await build({absWorkingDir:root,entryPoints:['src/index.ts','src/mock.ts'],bundle:true,splitting:true,
 platform:'node',format:'esm',target:'node24',outdir:'dist',chunkNames:'shared-[hash]',metafile:true,
 external:Object.keys(manifest.dependencies),legalComments:'eof',
 plugins:[{name:'engine-fixture-selection',setup(builder){
  builder.onLoad({filter:/fixtures\/local\/world-lifecycle\.json$/},async({path})=>{
   const fixture=JSON.parse(await readFile(path))
   return {contents:JSON.stringify({...fixture,exchanges:fixture.exchanges.filter(x=>x.wire==='engine-runtime/v2')}),loader:'json'}
  })
 }}]})
await copyFile(join(supply.sdk,'LICENSE'),join(root,'licenses/contracts-MIT.txt'))
await copyFile(join(supply.sdk,'NOTICE'),join(root,'licenses/contracts-NOTICE.txt'))
await copyFile(join(root,'node_modules/canonicalize/LICENSE'),join(root,'licenses/canonicalize-Apache-2.0.txt'))
const inputs={}
for(const [path,entry] of Object.entries(result.metafile.inputs)) {
 if(Object.values(result.metafile.outputs).some(o=>(o.inputs[path]?.bytesInOutput??0)>0))inputs[path]={sha256:sha256(await readFile(join(root,path))),bytes:entry.bytes}
}
const artifacts={}
for(const name of (await readdir(join(root,'dist'))).sort())if(/\.(js|d\.ts)$/.test(name))artifacts['dist/'+name]=sha256(await readFile(join(root,'dist',name)))
await writeFile(join(root,'dist/build-source.json'),JSON.stringify({schema:'local-runtime-build/v1',tag:supply.tag,sha:supply.sha,
 version:supply.version,source:supply.pin,resolved:supply.resolved,bundler:'esbuild@'+bundlerVersion,inputs,artifacts,outputs:result.metafile.outputs},null,2)+'\n')
console.log('Built independent runtime from',supply.tag,supply.sha)
