import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {collectionTarget,readTree,saveArtwork,syncCollection} from '../src/custom-collection.mjs';
import {refsResponse} from './fixtures/github.mjs';

const blob=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const zip=text=>Buffer.from(`PK${text}`);
const REPOS=['me/one','me/two'];

/** A stand-in GitHub holding two collections, counting what was asked of it. */
function github(collections){
  const asked=[];
  const files=new Map();
  for(const [repository,entries] of Object.entries(collections))for(const [file,bytes] of Object.entries(entries))files.set(`${repository}/${file}`,bytes);
  const fetchFn=async url=>{
    asked.push(url);
    const commit=/github\.com\/(.+?)\.git\/info\/refs/.exec(url);
    if(commit){
      const head=blob(Buffer.from(commit[1]+JSON.stringify(Object.entries(collections[commit[1]]).map(([file,bytes])=>[file,blob(bytes)]))));
      return refsResponse({HEAD:head,'refs/heads/main':head});
    }
    const tree=/repos\/(.+?)\/git\/trees\//.exec(url);
    if(tree)return {ok:true,status:200,json:async()=>({truncated:false,tree:Object.entries(collections[tree[1]]).map(([file,bytes])=>({type:'blob',path:file,sha:blob(bytes),size:bytes.length}))})};
    const raw=/raw\.githubusercontent\.com\/(.+?\/.+?)\/[0-9a-f]{40}\/(.+)$/.exec(url);
    const bytes=raw&&files.get(`${raw[1]}/${raw[2].split('/').map(decodeURIComponent).join('/')}`);
    if(bytes)return {ok:true,status:200,body:[bytes.subarray(0,3),bytes.subarray(3)]};
    return {ok:false,status:404};
  };
  return {fetchFn,asked};
}

async function folders(){
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-collection-'));
  const skinsRoot=path.join(root,'Custom Skins'),modsRoot=path.join(root,'Custom Mods');
  await mkdir(skinsRoot,{recursive:true});await mkdir(modsRoot,{recursive:true});
  return {root,skinsRoot,modsRoot,databaseRoot:root};
}

test('only packages in the custom folders, with names Windows accepts, are taken',()=>{
  assert.deepEqual(collectionTarget('Custom Skins/Ahri/Mint Ahri.fantome'),{kind:'skins',relative:'Ahri/Mint Ahri.fantome'});
  assert.deepEqual(collectionTarget("Custom Skins/Cho'Gath/Groudon Cho'Gath.fantome"),{kind:'skins',relative:"Cho'Gath/Groudon Cho'Gath.fantome"});
  assert.deepEqual(collectionTarget('Custom Mods/FriloSoundPack1.0.fantome'),{kind:'mods',relative:'FriloSoundPack1.0.fantome'});
  for(const bad of ['Custom Skins/Ahri.fantome','Custom Skins/Ahri/x.jpg','README.md','Custom Skins/../x/y.fantome','Custom Skins/A:B/x.fantome','Other/Ahri/x.fantome','Custom Skins/CON/x.fantome'])
    assert.equal(collectionTarget(bad),null,bad);
});

test('a skin\'s picture beside it is its art, found by its contents',()=>{
  const bytes=zip('ahri');
  const {files,artwork}=readTree('me/one','b'.repeat(40),[
    {type:'blob',path:'Custom Skins/Ahri/Mint Ahri.fantome',sha:blob(bytes),size:bytes.length},
    {type:'blob',path:'Custom Skins/Ahri/Mint Ahri.webp',sha:'c'.repeat(40),size:9},
    {type:'blob',path:'removed.json',sha:'d'.repeat(40),size:9},
  ]);
  assert.equal(files.length,1);
  assert.equal(artwork[blob(bytes)],`https://raw.githubusercontent.com/me/one/${'b'.repeat(40)}/Custom%20Skins/Ahri/Mint%20Ahri.webp`);
});

