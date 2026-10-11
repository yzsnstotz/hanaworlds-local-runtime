/** Package the product game/mod supply: unchanged upstream archives plus a per-file manifest for first-run install. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
/**
 * Verify each archive against its recorded upstream identity, extract it with the same system tool the Host uses,
 * and record every installed file's SHA256. Nothing is patched or repacked.
 * @param {string} archives - Directory holding the downloaded upstream archives.
 * @param {string} output - Fresh bundle directory (App resource luanti-content).
 * @returns {object} supply manifest summary.
 */
export function prepareHanaWorldsLuantiContent(archives, output) {
 if(existsSync(output)) throw Error('Fresh luanti-content output required');
 const spec=JSON.parse(readFileSync(join(import.meta.dirname,'hanaworlds-luanti-content.json')));
 const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
 mkdirSync(output,{recursive:true});
 const components=[];
 for(const c of spec.components) {
  const archive=join(archives,c.archive);
  if(statSync(archive).size!==c.source.archiveBytes||sha(archive)!==c.source.archiveSha256) throw Error(`Upstream archive mismatch: ${c.id}`);
  const work=mkdtempSync(join(output,'..','.luanti-content-'));
  try {
   if(c.format==='zip') execFileSync('/usr/bin/ditto',['-x','-k',archive,work]); else execFileSync('/usr/bin/tar',['-xzf',archive,'-C',work]);
   const root=join(work,c.root),files={};
   const walk=prefix=>{for(const e of readdirSync(join(root,prefix),{withFileTypes:true})){const p=prefix?`${prefix}/${e.name}`:e.name;
    if(e.isDirectory())walk(p);else if(e.isFile())files[p]=sha(join(root,p));else throw Error(`Special file in ${c.id}: ${p}`);}};
   walk('');
   if(c.kind==='game'&&!files['game.conf']) throw Error(`${c.id} root has no game.conf`);
   if(c.kind==='mod'&&!files['mod.conf']) throw Error(`${c.id} root has no mod.conf`);
   components.push({...c,files:Object.fromEntries(Object.entries(files).sort(([a],[b])=>a<b?-1:a>b?1:0))});
  } finally { rmSync(work,{recursive:true,force:true}); }
  copyFileSync(archive,join(output,c.archive));
  if(lstatSync(join(output,c.archive)).size!==c.source.archiveBytes) throw Error('Copy mismatch');
 }
 writeFileSync(join(output,'supply.json'),JSON.stringify({schemaVersion:1,components},null,1)+'\n');
 return {supplySha256:sha(join(output,'supply.json')),components:components.map(c=>({id:c.id,version:c.version,archiveSha256:c.source.archiveSha256,files:Object.keys(c.files).length}))};
}
if(import.meta.main){const [a,o]=process.argv.slice(2);if(!a||!o)throw Error('Expected archive directory and fresh output');console.log(JSON.stringify(prepareHanaWorldsLuantiContent(resolve(a),resolve(o)),null,1));}
