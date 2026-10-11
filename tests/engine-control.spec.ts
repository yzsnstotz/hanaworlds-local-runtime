import { describe, expect, it, vi } from 'vitest'
import { NativeEngineControl, type NativeControlSession } from '../src/engine-control.ts'

const input = { requesterRef: 'native-window-1', worldPath: '/fixture/world', userPath: '/fixture/user', operationRef: 'install-1' }
function rig() {
  let alive = true, sameWorld = true, stopped = false, closes = 0, probes = 0
  const session: NativeControlSession = {
    worldPath: input.worldPath, processId: 42,
    alive: () => alive,
    async verify() { probes++; if (!alive || !sameWorld) throw new Error('LOCAL_WORLD_CHANGED') },
    async stop() { if (!alive || !sameWorld) throw new Error('LOCAL_WORLD_CHANGED'); alive = false; stopped = true },
    async assertStopped() { if (!stopped || alive || !sameWorld) throw new Error('STOP_UNPROVEN') },
    async close() { closes++; alive = false },
  }
  const control = new NativeEngineControl(async () => session)
  return { control, replaceWorld: () => { sameWorld = false }, die: () => { alive = false }, closes: () => closes, probes: () => probes }
}

describe('local world engine control', () => {
  it('binds live native proof to requester, world and explicit operation', async () => {
    const r = rig(), lease = await r.control.acquire(input)
    expect(await r.control.inspect({ ...input, controlRef: lease.controlRef })).toMatchObject({ state: 'CURRENT', processId: 42 })
    for (const change of [{ requesterRef: 'other' }, { worldPath: '/other' }, { operationRef: 'other' }, { controlRef: 'forged' }]) {
      await expect(r.control.inspect({ ...input, controlRef: lease.controlRef, ...change })).rejects.toThrow('CONTROL_MISMATCH')
    }
    expect(r.probes()).toBe(2)
    await r.control.close()
  })
  it('world replacement or dead process permanently invalidates a handle', async () => {
    for (const invalidation of ['replaceWorld', 'die'] as const) {
      const r = rig(), lease = await r.control.acquire(input); r[invalidation]()
      const query = { ...input, controlRef: lease.controlRef }
      await expect(r.control.inspect(query)).rejects.toThrow()
      await expect(r.control.inspect(query)).rejects.toThrow('CONTROL_MISMATCH')
      expect(r.closes()).toBe(1)
    }
  })
  it('stops through the native session before a finite callback and refuses overlapping callbacks', async () => {
    const r = rig(), lease = await r.control.acquire(input), query = { ...input, controlRef: lease.controlRef }
    let calls = 0
    expect(await r.control.withStoppedWorld(query, async (evidence) => {
      calls++; expect(evidence).toMatchObject({ state: 'STOPPED', worldPath: input.worldPath, operationRef: input.operationRef })
      await expect(r.control.inspect(query)).rejects.toThrow('CONTROL_MISMATCH')
      await expect(r.control.withStoppedWorld(query, async () => 'duplicate')).rejects.toThrow('CONTROL_MISMATCH')
      return 'fixture-adapter-consumed'
    })).toBe('fixture-adapter-consumed')
    expect(calls).toBe(1); expect(r.closes()).toBe(0)
    await r.control.close(); expect(r.closes()).toBe(1)
    await expect(r.control.inspect(query)).rejects.toThrow('CONTROL_MISMATCH')
  })
  it('does not call a consumer after world replacement or failed shutdown', async () => {
    const r = rig(), lease = await r.control.acquire(input); r.replaceWorld(); let called = false
    await expect(r.control.withStoppedWorld({ ...input, controlRef: lease.controlRef }, async () => { called = true })).rejects.toThrow()
    expect(called).toBe(false)
  })
})

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

it('retains the submitted requester and operation across asynchronous world startup', async () => {
  const gate = barrier(), submitted = { ...input }
  const control = new NativeEngineControl(async (value) => {
    await gate.promise
    return { worldPath: value.worldPath, processId: 42, alive: () => true,
      verify: async () => {}, stop: async () => {}, assertStopped: async () => {}, close: async () => {} }
  })
  try {
    const acquiring = control.acquire(submitted)
    submitted.requesterRef = 'later-window'; submitted.operationRef = 'later-operation'
    gate.release()
    const lease = await acquiring
    expect(await control.inspect({ ...input, controlRef: lease.controlRef })).toMatchObject({ operationRef: input.operationRef })
  } finally { gate.release(); await control.close() }
})

it('holds the world lock through an in-flight consumer when Host closes', async () => {
  const r = rig(), lease = await r.control.acquire(input), entered = barrier(), finish = barrier()
  const consuming = r.control.withStoppedWorld({ ...input, controlRef: lease.controlRef }, async () => {
    entered.release(); await finish.promise
  })
  await entered.promise
  const closing = r.control.close()
  expect(r.closes()).toBe(0)
  finish.release(); await consuming; await closing
  expect(r.closes()).toBe(1)
  await expect(r.control.acquire(input)).rejects.toThrow('CONTROL_CLOSED')
})

