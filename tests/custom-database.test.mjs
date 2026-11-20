import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {importLegacyCustomLibraries,importProblem,loadCustomArtwork} from '../src/custom-database.mjs';

test('legacy FrYiLoCo packages move into the Friloverse database without overwriting',async()=>{
  const local=await mkdtemp(path.join(tmpdir(),'friloverse-custom-db-'));
  try{
    const oldSkins=path.join(local,'FrYiLoCo','Custom Skins','Ahri'),oldMods=path.join(local,'FrYiLoCo','Custom Mods');
    const newSkins=path.join(local,'friloverse-skins-data','Database','Custom Skins','Ahri'),newMods=path.join(local,'friloverse-skins-data','Database','Custom Mods');
    await mkdir(oldSkins,{recursive:true});await mkdir(oldMods,{recursive:true});
    await mkdir(newSkins,{recursive:true});
    await writeFile(path.join(oldSkins,'Yumeko.fantome'),'old skin');
    await writeFile(path.join(oldSkins,'Keep.fantome'),'do not replace');
    await writeFile(path.join(newSkins,'Keep.fantome'),'player copy');
    await writeFile(path.join(oldMods,'Maps.fantome'),'old mod');
    const progress=[];
    const result=await importLegacyCustomLibraries({localAppData:local,onProgress:(done,total)=>progress.push([done,total])});
    assert.deepEqual(result,{copied:2,total:2});
    assert.deepEqual(await readFile(path.join(newSkins,'Yumeko.fantome'),'utf8'),'old skin');
    assert.deepEqual(await readFile(path.join(newSkins,'Keep.fantome'),'utf8'),'player copy');
    assert.deepEqual(await readFile(path.join(newMods,'Maps.fantome'),'utf8'),'old mod');
    assert.deepEqual(progress.at(-1),[2,2]);
    await writeFile(path.join(oldSkins,'Yumeko.fantome'),'old skin changed');
    assert.deepEqual(await importLegacyCustomLibraries({localAppData:local}),{copied:0,total:0,skipped:true});
    assert.deepEqual(await readFile(path.join(oldSkins,'Yumeko.fantome'),'utf8'),'old skin changed','the source archive stays untouched');
  }finally{assert.equal(path.dirname(path.resolve(local)),path.resolve(tmpdir()));await rm(local,{recursive:true,force:true});}
});

test('no legacy folder is not an error and creates no database files',async()=>{
  const local=await mkdtemp(path.join(tmpdir(),'friloverse-custom-empty-'));
  try{assert.deepEqual(await importLegacyCustomLibraries({localAppData:local}),{copied:0,total:0});}
  finally{assert.equal(path.dirname(path.resolve(local)),path.resolve(tmpdir()));await rm(local,{recursive:true,force:true});}
});

test('the old collection artwork map becomes a local Friloverse database cache',async()=>{
  const local=await mkdtemp(path.join(tmpdir(),'friloverse-custom-art-'));
  try{
    const dataDir=path.join(local,'data');
    await mkdir(dataDir,{recursive:true});
    await writeFile(path.join(dataDir,'collection-index.json'),JSON.stringify({version:2,files:[{sha:'a'.repeat(40),artwork:'https://raw.githubusercontent.com/frilo369/FrYiLoCo-Custom-Skins/abc/Custom%20Skins/Ahri/Test.webp'}]}));
    const art=await loadCustomArtwork({dataDir,databaseRoot:path.join(local,'friloverse-skins-data','Database')});
    assert.equal(art['a'.repeat(40)],'https://raw.githubusercontent.com/frilo369/FrYiLoCo-Custom-Skins/abc/Custom%20Skins/Ahri/Test.webp');
    assert.deepEqual(await loadCustomArtwork({dataDir,databaseRoot:path.join(local,'friloverse-skins-data','Database')}),art);
  }finally{assert.equal(path.dirname(path.resolve(local)),path.resolve(tmpdir()));await rm(local,{recursive:true,force:true});}
});