test('a new PC gets every skin and mod, and the second check costs two small requests',async()=>{
  const where=await folders();
  const ahri=zip('ahri'),toji=zip('toji aatrox'),sound=zip('sound pack');
  const {fetchFn,asked}=github({'me/one':{'Custom Skins/Ahri/Mint Ahri.fantome':ahri,'Custom Skins/Aatrox/Toji.fantome':toji},'me/two':{'Custom Mods/Sound.fantome':sound,'Custom Skins/Ahri/Mint Ahri.fantome':zip('a different one')}});
  const statuses=[];
  try{
    const result=await syncCollection({...where,fetchFn,repositories:REPOS,onStatus:status=>statuses.push(status)});
    assert.equal(result.complete,true);
    assert.equal(result.added.length,3);
    assert.deepEqual(await readFile(path.join(where.skinsRoot,'Ahri','Mint Ahri.fantome')),ahri,'the first collection wins a shared path');
    assert.deepEqual(await readFile(path.join(where.skinsRoot,'Aatrox','Toji.fantome')),toji);
    assert.deepEqual(await readFile(path.join(where.modsRoot,'Sound.fantome')),sound);
    assert.equal(statuses[0].phase,'checking');
    const last=statuses.at(-1);
    assert.equal(last.files,3);assert.equal(last.count,3);assert.equal(last.bytes,last.total);
    asked.length=0;
    const again=await syncCollection({...where,fetchFn,repositories:REPOS});
    assert.equal(again.added.length,0);
    assert.equal(asked.length,2);
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('a skin the player already has, deleted or withdrew is never downloaded',async()=>{
  const where=await folders();
  const mine=zip('mine'),gone=zip('withdrawn'),deleted=zip('deleted later'),fresh=zip('new one');
  try{
    await mkdir(path.join(where.skinsRoot,'Ahri'));
    await writeFile(path.join(where.skinsRoot,'Ahri','Renamed by me.fantome'),mine);
    const first=github({'me/one':{'Custom Skins/Ahri/Mine.fantome':mine,'Custom Skins/Fiora/Broken.fantome':gone,'Custom Skins/Talon/Deleted.fantome':deleted}});
    const result=await syncCollection({...where,fetchFn:first.fetchFn,repositories:['me/one'],withdrawn:[{sha:blob(gone),size:gone.length}]});
    assert.deepEqual(result.added.map(file=>file.relative),['Talon/Deleted.fantome']);
    assert.deepEqual(await readdir(path.join(where.skinsRoot,'Ahri')),['Renamed by me.fantome']);
    await unlink(path.join(where.skinsRoot,'Talon','Deleted.fantome'));
    // The collection gains a skin: only that one arrives; the one the player deleted stays gone.
    const second=github({'me/one':{'Custom Skins/Ahri/Mine.fantome':mine,'Custom Skins/Talon/Deleted.fantome':deleted,'Custom Skins/Zed/New.fantome':fresh}});
    const later=await syncCollection({...where,fetchFn:second.fetchFn,repositories:['me/one']});
    assert.deepEqual(later.added.map(file=>file.relative),['Zed/New.fantome']);
    assert.deepEqual(await readdir(path.join(where.skinsRoot,'Talon')),[]);
  }finally{await rm(where.root,{recursive:true,force:true});}
});

const fileAsked=asked=>asked.filter(url=>url.includes('raw.githubusercontent.com')).map(url=>decodeURIComponent(url.split('/').slice(6).join('/')));

test('a reworked skin or mod replaces the old one, and only that file is downloaded',async()=>{
  const where=await folders();
  const same=zip('same'),old=zip('old skin'),oldMod=zip('old mod'),fresh=zip('brand new'),reworked=zip('reworked skin, longer now'),reworkedMod=zip('new mod!');
  const repo=files=>github({'me/one':files});
  try{
    await syncCollection({...where,fetchFn:repo({'Custom Skins/A/Same.fantome':same,'Custom Skins/A/Rework.fantome':old,'Custom Mods/Sound.fantome':oldMod}).fetchFn,repositories:['me/one']});
    const next=repo({'Custom Skins/A/Same.fantome':same,'Custom Skins/A/Rework.fantome':reworked,'Custom Mods/Sound.fantome':reworkedMod,'Custom Skins/B/New.fantome':fresh});
    const result=await syncCollection({...where,fetchFn:next.fetchFn,repositories:['me/one']});
    assert.equal(result.complete,true);
    assert.deepEqual(result.added.map(file=>file.relative),['B/New.fantome']);
    assert.deepEqual(result.updated.map(file=>file.relative).sort(),['A/Rework.fantome','Sound.fantome']);
    assert.deepEqual(fileAsked(next.asked).sort(),['Custom Mods/Sound.fantome','Custom Skins/A/Rework.fantome','Custom Skins/B/New.fantome']);
    assert.deepEqual(await readFile(path.join(where.skinsRoot,'A','Rework.fantome')),reworked);
    assert.deepEqual(await readFile(path.join(where.modsRoot,'Sound.fantome')),reworkedMod);
    assert.deepEqual((await readdir(path.join(where.skinsRoot,'A'))).sort(),['Rework.fantome','Same.fantome'],'no temp file is left');
    next.asked.length=0;
    assert.equal((await syncCollection({...where,fetchFn:next.fetchFn,repositories:['me/one']})).updated.length,0);
    assert.equal(next.asked.length,1,'one small request per repository once it is up to date');
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('a copy of the player\'s put in place while a rework downloads is kept',async()=>{
  const where=await folders();
  const old=zip('old skin'),reworked=zip('reworked skin, longer now'),mine=zip('my own copy');
  const target=path.join(where.skinsRoot,'A','Rework.fantome');
  try{
    await syncCollection({...where,fetchFn:github({'me/one':{'Custom Skins/A/Rework.fantome':old}}).fetchFn,repositories:['me/one']});
    const next=github({'me/one':{'Custom Skins/A/Rework.fantome':reworked}});
    // The player saves their own copy over the old one while the rework is still coming down.
    const fetchFn=async(url,options)=>{
      const response=await next.fetchFn(url,options);
      if(!url.includes('raw.githubusercontent.com'))return response;
      return {...response,body:(async function*(){await writeFile(target,mine);yield* response.body;})()};
    };
    const result=await syncCollection({...where,fetchFn,repositories:['me/one']});
    assert.equal(result.updated.length,0);
    assert.deepEqual(result.skipped.map(row=>row.file),['Custom Skins/A/Rework.fantome']);
    assert.deepEqual(await readFile(target),mine);
    assert.deepEqual(await readdir(path.join(where.skinsRoot,'A')),['Rework.fantome'],'no temp file is left');
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('a file of the player\'s with a collection skin\'s name is never replaced, even by a rework',async()=>{
  const where=await folders();
  const mine=zip('my own edit');
  try{
    await mkdir(path.join(where.skinsRoot,'A'));
    await writeFile(path.join(where.skinsRoot,'A','Same.fantome'),mine);
    for(const version of ['first','second']){
      const {fetchFn}=github({'me/one':{'Custom Skins/A/Same.fantome':zip(version)}});
      const result=await syncCollection({...where,fetchFn,repositories:['me/one']});
      assert.deepEqual([result.added.length,result.updated.length],[0,0]);
      assert.deepEqual(await readFile(path.join(where.skinsRoot,'A','Same.fantome')),mine);
    }
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('a rework does not bring back a skin the player deleted',async()=>{
  const where=await folders();
  try{
    await syncCollection({...where,fetchFn:github({'me/one':{'Custom Skins/A/Gone.fantome':zip('v1')}}).fetchFn,repositories:['me/one']});
    await unlink(path.join(where.skinsRoot,'A','Gone.fantome'));
    const next=github({'me/one':{'Custom Skins/A/Gone.fantome':zip('v2')}});
    const result=await syncCollection({...where,fetchFn:next.fetchFn,repositories:['me/one']});
    assert.deepEqual([result.added.length,result.updated.length],[0,0]);
    assert.deepEqual(fileAsked(next.asked),[]);
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('the first check after updating to 7.0 catches a rework the old record wrongly counted as delivered',async()=>{
  const where=await folders();
  const old=zip('old'),reworked=zip('reworked');
  const next=github({'me/one':{'Custom Skins/A/Rework.fantome':reworked}});
  try{
    await mkdir(path.join(where.skinsRoot,'A'));
    await writeFile(path.join(where.skinsRoot,'A','Rework.fantome'),old);
    const heads={'me/one':{revision:blob(Buffer.from('me/one'+JSON.stringify([['Custom Skins/A/Rework.fantome',blob(reworked)]]))),tree:'a'.repeat(40)}};
    await writeFile(path.join(where.root,'custom-collection.json'),JSON.stringify({version:1,heads,complete:true,delivered:[blob(old),blob(reworked)]}));
    const result=await syncCollection({...where,fetchFn:next.fetchFn,repositories:['me/one']});
    assert.deepEqual(result.updated.map(file=>file.relative),['A/Rework.fantome']);
    assert.deepEqual(await readFile(path.join(where.skinsRoot,'A','Rework.fantome')),reworked);
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('Check databases puts back a skin the player deleted, but never a withdrawn one',async()=>{
  const where=await folders();
  const kept=zip('kept'),gone=zip('withdrawn');
  const {fetchFn}=github({'me/one':{'Custom Skins/A/Kept.fantome':kept,'Custom Skins/B/Gone.fantome':gone}});
  const withdrawn=[{sha:blob(gone),size:gone.length}];
  try{
    await syncCollection({...where,fetchFn,repositories:['me/one'],withdrawn});
    await unlink(path.join(where.skinsRoot,'A','Kept.fantome'));
    assert.equal((await syncCollection({...where,fetchFn,repositories:['me/one'],withdrawn})).added.length,0);
    const restored=await syncCollection({...where,fetchFn,repositories:['me/one'],withdrawn,restore:true});
    assert.deepEqual(restored.added.map(file=>file.relative),['A/Kept.fantome']);
    assert.equal(restored.offered,2);
    assert.deepEqual(await readdir(path.join(where.skinsRoot,'B')).catch(()=>[]),[]);
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('a match stops it between files, and the next check carries on',async()=>{
  const where=await folders();
  const {fetchFn}=github({'me/one':{'Custom Skins/A/1.fantome':zip('1'),'Custom Skins/B/22.fantome':zip('22'),'Custom Skins/C/333.fantome':zip('333')}});
  try{
    let allowed=1;
    const stopped=await syncCollection({...where,fetchFn,repositories:['me/one'],canContinue:async()=>allowed-->0});
    assert.equal(stopped.complete,false);
    assert.equal(stopped.added.length,1);
    const resumed=await syncCollection({...where,fetchFn,repositories:['me/one']});
    assert.equal(resumed.complete,true);
    assert.equal(resumed.added.length,2);
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('a damaged download is never named, is tried again, and a file of the player\'s is never replaced',async()=>{
  const where=await folders();
  const good=zip('good skin');
  const base=github({'me/one':{'Custom Skins/A/Good.fantome':good,'Custom Skins/A/Lfs.fantome':Buffer.from('version https://git-lfs')}});
  let damage=true;
  const fetchFn=async(url,options)=>{
    const response=await base.fetchFn(url,options);
    if(damage&&url.includes('Good.fantome'))return {...response,body:[good.subarray(0,4),Buffer.from('xxxxx')]};
    return response;
  };
  try{
    const first=await syncCollection({...where,fetchFn,repositories:['me/one']});
    assert.equal(first.complete,false);
    assert.deepEqual(first.failed.map(item=>item.file),['Custom Skins/A/Good.fantome']);
    assert.deepEqual(first.skipped.map(item=>item.problem),['not a skin package']);
    assert.deepEqual(await readdir(path.join(where.skinsRoot,'A')),[],'no damaged file, no pointer and no temp file left');
    damage=false;
    const second=await syncCollection({...where,fetchFn,repositories:['me/one']});
    assert.equal(second.complete,true);
    assert.deepEqual(await readFile(path.join(where.skinsRoot,'A','Good.fantome')),good);
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('GitHub limiting requests is said in plain words',async()=>{
  const where=await folders();
  try{
    await assert.rejects(syncCollection({...where,repositories:['me/one'],fetchFn:async()=>({ok:false,status:403})}),/limiting requests/);
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('being limited with nothing saved says until when',async()=>{
  const where=await folders();
  const {fetchFn}=github({'me/one':{'Custom Skins/A/B.fantome':zip('b')}});
  const limited=async url=>url.includes('/git/trees/')?new Response('',{status:403,headers:{'x-ratelimit-reset':'1800000000'}}):fetchFn(url);
  try{
    await assert.rejects(syncCollection({...where,repositories:['me/one'],fetchFn:limited}),/limiting requests from this network until about/);
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('a check that did not finish does not ask GitHub for the same list again',async()=>{
  const where=await folders();
  const bytes=zip('stopped by a match');
  const before=github({'me/one':{'Custom Skins/A/B.fantome':bytes}});
  const lists=asked=>asked.filter(url=>url.includes('/git/trees/')).length;
  try{
    const stopped=await syncCollection({...where,fetchFn:before.fetchFn,repositories:['me/one'],canContinue:async()=>false});
    assert.equal(stopped.complete,false);
    assert.equal(lists(before.asked),1);
    const carried=await syncCollection({...where,fetchFn:before.fetchFn,repositories:['me/one']});
    assert.equal(carried.added.length,1);
    assert.equal(lists(before.asked),1,'the saved list of that commit is used');
    const after=github({'me/one':{'Custom Skins/A/B.fantome':bytes,'Custom Skins/C/D.fantome':zip('new')}});
    assert.equal((await syncCollection({...where,fetchFn:after.fetchFn,repositories:['me/one']})).added.length,1);
    assert.equal(lists(after.asked),1,'a new commit is listed once');
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('a damaged saved list is simply asked for again',async()=>{
  const where=await folders();
  const {fetchFn,asked}=github({'me/one':{'Custom Skins/A/B.fantome':zip('b')}});
  try{
    await writeFile(path.join(where.root,'custom-collection-lists.json'),'{not json');
    assert.equal((await syncCollection({...where,fetchFn,repositories:['me/one']})).added.length,1);
    assert.equal(asked.filter(url=>url.includes('/git/trees/')).length,1);
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('pictures join what the app already knew',async()=>{
  const where=await folders();
  try{
    await writeFile(path.join(where.root,'custom-artwork.json'),JSON.stringify({version:1,artwork:{['a'.repeat(40)]:'https://raw.githubusercontent.com/old.webp'}}));
    const merged=await saveArtwork(where.root,{['b'.repeat(40)]:'https://raw.githubusercontent.com/new.webp'});
    assert.equal(Object.keys(merged).length,2);
    assert.deepEqual(JSON.parse(await readFile(path.join(where.root,'custom-artwork.json'),'utf8')).artwork,merged);
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('a package left out is not recorded as delivered, and the next check looks at it again',async()=>{
  const where=await folders();
  const lfs=Buffer.from('version https://git-lfs');
  const {fetchFn,asked}=github({'me/one':{'Custom Skins/A/Good.fantome':zip('good'),'Custom Skins/A/Lfs.fantome':lfs}});
  const times=()=>asked.filter(url=>url.includes('Lfs.fantome')).length;
  try{
    const first=await syncCollection({...where,fetchFn,repositories:['me/one']});
    assert.deepEqual(first.skipped.map(item=>item.problem),['not a skin package']);
    assert.equal(first.complete,true,'no 5-minute retry for it');
    const saved=JSON.parse(await readFile(path.join(where.root,'custom-collection.json'),'utf8'));
    assert.equal(saved.complete,false);
    assert.ok(!saved.delivered.includes(blob(lfs)),'it never arrived');
    assert.ok(saved.delivered.includes(blob(zip('good'))));
    assert.equal(times(),1);
    await syncCollection({...where,fetchFn,repositories:['me/one']});
    assert.equal(times(),2,'tried again at the next check');
    assert.equal(asked.filter(url=>url.includes('Good.fantome')).length,1,'what arrived is not fetched again');
  }finally{await rm(where.root,{recursive:true,force:true});}
});

test('a refused download says GitHub is limiting, and the rest are not asked for',async()=>{
  const where=await folders();
  const listed={};for(const name of 'ABCDEFG')listed[`Custom Skins/A/${name}.fantome`]=zip(name);
  const {fetchFn}=github({'me/one':listed});
  let refused=0;
  const limited=async(url,options)=>{
    if(url.includes('raw.githubusercontent.com')&&url.endsWith('.fantome')){refused++;return new Response('',{status:429,headers:{'retry-after':'120'}});}
    return fetchFn(url,options);
  };
  try{
    const result=await syncCollection({...where,repositories:['me/one'],fetchFn:limited});
    assert.equal(result.complete,false);
    assert.match(result.failed[0].problem,/limiting requests/);
    assert.ok(result.limited.retryAt>Date.now()+100*1000);
    assert.ok(refused<=3,`one refusal for each download already running, not ${refused}`);
  }finally{await rm(where.root,{recursive:true,force:true});}
});
test('a download that broke off is not reported as being limited',async()=>{
  const where=await folders();
  const {fetchFn}=github({'me/one':{'Custom Skins/A/B.fantome':zip('b')}});
  const broken=async(url,options)=>url.includes('raw.githubusercontent.com')&&url.endsWith('.fantome')?new Response('',{status:500}):fetchFn(url,options);
  try{
    const result=await syncCollection({...where,repositories:['me/one'],fetchFn:broken});
    assert.equal(result.complete,false);
    assert.equal(result.limited,undefined);
  }finally{await rm(where.root,{recursive:true,force:true});}
});