it('disposes a late world startup instead of issuing control after Host closes', async () => {
  const gate = barrier(); let closed = false
  const control = new NativeEngineControl(async () => {
    await gate.promise
    return { worldPath: input.worldPath, processId: 42, alive: () => true,
      verify: async () => {}, stop: async () => {}, assertStopped: async () => {}, close: async () => { closed = true } }
  })
  const acquiring = control.acquire(input), rejected = expect(acquiring).rejects.toThrow('CONTROL_CLOSED')
  const closing = control.close(); gate.release()
  await rejected; await closing; expect(closed).toBe(true)
})


it.each(['fresh-verify', 'native-stop', 'assert-stopped', 'consumer'])('attributes %s failures without exposing private input', async (failedStage) => {
  const logs: string[] = []
  const logger = vi.spyOn(console, 'info').mockImplementation((...args) => { logs.push(args.join(' ')) })
  let stopping = false, closed = false, calls = 0
  const failure = new Error(failedStage === 'consumer' ? 'private-consumer-secret' : 'CHANNEL_CLOSED')
  const rejectAt = (stage: string): void => { if (stopping && stage === failedStage) throw failure }
  const session: NativeControlSession = { worldPath: input.worldPath, processId: 42, alive: () => true,
    verify: async () => { rejectAt('fresh-verify') }, stop: async () => { rejectAt('native-stop') },
    assertStopped: async () => { rejectAt('assert-stopped') }, close: async () => { closed = true } }
  const control = new NativeEngineControl(async () => session)
  try {
    const lease = await control.acquire(input)
    stopping = true
    await expect(control.withStoppedWorld({ ...input, controlRef: lease.controlRef }, async () => {
      calls++; rejectAt('consumer')
    })).rejects.toBe(failure)
    expect(closed).toBe(true)
    expect(calls).toBe(failedStage === 'consumer' ? 1 : 0)
    const serialized = logs.join('\n')
    for (const secret of [input.worldPath, input.requesterRef, input.operationRef, lease.controlRef, 'private-consumer-secret']) {
      expect(serialized).not.toContain(secret)
    }
    const rows: unknown[] = logs.map((line): unknown => JSON.parse(line.replace('HANAWORLDS_NATIVE_CONTROL ', '')))
    const rejected = rows.find(row => typeof row === 'object' && row !== null && 'stage' in row && row.stage === 'stop-rejected')
    expect(rejected).toMatchObject({ failedStage, processId: 42, requesterMatched: true, worldMatched: true,
      operationMatched: true, code: failedStage === 'consumer' ? 'UNCLASSIFIED' : 'CHANNEL_CLOSED' })
    await expect(control.inspect({ ...input, controlRef: lease.controlRef })).rejects.toThrow('CONTROL_MISMATCH')
  } finally { await control.close(); logger.mockRestore() }
})

it('attributes inspect rejection to the native check without logging provider text', async () => {
  const failure = Error('secret provider detail')
  let deny = false, closes = 0
  const control = new NativeEngineControl(async () => ({
    worldPath: input.worldPath, processId: 42, alive: () => true,
    verify: async () => { if (deny) throw failure }, stop: async () => {}, assertStopped: async () => {},
    close: async () => { closes++ },
  }))
  const logger = vi.spyOn(console, 'info').mockImplementation(() => {})
  try {
    const lease = await control.acquire(input)
    deny = true
    await expect(control.inspect({ ...input, controlRef: lease.controlRef })).rejects.toBe(failure)
    expect(closes).toBe(1)
    const logs = logger.mock.calls.map(args => args.join(' ')).join('\n')
    expect(logs).toContain('"stage":"inspect-rejected"')
    expect(logs).toContain('"failedStage":"native-verify"')
    expect(logs).toContain('"cleanupOwned":true')
    expect(logs).toContain('"code":"UNCLASSIFIED"')
    expect(logs).not.toContain(failure.message)
    expect(logs).not.toContain(lease.controlRef)
  } finally { await control.close(); logger.mockRestore() }
})

