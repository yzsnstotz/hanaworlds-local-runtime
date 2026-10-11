import type { Context } from '@deepseek-ai/cordis'
import { stat } from 'node:fs/promises'
import { NativeEngineRuntime } from './engine-runtime.ts'
import { startNativeEngineSession } from './native-engine-session.ts'
import { LocalWorldLifecycle, type LifecycleConfig } from './world-lifecycle.ts'
import type { LocalWorldsPort } from 'hanaworlds-contracts'
export { NativeEngineRuntime } from './engine-runtime.ts'
export { LocalWorldLifecycle, type LocalWorldLifecyclePort, type LifecycleConfig } from './world-lifecycle.ts'
export const name = 'hanaworlds-local-runtime'
export interface Config extends Partial<Omit<LifecycleConfig,'runtimeRoot'>> { runtimeRoot: string; stateRoot: string }
/** Cordis entry point: no fixed port, global profile or implicit engine installation. */
export function apply(ctx: Context, config: Config): void {
 if (!config?.runtimeRoot || !config?.stateRoot) throw Error('ENGINE_RUNTIME_CONFIG_REQUIRED')
 const runtime = new NativeEngineRuntime(async (input,expectedDirectory) => {
  try { if (!(await stat(input.worldPath)).isDirectory()) throw Error('WORLD_NOT_FOUND') }
  catch (error) {
   if (error instanceof Error && ('code' in error && error.code === 'ENOENT' || error.message === 'WORLD_NOT_FOUND'))
    throw Error('WORLD_NOT_FOUND')
   throw error
  }
  return startNativeEngineSession(config.runtimeRoot, config.stateRoot, input,expectedDirectory)
 })
 ctx.provide('hanaworldsEngineRuntime', runtime)
 const lifecycle = new LocalWorldLifecycle({...config,worldRoots:config.worldRoots??[]},
  ()=>ctx.get('hanaworldsLuantiLocalWorlds') as LocalWorldsPort|undefined,runtime)
 ctx.provide('hanaworldsWorldLifecycle',lifecycle)
 ctx.effect(() => async () => { await lifecycle.close(); await runtime.close() }, 'local-runtime lifecycle and native session cleanup')
}
