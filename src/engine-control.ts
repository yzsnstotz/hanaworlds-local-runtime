/** Host-owned local world process control; handles correlate finite lifecycle operations. */
import { randomUUID } from 'node:crypto'
import { nativeControlBinding, nativeControlTrace } from './native-control-diagnostic.ts'

import type { NativeControlInput, NativeControlQuery, NativeControlEvidence, LocalEngineControlPort } from 'hanaworlds-contracts'
export type { NativeControlInput, NativeControlQuery, NativeControlEvidence } from 'hanaworlds-contracts'
/** A concrete native driver owns the socket and child; fixture implementations belong only in tests. */
export interface NativeControlSession {
  readonly worldPath: string
  readonly processId: number
  readonly endpoint?: { readonly host: string; readonly port: number }
  alive(): boolean
  verify(): Promise<void>
  stop(): Promise<void>
  assertStopped(): Promise<void>
  close(): Promise<void>
}
interface RecordEntry {
  session: NativeControlSession
  requesterRef: string
  operationRef: string
  state: 'CURRENT' | 'STOPPING' | 'STOPPED'
}
/** Keeps the owned process associated with one caller, world and finite operation. */
export class NativeEngineControl implements LocalEngineControlPort {
  private readonly records = new Map<string, RecordEntry>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly busyWorlds = new Set<string>()
  private closed = false
  constructor(private readonly start: (input: NativeControlInput) => Promise<NativeControlSession>,
    private readonly lockIdle?: (worldPath: string) => Promise<() => Promise<void>>) {}

  /** Connection coordinates of the exact owned live child; this observation grants no authority. */
  endpoint(processId: number, worldPath: string): { host: string; port: number } | null {
    if (this.closed) return null
    for (const { session, state } of this.records.values()) {
      if (state === 'CURRENT' && session.processId === processId && session.worldPath === worldPath && session.alive()) {
        return session.endpoint ? { ...session.endpoint } : null
      }
    }
    return null
  }

  /** Stop one exact Host-owned world when Desktop selects another world.
   * @param processId - PID observed from the previous live binding.
   * @param worldPath - Canonical directory of that same binding.
   * @returns Completion after native exit; the original query retains its lock until same-world reacquisition, rejection or Host close.
   */
  async stopOwnedWorld(processId: number, worldPath: string): Promise<void> {
    await this.stoppedOperation(this.ownedQuery(processId, worldPath), () => Promise.resolve(undefined), true)
  }

  /** Stop and release one rejected Host-owned world; no retained stop callback remains.
   * @param processId - PID from the rejected world's acquisition.
   * @param worldPath - Canonical directory selected for that acquisition.
   * @returns Completion after exact child exit and world-lock release.
   */
  async discardOwnedWorld(processId: number, worldPath: string): Promise<void> {
    await this.stoppedOperation(this.ownedQuery(processId, worldPath), () => Promise.resolve(undefined), false)
  }

  private ownedQuery(processId: number, worldPath: string): NativeControlQuery {
    const entry = [...this.records.entries()].find(([, row]) => row.state !== 'STOPPING'
      && row.session.processId === processId && row.session.worldPath === worldPath)
    if (!entry) throw new Error('CONTROL_MISMATCH')
    const [controlRef, row] = entry
    return { controlRef, worldPath, requesterRef: row.requesterRef, operationRef: row.operationRef }
  }

