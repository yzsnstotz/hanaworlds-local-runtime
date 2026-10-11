import {execFileSync} from 'node:child_process'
const cwd=new URL('../',import.meta.url)
execFileSync(process.execPath,['scripts/build.mjs'],{cwd,stdio:'inherit'})
const parent=process.env.HANAWORLDS_BOUNDARY_PARENT
if(parent) {
 // A live boundary-test parent is waiting to inspect this pack. This avoids
 // recursively packing inside prepack; it does not skip build/source checks.
 const command=execFileSync('ps',['-p',parent,'-o','command='],{encoding:'utf8'})
 if(!command.includes('node scripts/test-package-boundary.mjs'))throw Error('Invalid boundary pack parent')
} else execFileSync(process.execPath,['scripts/test-package-boundary.mjs'],{cwd,stdio:'inherit'})