it('stops only the exact owned process when the Desktop changes worlds', async () => {
  const r = rig(), lease = await r.control.acquire(input)
  await expect(r.control.stopOwnedWorld(99, input.worldPath)).rejects.toThrow('CONTROL_MISMATCH')
  expect(r.closes()).toBe(0)
  await r.control.stopOwnedWorld(42, input.worldPath)
  expect(r.closes()).toBe(0)
  const query = { ...input, controlRef: lease.controlRef }
  await expect(r.control.inspect(query)).rejects.toThrow('CONTROL_MISMATCH')
  expect(r.control.endpoint(42, input.worldPath)).toBeNull()
  for (const change of [{ requesterRef: 'other' }, { worldPath: '/other' }, { operationRef: 'other' }, { controlRef: 'unknown' }]) {
    await expect(r.control.withStoppedWorld({ ...query, ...change }, async () => 'forged')).rejects.toThrow('CONTROL_MISMATCH')
  }
  expect(await r.control.withStoppedWorld(query, async (facts) => {
    expect(facts).toEqual({ state: 'STOPPED', processId: 42, worldPath: input.worldPath, operationRef: input.operationRef })
    expect(r.closes()).toBe(0)
    return 'retired-A'
  })).toBe('retired-A')
  expect(r.closes()).toBe(0)
  expect(await r.control.withStoppedWorld(query, async () => 'rechecked')).toBe('rechecked')
  await r.control.close(); expect(r.closes()).toBe(1)
})


it('rechecks the retained stopped world before giving the original query a callback', async () => {
  const r = rig(), lease = await r.control.acquire(input)
  try {
    await r.control.stopOwnedWorld(42, input.worldPath)
    r.replaceWorld()
    let called = false
    await expect(r.control.withStoppedWorld({ ...input, controlRef: lease.controlRef }, async () => { called = true })).rejects.toThrow('STOP_UNPROVEN')
    expect(called).toBe(false)
    expect(r.closes()).toBe(1)
  } finally { await r.control.close() }
})


it('rechecks the stopped original query after retirement and retains its world lock until Host closes', async () => {
  const r = rig(), lease = await r.control.acquire(input), query = { ...input, controlRef: lease.controlRef }
  try {
    await r.control.stopOwnedWorld(42, input.worldPath)
    await r.control.withStoppedWorld(query, async () => 'retired-A')
    expect(r.closes()).toBe(0)
    expect(await r.control.withStoppedWorld(query, async facts => facts.state)).toBe('STOPPED')
    r.replaceWorld()
    await expect(r.control.withStoppedWorld(query, async () => 'must-not-delete')).rejects.toThrow('STOP_UNPROVEN')
    expect(r.closes()).toBe(1)
  } finally { await r.control.close() }
})

it('invalidates the stopped old query before restarting the same world', async () => {
  let starts = 0, closes = 0
  const control = new NativeEngineControl(async () => {
    const pid = ++starts; let alive = true
    return { worldPath: input.worldPath, processId: pid, alive: () => alive,
      verify: async () => { expect(alive).toBe(true) }, stop: async () => { alive = false },
      assertStopped: async () => { expect(alive).toBe(false) }, close: async () => { closes++; alive = false } }
  })
  try {
    const first = await control.acquire(input), old = { ...input, controlRef: first.controlRef }
    await control.withStoppedWorld(old, async () => 'retired')
    expect(closes).toBe(0)
    const second = await control.acquire({ ...input, operationRef: 'restart-A' })
    expect(closes).toBe(1)
    await expect(control.withStoppedWorld(old, async () => 'stale')).rejects.toThrow('CONTROL_MISMATCH')
    expect(await control.inspect({ ...input, operationRef: 'restart-A', controlRef: second.controlRef })).toMatchObject({ processId: 2 })
  } finally { await control.close() }
})


it('holds a never-acquired world deletion guard and refuses Host acquisition during it', async () => {
  const entered = barrier(), finish = barrier(); let released = 0, starts = 0
  const control = new NativeEngineControl(async () => { starts++; throw Error('must-not-start') },
    async (world) => { expect(world).toBe(input.worldPath); return async () => { released++ } })
  const deleting = control.withIdleWorld(input.worldPath, async () => { entered.release(); await finish.promise; return 'deleted' })
  try {
    await entered.promise
    await expect(control.acquire(input)).rejects.toThrow('WORLD_OPERATION_IN_PROGRESS')
    expect(starts).toBe(0); expect(released).toBe(0)
  } finally { finish.release(); await deleting; await control.close() }
  expect(released).toBe(1)
})

it('refuses unknown or externally occupied deletion facts without entering the consumer', async () => {
  let entered = 0
  const missing = new NativeEngineControl(async () => { throw Error('unused') })
  await expect(missing.withIdleWorld(input.worldPath, async () => { entered++ })).rejects.toThrow('ENGINE_CONTROL_UNAVAILABLE')
  const external = new NativeEngineControl(async () => { throw Error('unused') }, async () => { throw Error('WORLD_ALREADY_RUNNING') })
  await expect(external.withIdleWorld(input.worldPath, async () => { entered++ })).rejects.toThrow('WORLD_ALREADY_RUNNING')
  expect(entered).toBe(0)
  await missing.close(); await external.close()
})
