import assert from 'node:assert/strict'
import {readFile, readdir, stat,realpath} from 'node:fs/promises'
import {resolve, dirname, relative, join} from 'node:path'
import {isBuiltin} from 'node:module'
import ts from 'typescript'
import identity from './contract-source.json' with {type:'json'}
import {sha256} from './contract-supply.mjs'

export function exportTargets(value, conditions=[]) {
 if(typeof value==='string')return [{target:value,types:conditions.includes('types')}]
 if(value===null)return []
 assert.ok(value && typeof value==='object','Invalid public export')
 return Object.entries(value).flatMap(([key,item])=>exportTargets(item,[...conditions,key]))
}
export async function auditPackage(root) {
 root=resolve(root)
 const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
 assert.equal(manifest.devDependencies?.['hanaworlds-contracts'],'git+https://github.com/yzsnstotz/hanaworlds-contracts.git#'+identity.tag,'Wrong declared development supply')
 const production=new Set()
 for(const field of ['dependencies','peerDependencies','optionalDependencies']) {
  for(const [name,spec] of Object.entries(manifest[field]??{})) {
   assert.ok(name!=='hanaworlds-contracts' && !spec.includes('hanaworlds-contracts'),'Production contract dependency')
   assert.ok(!/^(file:|link:|workspace:|git|https?:)/.test(spec),'Exotic production dependency')
   production.add(name)
  }
 }
 const graph={}, seen=new Set()
 const local=async(base,target,fileOnly=true)=>{
  const path=resolve(base,target)
  assert.ok(path.startsWith(root+'/'),'Resource escapes package: '+target)
  assert.equal(await realpath(path),path,'Packaged resource is a symlink')
  const info=await stat(path)
  assert.ok(info.isFile()||!fileOnly&&info.isDirectory(),'Missing packaged file: '+target)
  return path
 }
 const load=async(base,spec)=>{
  assert.ok(!spec.startsWith('hanaworlds-contracts') && !spec.startsWith('#contracts'),'Residual contract runtime load: '+spec)
  if(isBuiltin(spec))return spec
  if(spec.startsWith('#')) {
   const targets=exportTargets(manifest.imports?.[spec])
   assert.ok(targets.length,'Unresolved package import: '+spec)
   for(const {target} of targets)await load(root,target)
   return spec
  }
  if(spec.startsWith('.')) {const path=await local(base,spec);await visit(path);return relative(root,path)}
  assert.ok(!spec.includes(':')&&!spec.startsWith('/'),'External resource: '+spec)
  const name=spec.startsWith('@')?spec.split('/').slice(0,2).join('/'):spec.split('/')[0]
  assert.ok(production.has(name),'Undeclared runtime dependency: '+spec)
  return spec
 }
 const literal=node=>{
  assert.ok(node && ts.isStringLiteralLike(node),'Dynamic runtime loader/resource is not statically bounded')
  return node.text
 }
 const visit=async path=>{
  if(seen.has(path))return
  seen.add(path)
  if(path.endsWith('.json')) {JSON.parse(await readFile(path,'utf8'));return}
  if(!/\.[cm]?js$/.test(path))return
  const source=ts.createSourceFile(path,await readFile(path,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  assert.equal(source.parseDiagnostics.length,0,'Invalid JS artifact')
  const loads=[], resources=[],constants=new Map(),fileReaders=new Set(['readFile','readFileSync','createReadStream'])
  const gather=node=>{
   if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer)constants.set(node.name.text,node.initializer)
   if(ts.isImportDeclaration(node)&&node.moduleSpecifier.text.startsWith('node:fs'))for(const item of node.importClause?.namedBindings?.elements??[])if(['readFile','readFileSync','createReadStream'].includes(item.propertyName?.text??item.name.text))fileReaders.add(item.name.text)
   ts.forEachChild(node,gather)
  };gather(source)
  const evaluate=(node,visited=new Set())=>{
   if(!node)return undefined
   if(ts.isStringLiteralLike(node))return node.text
   if(ts.isParenthesizedExpression(node))return evaluate(node.expression,visited)
   if(ts.isIdentifier(node)&&constants.has(node.text)&&!visited.has(node.text))return evaluate(constants.get(node.text),new Set([...visited,node.text]))
   if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken){const a=evaluate(node.left,visited),b=evaluate(node.right,visited);if(a!==undefined&&b!==undefined)return a+b}
   if(ts.isTemplateExpression(node)) {
    let text=node.head.text
    for(const part of node.templateSpans){const value=evaluate(part.expression,visited);if(value===undefined)return undefined;text+=value+part.literal.text}
    return text
   }
   if(ts.isCallExpression(node)&&/^(join|resolve)$/.test(node.expression.getText(source))){const parts=node.arguments.map(x=>evaluate(x,visited));if(parts.every(x=>x!==undefined))return parts.join('/')}
   return undefined
  }
  const pathText=(node,visited=new Set())=>{
   if(!node)return []
   const value=evaluate(node,visited);if(value!==undefined)return [value]
   if(ts.isIdentifier(node)&&constants.has(node.text)&&!visited.has(node.text))return pathText(constants.get(node.text),new Set([...visited,node.text]))
   if(ts.isBinaryExpression(node))return [...pathText(node.left,visited),...pathText(node.right,visited)]
   if(ts.isCallExpression(node)||ts.isNewExpression(node))return [...(node.arguments??[])].flatMap(x=>pathText(x,visited))
   return []
  }
  const walk=node=>{
   if(ts.isIdentifier(node)&&['eval','Function'].includes(node.text))throw Error('Unbounded runtime loader: '+node.text)
   if(ts.isIdentifier(node)&&['require','__require','createRequire'].includes(node.text)) {
    assert.ok(ts.isCallExpression(node.parent)&&node.parent.expression===node,'Indirect runtime loader')
   }
   if(node.kind===ts.SyntaxKind.MetaProperty&&node.getText(source)==='import.meta') {
    assert.ok(ts.isPropertyAccessExpression(node.parent)&&['url','dirname','main','resolve'].includes(node.parent.name.text),'Indirect import.meta loader/resource')
    if(node.parent.name.text==='resolve')assert.ok(ts.isCallExpression(node.parent.parent)&&node.parent.parent.expression===node.parent,'Indirect runtime resolver')
   }
   if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)loads.push(literal(node.moduleSpecifier))
   if(ts.isCallExpression(node)) {
    const name=node.expression.getText(source)
    if(node.expression.kind===ts.SyntaxKind.ImportKeyword||/^(require|__require|require\.resolve|import\.meta\.resolve)$/.test(name))loads.push(literal(node.arguments[0]))
    if(/(^|\.)(eval|Function|createRequire|require)$/.test(name)&&!['require','__require'].includes(name))throw Error('Unbounded runtime loader: '+name)
    if(fileReaders.has(name)||/\.(readFile|readFileSync|createReadStream)$/.test(name)) {
     for(const text of pathText(node.arguments[0]))assert.ok(!text.includes('hanaworlds-contracts')&&!text.includes('#contracts')&&!text.includes('node_modules/'),'External development resource readback')
    }
    if(/^(join|resolve)$/.test(name)&&node.arguments[0]?.getText(source)==='import.meta.dirname') {
     resources.push(node.arguments.slice(1).map(literal).join('/'))
    }
   }
   if(ts.isNewExpression(node)&&node.expression.getText(source)==='URL'&&node.arguments?.[1]?.getText(source)==='import.meta.url')resources.push(literal(node.arguments[0]))
   ts.forEachChild(node,walk)
  }
  walk(source)
  graph[relative(root,path)]=[]
  for(const spec of loads)graph[relative(root,path)].push(await load(dirname(path),spec))
  for(const spec of resources){const file=await local(dirname(path),spec,false);await visit(file);graph[relative(root,path)].push(relative(root,file))}
 }
 for(const [specifier,value] of Object.entries(manifest.imports??{})) {
  assert.ok(!specifier.startsWith('#contracts'),'Residual contract package import')
  for(const {target} of exportTargets(value))await load(root,target)
 }
 const entries=exportTargets(manifest.exports??manifest.main)
 for(const key of ['main','module','types'])if(manifest[key])entries.push({target:manifest[key],types:key==='types'})
 for(const {target,types} of entries) {
  assert.ok(target.startsWith('./')&&!target.includes('*'),'Unbounded public artifact entry')
  const path=await local(root,target)
  if(!types){assert.ok(/\.(json|[cm]?js)$/.test(path),'Non-artifact runtime entry');await visit(path)}
 }
 // Shipped executable tooling is also a production artifact, even when not exported.
 const scan=async dir=>{for(const name of await readdir(dir)){const path=join(dir,name);if((await stat(path)).isDirectory())await scan(path);else if(/\.[cm]?js$/.test(path))await visit(path)}}
 await scan(root)
 const provenance=JSON.parse(await readFile(join(root,'dist/build-source.json')))
 assert.equal(provenance.sha,identity.sha,'Wrong build source SHA')
 assert.equal(provenance.tag,identity.tag,'Wrong build source tag')
 assert.equal(provenance.version,identity.version,'Wrong build source version')
 assert.equal(provenance.source,manifest.devDependencies['hanaworlds-contracts'],'Wrong build source release')
 assert.equal(provenance.resolved,identity.resolved,'Wrong build resolved identity')
 assert.equal(provenance.bundler,'esbuild@'+manifest.devDependencies.esbuild,'Wrong build bundler identity')
 for(const [path,digest] of Object.entries(provenance.artifacts))assert.equal(sha256(await readFile(await local(root,path))),digest,'Artifact digest changed: '+path)
 for(const [path,input] of Object.entries(provenance.inputs))if(path.startsWith('node_modules/hanaworlds-contracts/')) {
  assert.equal(input.sha256,identity.files[path.slice('node_modules/hanaworlds-contracts/'.length)],'Wrong compiled SDK source: '+path)
 }
 return {manifest,graph,entries}
}
