/** Actual OS child/UDP lifecycle against a synthetic executable; no Luanti/UI acceptance. */
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,writeFile,rm,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {testRoot} from './test-root.ts'
import {NativeEngineRuntime} from '../src/engine-runtime.ts'
import {startNativeEngineSession} from '../src/native-engine-session.ts'
it.skipIf(process.platform!=='darwin'||process.arch!=='arm64')('starts, verifies, stops and reincarnates the exact OS child',async()=>{
 const root=await realpath(await mkdtemp(join(testRoot(),'native-fixture-')))
 const engineRoot=join(root,'engine'),userPath=join(root,'user'),worldPath=join(userPath,'worlds','world')
 await mkdir(engineRoot);await mkdir(worldPath,{recursive:true});await writeFile(join(worldPath,'world.mt'),'world_name = Fixture\n')
 const binary=`#!${process.execPath}\n`+String.raw`
const fs=require('node:fs'),dgram=require('node:dgram'),path=require('node:path');
const args=process.argv.slice(2),config=fs.readFileSync(args[args.indexOf('--config')+1],'utf8');
const port=Number(/^port = (\d+)$/m.exec(config)[1]);
const world=args[args.indexOf('--world')+1],fd=fs.openSync(path.join(world,'world.mt'),'r');
const udp=dgram.createSocket('udp4');
udp.bind(port,'127.0.0.1',()=>console.log('listening on 127.0.0.1:'+port+'.'));
process.on('SIGINT',()=>udp.close(()=>{fs.closeSync(fd);process.exit(0)}));
`
 await writeFile(join(engineRoot,'server'),binary,{mode:0o700})
 await writeFile(join(engineRoot,'manifest.json'),JSON.stringify({capabilities:{http:true},engine:{path:'server',sha256:createHash('sha256').update(binary).digest('hex')}}))
 const runtime=new NativeEngineRuntime(input=>startNativeEngineSession(engineRoot,join(root,'state'),input))
 try {
  const q={contractVersion:'engine-runtime/v2' as const,requestId:'native-start',worldRef:'fixture-world',engineProfile:{profileId:'luanti-native/v1',worldPath,userPath}}
  const first=await runtime.StartWorldRuntime(q);expect(first.error).toBeNull()
  const selector={contractVersion:q.contractVersion,requestId:'status',connectionRef:first.result!.connectionRef}
  expect((await runtime.ReadRuntimeStatus(selector)).result?.state).toBe('RUNNING')
  expect((await runtime.StopWorldRuntime({...selector,requestId:'stop'})).result?.state).toBe('STOPPED')
  expect((await runtime.ReadRuntimeStatus(selector)).result?.state).toBe('STOPPED')
  const second=await runtime.StartWorldRuntime({...q,requestId:'restart'})
  expect(second.error).toBeNull()
  expect(second.result?.connectionIncarnationRef).not.toBe(first.result!.connectionIncarnationRef)
  expect((await runtime.ReadRuntimeStatus(selector)).error?.code).toBe('CONNECTION_NOT_FOUND')
  await runtime.StopWorldRuntime({...selector,requestId:'stop-second',connectionRef:second.result!.connectionRef})
 }finally{await runtime.close();await rm(root,{recursive:true,force:true})}
})
