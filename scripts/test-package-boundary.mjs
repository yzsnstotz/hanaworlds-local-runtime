import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp, mkdir, readFile, writeFile,cp,unlink} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {homedir} from 'node:os'
import {auditPackage} from './package-boundary.mjs'
import {sha256} from './contract-supply.mjs'

// Only the child pack's recursive check is elided. Its prepack still rebuilds;
// the waiting parent audits that real tgz. No installation script is disabled.
const runRoot=resolve(process.env.HANAWORLDS_TEST_ROOT??join(homedir(),'.cache/hana-world-runs/local-runtime-contract-build-01'))
await mkdir(runRoot,{recursive:true})
const run=await mkdtemp(join(runRoot,'package-boundary-'))
const env={...process.env,HANAWORLDS_BOUNDARY_PARENT:String(process.pid)}
// npm spawns the lifecycle through a shell: the token is checked in prepack,
// rather than trusting a caller-controlled request to omit an install script.
delete env.NODE_PATH
delete env.NODE_OPTIONS
const output=execFileSync('npm',['pack','--json','--pack-destination',run,'--cache',join(homedir(),'.npm')],{cwd:resolve(import.meta.dirname,'..'),env,encoding:'utf8'})
const packed=JSON.parse(output.slice(output.indexOf('[\n')))[0]
await mkdir(join(run,'unpacked'))
execFileSync('tar',['-xzf',join(run,packed.filename),'-C',join(run,'unpacked')])
const audit=await auditPackage(join(run,'unpacked/package'))
await writeFile(join(run,'audit.json'),JSON.stringify(audit,null,2)+'\n')
const packageDir=join(run,'unpacked/package')
const provenance=JSON.parse(await readFile(join(packageDir,'dist/build-source.json')))
assert.equal(provenance.sha,'f0c6751e984bb15081ea70c351ccbb484c91226c')
assert.equal(provenance.tag,'v2.5.0')
assert.ok(Object.keys(provenance.inputs).some(x=>x.includes('hanaworlds-contracts/dist/')))
for(const [path,digest] of Object.entries(provenance.artifacts))assert.equal(sha256(await readFile(join(packageDir,path))),digest)
await writeFile(join(run,'artifact-sha256.json'),JSON.stringify({file:packed.filename,sha256:sha256(await readFile(join(run,packed.filename)))},null,2)+'\n')
const config=join(run,'manager-config');await mkdir(config)
const productionEnv={PATH:process.env.PATH.split(':').filter(x=>!x.includes('node_modules')).join(':'),HOME:homedir(),LANG:'en_US.UTF-8',CI:'true',XDG_CONFIG_HOME:config,npm_config_cache:join(homedir(),'.npm')}
const pnpm=(cwd,args,log)=>{
 try {const out=execFileSync('npm',['exec','--cache',join(homedir(),'.npm'),'--yes','--package=pnpm@11.28.5','--','pnpm',...args],{cwd,env:productionEnv,encoding:'utf8',stdio:['ignore','pipe','pipe']});if(log)return writeFile(log,out);return out}
 catch(error){if(log)execFileSync(process.execPath,['-e','require("node:fs").writeFileSync(process.argv[1],process.argv[2])',log,String(error.stdout)+String(error.stderr)]);throw error}
}
const install=async(name,tgz)=>{
 const dir=join(run,name);await mkdir(dir)
 await writeFile(join(dir,'package.json'),JSON.stringify({name:'isolated-runtime-consumer',private:true,type:'module',dependencies:{'hanaworlds-local-runtime':'file:'+tgz,'@deepseek-ai/cordis':'4.0.4'}},null,2)+'\n')
 await pnpm(dir,['install','--prod'],join(dir,'install.log'))
 return dir
}
const consumer=await install('production',join(run,packed.filename))
const graph=pnpm(consumer,['list','--prod','--depth','Infinity','--json'])
assert.ok(!graph.includes('hanaworlds-contracts'),'Contract present in production resolution graph')
await writeFile(join(consumer,'resolution-graph.json'),graph)
assert.equal(pnpm(consumer,['--version']).trim(),'11.28.5')
const managerConfig=JSON.parse(pnpm(consumer,['config','list','--json']))
for(const [key,value] of Object.entries(managerConfig))if(/block.?exotic|strict.?dep.?build|ignore.?scripts|allow.?build|override|hook/i.test(key))throw Error('Non-default production policy: '+key+'='+String(value))
await writeFile(join(consumer,'manager-defaults.json'),JSON.stringify({version:'11.28.5',policy:'default',policyOverridesPresent:false,registry:managerConfig.registry},null,2)+'\n')
const lockText=await readFile(join(consumer,'pnpm-lock.yaml'),'utf8')
assert.ok(!lockText.includes('hanaworlds-contracts'))
await cp(new URL('./check-production.mjs',import.meta.url),join(consumer,'check-production.mjs'))
const capabilities=execFileSync(process.execPath,['check-production.mjs'],{cwd:consumer,env:productionEnv,encoding:'utf8'})
await writeFile(join(consumer,'capabilities.log'),capabilities)
for(const {target,types} of audit.entries)if(!types) {
 const path=join(consumer,'node_modules/hanaworlds-local-runtime',target)
 const code=target.endsWith('.json')?'JSON.parse(require("node:fs").readFileSync(process.argv[1]))':'import(require("node:url").pathToFileURL(process.argv[1]).href)'
 execFileSync(process.execPath,['-e',code,path],{cwd:consumer,env:productionEnv,stdio:'pipe'})
}
// Every counterexample is an actual damaged packed candidate, retained for audit.
const failures=[]
for(const [name,edit,pattern] of [
 ['production-contract',async d=>{const p=JSON.parse(await readFile(join(d,'package.json')));p.dependencies['hanaworlds-contracts']=p.devDependencies['hanaworlds-contracts'];await writeFile(join(d,'package.json'),JSON.stringify(p))},/Production contract dependency/],
 ['bare-value',d=>writeFile(join(d,'dist/index.js'),"import 'hanaworlds-contracts';\n"),/Residual contract runtime load/],
 ['hash-import',async d=>{const p=JSON.parse(await readFile(join(d,'package.json')));p.imports={'#contracts':'hanaworlds-contracts'};await writeFile(join(d,'package.json'),JSON.stringify(p));await writeFile(join(d,'dist/index.js'),"import '#contracts';\n")},/Residual contract package import/],
 ['dynamic-import',d=>writeFile(join(d,'dist/index.js'),"const value='hanaworlds-contracts'; await import(value);\n"),/Dynamic runtime loader/],
 ['require-value',d=>writeFile(join(d,'dist/index.js'),"require('hanaworlds-contracts');\n"),/Residual contract runtime load/],
 ['resolve-value',d=>writeFile(join(d,'dist/index.js'),"import.meta.resolve('hanaworlds-contracts/package.json');\n"),/Residual contract runtime load/],
 ['external-json',d=>writeFile(join(d,'dist/index.js'),"new URL('../../development/schema.json',import.meta.url);\n"),/Resource escapes package/],
 ['dynamic-json',d=>writeFile(join(d,'dist/index.js'),"const file='schema.json';new URL(file,import.meta.url);\n"),/Dynamic runtime loader/],
 ['missing-local',d=>writeFile(join(d,'dist/index.js'),"import './missing-bundle.js';\n"),/ENOENT/],
 ['undeclared-package',d=>writeFile(join(d,'dist/index.js'),"import 'unlisted-sdk';\n"),/Undeclared runtime dependency/],
 ['unused-import-map',async d=>{const p=JSON.parse(await readFile(join(d,'package.json')));p.imports={'#sdk':'hanaworlds-contracts'};await writeFile(join(d,'package.json'),JSON.stringify(p))},/Residual contract runtime load/],
 ['indirect-loader',d=>writeFile(join(d,'dist/index.js'),"const load=require;load('hanaworlds-contracts');\n"),/Indirect runtime loader/],
 ['indirect-resolver',d=>writeFile(join(d,'dist/index.js'),"const find=import.meta.resolve;find('hanaworlds-contracts');\n"),/Indirect runtime resolver/],
 ['development-readback',d=>writeFile(join(d,'dist/index.js'),"import {readFileSync} from 'node:fs';const file='node_modules/hanaworlds-contracts/package.json';readFileSync(file);\n"),/External development resource readback/],
 ['function-loader',d=>writeFile(join(d,'dist/index.js'),"export function loader(){return new Function('return import(\"hanaworlds-contracts\")')()}\n"),/Unbounded runtime loader/],
 ['joined-development-path',d=>writeFile(join(d,'dist/index.js'),"import {readFileSync as readResource} from 'node:fs';const base='node_modules/'+'hanaworlds-contracts/';const file=base+'package.json';export function read(){return readResource(file)}\n"),/External development resource readback/],
 ['template-development-path',d=>writeFile(join(d,'dist/index.js'),"import {readFileSync as readResource} from 'node:fs';const name='hanaworlds-contracts';const file=`node_modules/${name}/package.json`;export function read(){return readResource(file)}\n"),/External development resource readback/],
 ['missing-fixture',d=>unlink(join(d,'examples/world-lifecycle.json')),/ENOENT/],
 ['wrong-source',async d=>{const p=JSON.parse(await readFile(join(d,'dist/build-source.json')));p.sha='0'.repeat(40);await writeFile(join(d,'dist/build-source.json'),JSON.stringify(p))},/Wrong build source SHA/],
 ['wrong-resolved',async d=>{const p=JSON.parse(await readFile(join(d,'dist/build-source.json')));p.resolved='git+https://github.com/other/contracts.git#'+p.sha;await writeFile(join(d,'dist/build-source.json'),JSON.stringify(p))},/Wrong build resolved identity/],
 ['unrecorded-artifact',d=>writeFile(join(d,'dist/unrecorded-helper'),'unadmitted existing output'),/Unrecorded dist artifact/],
]) {
 const dir=join(run,'negative-'+name);await cp(packageDir,join(dir,'package'),{recursive:true});await edit(join(dir,'package'))
 // Match a real broken build: provenance must describe the changed bytes, so
 // the semantic boundary check cannot be hidden behind a stale digest failure.
 const provenanceFile=join(dir,'package/dist/build-source.json')
 const candidateSource=JSON.parse(await readFile(provenanceFile))
 for(const path of Object.keys(candidateSource.artifacts))candidateSource.artifacts[path]=sha256(await readFile(join(dir,'package',path)))
 await writeFile(provenanceFile,JSON.stringify(candidateSource))
 const tgz=join(dir,'candidate.tgz');execFileSync('tar',['-czf',tgz,'-C',dir,'package'])
 // Extract the mutated tgz before checking, so tests cannot pass on source alone.
 await mkdir(join(dir,'readback'));execFileSync('tar',['-xzf',tgz,'-C',join(dir,'readback')])
 await assert.rejects(auditPackage(join(dir,'readback/package')),pattern)
 if(name==='production-contract') {
  await assert.rejects(install('rejected-exotic-subdependency',tgz),e=>/EXOTIC|exotic/.test(String(e.stdout)+String(e.stderr)))
 }
 if(name==='bare-value'||name==='missing-local') {
  const bad=await install('installed-negative-'+name,tgz)
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',"await import('hanaworlds-local-runtime')"],{cwd:bad,env:productionEnv,stdio:'pipe'}),e=>String(e.stderr).includes('ERR_MODULE_NOT_FOUND'))
 }
 failures.push({name,artifact:tgz,result:'rejected'})
}
const unreviewed=join(run,'negative-unreviewed-build');await cp(packageDir,join(unreviewed,'package'),{recursive:true})
const unreviewedManifest=JSON.parse(await readFile(join(unreviewed,'package/package.json')))
unreviewedManifest.scripts.postinstall='node -e "process.exit(0)"'
await writeFile(join(unreviewed,'package/package.json'),JSON.stringify(unreviewedManifest))
const unreviewedTgz=join(unreviewed,'candidate.tgz');execFileSync('tar',['-czf',unreviewedTgz,'-C',unreviewed,'package'])
await assert.rejects(install('rejected-unreviewed-build',unreviewedTgz),e=>/ERR_PNPM_IGNORED_BUILDS/.test(String(e.stdout)+String(e.stderr)))
failures.push({name:'unreviewed-build',artifact:unreviewedTgz,result:'default strictDepBuilds rejected'})
// Source identity tampering must fail the actual normal build supply gate.
const supplyRoot=resolve(import.meta.dirname,'../node_modules/hanaworlds-contracts')
const sdkFile=join(supplyRoot,'dist/local/index.mjs'),original=await readFile(sdkFile)
try {
 await writeFile(sdkFile,Buffer.concat([original,Buffer.from('\n// incorrect supply\n')]))
 assert.throws(()=>execFileSync(process.execPath,['scripts/build.mjs'],{cwd:resolve(import.meta.dirname,'..'),stdio:'pipe'}),e=>String(e.stderr).includes('Development supply changed'))
} finally {await writeFile(sdkFile,original)}
failures.push({name:'development-source-tamper',result:'normal build rejected'})
await writeFile(join(run,'negative-results.json'),JSON.stringify(failures,null,2)+'\n')
console.log('Package boundary passed:',run)