async function legacyFolders(prefix){
  const local=await mkdtemp(path.join(tmpdir(),prefix));
  const oldRoot=path.join(local,'FrYiLoCo','Custom Skins'),newRoot=path.join(local,'friloverse-skins-data','Database','Custom Skins');
  await mkdir(path.join(oldRoot,'Ahri'),{recursive:true});await mkdir(path.join(oldRoot,'Lux'),{recursive:true});await mkdir(newRoot,{recursive:true});
  await writeFile(path.join(oldRoot,'Ahri','Bad.fantome'),'bad');await writeFile(path.join(oldRoot,'Lux','Good.fantome'),'good');
  return {local,oldRoot,newRoot,marker:path.join(local,'friloverse-skins-data','Database','.legacy-custom-imported')};
}
const drop=local=>rm(local,{recursive:true,force:true});

test('something else at a file\'s name costs only that file, and the import still finishes',async()=>{
  const f=await legacyFolders('friloverse-import-odd-');
  try{
    await mkdir(path.join(f.newRoot,'Ahri','Bad.fantome'),{recursive:true});
    const result=await importLegacyCustomLibraries({localAppData:f.local});
    assert.equal(result.copied,1);
    assert.equal(result.leftOut.length,1);
    assert.equal(await readFile(path.join(f.newRoot,'Lux','Good.fantome'),'utf8'),'good');
    assert.deepEqual(await importLegacyCustomLibraries({localAppData:f.local}),{copied:0,total:0,skipped:true});
  }finally{await drop(f.local);}
});

test('a file that could not be copied is tried again alone, and a deleted skin stays deleted',async()=>{
  const f=await legacyFolders('friloverse-import-retry-');
  try{
    await writeFile(path.join(f.newRoot,'Ahri'),'a file where the folder should go');
    const first=await importLegacyCustomLibraries({localAppData:f.local});
    assert.equal(first.copied,1);
    assert.deepEqual(first.failed.map(item=>item.file),['Custom Skins/Ahri/Bad.fantome']);
    assert.deepEqual(JSON.parse(await readFile(f.marker,'utf8')).pending,['Custom Skins/Ahri/Bad.fantome']);
    await rm(path.join(f.newRoot,'Ahri'));
    await rm(path.join(f.newRoot,'Lux','Good.fantome'));
    assert.deepEqual(await importLegacyCustomLibraries({localAppData:f.local}),{copied:1,total:1});
    assert.equal(await readFile(path.join(f.newRoot,'Ahri','Bad.fantome'),'utf8'),'bad');
    await assert.rejects(readFile(path.join(f.newRoot,'Lux','Good.fantome')),{code:'ENOENT'});
    assert.deepEqual(await importLegacyCustomLibraries({localAppData:f.local}),{copied:0,total:0,skipped:true});
  }finally{await drop(f.local);}
});

test('a file that can never be copied is given up on after five starts',async()=>{
  const f=await legacyFolders('friloverse-import-limit-');
  try{
    await writeFile(path.join(f.newRoot,'Ahri'),'in the way');
    for(let start=0;start<5;start++)assert.equal((await importLegacyCustomLibraries({localAppData:f.local})).failed.length,1,`start ${start}`);
    assert.deepEqual(await importLegacyCustomLibraries({localAppData:f.local}),{copied:0,total:0,skipped:true});
  }finally{await drop(f.local);}
});

test('files an import could not bring over are said in words, and nothing else is',()=>{
  assert.equal(importProblem({copied:3,total:3}),'');
  assert.match(importProblem({failed:[{file:'a',problem:'locked'}]}),/^1 old custom file could not be imported\. It is still/);
  assert.match(importProblem({failed:[{file:'a',problem:'locked'}],leftOut:[{file:'b',problem:'x'}]}),/^2 old custom files could not be imported\. They are still/);
});
