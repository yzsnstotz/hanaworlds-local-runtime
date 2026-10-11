import {expect,it} from 'vitest'
import {createEngineRuntimeMock} from '../src/mock.ts'
it('offers a stateless fixture-only counterparty with every declared engine refusal',async()=>{
 const mock=createEngineRuntimeMock()
 const q={contractVersion:'engine-runtime/v2' as const,requestId:'mock',worldRef:'fixture-world',engineProfile:null}
 const started=await mock.StartWorldRuntime(q);expect(started.result?.state).toBe('RUNNING')
 expect((await mock.StopWorldRuntime({contractVersion:q.contractVersion,requestId:'stop',connectionRef:started.result!.connectionRef})).result?.state).toBe('STOPPED')
 // Deliberately stateless: a fixture stop cannot create any runtime fact.
 expect((await mock.ReadRuntimeStatus({contractVersion:q.contractVersion,requestId:'status',connectionRef:started.result!.connectionRef})).result?.state).toBe('RUNNING')
 for(const code of ['ADAPTER_UNAVAILABLE','WORLD_NOT_FOUND'] as const)
  expect((await createEngineRuntimeMock({'engine-runtime/v2:StartWorldRuntime':code}).StartWorldRuntime(q)).error?.code).toBe(code)
 expect((await mock.StopWorldRuntime({contractVersion:q.contractVersion,requestId:'stop',connectionRef:'unknown'})).error?.code).toBe('CONNECTION_NOT_FOUND')
})
