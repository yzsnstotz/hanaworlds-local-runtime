import {mkdirSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
export function testRoot(): string {
 const root=process.env.HANAWORLDS_TEST_ROOT??join(homedir(),'.cache','hana-world-runs','local-runtime-01')
 mkdirSync(root,{recursive:true})
 return root
}
