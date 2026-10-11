/** Launch only the packaged graphical client at the current Host-owned loopback endpoint. */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)

/** One Desktop-owned viewer; world switching and Host shutdown await its exit. */
export class DesktopGameClient {
  private child: { process: ChildProcess; done: Promise<void> } | undefined
  constructor(private readonly runtimeRoot: string, private readonly stateRoot: string) {}

  /** Open the bundled game without exposing paths, passwords or server addresses as UI inputs.
   * @param endpoint - Fresh loopback coordinates read from the owned world process.
   * @returns Completion of verified client process startup, before visual readiness.
   */
  async open(endpoint: { host: string; port: number }): Promise<void> {
    if (endpoint.host !== '127.0.0.1' || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new Error('GAME_ENDPOINT_INVALID')
    const root = await realpath(this.runtimeRoot)
    const raw: unknown = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
    if (typeof raw !== 'object' || raw === null || !('executable' in raw) || typeof raw.executable !== 'object' || raw.executable === null
      || !('path' in raw.executable) || typeof raw.executable.path !== 'string' || !('sha256' in raw.executable) || typeof raw.executable.sha256 !== 'string'
      || !/^[a-zA-Z0-9_./-]+$/.test(raw.executable.path) || raw.executable.path.startsWith('/') || raw.executable.path.split('/').includes('..')) throw new Error('GAME_RUNTIME_INVALID')
    const binary = join(root, raw.executable.path)
    if (await realpath(binary) !== binary || !(await stat(binary)).isFile()
      || createHash('sha256').update(await readFile(binary)).digest('hex') !== raw.executable.sha256) throw new Error('GAME_RUNTIME_INVALID')
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(root, 'luanti.app')])
    await this.close()
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 })
    const process = spawn(binary, ['--address', endpoint.host, '--port', String(endpoint.port), '--name', 'HanaWorlds', '--password', '', '--go',
      '--logfile', join(this.stateRoot, 'debug.txt')], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: this.stateRoot, LUANTI_USER_PATH: this.stateRoot, LANG: 'en_US.UTF-8' }, stdio: 'ignore',
    })
    const done = new Promise<void>((resolve) => { process.once('exit', () => { resolve() }); process.once('error', () => { resolve() }) })
    const record = { process, done }
    this.child = record
    void done.then(() => { if (this.child === record) this.child = undefined })
    await new Promise<void>((resolve, reject) => { process.once('spawn', resolve); process.once('error', () => { reject(new Error('GAME_CLIENT_START_FAILED')) }) })
  }

  /** Close only this Desktop-owned viewer and await its process exit. */
  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGTERM')
    await child.done
    if (this.child === child) this.child = undefined
  }
}
