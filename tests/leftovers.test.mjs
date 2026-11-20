import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {removeLeftovers} from '../src/leftovers.mjs';

async function withDir(work){
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-leftovers-'));
  try{await work(dir);}finally{await rm(dir,{recursive:true,force:true});}
}
const put=async(dir,...parts)=>{const file=path.join(dir,...parts);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'x');};

test('what older versions left goes, and nothing else',()=>withDir(async dir=>{
  await put(dir,'riot-skins','103','103001.fantome');await put(dir,'riot-database','list.json');
  await put(dir,'restart-old-games');await put(dir,'database-imports.json');
  await put(dir,'settings.json');await put(dir,'built-skins','a.fantome');await put(dir,'collection-index.json');
  await removeLeftovers(dir);
  const left=(await readdir(dir)).filter(name=>!name.startsWith('prepared-skins-cleared'));
  assert.deepEqual(left.sort(),['built-skins','collection-index.json','settings.json']);
}));

test('copies made ahead of time are cleared once; later copies stay',()=>withDir(async dir=>{
  await put(dir,'prepared-skins','old.fantome');
  await removeLeftovers(dir);
  assert.ok(!(await readdir(dir)).includes('prepared-skins'));
  await put(dir,'prepared-skins','kept.fantome');
  await removeLeftovers(dir);
  assert.deepEqual(await readdir(path.join(dir,'prepared-skins')),['kept.fantome']);
}));

test('a PC with none of it has nothing to do',()=>withDir(async dir=>{
  await removeLeftovers(dir);
  await removeLeftovers(dir);
  assert.equal((await readdir(dir)).length,1);
}));
