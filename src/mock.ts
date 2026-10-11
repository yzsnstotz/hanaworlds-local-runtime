/** Stateless contract fixture, never process or world evidence. */
import {createWorldLifecycleMock,validateRequest,validateBoundResponse,type EngineRuntimePort,type ErrorCode} from 'hanaworlds-contracts'
import fixture from 'hanaworlds-contracts/fixtures/world-lifecycle' with {type:'json'}
import lifecycleFixture from '../examples/world-lifecycle.json' with {type:'json'}
import type {LocalWorldLifecyclePort} from './world-lifecycle.ts'
export function createEngineRuntimeMock(refusals: Record<string,ErrorCode> = {}): EngineRuntimePort {
 const call=createWorldLifecycleMock(fixture,refusals)
 return {
  StartWorldRuntime:async input=>call('engine-runtime/v2','StartWorldRuntime',input),
  StopWorldRuntime:async input=>call('engine-runtime/v2','StopWorldRuntime',input),
  ReadRuntimeStatus:async input=>call('engine-runtime/v2','ReadRuntimeStatus',input),
 }
}
/** Eight-operation lifecycle fixture; play is explicitly unavailable. */
export function createLocalWorldLifecycleMock(refusals:Record<string,ErrorCode>={}):LocalWorldLifecyclePort {
 const call=createWorldLifecycleMock(lifecycleFixture,refusals)
 return {
  describe:async input=>call('world-lifecycle/v2','describe',input),
  list:async input=>call('world-lifecycle/v2','list',input),
  create:async input=>call('world-lifecycle/v2','create',input),
  describeDelete:async input=>call('world-lifecycle/v2','describeDelete',input),
  delete:async input=>call('world-lifecycle/v2','delete',input),
  launch:async input=>call('world-lifecycle/v2','launch',input),
  stop:async input=>call('world-lifecycle/v2','stop',input),
  play:async input=>{
   const q=validateRequest('world-lifecycle/v2','play',input)
   const code=refusals['world-lifecycle/v2:play']??'CAPABILITY_UNAVAILABLE'
   const example=lifecycleFixture.exchanges.find(x=>x.operation==='play'&&x.response.error?.code===code)!
   return validateBoundResponse('world-lifecycle/v2','play',q,{...example.response,requestId:q.requestId})
  },
 }
}
