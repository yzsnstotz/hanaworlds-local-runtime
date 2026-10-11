/** Stateless contract fixture, never process or world evidence. */
import {createWorldLifecycleMock,type EngineRuntimePort,type ErrorCode} from 'hanaworlds-contracts'
import fixture from 'hanaworlds-contracts/fixtures/world-lifecycle' with {type:'json'}
export function createEngineRuntimeMock(refusals: Record<string,ErrorCode> = {}): EngineRuntimePort {
 const call=createWorldLifecycleMock(fixture,refusals)
 return {
  StartWorldRuntime:async input=>call('engine-runtime/v2','StartWorldRuntime',input),
  StopWorldRuntime:async input=>call('engine-runtime/v2','StopWorldRuntime',input),
  ReadRuntimeStatus:async input=>call('engine-runtime/v2','ReadRuntimeStatus',input),
 }
}