  private track<T>(work: () => Promise<T>): Promise<T> {
    const pending = work()
    this.pending.add(pending)
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending))
    return pending
  }
  private isClosed(): boolean {
    return this.closed
  }
  /** Start the selected local world and verify the owned process and endpoint.
   * @param input - Exact caller, world directory and operation correlation.
   * @returns A private handle for this owned process and canonical world.
   */
  acquire(input: NativeControlInput): Promise<{ controlRef: string; worldPath: string }> {
    input = { ...input }
    return this.track(async () => {
      if (this.closed) throw new Error('CONTROL_CLOSED')
      if (this.busyWorlds.has(input.worldPath)) throw new Error('WORLD_OPERATION_IN_PROGRESS')
      this.busyWorlds.add(input.worldPath)
      try {
        for (const [ref, record] of this.records) {
          if (record.session.worldPath !== input.worldPath) continue
          if (record.state !== 'STOPPED') throw new Error('WORLD_ALREADY_RUNNING')
          // A new incarnation must release the old lock and permanently expire its query.
          this.records.delete(ref)
          await record.session.close()
        }
        if (this.isClosed()) throw new Error('CONTROL_CLOSED')
        const session = await this.start(input)
        try {
          await session.verify()
          if (this.isClosed() || !session.alive()) throw new Error('CONTROL_CLOSED')
          const controlRef = randomUUID()
          this.records.set(controlRef, { session, requesterRef: input.requesterRef, operationRef: input.operationRef,
            state: 'CURRENT' })
          return { controlRef, worldPath: session.worldPath }
        } catch (error) { await session.close(); throw error }
      } finally { this.busyWorlds.delete(input.worldPath) }
    })
  }
  /** Keep the exact unoccupied world locked while Desktop consumes Adapter deletion.
   * @param worldPath - Canonical directory returned by Adapter discovery.
   * @param consume - Finite deletion work, including a fresh all-live Session binding check.
   * @returns The consumer result; unknown occupancy and concurrent starts are refused.
   */
  withIdleWorld<T>(worldPath: string, consume: () => Promise<T>): Promise<T> {
    return this.track(async () => {
      if (this.closed) throw new Error('CONTROL_CLOSED')
      if (this.busyWorlds.has(worldPath)) throw new Error('WORLD_OPERATION_IN_PROGRESS')
      this.busyWorlds.add(worldPath)
      let release: (() => Promise<void>) | undefined
      try {
        const rows = [...this.records.values()].filter(row => row.session.worldPath === worldPath)
        if (rows.some(row => row.state !== 'STOPPED')) throw new Error('WORLD_ALREADY_RUNNING')
        if (rows.length > 1) throw new Error('STOPPED_WORLD_UNPROVEN')
        const stopped = rows[0]
        if (stopped) await stopped.session.assertStopped()
        else {
          if (!this.lockIdle) throw new Error('ENGINE_CONTROL_UNAVAILABLE')
          release = await this.lockIdle(worldPath)
        }
        if (this.isClosed()) throw new Error('CONTROL_CLOSED')
        return await consume()
      } finally {
        try { await release?.() } finally { this.busyWorlds.delete(worldPath) }
      }
    })
  }
  private record(query: NativeControlQuery, allowStopped = false): RecordEntry {
    const record = this.records.get(query.controlRef)
    if (this.closed || !record || (record.state !== 'CURRENT' && !(allowStopped && record.state === 'STOPPED')) || record.requesterRef !== query.requesterRef
      || record.operationRef !== query.operationRef || record.session.worldPath !== query.worldPath) throw new Error('CONTROL_MISMATCH')
    return record
  }
  private facts(record: RecordEntry, state: NativeControlEvidence['state']): NativeControlEvidence {
    return { state, worldPath: record.session.worldPath,
      processId: record.session.processId, operationRef: record.operationRef }
  }
  /** Recheck the same owned process and world directory; a stopped handle never revives.
   * @param query - Original requester, canonical world, operation and handle.
   * @returns Current process and world observations.
   */
  inspect(query: NativeControlQuery): Promise<NativeControlEvidence> {
    query = { ...query }
    return this.track(async () => {
      const record = this.record(query)
      const binding = { ...nativeControlBinding(query.worldPath, query.operationRef), processId: record.session.processId }
      let stage = 'alive-before'
      try {
        if (!record.session.alive()) throw new Error('CONTROL_CLOSED')
        stage = 'native-verify'
        await record.session.verify()
        stage = 'alive-after'
        if (this.record(query) !== record || !record.session.alive()) throw new Error('CONTROL_CLOSED')
        return this.facts(record, 'CURRENT')
      } catch (error) {
        nativeControlTrace('inspect-rejected', { ...binding, failedStage: stage, cleanupOwned: record.state === 'CURRENT' }, error)
        // A concurrent stop owns its own cleanup and must not lose its world lock.
        if (record.state === 'CURRENT') { this.records.delete(query.controlRef); await record.session.close() }
        throw error
      }
    })
  }
  /** Native shutdown or the retained exact exit precedes each callback under the original world lock.
   * @param query - Original requester, canonical world, operation and handle.
   * @param consume - Finite Adapter-owned work; observations describe this invocation only.
   * @returns The finite consumer result; the stopped query and lock remain until reacquisition, rejection or Host close.
   */
  withStoppedWorld<T>(query: NativeControlQuery, consume: (facts: NativeControlEvidence) => Promise<T>): Promise<T> {
    return this.stoppedOperation(query, consume, true)
  }
  private stoppedOperation<T>(query: NativeControlQuery,
    consume: (facts: NativeControlEvidence) => Promise<T>, retain: boolean): Promise<T> {
    query = { ...query }
    return this.track(async () => {
      const binding = nativeControlBinding(query.worldPath, query.operationRef)
      const record = this.record(query, true)
      const alreadyStopped = record.state === 'STOPPED'
      const facts = { ...binding, processId: record.session.processId, requesterMatched: true, worldMatched: true, operationMatched: true }
      record.state = 'STOPPING'
      let stage = 'fresh-verify', retained = false
      nativeControlTrace('stop-bound', facts)
      try {
        if (!alreadyStopped) {
          await record.session.verify()
          nativeControlTrace('fresh-verify-returned', facts)
          if (this.closed || !record.session.alive()) throw new Error('CONTROL_CLOSED')
          stage = 'native-stop'
          await record.session.stop()
          nativeControlTrace('native-stop-returned', facts)
        }
        stage = 'assert-stopped'
        await record.session.assertStopped()
        nativeControlTrace('assert-stopped-returned', facts)
        if (this.closed) throw new Error('CONTROL_CLOSED')
        stage = 'consumer'
        nativeControlTrace('consumer-enter', facts)
        const result = await consume(this.facts(record, 'STOPPED'))
        if (retain && !this.isClosed()) { record.state = 'STOPPED'; retained = true }
        return result
      } catch (error) {
        nativeControlTrace('stop-rejected', { ...facts, failedStage: stage }, error)
        throw error
      } finally {
        if (!retained) { this.records.delete(query.controlRef); await record.session.close() }
      }
    })
  }
  /** Refuse new work and await finite in-flight consumers before releasing world locks.
   * @returns Completion of all owned native session cleanup.
   */
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.pending])
    const records = [...this.records.values()]
    this.records.clear()
    await Promise.all(records.map(async record => record.session.close()))
  }
}
