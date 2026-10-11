/** Owns one local Luanti process, its world directory and loopback endpoint without game authorization. */
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { NativeCleanupFailure } from './native-cleanup.ts'
import { nativeControlBinding, nativeControlTrace } from './native-control-diagnostic.ts'
import type { NativeControlInput, NativeControlSession } from './engine-control.ts'

const exec = promisify(execFile)
interface RuntimeManifest {
  capabilities?: { http?: boolean }
  engine: { path: string; sha256: string }
}

async function bounded<T>(pending: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(code)) }, milliseconds) })
    return await Promise.race([pending, timeout])
  }
  finally { clearTimeout(timer) }
}
async function installedBinary(root: string, entry: RuntimeManifest['engine']): Promise<string> {
  if (!/^[a-zA-Z0-9_./-]+$/.test(entry.path) || entry.path.startsWith('/') || entry.path.split('/').includes('..')
    || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('ENGINE_RUNTIME_INVALID')
  const path = join(root, entry.path)
  if (await realpath(path) !== path || !(await stat(path)).isFile()
    || createHash('sha256').update(await readFile(path)).digest('hex') !== entry.sha256) throw new Error('ENGINE_RUNTIME_INVALID')
  return path
}
// Luanti treats port 0 as its fixed default and cannot inherit a bound socket.
// The child must prove ownership of the OS-selected port; a failed handoff is terminal.
async function unusedPort(): Promise<number> {
  const socket = createSocket('udp4')
  try {
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve) })
    return socket.address().port
  } finally { socket.close() }
}
async function worldProcesses(world: string): Promise<number[]> {
  try {
    const { stdout } = await exec('/usr/sbin/lsof', ['-t', '+D', world], { maxBuffer: 1024 * 1024, timeout: 5000 })
    return [...new Set(stdout.trim().split('\n').filter(Boolean).map(Number))]
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1
      && 'stdout' in error && error.stdout === '' && 'stderr' in error && error.stderr === '') return []
    throw new Error('WORLD_OCCUPANCY_UNPROVEN')
  }
}

/** Lock a world that this Host never acquired and inspect actual OS occupancy.
 * @param stateRoot - The same private lock directory used by native server acquisition.
 * @param worldPath - Canonical Adapter-discovered world directory.
 * @returns An awaited lock disposer; no native process or STOPPED evidence is created.
 */
export async function lockIdleNativeWorld(stateRoot: string, worldPath: string): Promise<() => Promise<void>> {
  const world = await realpath(worldPath), identity = await stat(world)
  if (world !== worldPath || !identity.isDirectory()) throw new Error('WORLD_SELECTION_INVALID')
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const path = join(stateRoot, `${createHash('sha256').update(world).digest('hex')}.lock`)
  const file = await open(path, 'wx', 0o600)
  let released = false
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    try { await file.close() } finally { await rm(path) }
  }
  try {
    const current = await stat(world)
    if (await realpath(world) !== world || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error('WORLD_SELECTION_INVALID')
    }
    if ((await worldProcesses(world)).length !== 0) throw new Error('WORLD_ALREADY_RUNNING')
    return release
  } catch (error) { await release(); throw error }
}

/** Launch the selected local world in one owned server process.
 * @param runtimeRoot - Installed engine directory with its hash manifest.
 * @param stateRoot - Private Host directory for exclusive world locks and temporary configuration.
 * @param input - Canonical local world and user directory with operation correlation.
 * @returns Live process observations; the caller must close the session and await child exit.
 */
