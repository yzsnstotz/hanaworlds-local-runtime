import {expect,it} from 'vitest'
import {validateBoundResponse} from 'hanaworlds-contracts'
import {createLocalWorldLifecycleMock} from '../src/mock.ts'
import fixture from '../examples/world-lifecycle.json' with {type:'json'}
it('publishes all eight operations through an admitted stateless mock with truthful unavailable play',async()=>{
 const mock=createLocalWorldLifecycleMock()
 for(const exchange of fixture.exchanges){
  if(exchange.response.error)continue
  const input={...exchange.request,requestId:'consumer'}
  const response=await (mock as any)[exchange.operation](input)
  validateBoundResponse('world-lifecycle/v2',exchange.operation as any,input,response)
  expect(response.result).toEqual(exchange.response.result)
 }
 const description=await mock.describe({contractVersion:'world-lifecycle/v2',requestId:'describe'})
 expect(description.result?.canPlay).toBe(false);expect(description.result?.canDelete).toBe(true)
 const play=await mock.play({contractVersion:'world-lifecycle/v2',requestId:'play',worldId:'fixture-world-id'})
 expect(play.error?.code).toBe('CAPABILITY_UNAVAILABLE');expect(play.result).toBeNull()
})
it('supports each published business refusal and rejects undeclared fixture refusals',async()=>{
 for(const exchange of fixture.exchanges){
  if(!exchange.response.error)continue
  const mock=createLocalWorldLifecycleMock({[`world-lifecycle/v2:${exchange.operation}`]:exchange.response.error.code as any})
  const input={...exchange.request,requestId:'refusal'}
  const response=await (mock as any)[exchange.operation](input)
  validateBoundResponse('world-lifecycle/v2',exchange.operation as any,input,response)
  expect(response.error.code).toBe(exchange.response.error.code)
 }
 expect(()=>createLocalWorldLifecycleMock({'world-lifecycle/v2:list':'INVALID_NAME'})).toThrow()
})
