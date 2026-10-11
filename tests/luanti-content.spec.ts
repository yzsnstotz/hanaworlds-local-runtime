/** Product game/mod supply and flat-world creation over a fixture Adapter lifecycle port; archives are synthetic. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import {testRoot as tmpdir} from './test-root.ts'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DesktopLuantiContent } from '../src/luanti-content.ts'

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
async function bundle(root: string) {
  const work = join(root, 'work'), out = join(root, 'bundle')
  await mkdir(join(work, 'game-1', 'flatgame', 'mods', 'core'), { recursive: true }); await mkdir(join(work, 'we', 'pack', 'worldedit'), { recursive: true }); await mkdir(out)
  const game = { 'game.conf': 'title = Flat Game\n', 'mods/core/init.lua': '-- core\n' }, mod = { 'mod.conf': 'name = worldedit\n', 'init.lua': '-- we\n' }
  for (const [p, t] of Object.entries(game)) await writeFile(join(work, 'game-1', 'flatgame', p), t)
  for (const [p, t] of Object.entries(mod)) await writeFile(join(work, 'we', 'pack', 'worldedit', p), t)
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(work, 'game-1', 'flatgame'), join(out, 'game.zip')])
  execFileSync('/usr/bin/tar', ['-czf', join(out, 'we.tar.gz'), '-C', join(work, 'we'), 'pack'])
  const source = async (file: string) => ({ url: 'https://example.invalid/a', page: 'https://example.invalid/', revision: 'r1',
    archiveSha256: sha(await readFile(join(out, file))), archiveBytes: (await stat(join(out, file))).size })
  const files = (tree: Record<string, string>) => Object.fromEntries(Object.entries(tree).map(([p, t]) => [p, sha(t)]))
  await writeFile(join(out, 'supply.json'), JSON.stringify({ schemaVersion: 1, components: [
    { id: 'flatgame', kind: 'game', name: 'Flat Game', version: '1', installName: 'flatgame', license: 'GPL', source: await source('game.zip'), archive: 'game.zip', format: 'zip', root: 'flatgame', files: files(game) },
    { id: 'worldedit', kind: 'mod', name: 'WorldEdit', version: 'r1', installName: 'worldedit', license: 'AGPL', source: await source('we.tar.gz'), archive: 'we.tar.gz', format: 'tar.gz', root: 'pack/worldedit', files: files(mod) },
  ] }))
  return out
}

it('installs the packaged game and mod once into the product user path, verifies every file and never overwrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hanaworlds-luanti-content-'))
  try {
    const userPath = join(root, 'profile', 'luanti')
    const content = await DesktopLuantiContent.open(await bundle(root), userPath)
    expect(content.gameId()).toBe('flatgame')
    expect((await content.describe()).map(c => c.state)).toEqual(['NOT_INSTALLED', 'NOT_INSTALLED'])
    expect((await content.ensure()).map(c => [c.target, c.state])).toEqual([[join(userPath, 'games', 'flatgame'), 'INSTALLED_VERIFIED'],
      [join(userPath, 'mods', 'worldedit'), 'INSTALLED_VERIFIED']])
    expect(await readFile(join(userPath, 'games', 'flatgame', 'game.conf'), 'utf8')).toBe('title = Flat Game\n')
    // Second run verifies instead of reinstalling; a changed installed file is a named error, not overwritten.
    expect((await content.ensure()).every(c => c.state === 'INSTALLED_VERIFIED')).toBe(true)
    await writeFile(join(userPath, 'mods', 'worldedit', 'init.lua'), '-- changed\n')
    await expect(content.ensure()).rejects.toThrow('LUANTI_CONTENT_CHANGED: worldedit')
    expect(await readFile(join(userPath, 'mods', 'worldedit', 'init.lua'), 'utf8')).toBe('-- changed\n')
    await expect(DesktopLuantiContent.open(join(root, 'missing'), userPath)).rejects.toThrow('LUANTI_CONTENT_UNAVAILABLE')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses a packaged archive whose bytes differ from the recorded upstream identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hanaworlds-luanti-content-'))
  try {
    const out = await bundle(root)
    await writeFile(join(out, 'we.tar.gz'), Buffer.concat([await readFile(join(out, 'we.tar.gz')), Buffer.from([0])]))
    const content = await DesktopLuantiContent.open(out, join(root, 'luanti'))
    await expect(content.ensure()).rejects.toThrow('LUANTI_CONTENT_ARCHIVE_CHANGED: worldedit')
  } finally { await rm(root, { recursive: true, force: true }) }
})
