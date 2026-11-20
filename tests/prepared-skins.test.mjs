import {COMPAT_REVISION} from '../src/custom-skin-compat.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PreparedSkinLibrary,currentManifest,environmentFingerprint,fileFingerprint} from '../src/prepared-skins.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function withLibrary(work){
  const dataDir=await mkdtemp(path.join(tmpdir(),'friloverse-prepared-'));
  try{
    const league=path.join(dataDir,'league'),manager=path.join(dataDir,'manager.exe');
    await mkdir(path.join(league,'Game'),{recursive:true});
    const game=path.join(league,'Game','League of Legends.exe');
    await writeFile(game,'game-v1');await writeFile(manager,'manager-v1');
    const dir=path.join(dataDir,'prepared-skins');await mkdir(dir);
    const bytes=Buffer.from('prepared custom skin'),sha256=digest(bytes),name=`${sha256}.fantome`,file=path.join(dir,name);
    await writeFile(file,bytes);
    const original=path.join(dataDir,'Yumeko.fantome');await writeFile(original,'the original');
    const key='1'.repeat(40),pick={key,file:original,alias:'Ahri',label:'Yumeko'};
    const manifest={version:1,compatRevision:COMPAT_REVISION,...await environmentFingerprint({league,manager}),entries:{[key]:{status:'ready',file:name,sha256,sourceHash:'2'.repeat(64),champion:'Ahri'}}};
    let tick=Date.now();
    const save=async()=>{await writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));tick+=2000;await utimes(path.join(dir,'manifest.json'),tick/1000,tick/1000);};
    await save();
    const built=[];
    const buildCopy=async request=>{built.push(request);return {file:path.join(request.dir,'copy.fantome')};};
    const library=new PreparedSkinLibrary({dataDir,league:async()=>league,manager:async()=>manager,buildCopy});
    await work({library,manifest,pick,file,save,game,manager,dir,built,league,dataDir});
  }finally{await rm(dataDir,{recursive:true,force:true});}
}
const preparedNow=(result,built)=>{assert.equal(result.working,true);assert.equal(result.prepared,false);assert.equal(built.length,1);};

test('a prepared archive replaces only the load path, preserving party identity and source',()=>withLibrary(async({library,pick,file,built})=>{
  const result=await library.resolve(pick);
  assert.equal(result.file,file);assert.equal(result.prepared,true);assert.equal(result.key,pick.key);
  assert.equal(result.label,'Yumeko');assert.equal(result.alias,'Ahri');assert.equal(path.basename(pick.file),'Yumeko.fantome');
  assert.deepEqual(await readFile(file),Buffer.from('prepared custom skin'));
  assert.equal(built.length,0);
}));

test('trusted Riot picks bypass the prepared library entirely',async()=>{
  const library=new PreparedSkinLibrary({dataDir:'absent',league:async()=>{throw new Error('must not resolve');},manager:async()=>{throw new Error('must not resolve');}});
  const pick={key:'riot',file:'riot.fantome',trusted:true};
  assert.equal(await library.resolve(pick),pick);
});

test('after a League or LTK update the old copy is still used, for LTK to check',()=>withLibrary(async({library,pick,file,game,manager,manifest,save,built})=>{
  await library.resolve(pick);
  await writeFile(game,'game-v2-patched');
  let result=await library.resolve(pick);
  assert.equal(result.file,file);assert.equal(result.prepared,false);assert.equal(result.working,undefined);
  manifest.gameFingerprint=await fileFingerprint(game);await save();
  assert.equal((await library.resolve(pick)).prepared,true);
  await writeFile(manager,'manager-v2-patched');
  result=await library.resolve(pick);
  assert.equal(result.prepared,false);
  assert.equal(built.length,0);
}));

test('a copy marked as old is not trusted either',()=>withLibrary(async({library,pick,manifest,save})=>{
  manifest.entries[pick.key].stale=true;await save();
  assert.equal((await library.resolve(pick)).prepared,false);
}));

test('a skin with no copy is made on the pick, on its champion',()=>withLibrary(async({library,pick,built,league,dir})=>{
  const unknown={...pick,key:'3'.repeat(40)};
  const result=await library.resolve(unknown);
  preparedNow(result,built);
  assert.equal(result.key,unknown.key);assert.equal(built[0].file,pick.file);assert.equal(built[0].champion,'Ahri');
  assert.equal(built[0].league,league);assert.equal(built[0].dir,path.join(dir,'working'));
}));

test('a mod has no champion to make its copy on',()=>withLibrary(async({library,pick,built})=>{
  await library.resolve({key:'3'.repeat(40),file:pick.file,label:'Sound pack'});
  assert.equal(built[0].champion,null);
}));

