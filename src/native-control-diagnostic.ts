/** Fixed, non-authorizing lifecycle diagnostics; credentials, handles and native text never enter logs. */
import { createHash } from 'node:crypto'

const codes = new Set(['CONTROL_MISMATCH', 'CONTROL_CLOSED', 'NATIVE_CHANNEL_CLOSED', 'NATIVE_REPLY_TIMEOUT',
  'NATIVE_PERMISSION_UNPROVEN', 'NATIVE_CHAT_RATE_LIMITED', 'NATIVE_PERMISSION_DENIED', 'CHANNEL_CLOSED',
  'CHANNEL_UNAVAILABLE', 'CURRENT_PERMISSION_UNPROVEN', 'ENGINE_EXIT_UNPROVEN', 'HELPER_EXIT_UNPROVEN',
  'STOPPED_WORLD_UNPROVEN', 'WORLD_OCCUPANCY_UNPROVEN'])

/** Correlate an operation without recording its private references or selected path.
 * @param worldPath - Canonical selected world.
 * @param operationRef - Original finite operation.
 * @returns Stable one-way correlation fields, never a control handle.
 */
export function nativeControlBinding(worldPath: string, operationRef: string): { worldKey: string; operationKey: string } {
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
  return { worldKey: hash(worldPath), operationKey: hash(operationRef) }
}

/** Emit only caller-owned finite stage names, scalar facts and allowlisted failures.
 * @param stage - Internal stage, never native or user text.
 * @param facts - Internal scalar observations without credentials or control references.
 * @param error - Original failure; unknown messages become UNCLASSIFIED.
 */
export function nativeControlTrace(stage: string, facts: Record<string, string | number | boolean | null>, error?: unknown): void {
  const code = error === undefined ? undefined : error instanceof Error && codes.has(error.message) ? error.message : 'UNCLASSIFIED'
  console.info('HANAWORLDS_NATIVE_CONTROL', JSON.stringify({ stage, ...facts, ...(code === undefined ? {} : { code }) }))
}
