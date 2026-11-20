import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {divineDownloadUrl,divineOrigin,divineSelection,divineSkinLabel,inspectDownload,prepareDownload,reportDivineDownload,saveDivineSkin} from '../src/divine-skins.mjs';
import {writeZip} from '../src/skin-slots.mjs';
import {gitBlobHash} from '../src/git-blob.mjs';

const champions=[{id:'MonkeyKing',name:'Wukong'},{id:'Kaisa',name:"Kai'Sa"}];
async function workspace(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'divine-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const root=path.join(dir,'LocalSkins'),stage=await prepareDownload(root);
  return {root,stage,file:path.join(stage,'skin.part')};
}
const archive=(...names)=>writeZip(names.map(name=>({name,bytes:Buffer.from('asset')})));

test('a catalogue click uses the local champion spelling and only a Divine skin route',()=>{
  assert.deepEqual(divineSelection({champion:"Kai’Sa",route:'/Some_Creator/velvet-kaisa'},champions),
    {champion:champions[1],url:'https://divineskins.gg/download/Some_Creator/velvet-kaisa'});
  for(const route of ['//example.com/skin','/a/..','/a/%2foutside','/a/%2E%2E','/a/skin?next=x','/a/%FF'])
    assert.throws(()=>divineSelection({champion:'Wukong',route},champions),/link/);
  assert.throws(()=>divineSelection({champion:'Unknown',route:'/a/skin'},champions),/champion/);
});

test('a skin page opens only its own download page, never a catalogue or download route (12.8)',()=>{
  assert.equal(divineDownloadUrl('/Frog/iron-darius'),'https://divineskins.gg/download/Frog/iron-darius');
  for(const route of ['/mods/lol','/download/Frog','/Frog','/Frog/iron-darius/extra','',null])
    assert.throws(()=>divineDownloadUrl(route),/link/);
  assert.equal(divineSkinLabel('/Frog/iron-darius'),'Iron Darius');
  assert.equal(divineSkinLabel('/a/kda_firestarter-ahri'),'Kda Firestarter Ahri');
  assert.equal(divineSkinLabel(''),'This skin');
});

test('only Divine and its CDN supply downloads',()=>{
  assert.ok(divineOrigin('https://divineskins.gg/download/name/skin'));
  assert.ok(divineOrigin('blob:https://divineskins.gg/123'));
  assert.ok(divineOrigin('https://lol-mods.divine-cdn.com/skin',{cdn:true}));
  for(const url of ['https://divineskins.gg.example.com/a','https://divineskins.gg@localhost/a','http://divineskins.gg/a','file:///C:/test','blob:https://example.com/123','https://divineskins.gg:80/'])
    assert.equal(divineOrigin(url,{cdn:true}),false);
});
test('archive contents identify a champion despite the download name or a locale WAD',async t=>{
  const {file}=await workspace(t);
  await writeFile(file,archive('WAD/MonkeyKing.en_US.wad.client/audio','WAD/Shaders.wad.client/shader'));
  assert.deepEqual(await inspectDownload(file,'../CON.old.fantome',champions),{name:'Divine skin.fantome',suggested:'MonkeyKing'});
  await writeFile(file,archive('WAD/Kaisa.wad.client','WAD/MonkeyKing.wad.client'));
  assert.equal((await inspectDownload(file,'Two.zip',champions)).suggested,'');
  await writeFile(file,archive('RAW/assets/sample'));
  assert.equal((await inspectDownload(file,'Raw.fantome',champions)).suggested,'');
});
test('invalid and interrupted downloads never enter the local library',async t=>{
  const {file,root,stage}=await workspace(t);
  for(const bytes of [Buffer.from('<html>'),archive('readme.txt'),Buffer.from('_modpkg_')]){
    await writeFile(file,bytes);
    await assert.rejects(inspectDownload(file,'fake.modpkg',champions));
  }
  await assert.rejects(readdir(root),{code:'ENOENT'});
  await writeFile(path.join(stage,'skin-8f6a8040-93ad-446f-b5dd-0219de136821.part.crdownload'),'partial');
  await prepareDownload(root);
  assert.deepEqual(await readdir(stage),['skin.part']);
});
test('concurrent imports preserve existing files and identical downloads reuse their card',async t=>{
  const {file,root}=await workspace(t);
  const bytes=archive('WAD/Kaisa.wad.client');
  await writeFile(file,bytes);
  const skin={...await inspectDownload(file,'Skin.fantome',champions),file};
  await assert.rejects(saveDivineSkin(root,skin,champions,'../Kaisa'),/Choose a champion/);
  const save=download=>saveDivineSkin(root,download,champions,skin.suggested);
  const results=await Promise.all([save(skin),save(skin)]);
  assert.deepEqual(results.map(row=>row.already).sort(),[false,true]);
  const other={...skin,file:file+'2'};
  await writeFile(other.file,archive('WAD/Kaisa.wad.client/new'));
  assert.equal((await save(other)).already,false);
  assert.equal((await save(other)).already,true);
  const folder=path.join(root,"Kai'Sa");
  assert.deepEqual(await readFile(path.join(folder,skin.name)),bytes);
  assert.equal((await readdir(folder)).length,2);
});

test('a saved Divine skin is reported by its link, champion, file and Git blob hash only (12.9)',async t=>{
  const {root}=await workspace(t),file=path.join(root,'Darius','Iron.fantome');
  await import('node:fs/promises').then(fs=>fs.mkdir(path.dirname(file),{recursive:true}));
  await writeFile(file,'skin bytes');
  const sent=[];
  const ok=await reportDivineDownload({route:'/Frog/iron-darius',champion:'Darius',file,version:'12.9.0',url:'https://logs.example/divine-downloads',
    fetchFn:async(url,options)=>{sent.push({url,headers:options.headers,body:JSON.parse(options.body)});return {ok:true};}});
  assert.equal(ok,true);
  const {sha,...rest}=sent[0].body;
  assert.deepEqual(rest,{route:'/Frog/iron-darius',champion:'Darius',file:'Iron.fantome',size:10});
  assert.equal(sha,await gitBlobHash(file,10));
  assert.equal(sent[0].headers['x-friloverse-version'],'12.9.0');
  // No network, no file: the import is never held up.
  assert.equal(await reportDivineDownload({route:'/a/b',champion:'Darius',file,version:'12.9.0',fetchFn:async()=>{throw new Error('offline');}}),false);
  assert.equal(await reportDivineDownload({route:'/a/b',champion:'Darius',file:path.join(root,'missing'),version:'12.9.0'}),false);
});
