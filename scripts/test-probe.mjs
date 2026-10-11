/** Supplied native probe's synthetic Fixture mode only; no sockets or account access. */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir,mkdtemp,rm} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
const root=process.env.HANAWORLDS_TEST_ROOT??join(homedir(),'.cache','hana-world-runs','local-runtime-01')
await mkdir(root,{recursive:true})
const directory=await mkdtemp(join(root,'probe-fixture-'))
try {
 const executable=join(directory,'native-probe')
 execFileSync('go',['build','-trimpath','-o',executable,'.'],{cwd:new URL('../tests/native-control-runtime/',import.meta.url),stdio:'inherit'})
 const proof=execFileSync(executable,[],{input:JSON.stringify({Fixture:true,Username:'fixture-user',Password:'fixture-only'})+'\n',encoding:'utf8'})
 assert.match(proof,/^#1#[A-Za-z0-9+/]+#[A-Za-z0-9+/]+$/)
 console.log('native-control-runtime/main.go: Fixture mode PASS (no network)')
} finally { await rm(directory,{recursive:true,force:true}) }
