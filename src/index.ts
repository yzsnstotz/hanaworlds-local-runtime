import type { Context } from '@deepseek-ai/cordis'
import { stat } from 'node:fs/promises'
import { NativeEngineRuntime } from './engine-runtime.ts'
import { startNativeEngineSession } from './native-engine-session.ts'
export { NativeEngineRuntime } from './engine-runtime.ts'
export const name = 'hanaworlds-local-runtime'
export interface Config { runtimeRoot: string; stateRoot: string }
/** Cordis entry point: no fixed port, global profile or implicit engine installation. */
export function apply(ctx: Context, config: Config): void {
 if (!config?.runtimeRoot || !config?.stateRoot) throw Error('ENGINE_RUNTIME_CONFIG_REQUIRED')
 const runtime = new NativeEngineRuntime(async input => {
  try { if (!(await stat(input.worldPath)).isDirectory()) throw Error('WORLD_NOT_FOUND') }
  catch (error) {
   if (error instanceof Error && ('code' in error && error.code === 'ENOENT' || error.message === 'WORLD_NOT_FOUND'))
    throw Error('WORLD_NOT_FOUND')
   throw error
  }
  return startNativeEngineSession(config.runtimeRoot, config.stateRoot, input)
 })
 ctx.provide('hanaworldsEngineRuntime', runtime)
 ctx.effect(() => () => runtime.close(), 'local-runtime native session cleanup')
}
