import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import {testRoot as tmpdir} from './test-root.ts'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DesktopGameClient } from '../src/game-client.ts'

it('rejects a non-loopback game endpoint before reading or launching the installed client', async () => {
  const client = new DesktopGameClient('/not-installed', '/not-created')
  await expect(client.open({ host: 'remote.example', port: 30000 })).rejects.toThrow('GAME_ENDPOINT_INVALID')
  await client.close()
})

it('rejects altered client bytes before launching any game process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'game-client-'))
  const client = new DesktopGameClient(root, join(root, 'state'))
  try {
    await writeFile(join(root, 'client'), 'changed fixture bytes')
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ executable: { path: 'client', sha256: '0'.repeat(64) } }))
    await expect(client.open({ host: '127.0.0.1', port: 30000 })).rejects.toThrow('GAME_RUNTIME_INVALID')
  } finally { await client.close(); await rm(root, { recursive: true, force: true }) }
})
