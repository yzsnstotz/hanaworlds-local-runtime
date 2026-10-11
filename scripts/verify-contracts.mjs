import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {version,worldLifecycle,validateBoundResponse,createWorldLifecycleMock} from 'hanaworlds-contracts'
import fixture from 'hanaworlds-contracts/fixtures/world-lifecycle' with {type:'json'}
import {apply,NativeEngineRuntime} from '../dist/index.js'
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url)))
assert.equal(pkg.dependencies['hanaworlds-contracts'],'git+https://github.com/yzsnstotz/hanaworlds-contracts.git#v2.3.0')
assert.equal(version,'2.3.0')
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
console.log('contracts v2.3.0: 38 published lifecycle examples admitted; engine provider has all 3 operations')
