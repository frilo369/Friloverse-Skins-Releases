import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CustomMods} from '../src/custom-mods.mjs';
import {SkinDatabase} from '../src/skin-database.mjs';
import {zip} from './fixtures/zip.mjs';

async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-mods-')),folder=path.join(root,'Custom Mods');
  await mkdir(folder);
  const original=zip({'META/info.json':JSON.stringify({Name:'Minions',Author:'Frog'}),'WAD/x.wad.client':'data'});
  const file=path.join(folder,'Minions.fantome');await writeFile(file,original);
  const make=()=>new CustomMods({database:new SkinDatabase({root:folder,mode:'mods'}),dataDir:path.join(root,'data')});
  return {root,file,original,make};
}

test('a mod stays on across restarts, and its file is never changed',async()=>{
  const f=await fixture();
  try{
    const mods=f.make();
    const [mod]=(await mods.list()).mods;
    assert.match(mod.id,/^moddb:/);assert.equal(mod.enabled,false);assert.equal(mod.name,'Minions');
    assert.deepEqual(await mods.files(),[]);
    await mods.setEnabled(mod.id,true);
    const later=f.make();await later.load();
    assert.equal((await later.list()).mods[0].enabled,true);
    const files=await later.files();
    assert.equal(files.length,1);assert.equal(files[0].file,f.file);assert.match(files[0].key,/^[0-9a-f]{40}$/);
    await later.setEnabled(mod.id,false);
    assert.deepEqual(await later.files(),[]);
    assert.deepEqual(await readFile(f.file),f.original);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('a mod that no longer exists cannot be turned on',async()=>{
  const f=await fixture();
  try{
    const mods=f.make();
    await assert.rejects(mods.setEnabled('moddb:unknown',true),/no longer available/);
    await assert.rejects(mods.setEnabled(5,true),/Choose/);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('a chosen mod whose file went away stays chosen but loads nothing',async()=>{
  const f=await fixture();
  try{
    const mods=f.make();const [mod]=(await mods.list()).mods;
    await mods.setEnabled(mod.id,true);
    await rm(f.file);
    assert.deepEqual(await mods.files(),[]);
    assert.equal(mods.enabled.has(mod.id),true);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('a missing mods folder is reported, not an error',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-mods-'));
  try{
    const mods=new CustomMods({database:new SkinDatabase({root:path.join(root,'none'),mode:'mods'}),dataDir:root});
    assert.deepEqual(await mods.list(),{available:false,mods:[]});
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a damaged mod stays chosen but is not given to the engine',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-mods-'));
  try{
    const folder=path.join(root,'mods');await mkdir(folder,{recursive:true});
    await writeFile(path.join(folder,'Damaged.fantome'),Buffer.from('not a zip'));
    const mods=new CustomMods({database:new SkinDatabase({root:folder,mode:'mods'}),dataDir:path.join(root,'data')});
    const [row]=(await mods.list()).mods;
    assert.equal(row.broken,true);
    mods.enabled.add(row.id);
    assert.deepEqual(await mods.files(),[]);
    assert.equal((await mods.list()).mods[0].enabled,true);
  }finally{await rm(root,{recursive:true,force:true});}
});