test('a copy that cannot be made says so plainly, and a busy file may be tried again',()=>withLibrary(async({library,pick})=>{
  const unknown={...pick,key:'3'.repeat(40)};
  library.buildCopy=async()=>{throw new Error('League base skin name could not be read.');};
  await assert.rejects(library.resolve(unknown),error=>error.plain&&/Yumeko could not be prepared/.test(error.message));
  library.buildCopy=async()=>{throw Object.assign(new Error('busy'),{code:'EBUSY'});};
  await assert.rejects(library.resolve(unknown),error=>error.code==='EBUSY'&&!error.plain);
}));

test('an altered prepared archive is made again, even after its old hash was cached',()=>withLibrary(async({library,pick,file,built})=>{
  await library.resolve(pick);
  await writeFile(file,'damaged archive, different length');
  preparedNow(await library.resolve(pick),built);
}));

test('a different champion cannot reuse another copy',()=>withLibrary(async({library,pick,built})=>{
  preparedNow(await library.resolve({...pick,alias:'Aatrox'}),built);
  assert.equal(built[0].champion,'Aatrox');
}));

test('prepared filenames cannot escape the cache or load an unverified format',()=>withLibrary(async({library,pick,manifest,save,built})=>{
  for(const filename of ['../outside.fantome','C:/outside.fantome','a'.repeat(64)+'.dll']){
    manifest.entries[pick.key].file=filename;await save();
    assert.equal((await library.resolve(pick)).working,true);
  }
  assert.equal(built.length,3);
}));

test('a missing or unsupported manifest means making the copy on the pick',()=>withLibrary(async({library,pick,manifest,save,dir,built})=>{
  manifest.compatRevision=99;await save();assert.equal((await library.resolve(pick)).working,true);
  await rm(path.join(dir,'manifest.json'));assert.equal((await library.resolve(pick)).working,true);
  assert.equal(built.length,2);
}));

test('what LTK accepted on a pick is kept, and the next pick needs nothing',()=>withLibrary(async({library,pick,manifest,save,game,dataDir,dir,built})=>{
  const other='4'.repeat(40);
  manifest.entries[other]={...manifest.entries[pick.key],champion:'Zed'};delete manifest.entries[pick.key];await save();
  await writeFile(game,'game-v2-patched');
  const modDir=path.join(dataDir,'ltk-mod');await writeFile(`${modDir}.fantome`,'repaired by LTK');
  const fresh=await library.resolve(pick);assert.equal(fresh.working,true);
  const mod={storage:'archive',format:'fantome',hasArchive:true,slug:'yumeko',modDir};
  assert.equal(await library.keep(pick,mod),true);
  const saved=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));
  assert.equal(saved.entries[other].stale,true,'the rest stay, as old copies');
  const again=await library.resolve(pick);
  assert.equal(again.prepared,true);assert.equal(again.working,undefined);
  assert.equal(await readFile(again.file,'utf8'),'repaired by LTK');
  assert.equal(built.length,1);
}));

test('only an archive LTK says it holds is kept',()=>withLibrary(async({library,pick,dir,manifest})=>{
  const before=await readFile(path.join(dir,'manifest.json'),'utf8');
  assert.equal(await library.keep(pick,undefined),false);
  assert.equal(await library.keep(pick,{storage:'folder',format:'fantome',hasArchive:true,slug:'x',modDir:path.resolve('x')}),false);
  assert.equal(await library.keep({...pick,key:'bad'},{storage:'archive',format:'fantome',hasArchive:true,slug:'x',modDir:path.resolve('x')}),false);
  assert.equal(await readFile(path.join(dir,'manifest.json'),'utf8'),before);assert.ok(manifest);
}));

test('an update keeps copies as old ones, and a new way of making them drops them',()=>{
  const environment={gameFingerprint:'new',managerFingerprint:'m'};
  const saved=()=>({version:1,compatRevision:COMPAT_REVISION,gameFingerprint:'old',managerFingerprint:'m',entries:{a:{status:'ready'}}});
  const updated=currentManifest(saved(),environment);
  assert.equal(updated.entries.a.stale,true);assert.equal(updated.gameFingerprint,'new');
  const same=currentManifest({...saved(),gameFingerprint:'new'},environment);
  assert.equal(same.entries.a.stale,undefined);
  assert.deepEqual(currentManifest({...saved(),compatRevision:COMPAT_REVISION-1},environment).entries,{});
  assert.deepEqual(currentManifest(null,environment).entries,{});
});
