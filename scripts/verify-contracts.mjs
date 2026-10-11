import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {version,worldLifecycle,validateBoundResponse,createWorldLifecycleMock,describeSourceWorld,createLocalWorldSourceMock} from 'hanaworlds-contracts'
import fixture from 'hanaworlds-contracts/fixtures/world-lifecycle' with {type:'json'}
import {apply,NativeEngineRuntime,LocalWorldLifecycle} from '../dist/index.js'
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url)))
const pin='git+https://github.com/yzsnstotz/hanaworlds-contracts.git#v2.5.0'
assert.equal(pkg.dependencies['hanaworlds-contracts'],pin)
assert.equal(version,'2.5.0')
const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url)))
assert.equal(lock.packages[''].dependencies['hanaworlds-contracts'],pin)
assert.equal(lock.packages['node_modules/hanaworlds-contracts'].version,'2.5.0')
assert.equal(lock.packages['node_modules/hanaworlds-contracts'].resolved,'git+https://github.com/yzsnstotz/hanaworlds-contracts.git#f0c6751e984bb15081ea70c351ccbb484c91226c')
assert.equal(typeof describeSourceWorld,'function')
assert.equal(typeof createLocalWorldSourceMock,'function')
for(const operation of ['describe','list','create','launch','stop','play'])assert.equal(typeof LocalWorldLifecycle.prototype[operation],'function')
assert.equal(typeof apply,'function')
for(const operation of ['StartWorldRuntime','StopWorldRuntime','ReadRuntimeStatus']) {
 assert.equal(typeof NativeEngineRuntime.prototype[operation],'function')
 assert.ok(worldLifecycle.operations.some(o=>o.wire==='engine-runtime/v2'&&o.operation===operation))
}
const mock=createWorldLifecycleMock(fixture)
for(const x of fixture.exchanges) {
 validateBoundResponse(x.wire,x.operation,x.request,x.response)
 if(x.response.result) validateBoundResponse(x.wire,x.operation,x.request,mock(x.wire,x.operation,x.request))
}
const examples=JSON.parse(await readFile(new URL('../examples/engine-runtime.json',import.meta.url)))
assert.equal(examples.exchanges.length,7)
for(const x of examples.exchanges)validateBoundResponse(x.wire,x.operation,x.request,x.response)
const lifecycle=JSON.parse(await readFile(new URL('../examples/world-lifecycle.json',import.meta.url)))
const localMock=createWorldLifecycleMock(lifecycle)
for(const x of lifecycle.exchanges){
 validateBoundResponse(x.wire,x.operation,x.request,x.response)
 if(x.response.result)validateBoundResponse(x.wire,x.operation,x.request,localMock(x.wire,x.operation,x.request))
}
assert.equal(localMock('world-lifecycle/v2','describe',{contractVersion:'world-lifecycle/v2',requestId:'verify'}).result.canPlay,false)
console.log('contracts v2.5.0 / f0c6751: exact lock, published source locator helper, 3 engine and 6 lifecycle operations; all examples admitted')
