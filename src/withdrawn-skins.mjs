import {readdir,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {gitBlobHash} from './git-blob.mjs';

// A skin taken off GitHub goes from every player's library too. The collections name each one
// in `removed.json` by its contents, so a player's own file is never touched, whatever it is
// called. This list ships with each app update; the live one is read at every skin-list check,
// so a removal reaches players without waiting for a new version.
export const COLLECTIONS=['frilo369/FrYiLoCo-Custom-Skins','frilo369/FrYiLoCo-Custom-Skins-2'];
const REMOVED_URL=repository=>`https://raw.githubusercontent.com/${repository}/main/removed.json`;
const {removed:BUNDLED}=createRequire(import.meta.url)('./withdrawn-skins.json');

/** The usable rows of a `removed.json`. A damaged list names nothing. */
export function withdrawnRows(value){
  const rows=Array.isArray(value?.removed)?value.removed:[];
  return rows.filter(row=>/^[0-9a-f]{40}$/.test(row?.sha||'')&&Number.isSafeInteger(row?.size)&&row.size>0);
}
/** What is withdrawn now. GitHub out of reach only means the list shipped with the app. */
export async function withdrawnSkins({fetchFn=fetch}={}){
  const rows=[...withdrawnRows({removed:BUNDLED})];
  await Promise.all(COLLECTIONS.map(async repository=>{
    try{
      const response=await fetchFn(REMOVED_URL(repository),{signal:AbortSignal.timeout(20000)});
      if(response.ok)rows.push(...withdrawnRows(await response.json()));
    }catch{/* The next check asks again. */}
  }));
  return rows;
}
async function packages(root){
  const files=[];
  const walk=async(dir,depth)=>{
    if(depth>5)return;
    let entries;
    try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}
    for(const entry of entries){
      if(entry.isSymbolicLink())continue;
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())await walk(file,depth+1);
      else if(entry.isFile()&&/\.(?:fantome|modpkg)$/i.test(entry.name))files.push(file);
    }
  };
  await walk(root,0);
  return files;
}
/**
 * Removes every package with exactly the contents of a withdrawn row. Only a file of the right
 * size is hashed, so a check costs almost nothing. Returns the files removed.
 */
export async function pruneWithdrawn({roots,rows,remove,hash=gitBlobHash}){
  const wanted=new Set(rows.map(row=>`${row.sha}:${row.size}`)),sizes=new Set(rows.map(row=>row.size)),removed=[];
  for(const root of roots)for(const file of await packages(root)){
    try{
      const {size}=await stat(file);
      if(!sizes.has(size)||!wanted.has(`${await hash(file,size)}:${size}`))continue;
      await remove(file);
      removed.push(file);
    }catch{/* In use or just gone: the next check tries again. */}
  }
  return removed;
}