export async function startNativeEngineSession(
  runtimeRoot: string, stateRoot: string, input: NativeControlInput,
  expectedDirectory?: {device:string;inode:string},
): Promise<NativeControlSession> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('ENGINE_PLATFORM_UNAVAILABLE')
  if (!input.requesterRef || !input.operationRef) throw new Error('LOCAL_WORLD_CONTEXT_REQUIRED')
  const root = await realpath(runtimeRoot)
  const raw: unknown = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  if (typeof raw !== 'object' || raw === null || !('engine' in raw)) throw new Error('ENGINE_RUNTIME_INVALID')
  const manifest = raw as RuntimeManifest
  if (manifest.capabilities?.http !== true) throw new Error('ENGINE_HTTP_UNAVAILABLE')
  const enginePath = await installedBinary(root, manifest.engine)
  const world = await realpath(input.worldPath), userPath = await realpath(input.userPath), identity = await stat(world,{bigint:true})
  if (world !== input.worldPath || userPath !== input.userPath || !identity.isDirectory()) throw new Error('WORLD_SELECTION_INVALID')
  if(expectedDirectory&&(String(identity.dev)!==expectedDirectory.device||String(identity.ino)!==expectedDirectory.inode))throw new Error('LOCAL_WORLD_CHANGED')
  const assertIdentity=async():Promise<void>=>{
    const current=await stat(world,{bigint:true})
    if(await realpath(world)!==world||current.dev!==identity.dev||current.ino!==identity.ino)throw new Error('LOCAL_WORLD_CHANGED')
  }
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const lockPath = join(stateRoot, `${createHash('sha256').update(world).digest('hex')}.lock`)
  const lock = await open(lockPath, 'wx', 0o600)
  let directory: string | undefined
  let engine: ReturnType<typeof spawn> | undefined
  let engineDone: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
  let nativeStopped = false, released = false, closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    nativeControlTrace('session-close', { ...nativeControlBinding(world, input.operationRef), processId: engine?.pid ?? 0,
      engineAlive: engine !== undefined && engine.exitCode === null && engine.signalCode === null })
    released = true
    if (engine && engine.exitCode === null && engine.signalCode === null) engine.kill('SIGINT')
    if (engineDone) await bounded(engineDone, 10000, 'ENGINE_EXIT_UNPROVEN')
    if (directory) await rm(directory, { recursive: true, force: true })
    await lock.close(); await rm(lockPath)
  })()
  try {
    await assertIdentity()
    if ((await worldProcesses(world)).length !== 0) throw new Error('WORLD_ALREADY_RUNNING')
    directory = await mkdtemp(join(stateRoot, 'session-')); await chmod(directory, 0o700)
    const requestedPort = await unusedPort(), config = join(directory, 'server.conf')
    const configFile = await open(config, 'wx', 0o600)
    await configFile.writeFile([
      'name =', 'bind_address = 127.0.0.1', `port = ${requestedPort}`, 'server_announce = false', 'enable_ipv6 = false',
      'chat_message_limit_per_10sec = 8',
      'secure.enable_security = true', 'secure.trusted_mods =', 'secure.http_mods = hanaworlds_adapter', '',
    ].join('\n'))
    await configFile.close()
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, LUANTI_USER_PATH: userPath, LANG: 'en_US.UTF-8' }
    await assertIdentity()
    engine = spawn(enginePath, ['--world', world, '--config', config, '--logfile', ''], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const child = engine
    engineDone = new Promise((resolve, reject) => { child.once('error', () => { reject(new Error('ENGINE_START_FAILED')) }); child.once('exit', (code, signal) => { resolve({ code, signal }) }) })
    const binding = { ...nativeControlBinding(world, input.operationRef), processId: child.pid ?? 0 }
    const ownedExit = engineDone
    void ownedExit.then((exit) => { nativeControlTrace('child-exit', { ...binding, exitCode: exit.code, signal: exit.signal }) }, () => undefined)
    void ownedExit.catch(() => undefined)
    let diagnostic = ''
    const ready = new Promise<void>((resolve, reject) => {
      const receive = (chunk: Buffer): void => {
        diagnostic = (diagnostic + chunk.toString()).slice(-16384)
        if (/listening on 127\.0\.0\.1:\d+\./.test(diagnostic)) resolve()
      }
      child.stdout?.on('data', receive); child.stderr?.on('data', receive)
      child.once('exit', () => { reject(new Error('ENGINE_START_FAILED')) })
      child.once('error', () => { reject(new Error('ENGINE_START_FAILED')) })
    })
    await bounded(ready, 10000, 'ENGINE_START_TIMEOUT')
    const pid = child.pid
    if (!pid) throw new Error('ENGINE_START_FAILED')
    const currentWorld = async (): Promise<void> => {
      const current = await stat(world,{bigint:true})
      if (released || child.exitCode !== null || child.signalCode !== null
        || current.dev !== identity.dev || current.ino !== identity.ino
        || await realpath(world) !== world) throw new Error('LOCAL_WORLD_CHANGED')
    }
    const endpointPort = async (): Promise<number> => {
      await currentWorld()
      const sockets = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iUDP', '-Fpn'], { timeout: 5000 })
      const lines = sockets.stdout.split('\n')
      const endpoints = lines.filter(line => /^n127\.0\.0\.1:\d+$/.test(line))
      const port = Number(endpoints[0]?.slice('n127.0.0.1:'.length))
      if (!lines.includes(`p${pid}`) || endpoints.length !== 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('ENGINE_ENDPOINT_UNPROVEN')
      }
      await currentWorld()
      return port
    }
    const port = await endpointPort()
    if (port !== requestedPort) throw new Error('ENGINE_ENDPOINT_UNPROVEN')
    const verify = async (): Promise<void> => {
      if (await endpointPort() !== port) throw new Error('LOCAL_WORLD_CHANGED')
    }
    let stopping: Promise<void> | undefined
    const stop = (): Promise<void> => stopping ??= (async () => {
      await verify()
      if (!child.kill('SIGINT')) throw new Error('ENGINE_STOP_FAILED')
      const exit = await bounded(ownedExit, 10000, 'ENGINE_EXIT_UNPROVEN')
      if (exit.code !== 0 || exit.signal !== null) throw new Error('ENGINE_EXIT_UNPROVEN')
      nativeControlTrace('local-stop-exit-confirmed', { ...binding, exitCode: exit.code, signal: exit.signal })
      nativeStopped = true
    })()
    return {
      worldPath: world, processId: pid, endpoint: { host: '127.0.0.1', port },
      alive: () => !released && child.exitCode === null && child.signalCode === null,
      verify, stop,
      async assertStopped() {
        const current = await stat(world,{bigint:true})
        if (!nativeStopped || child.exitCode !== 0 || child.signalCode !== null
          || current.dev !== identity.dev || current.ino !== identity.ino
          || await realpath(world) !== world || (await worldProcesses(world)).length !== 0) throw new Error('STOPPED_WORLD_UNPROVEN')
      }, close,
    }
  } catch (error) {
    try { await close() } catch (failure) { throw new NativeCleanupFailure(failure) }
    throw error
  }
}
