import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {dirname,join} from 'node:path'
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex')
export async function verifySupply() {
 const root=fileURLToPath(new URL('../',import.meta.url))
 const expected=JSON.parse(await readFile(new URL('./contract-source.json',import.meta.url)))
 const manifest=JSON.parse(await readFile(join(root,'package.json')))
 const lock=JSON.parse(await readFile(join(root,'package-lock.json')))
 const pin='git+https://github.com/yzsnstotz/hanaworlds-contracts.git#'+expected.tag
 for(const field of ['dependencies','peerDependencies','optionalDependencies'])assert.ok(!manifest[field]?.['hanaworlds-contracts'])
 assert.equal(manifest.devDependencies['hanaworlds-contracts'],pin)
 assert.equal(lock.packages[''].devDependencies['hanaworlds-contracts'],pin)
 assert.ok(!lock.packages[''].dependencies['hanaworlds-contracts'])
 const installed=lock.packages['node_modules/hanaworlds-contracts']
 assert.equal(installed.version,expected.version)
 assert.equal(installed.resolved,expected.resolved)
 assert.match(installed.resolved,new RegExp('^git\\+(https://github\\.com/|ssh://git@github\\.com/)yzsnstotz/hanaworlds-contracts\\.git#'+expected.sha+'$'))
 assert.equal(installed.dev,true)
 const sdk=dirname(fileURLToPath(import.meta.resolve('hanaworlds-contracts/package.json')))
 for(const [path,digest] of Object.entries(expected.files))assert.equal(sha256(await readFile(join(sdk,path))),digest,'Development supply changed: '+path)
 return {...expected,sdk,pin}
}
