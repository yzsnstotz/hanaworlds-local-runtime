/** Materialize the unchanged, signed official Luanti client with its pinned archive and licenses. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const pin = JSON.parse(readFileSync(new URL('./hanaworlds-game-client.json', import.meta.url)));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function prepareHanaWorldsGameClient(supply, destination) {
  if (existsSync(destination)) throw Error('Fresh graphical client destination required');
  const archive = join(supply, pin.archive), license = join(supply, pin.license.file);
  if (statSync(archive).size !== pin.bytes || sha(archive) !== pin.sha256 || sha(license) !== pin.license.sha256) throw Error('Official graphical client input mismatch');
  mkdirSync(destination, { recursive: true });
  execFileSync('/usr/bin/ditto', ['-x', '-k', archive, destination]);
  if (sha(join(destination, pin.executable.path)) !== pin.executable.sha256) throw Error('Graphical client executable mismatch');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(destination, 'luanti.app')]);
  copyFileSync(license, join(destination, pin.license.file));
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(pin, null, 2) + '\n');
  return pin;
}
