/** Product game/mod supply: packaged upstream archives installed into the product's own Luanti user path. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const exec = promisify(execFile)
const sha256 = /^[a-f0-9]{64}$/
const relativePath = z.string().refine(path => path.length > 0 && !path.startsWith('/')
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'relative path')
const componentSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), kind: z.enum(['game', 'mod']), name: z.string(), version: z.string(),
  installName: z.string().regex(/^[a-z0-9_]+$/), license: z.string(),
  source: z.object({ url: z.url(), page: z.url(), revision: z.string(), archiveSha256: z.string().regex(sha256),
    archiveBytes: z.number().int().positive() }).strict(),
  archive: relativePath, format: z.enum(['zip', 'tar.gz']), root: relativePath,
  files: z.record(relativePath, z.string().regex(sha256)),
}).strict()
const supplySchema = z.object({ schemaVersion: z.literal(1), components: z.array(componentSchema).min(1) }).strict()
export type LuantiContentComponent = z.infer<typeof componentSchema>
export type LuantiContentState = 'INSTALLED_VERIFIED' | 'NOT_INSTALLED'
export interface LuantiContentStatus {
  id: string
  kind: 'game' | 'mod'
  name: string
  version: string
  installName: string
  license: string
  source: LuantiContentComponent['source']
  target: string
  state: LuantiContentState
  files: number
}

const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
const target = (component: LuantiContentComponent) => join(component.kind === 'game' ? 'games' : 'mods', component.installName)
function fail(code: string, detail: string): never { throw new Error(`${code}: ${detail}`) }

/** Every regular file under a directory; symlinks and other special files are refused. */
async function regularFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await regularFiles(root, path))
    else if (entry.isFile()) files.push(path)
    else fail('LUANTI_CONTENT_SPECIAL_FILE', path)
  }
  return files
}

/** Compare an installed or staged tree with the packaged per-file manifest; no extra or changed file is accepted. */
async function verifyTree(root: string, component: LuantiContentComponent): Promise<void> {
  const expected = Object.keys(component.files).sort(), found = (await regularFiles(root)).sort()
  const missing = expected.filter(path => !found.includes(path)), extra = found.filter(path => !(path in component.files))
  if (missing.length || extra.length) {
    fail('LUANTI_CONTENT_CHANGED', `${component.id} at ${root}: ${missing.length} missing (${missing.slice(0, 3).join(', ')}), ${extra.length} extra (${extra.slice(0, 3).join(', ')})`)
  }
  for (const path of expected) {
    if (await digest(join(root, path)) !== component.files[path]) fail('LUANTI_CONTENT_CHANGED', `${component.id} at ${root}: ${path} differs`)
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** Installs the packaged game and per-cell mod exactly once into the product user path; never overwrites. */
export class DesktopLuantiContent {
  private constructor(private readonly bundle: string, readonly userPath: string,
    private readonly components: readonly LuantiContentComponent[]) {}
  /**
   * Read the packaged supply manifest; an App without it names the gap instead of guessing a game.
   * @param bundle - App-owned directory holding supply.json and the unchanged upstream archives.
   * @param userPath - Product-owned Luanti user path (games/, mods/, worlds/).
   * @returns Supply bound to that user path.
   */
  static async open(bundle: string, userPath: string): Promise<DesktopLuantiContent> {
    let text: string
    try { text = await readFile(join(bundle, 'supply.json'), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('LUANTI_CONTENT_UNAVAILABLE', `the App has no packaged game/mod supply at ${bundle}`)
      throw error
    }
    const supply = supplySchema.parse(JSON.parse(text))
    if (new Set(supply.components.map(c => target(c))).size !== supply.components.length) fail('LUANTI_CONTENT_INVALID', 'duplicate install target')
    return new DesktopLuantiContent(await realpath(bundle), userPath, supply.components)
  }
  /** The product game the supply provides; world creation names it instead of letting Adapter guess. */
  gameId(): string {
    const games = this.components.filter(c => c.kind === 'game')
    if (games.length !== 1) fail('LUANTI_CONTENT_INVALID', `expected exactly one supplied game, found ${games.length}`)
    return (games[0] as LuantiContentComponent).installName
  }
  /** Current state per component; a present but changed tree is an error, never "installed". */
  async describe(): Promise<LuantiContentStatus[]> {
    const rows: LuantiContentStatus[] = []
    for (const component of this.components) {
      const path = join(this.userPath, target(component))
      let state: LuantiContentState = 'NOT_INSTALLED'
      if (await exists(path)) { await verifyTree(path, component); state = 'INSTALLED_VERIFIED' }
      rows.push({ id: component.id, kind: component.kind, name: component.name, version: component.version,
        installName: component.installName, license: component.license, source: { ...component.source },
        target: path, state, files: Object.keys(component.files).length })
    }
    return rows
  }
  /** First-run installation: verify archive bytes, extract with the system tool, verify every file, atomically rename. */
  async ensure(): Promise<LuantiContentStatus[]> {
    await mkdir(this.userPath, { recursive: true, mode: 0o700 })
    for (const component of this.components) {
      const final = join(this.userPath, target(component))
      if (await exists(final)) { await verifyTree(final, component); continue }
      const archive = join(this.bundle, component.archive)
      const bytes = (await stat(archive)).size
      if (bytes !== component.source.archiveBytes || await digest(archive) !== component.source.archiveSha256) {
        fail('LUANTI_CONTENT_ARCHIVE_CHANGED', `${component.id} packaged archive ${archive}`)
      }
      await mkdir(join(this.userPath, target(component), '..'), { recursive: true, mode: 0o700 })
      const staging = join(this.userPath, `.hanaworlds-content-${randomUUID()}`)
      await mkdir(staging, { mode: 0o700 })
      try {
        if (component.format === 'zip') await exec('/usr/bin/ditto', ['-x', '-k', archive, staging])
        else await exec('/usr/bin/tar', ['-xzf', archive, '-C', staging])
        const extracted = join(staging, component.root)
        await verifyTree(extracted, component)
        if (await exists(final)) fail('LUANTI_CONTENT_RACE', `${final} appeared during installation`)
        await rename(extracted, final)
        await syncDirectory(join(final, '..'))
      } finally { await rm(staging, { recursive: true, force: true }) }
      await verifyTree(final, component)
    }
    return this.describe()
  }
}
