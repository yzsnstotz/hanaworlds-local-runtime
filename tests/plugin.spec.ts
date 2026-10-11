import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
it('loads through Cordis apply, serves the published wire and unloads its services', async () => {
 const ctx=new Context()
 const fork=ctx.plugin(plugin,{runtimeRoot:'/not-installed',stateRoot:'/not-created'})
 await fork
 const port=ctx.get('hanaworldsEngineRuntime')
 expect(port).toBeDefined()
 expect((await port.ReadRuntimeStatus({contractVersion:'engine-runtime/v2',requestId:'absent',connectionRef:'absent'})).error.code).toBe('CONNECTION_NOT_FOUND')
 expect((await port.StartWorldRuntime({contractVersion:'engine-runtime/v2',requestId:'missing',worldRef:'w',engineProfile:{profileId:'luanti-native/v1',worldPath:'/absent/world',userPath:'/absent/user'}})).error.code).toBe('WORLD_NOT_FOUND')
 await fork.dispose()
 expect(ctx.get('hanaworldsEngineRuntime')).toBeUndefined()
})
