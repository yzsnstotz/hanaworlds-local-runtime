/** Build a relocatable component runtime from the declared official engine artifact.
 * This does not install or modify a formal Desktop or Luanti application.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const [engineArtifact, destination] = process.argv.slice(2)
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Only darwin-arm64 is supported')
if (!engineArtifact || !destination) throw new Error('Usage: node build-engine-control-runtime.mjs <official-http-engine-runtime> <new-output>')
const source = resolve(engineArtifact), output = resolve(destination)
if (existsSync(output)) throw new Error('Output already exists; preserve the prior artifact')
const binary = join(source, 'luanti.app/Contents/MacOS/luantiserver')
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const engineSHA = '6fd32e8fcd56a6d7b50cf8f0a881a18c47a9232e453cad5363d857a2c359d494'
if (sha(binary) !== engineSHA) throw new Error('Expected official 5.17.0 c0e6812 HTTP engine built for macOS 14')
mkdirSync(output, { recursive: true })
cpSync(join(source, 'luanti.app'), join(output, 'luanti.app'), { recursive: true, dereference: true })
// Materialize the upstream compatibility alias so the component contains no build-cache link.
const compatibilityAlias = join(output, 'luanti.app/Contents/MacOS/minetestserver')
rmSync(compatibilityAlias, { force: true })
copyFileSync(binary, compatibilityAlias)
cpSync(join(source, 'LICENSE-Luanti.txt'), join(output, 'LICENSE-Luanti.txt'))
const cwd = resolve(import.meta.dirname, '../engine-control')
execFileSync('go', ['build', '-trimpath', '-o', join(output, 'native-control'), '.'], { cwd, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'inherit' })
const modules = JSON.parse(execFileSync('go', ['list', '-m', '-json'], { cwd, encoding: 'utf8' }))
const licenses = join(output, 'licenses'); mkdirSync(licenses)
cpSync(join(source, 'licenses'), licenses, { recursive: true })
cpSync(join(source, 'engine-build.json'), join(output, 'engine-build.json'))
const goRoot = execFileSync('go', ['env', 'GOROOT'], { cwd, encoding: 'utf8' }).trim()
const goLicense = [join(goRoot, 'LICENSE'), resolve(goRoot, '../LICENSE')].find(existsSync)
if (!goLicense) throw new Error('Go toolchain license is missing')
cpSync(goLicense, join(licenses, 'Go.txt'))
for (const module of ['github.com/HimbeerserverDE/mt', 'github.com/HimbeerserverDE/srp', 'github.com/klauspost/compress']) {
 const details = JSON.parse(execFileSync('go', ['list', '-m', '-json', module], { cwd, encoding: 'utf8' }))
 cpSync(join(details.Dir, 'LICENSE'), join(licenses, module.split('/').at(-1)+'.txt'))
}
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, platform: 'darwin-arm64',
 engineSource: { url: 'https://github.com/luanti-org/luanti', commit: 'c0e6812b1a4260bb25a1f606f70f55f4962bb97d', version: '5.17.0' },
 engine: { path: 'luanti.app/Contents/MacOS/luantiserver', sha256: engineSHA },
 helper: { path: 'native-control', sha256: sha(join(output, 'native-control')) },
 capabilities: { http: true, curses: true }, helperModule: modules.Path, scope: 'COMPONENT; formal product installer and clean-machine verification pending',
}, null, 2)+'\n')
console.log(JSON.stringify({ output, engineSHA256: engineSHA, helperSHA256: sha(join(output, 'native-control')) }))
