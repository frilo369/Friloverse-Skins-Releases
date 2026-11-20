import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import zlib from 'node:zlib';
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {NAMES_URL,RiotCatalogue,riotCards,skinNames} from '../src/riot-skins-local.mjs';
import {RiotSkinBuilder} from '../src/riot-skin-builder.mjs';
import {SkinChoices} from '../src/skin-choices.mjs';
import {SPECIAL_APPEARANCES,isFormSkin} from '../src/fryilo-catalog/catalog.mjs';
import {baseSkinName} from '../src/bin-compat.mjs';
import {rebuildMesh} from '../src/mesh-rebuild.mjs';
import {parseBin,readWadFile,readWadFilesOnDisk} from '../src/skin-slots.mjs';
import {archiveFiles} from '../src/custom-skin-compat.mjs';
import {wwiseHash} from '../src/skin-audio.mjs';
import {fantome} from './fixtures/zip.mjs';
import {refsResponse,releaseResponse} from './fixtures/github.mjs';
import {setRiotSkinsOff} from '../src/riot-skin-availability.mjs';

// These test the Riot paths for the day LTK allows them again; tests/riot-skins-off.test.mjs covers 10.6.
setRiotSkinsOff(false);

const sha=letter=>letter.repeat(40);
const u32=value=>{const out=Buffer.alloc(4);out.writeUInt32LE(value>>>0);return out;};
async function withDir(work){
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-riot-'));
  try{await work(dir);}finally{await rm(dir,{recursive:true,force:true});}
}
const row=(id,letter='a',name='')=>({id,champion:1,parent:null,relative:`1/${id}/${id}.fantome`,sha:sha(letter),size:10,name});
async function writeManifest(root,{skins=[row(1001)],generatedAt='2026-11-06T10:00:00Z'}={}){
  await mkdir(root,{recursive:true});
  await writeFile(path.join(root,'riot-skins-manifest.json'),JSON.stringify({version:1,converterRevision:6,generatedAt,skins}));
}
/** A local catalogue folder: only its manifest and cached names matter here. */
async function database(dir,options={}){
  const root=path.join(dir,'RiotSkins');
  await rm(root,{recursive:true,force:true});
  await writeManifest(root,options);
  return root;
}
/** Riot's names, answered only for the URL this app asks. */
function namesServer(names,etag='"names"'){
  const seen=[];
  const fetchFn=async(url,options={})=>{
    seen.push({url,etag:options.headers?.['If-None-Match']});
    if(url!==NAMES_URL)return new Response('not found',{status:404});
    if(!names)throw new Error('offline');
    if(options.headers?.['If-None-Match']===etag)return new Response(null,{status:304,headers:{etag}});
    return Response.json(Object.fromEntries(names.map(item=>[String(item.id),item])));
  };
  return {fetchFn,seen};
}
// The GitHub side: one commit, one manifest, no archives (the game supplies those).
const REV='b'.repeat(40),NEXT='c'.repeat(40);
const DATABASE='frilo369/Friloverse_Skins_Database';
const REFS=`https://github.com/${DATABASE}.git/info/refs?service=git-upload-pack`,RELEASE=`https://github.com/${DATABASE}/releases/latest`;
/** What `main` and the tags point at, as the two free addresses give them. */
const webAnswer=(url,{revision,main=revision,release='',tags=release?{[`refs/tags/${release}`]:revision}:{}})=>
  url===REFS?refsResponse({HEAD:main,'refs/heads/main':main,...tags}):url===RELEASE?releaseResponse(DATABASE,release):null;
const MANIFEST_AT=revision=>`https://raw.githubusercontent.com/frilo369/Friloverse_Skins_Database/${revision}/riot-skins-manifest.json`;
function github({revision=REV,manifest,offline=false,...web}={}){
  const seen=[];
  const fetchFn=async url=>{
    seen.push(url);
    if(offline)throw new Error('offline');
    const answer=webAnswer(url,{revision,...web});
    if(answer)return answer;
    if(url===MANIFEST_AT(revision))return Response.json(manifest);
    return new Response('not found',{status:404});
  };
  return {fetchFn,seen};
}
const annie={id:'Annie',key:'1',name:'Annie',skins:[
  {id:'1000',num:0,name:'default'},{id:'1001',num:1,name:'Goth Annie'},
  {id:'1013',num:13,name:'Lunar Beast Annie'},
  {id:'1014',num:14,name:'Lunar Beast Annie (Ruby)',parentSkin:13,appearanceUrl:'https://art.test/1014.png'},
  {id:'1015',num:15,name:'Lunar Beast Annie (Vitality)',parentSkin:13},
]};
const entry=(id,parent,relative,name='')=>({id,champion:1,parent,relative,name});

// --- Names, cards, local list ------------------------------------------------

test('names come from Riot\'s data for skins, chromas and forms, and a bad row is skipped',()=>{
  const names=skinNames({
    1:{id:1,name:' One ',chromas:[{id:2,name:'One (Ruby)'},{id:'x',name:'Bad'}]},
    3:{id:3,name:'',questSkinInfo:{tiers:[{id:4,name:'Risen'}]}},
    5:{id:5,name:'5'},
    6:{id:6,name:'Skin 6'},
  });
  assert.deepEqual([...names],[[1,'One'],[2,'One (Ruby)'],[4,'Risen']]);
  assert.equal(skinNames(null).size,0);
});

test('the number decides the skin and chroma, and a card holds its chromas',()=>{
  const cards=riotCards(annie,[
    entry(1001,null,'1/1001/1001.fantome'),
    entry(1013,null,'1/1013/1013.fantome'),
    entry(1014,1013,'1/1013/1014/1014.fantome'),
    entry(1015,1013,'1/1013/1015/1015.fantome'),
  ]);
  assert.deepEqual(cards.map(card=>[card.id,card.name,card.kind]),[['riot:1013','Lunar Beast Annie','riot'],['riot:1001','Goth Annie','riot']],'newest first, as FrYiLoCo shows them');
  assert.equal(cards[0].image,'https://ddragon.leagueoflegends.com/cdn/img/champion/splash/Annie_13.jpg');
  assert.match(cards[0].fallback,/champion-splashes\/1\/1013\.jpg$/);
  assert.deepEqual(cards[0].chromas.map(chroma=>[chroma.id,chroma.name]),[['riot:1014','Ruby'],['riot:1015','Vitality']]);
  assert.equal(cards[0].chromas[0].image,'https://art.test/1014.png');
  assert.equal(cards[0].chromas[1].image,'friloverse-icon://chroma/1/1015','a chroma without its own address uses its number, read from the installed League');
  assert.deepEqual(cards[1].chromas,[]);
});

test('a skin newer than the bundled names keeps its family and takes the listed name',()=>{
  const cards=riotCards(annie,[entry(1090,null,'1/1090/1090.fantome','New Annie'),entry(1091,1090,'1/1090/1091/1091.fantome','New Annie (Gold)')]);
  assert.deepEqual(cards.map(card=>card.name),['New Annie']);
  assert.deepEqual(cards[0].chromas.map(chroma=>chroma.name),['Gold']);
  assert.match(cards[0].image,/Annie_90\.jpg$/);
});

test('a family with only chromas turns on its first one, and forms use the bundled art',()=>{
  const lux={id:'Lux',key:'99',name:'Lux',skins:[{id:'99007',num:7,name:'Elementalist Lux'}]};
  const cards=riotCards(lux,[{id:99991,champion:99,parent:99007,relative:'99/99007/99991/99991.fantome',name:''}]);
  assert.equal(cards.length,1);
  assert.equal(cards[0].id,'riot:99991');
  assert.equal(cards[0].name,'Elementalist Lux');
  assert.equal(cards[0].chromas[0].image,'forms/99991.png');
  assert.equal(cards[0].chromas[0].name,'Air');
});

test('Revenant Reign and its six swords appear as Viego cards',()=>{
  const viego={id:'Viego',key:'234',name:'Viego',skins:[
    {id:'234021',num:21,name:'King Viego'},{id:'234043',num:43,name:'Revenant Reign Viego'},
  ]};
  const family=[234043,234994,234995,234996,234997,234998,234999].map(id=>({id,champion:234,
    relative:id===234043?'234/234043/234043.fantome':`234/234043/${id}/${id}.fantome`}));
  const cards=riotCards(viego,family);
  assert.equal(cards.length,1);
  assert.equal(cards[0].id,'riot:234043');
  assert.equal(cards[0].name,'Revenant Reign Viego');
  assert.deepEqual(cards[0].chromas.map(chroma=>chroma.id),['riot:234994','riot:234995','riot:234996','riot:234997','riot:234998','riot:234999']);
  const all=riotCards(viego,[...family,{id:234021,champion:234,relative:'234/234021/234021.fantome'}]);
  assert.deepEqual(all.map(card=>card.id).sort(),['riot:234021','riot:234043']);
});

test('every form FrYiLoCo names has its picture in Friloverse',async()=>{
  for(const [,form] of SPECIAL_APPEARANCES)
    if(form.appearanceUrl.startsWith('/forms/'))await access(new URL(`../src/ui${form.appearanceUrl}`,import.meta.url));
});

test('a real name beats the catalogue\'s placeholders, and never its real names',()=>{
  const gragas={id:'Gragas',key:'79',name:'Gragas',skins:[{id:'79047',num:47,name:'Music Fan Gragas'},{id:'79049',num:49,name:'Chroma 79049',parentSkin:47}]};
  const cards=riotCards(gragas,[
    entry(79047,null,'79/79047/79047.fantome','Riot Says Music Fan'),
    entry(79049,79047,'79/79047/79049/79049.fantome','Music Fan Gragas (FIRESTARTER)'),
  ]);
  assert.deepEqual(cards.map(card=>card.name),['Music Fan Gragas']);
  assert.deepEqual(cards[0].chromas.map(chroma=>chroma.name),['FIRESTARTER']);
});

test('a chroma newer than the bundled names shows its colour, not a number',()=>{
  const ahri={id:'Ahri',key:'103',name:'Ahri',skins:[]};
  const cards=riotCards(ahri,[
    entry(103097,null,'103/103097/103097.fantome','K/DA FIRESTARTER Ahri'),
    entry(103098,103097,'103/103097/103098/103098.fantome','K/DA FIRESTARTER Ahri (Ruby)'),
  ]);
  assert.deepEqual(cards.map(card=>card.name),['K/DA FIRESTARTER Ahri']);
  assert.deepEqual(cards[0].chromas.map(chroma=>chroma.name),['Ruby']);
});

test('a name Riot knows reaches an entry the manifest could not name',()=>withDir(async dir=>{
  const root=await database(dir);
  const {fetchFn,seen}=namesServer([{id:1001,name:'Goth Annie'}]);
  const catalogue=new RiotCatalogue({root,fetchFn});
  assert.equal(await catalogue.check(),true);
  assert.equal((await catalogue.forChampion(1))[0].name,'Goth Annie');
  assert.equal(seen.length,1);
  assert.equal(await catalogue.check(),false,'the names are kept with the list');
  assert.equal(seen.length,1);
  const again=new RiotCatalogue({root,fetchFn:async()=>{throw new Error('must not ask');}});
  assert.equal(await again.load(),true);
  assert.equal((await again.forChampion(1))[0].name,'Goth Annie');
}));

test('a name the manifest wrote is never replaced by Riot\'s',()=>withDir(async dir=>{
  const root=await database(dir,{skins:[row(1001,'a','Bundled Annie')]});
  const catalogue=new RiotCatalogue({root,fetchFn:namesServer([{id:1001,name:'Riot Annie'}]).fetchFn});
  await catalogue.check();
  assert.equal((await catalogue.forChampion(1))[0].name,'Bundled Annie');
}));

test('names that cannot be read leave the numbers, and are asked for again',()=>withDir(async dir=>{
  const root=await database(dir);
  const {fetchFn,seen}=namesServer(null);
  const catalogue=new RiotCatalogue({root,fetchFn});
  assert.equal(await catalogue.check(),true);
  assert.equal((await catalogue.forChampion(1))[0].name,'');
  assert.equal(seen.length,1);
  assert.equal(await catalogue.check(),true,'nothing was saved, so it is asked again');
  assert.equal(seen.length,2);
}));

// --- The list on GitHub ------------------------------------------------------

const listManifest=(entries,generatedAt='2026-11-06T10:00:00Z')=>({version:1,converterRevision:6,generatedAt,skins:entries});

test('a changed list is taken from GitHub, and an unchanged one costs two small requests',()=>withDir(async dir=>{
  const root=path.join(dir,'RiotSkins');
  const manifest=listManifest([row(1001)]);
  const {fetchFn,seen}=github({manifest});
  const catalogue=new RiotCatalogue({root,fetchFn});
  assert.equal(await catalogue.load(),false,'nothing is here yet');
  const update=await catalogue.checkRemote();
  assert.equal(update.changed,true);
  assert.equal(catalogue.commit,'github-bbbbbbb');
  assert.equal(await catalogue.ready,true);
  assert.equal((await catalogue.forChampion(1))[0].id,1001);
  assert.equal(JSON.parse(await readFile(path.join(root,'riot-skins-manifest.json'),'utf8')).skins.length,1);
  assert.equal(JSON.parse(await readFile(path.join(root,'riot-skins-list.json'),'utf8')).revision,REV);
  const count=seen.length;
  const again=new RiotCatalogue({root,fetchFn});
  await again.load();
  assert.equal((await again.checkRemote()).changed,false);
  assert.equal(seen.length,count+2,'only the release and the commit are asked for');
  assert.ok(seen.every(url=>!url.includes('api.github.com')),'none of GitHub\'s limited API');
}));

test('a list on this PC stays until GitHub has another commit, then GitHub\'s is used',()=>withDir(async dir=>{
  const root=path.join(dir,'RiotSkins');
  await writeManifest(root,{generatedAt:'2026-11-08T10:00:00Z'});
  await writeFile(path.join(root,'riot-skins-list.json'),JSON.stringify({version:1,revision:REV}));
  const {fetchFn}=github({revision:NEXT,manifest:listManifest([row(1002,'b')])});
  const catalogue=new RiotCatalogue({root,fetchFn});
  await catalogue.load();
  assert.equal((await catalogue.checkRemote()).changed,true);
  assert.deepEqual(catalogue.skins().map(skin=>skin.id),[1002]);
}));

test('no list and no connection says what to do',()=>withDir(async dir=>{
  const catalogue=new RiotCatalogue({root:path.join(dir,'RiotSkins'),fetchFn:github({offline:true}).fetchFn});
  assert.equal(await catalogue.load(),false);
  assert.match(catalogue.lastError,/Connect to the internet/);
}));

test('an unreachable list leaves the local one usable and says why',()=>withDir(async dir=>{
  const root=await database(dir);
  const catalogue=new RiotCatalogue({root,fetchFn:github({offline:true}).fetchFn});
  await catalogue.load();
  const update=await catalogue.checkRemote();
  assert.equal(update.changed,false);
  assert.match(catalogue.remoteError,/could not be checked/);
  assert.equal(await catalogue.ready,true);
  assert.equal((await catalogue.forChampion(1))[0].id,1001);
}));

test('the list comes from the newest release, whatever has been uploaded since',()=>withDir(async dir=>{
  const root=path.join(dir,'RiotSkins');
  const {fetchFn,seen}=github({manifest:listManifest([row(1001)]),release:'list-1',main:NEXT});
  const catalogue=new RiotCatalogue({root,fetchFn});
  await catalogue.load();
  assert.equal((await catalogue.checkRemote()).revision,REV);
  assert.ok(seen.includes(MANIFEST_AT(REV)));
  assert.ok(!seen.includes(MANIFEST_AT(NEXT)),'the unreleased upload is not looked at');
}));

test('an annotated release tag means its commit',()=>withDir(async dir=>{
  const root=path.join(dir,'RiotSkins');
  const {fetchFn}=github({manifest:listManifest([row(1001)]),release:'list-1',tags:{'refs/tags/list-1':sha('e'),'refs/tags/list-1^{}':REV}});
  const catalogue=new RiotCatalogue({root,fetchFn});
  await catalogue.load();
  assert.equal((await catalogue.checkRemote()).revision,REV);
}));

test('with no release yet the list follows main, as before',()=>withDir(async dir=>{
  const root=path.join(dir,'RiotSkins');
  const {fetchFn}=github({manifest:listManifest([row(1001)])});
  const catalogue=new RiotCatalogue({root,fetchFn});
  await catalogue.load();
  assert.equal((await catalogue.checkRemote()).revision,REV);
}));

test('a release whose tag cannot be found changes nothing and says so',()=>withDir(async dir=>{
  const root=await database(dir);
  const {fetchFn,seen}=github({manifest:listManifest([row(1002,'b')]),release:'list-gone',tags:{}});
  const catalogue=new RiotCatalogue({root,fetchFn});
  await catalogue.load();
  assert.equal((await catalogue.checkRemote()).changed,false);
  assert.match(catalogue.remoteError,/could not be checked/);
  assert.equal(seen.some(url=>url.includes('raw.githubusercontent.com')),false,'main is not used instead');
  assert.equal((await catalogue.forChampion(1))[0].id,1001);
}));

// --- Building the package ----------------------------------------------------

test('a pick is built and handed to the engine',()=>withDir(async dir=>{
  const root=await database(dir);
  const built=[];
  const catalogue=new RiotCatalogue({root,fetchFn:github({offline:true}).fetchFn,
    buildSkin:async skin=>{built.push(skin.id);return {file:path.join(dir,'built',`${skin.id}.fantome`)};}});
  await catalogue.load();
  const first=await catalogue.ensure(1,1001);
  assert.equal(first.file,path.join(dir,'built','1001.fantome'));
  assert.equal(first.sha,sha('a'),'the catalogue hash is what a party key carries');
  const second=await catalogue.ensure(1,1001);
  assert.equal(second.file,first.file,'the same copy is handed back');
  assert.ok(built.length>=1);
  const found=await catalogue.find(1,sha('a'));
  assert.equal(found.id,1001);
}));

const gitBlob=bytes=>createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest('hex');
const formRow=(bytes,id=234994)=>({id,champion:234,parent:234043,relative:`234/234043/${id}/${id}.fantome`,sha:gitBlob(bytes),size:bytes.length,name:'Revenant Reign Viego (Assassin Sword)'});
async function putForm(root,row,bytes){
  const file=path.join(root,...row.relative.split('/'));
  await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,bytes);
  return file;
}

test('Riot form numbers are recognised and ordinary skins are not',()=>{
  for(const id of [234994,234995,234996,234997,234998,234999,99991])assert.equal(isFormSkin({id}),true,String(id));
  for(const id of [234001,234043,103027,0])assert.equal(isFormSkin({id}),false,String(id));
  assert.equal(isFormSkin(null),false);
});

test('a selectable form uses its converted database package',()=>withDir(async dir=>{
  const bytes=Buffer.from('handcrafted form package'),row=formRow(bytes),root=path.join(dir,'RiotSkins');
  await writeManifest(root,{skins:[row]});
  const file=await putForm(root,row,bytes);
  const calls=[];
  const catalogue=new RiotCatalogue({root,fetchFn:async()=>{throw new Error('must not download');},
    buildSkin:async(skin,options)=>{calls.push({skin,options});return {file:path.join(dir,'built.fantome')};}});
  await catalogue.load();
  const ready=await catalogue.ensure(234,234994);
  assert.equal(ready.file,path.join(dir,'built.fantome'));
  assert.equal(ready.sha,row.sha,'the catalogue hash still identifies the form');
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.archive,file,'the package itself is handed to the builder');
}));

test('a missing form package is downloaded once, verified and kept',()=>withDir(async dir=>{
  const bytes=Buffer.from('form package from the database repository'),row=formRow(bytes);
  const root=path.join(dir,'RiotSkins'),revision='d'.repeat(40),seen=[];
  await writeManifest(root,{skins:[row]});
  const catalogue=new RiotCatalogue({root,
    fetchFn:async url=>{seen.push(url);return new Response(bytes);},
    buildSkin:async(skin,options)=>({file:options.archive})});
  await catalogue.load();
  catalogue.revision=revision;
  const ready=await catalogue.ensure(234,234994);
  const expected=path.join(root,'234','234043','234994','234994.fantome');
  assert.equal(ready.file,expected);
  assert.deepEqual(await readFile(expected),bytes);
  assert.equal(seen.length,1);
  assert.match(seen[0],new RegExp(`/${revision}/234/234043/234994/234994\\.fantome$`));
  await catalogue.ensure(234,234994);
  assert.equal(seen.length,1,'the verified local copy is reused');
}));

const gitHash=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const packaged=(id,text)=>{const bytes=Buffer.from(text);return {...row(id),sha:gitHash(bytes),size:bytes.length,name:'A skin',bytes};};
const listOf=(items,generatedAt='2026-11-07T10:00:00Z')=>({version:1,converterRevision:7,generatedAt,skins:items.map(({bytes,...item})=>item)});
/** GitHub with a list and its files, answering each file only at that list's commit. */
function githubFiles({revision=NEXT,items,answer=null}){
  const fileAsked=[],files=new Map(items.map(item=>[item.relative,item.bytes]));
  const fetchFn=async url=>{
    const web=webAnswer(url,{revision});
    if(web)return web;
    if(url===MANIFEST_AT(revision))return Response.json(listOf(items));
    const relative=url.split(`/${revision}/`)[1];
    fileAsked.push(relative);
    const special=answer?.(relative);
    if(special)return special;
    return files.has(relative)?new Response(files.get(relative)):new Response('not found',{status:404});
  };
  return {fetchFn,fileAsked};
}
/** A PC holding the older list, as it would be before a new export. */
async function pcWithList(dir,items,fetchFn){
  const root=path.join(dir,'RiotSkins');
  await writeManifest(root,{skins:listOf(items,'2026-11-06T10:00:00Z').skins});
  await writeFile(path.join(root,'riot-skins-list.json'),JSON.stringify({version:1,revision:REV,agreedAt:'2026-11-06T10:00:00Z'}));
  const catalogue=new RiotCatalogue({root,fetchFn});
  await catalogue.load();
  return catalogue;
}

const putFile=async(catalogue,item,bytes=item.bytes)=>{await mkdir(path.dirname(catalogue.fileFor(item)),{recursive:true});await writeFile(catalogue.fileFor(item),bytes);};

test('a new list downloads only the forms that are new or changed, never an ordinary skin',()=>withDir(async dir=>{
  const same=packaged(1901,'same'),old=packaged(1902,'old'),reworked=packaged(1902,'reworked'),fresh=packaged(1903,'new form'),ordinary=packaged(1001,'ordinary');
  const {fetchFn,fileAsked}=githubFiles({items:[ordinary,same,reworked,fresh]});
  const catalogue=await pcWithList(dir,[same,old],fetchFn);
  await putFile(catalogue,same);await putFile(catalogue,old);
  assert.equal((await catalogue.checkRemote()).changed,true);
  assert.equal((await catalogue.audit()).queued,2);
  const result=await catalogue.fetchChanged();
  assert.deepEqual({downloaded:result.downloaded,left:result.left},{downloaded:2,left:0});
  assert.deepEqual(fileAsked.sort(),['1/1902/1902.fantome','1/1903/1903.fantome']);
  assert.deepEqual(await readFile(catalogue.fileFor(reworked)),reworked.bytes);
  assert.deepEqual(await readFile(catalogue.fileFor(fresh)),fresh.bytes);
  assert.equal(existsSync(catalogue.fileFor(ordinary)),false,'an ordinary skin is built from League');
  fileAsked.length=0;
  assert.equal((await catalogue.audit()).queued,0);
  await catalogue.fetchChanged();
  assert.deepEqual(fileAsked,[]);
}));

test('a form already here with the right contents is not downloaded',()=>withDir(async dir=>{
  const old=packaged(1902,'old'),reworked=packaged(1902,'reworked');
  const {fetchFn,fileAsked}=githubFiles({items:[reworked]});
  const catalogue=await pcWithList(dir,[old],fetchFn);
  await putFile(catalogue,reworked);
  await catalogue.checkRemote();
  assert.equal((await catalogue.audit()).queued,0);
  const result=await catalogue.fetchChanged();
  assert.deepEqual({downloaded:result.downloaded,left:result.left},{downloaded:0,left:0});
  assert.deepEqual(fileAsked,[]);
}));

test('a clean PC gets the list and the forms, and nothing else',()=>withDir(async dir=>{
  const {fetchFn,fileAsked}=githubFiles({items:[packaged(1001,'one'),packaged(1002,'two'),packaged(1901,'form')]});
  const catalogue=new RiotCatalogue({root:path.join(dir,'RiotSkins'),fetchFn});
  await catalogue.load();
  assert.equal((await catalogue.checkRemote()).changed,true);
  assert.equal(catalogue.skins().length,3,'every skin keeps its card');
  assert.deepEqual(await catalogue.audit(),{checked:1,queued:1,skipped:false});
  assert.equal((await catalogue.fetchChanged()).downloaded,1);
  assert.deepEqual(fileAsked,['1/1901/1901.fantome']);
  assert.equal((await catalogue.audit()).queued,0);
}));

test('the comparison finds a missing form and one changed at the same size',()=>withDir(async dir=>{
  const one=packaged(1901,'one'),two=packaged(1902,'two');
  const {fetchFn}=githubFiles({items:[one,two]});
  const catalogue=new RiotCatalogue({root:path.join(dir,'RiotSkins'),fetchFn});
  await catalogue.load();await catalogue.checkRemote();
  await catalogue.audit();await catalogue.fetchChanged();
  const [first,second]=catalogue.skins();
  await rm(catalogue.fileFor(first));
  await writeFile(catalogue.fileFor(second),Buffer.alloc(second.size,120));
  assert.equal((await catalogue.audit()).queued,2);
  assert.equal((await catalogue.fetchChanged()).downloaded,2);
  assert.equal(await catalogue.hasPackage(second),true);
}));

test('the comparison waits for a list that came from GitHub',()=>withDir(async dir=>{
  const catalogue=new RiotCatalogue({root:await database(dir,{skins:[packaged(1901,'one')]}),fetchFn:github({offline:true}).fetchFn});
  await catalogue.load();
  assert.equal((await catalogue.audit()).skipped,true);
  assert.equal(catalogue.waiting.size,0);
}));

test('a waiting list saved by an older version keeps only the forms',()=>withDir(async dir=>{
  const root=await database(dir,{skins:[packaged(1001,'one'),packaged(1901,'form')]});
  await writeFile(path.join(root,'riot-skins-list.json'),JSON.stringify({version:1,revision:REV,waiting:['1/1001/1001.fantome','1/1901/1901.fantome','nonsense',7]}));
  const catalogue=new RiotCatalogue({root,fetchFn:github({offline:true}).fetchFn});
  await catalogue.load();
  assert.deepEqual([...catalogue.waiting],['1/1901/1901.fantome']);
}));

test('the unused files go once; forms, the list and anything else stay',()=>withDir(async dir=>{
  const form=formRow(Buffer.from('form')),ordinary={...form,id:234043,parent:null,relative:'234/234043/234043.fantome'},chroma=row(1014),root=await database(dir,{skins:[form,ordinary,chroma]});
  await writeFile(path.join(root,'riot-skins-list.json'),JSON.stringify({version:1,revision:REV}));
  await writeFile(path.join(root,'riot-skins-names.json'),'{}');
  await writeFile(path.join(root,'notes.txt'),'mine');
  const formFile=await putForm(root,form,Buffer.from('form'));
  const ordinaryFile=await putForm(root,ordinary,Buffer.from('x'));
  const chromaFile=await putForm(root,chroma,Buffer.from('y'));
  const staleTemp=`${chromaFile}.abc123.tmp`;await writeFile(staleTemp,'z');
  await mkdir(path.join(root,'not-a-number'));await writeFile(path.join(root,'not-a-number','1014.fantome'),'mine');
  const catalogue=new RiotCatalogue({root,fetchFn:github({offline:true}).fetchFn});
  await catalogue.load();
  const paused=await catalogue.removeUnused({canContinue:async()=>false});
  assert.deepEqual({removed:paused.removed,stopped:paused.stopped},{removed:0,stopped:true});
  assert.equal(existsSync(chromaFile),true);
  assert.equal((await catalogue.removeUnused()).removed,3);
  for(const gone of [ordinaryFile,chromaFile,staleTemp,path.dirname(chromaFile)])assert.equal(existsSync(gone),false,gone);
  assert.equal(existsSync(formFile),true,'a form is kept');
  for(const kept of ['riot-skins-manifest.json','riot-skins-list.json','riot-skins-names.json','notes.txt','not-a-number/1014.fantome'])assert.equal(existsSync(path.join(root,kept)),true,kept);
  await putForm(root,chroma,Buffer.from('y'));
  const next=new RiotCatalogue({root,fetchFn:github({offline:true}).fetchFn});
  await next.load();
  assert.equal((await next.removeUnused()).skipped,true,'once only');
  assert.equal(existsSync(chromaFile),true);
}));

test('a list deleted from the disk comes back though the commit did not change',()=>withDir(async dir=>{
  const {fetchFn}=githubFiles({items:[packaged(1001,'one')]});
  const catalogue=new RiotCatalogue({root:path.join(dir,'RiotSkins'),fetchFn});
  await catalogue.load();await catalogue.checkRemote();
  await rm(path.join(dir,'RiotSkins'),{recursive:true,force:true});
  assert.equal(await catalogue.load(),true);assert.equal(catalogue.ready,true);
  assert.equal((await catalogue.checkRemote()).changed,true);
  assert.equal(JSON.parse(await readFile(catalogue.manifestFile,'utf8')).skins.length,1);
}));

test('an unchanged list downloads no files',()=>withDir(async dir=>{
  const same=packaged(1901,'same');
  const {fetchFn,fileAsked}=githubFiles({revision:REV,items:[same]});
  const catalogue=await pcWithList(dir,[same],fetchFn);
  assert.equal((await catalogue.checkRemote()).changed,false);
  await catalogue.fetchChanged();
  assert.deepEqual(fileAsked,[]);
}));

test('a match, a closed app and GitHub limiting requests only delay the forms',()=>withDir(async dir=>{
  const one=packaged(1901,'one'),two=packaged(1902,'two'),old=[{...one,sha:sha('a')},{...two,sha:sha('b')}];
  let limited=false;
  const {fetchFn,fileAsked}=githubFiles({items:[one,two],answer:()=>limited?new Response('slow down',{status:429}):null});
  const first=await pcWithList(dir,old,fetchFn);
  await first.checkRemote();
  await first.audit();
  const stopped=await first.fetchChanged({canContinue:async()=>false});
  assert.deepEqual({stopped:stopped.stopped,left:stopped.left},{stopped:true,left:2});
  assert.deepEqual(fileAsked,[]);
  // The app closes here. A new start knows what is still waiting, from disk.
  const second=new RiotCatalogue({root:first.root,fetchFn});
  await second.load();
  limited=true;
  const refused=await second.fetchChanged();
  assert.deepEqual({limited:refused.limited,left:refused.left},{limited:true,left:2});
  limited=false;
  const finished=await second.fetchChanged();
  assert.deepEqual({downloaded:finished.downloaded,left:finished.left},{downloaded:2,left:0});
  assert.deepEqual(await readFile(second.fileFor(two)),two.bytes);
}));

test('a damaged form is refused and stays waiting',()=>withDir(async dir=>{
  const fresh=packaged(1903,'the real file');
  let damaged=true;
  const {fetchFn}=githubFiles({items:[fresh],answer:()=>damaged?new Response(Buffer.from('something else')):null});
  const catalogue=await pcWithList(dir,[{...fresh,sha:sha('a')}],fetchFn);
  await catalogue.checkRemote();
  await catalogue.audit();
  const result=await catalogue.fetchChanged();
  assert.deepEqual({downloaded:result.downloaded,left:result.left},{downloaded:0,left:1});
  assert.equal(existsSync(catalogue.fileFor(fresh)),false);
  damaged=false;
  assert.equal((await catalogue.fetchChanged()).left,0);
}));

test('a form download that does not match the list is refused',()=>withDir(async dir=>{
  const row=formRow(Buffer.from('expected package'));
  const root=path.join(dir,'RiotSkins');
  await writeManifest(root,{skins:[row]});
  const catalogue=new RiotCatalogue({root,
    fetchFn:async()=>new Response(Buffer.from('something else')),
    buildSkin:async skin=>({file:path.join(dir,'built.fantome')})});
  await catalogue.load();
  catalogue.revision='e'.repeat(40);
  await assert.rejects(catalogue.ensure(234,234994),/did not match/);
  assert.equal(existsSync(path.join(root,'234','234043','234994','234994.fantome')),false);
}));

test('a skin cannot be chosen for another champion, and a friend\'s is found by contents',()=>withDir(async dir=>{
  const root=path.join(dir,'RiotSkins');
  const key=sha('a');
  await writeManifest(root,{skins:[{id:103001,champion:103,parent:null,relative:'103/103001/103001.fantome',sha:key,size:10,name:'Dynasty Ahri'}]});
  const catalogue=new RiotCatalogue({root,fetchFn:github({offline:true}).fetchFn,
    buildSkin:async skin=>{const file=path.join(dir,'built',`${skin.id}.fantome`);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,fantome('built'));return {file};}});
  await catalogue.load();
  const localSkins={findArchive:async()=>null,resolve:async()=>{throw new Error('unused');}};
  const choices=new SkinChoices({database:localSkins,catalogue,champions:[{id:'Ahri',key:'103',name:'Ahri'},{id:'Zed',key:'238',name:'Zed'}]});
  await assert.rejects(choices.choose('riot:103001','Zed'),/does not belong/);
  const pick=await choices.choose('riot:103001','Ahri','Dynasty Ahri');
  assert.equal(pick.key,key);assert.equal(pick.label,'Dynasty Ahri');
  assert.equal(choices.pick('ahri').id,'riot:103001');
  assert.equal(choices.pick('Zed'),null);
  assert.equal((await choices.findByContents('ahri',key)).file,pick.file);
  assert.equal(await choices.findByContents('zed',key),null,'the same hash on another champion does not count');
  assert.equal(await choices.findByContents('ahri','0'.repeat(40)),null);
  choices.clear();assert.equal(choices.pick('Ahri'),null);
}));

test('a friend\'s skin in this PC\'s own folder is used before the catalogue',async()=>{
  const database={findArchive:async()=>'db:1',resolve:async id=>({id,key:'k',file:'C:/mine.fantome',label:'Mine'})};
  const catalogue={find:()=>{throw new Error('must not build');}};
  const choices=new SkinChoices({database,catalogue,champions:[{id:'Ahri',key:'103',name:'Ahri'}]});
  assert.equal((await choices.findByContents('ahri','0'.repeat(40))).file,'C:/mine.fantome');
});

// --- The real game, when this machine has it ---------------------------------

let LEAGUE=null,installed=false,unavailable='League is not installed here';
try{
  const {leagueFolder}=await import('../src/league-client.mjs');
  LEAGUE=await leagueFolder();
  // League's WADs are zstd-compressed, which Node 20 cannot read; the app and the
  // packaged runtime can. These tests run under a runtime that has it.
  if(!zlib.zstdDecompressSync)unavailable='This Node runtime has no zstd support; run these tests with Node 24';
  installed=Boolean(zlib.zstdDecompressSync)&&Boolean(LEAGUE)&&existsSync(path.join(LEAGUE,'Game','DATA','FINAL','Champions','Ahri.wad.client'));
}catch{/* No League here. */}

test('a Riot skin is built from the installed League as the base skin',{skip:!installed?unavailable:false},()=>withDir(async dir=>{
  const builder=new RiotSkinBuilder({cacheDir:dir,league:async()=>LEAGUE});
  const built=await builder.build({champion:103,id:103027,sha:sha('a'),name:'Spirit Blossom Ahri'});
  assert.ok(built.file&&built.bytes.length>500000,'it carries the skin\'s own model');
  const files=await archiveFiles(built.file);
  const wad=files.find(file=>/\.wad\.client$/i.test(file.name)).bytes;
  assert.equal(files.find(file=>/\.wad\.client$/i.test(file.name)).name,'WAD/Ahri.wad.client');
  assert.ok(wad.readUInt32LE(268)>=5,'the base skin data, its two model files and its audio');
  const sounds=readWadFile(wad,'assets/sounds/wwise2016/sfx/characters/ahri/skins/base/ahri_base_sfx_events.bnk');
  assert.ok(sounds?.includes(u32(wwiseHash('Play_sfx_Ahri_AhriBasicAttack_OnCast'))),'the skin\'s sounds answer to the base skin\'s tag');
  const localeRow=files.find(file=>/^WAD\/Ahri\.[a-z]{2}_[A-Z]{2}\.wad\.client$/i.test(file.name));
  assert.ok(localeRow,'its localized voice WAD is packed');
  const lang=localeRow.name.match(/\.([a-z]{2}_[A-Z]{2})\.wad\.client$/i)[1];
  assert.ok(readWadFile(localeRow.bytes,`assets/sounds/wwise2016/vo/${lang}/characters/ahri/skins/base/ahri_base_vo_events.bnk`),'and its full voice event bank');
  assert.ok(readWadFile(localeRow.bytes,`assets/sounds/wwise2016/vo/${lang}/characters/ahri/skins/base/ahri_base_vo_audio.wpk`),'and its voice audio package');
  const bin=readWadFile(wad,'data/characters/ahri/skins/skin0.bin');
  assert.equal(baseSkinName(bin,'ahri'),'Ahri','LTK Manager sees the base skin\'s name');
  assert.equal(parseBin(bin).objects.length,2);
  const text=bin.toString('latin1');
  assert.doesNotMatch(text,/Skins\/Skin27\/[^.\u0000]*\.sk[ln]/i,'no mesh points at the chosen skin');
  assert.match(text,/ASSETS\/Characters\/Ahri\/Skins\/Base\/Ahri_Base\.sk[ln]/i,'it draws the chosen skin\'s model');
  // LTK Manager refuses a base skin whose audio labels name another skin.
  const audioNames=[];
  for(let at=0;at+2<=bin.length;at++){
    const size=bin.readUInt16LE(at);
    if(size<6||size>120||at+2+size>bin.length)continue;
    const value=bin.toString('latin1',at+2,at+2+size);
    if(/^[A-Za-z0-9_]+$/.test(value)&&/^ahri_?skin0*[1-9]\d*(?:_|$)/i.test(value))audioNames.push(value);
  }
  assert.deepEqual(audioNames,[],'no audio label names another Ahri skin');
  const again=await builder.build({champion:103,id:103027,sha:sha('a'),name:'Spirit Blossom Ahri'});
  assert.equal(again.file,built.file,'the built package is reused');
}));

test('a texture-only Riot skin that names the base model is built, not refused (12.2)',{skip:!installed?unavailable:false},()=>withDir(async dir=>{
  const builder=new RiotSkinBuilder({cacheDir:dir,league:async()=>LEAGUE});
  // Both families reference Skins/Base/ for the body and only their own particle models.
  for(const [champion,id,alias,baseName] of [[51,51007,'caitlyn','CaitlynBase'],[154,154003,'zac','Zac']]){
    const built=await builder.build({champion,id,sha:sha('d'),name:''});
    const files=await archiveFiles(built.file);
    const wad=files.find(file=>new RegExp(`/${alias}\\.wad\\.client$`,'i').test(file.name))?.bytes;
    assert.ok(wad,`${id} carries its champion's WAD`);
    const bin=readWadFile(wad,`data/characters/${alias}/skins/skin0.bin`);
    assert.equal(baseSkinName(bin,alias),baseName,`${id} keeps League's base-skin name`);
    const text=bin.toString('latin1');
    assert.match(text,/Skins\/Base\/[^.\u0000]*\.sk[ln]/i,`${id} draws the base model`);
    assert.doesNotMatch(text,new RegExp(`Skins\\/Skin\\d+\\/${alias}`,'i'),`${id} names no other skin's model`);
  }
}));

test('DJ Sona\'s Genre1 form body is moved onto the base model, not overwritten by Genre2, and keeps its music and VO (12.3)',{skip:!installed?unavailable:false},()=>withDir(async dir=>{
  const builder=new RiotSkinBuilder({cacheDir:dir,league:async()=>LEAGUE});
  const built=await builder.build({champion:37,id:37077,sha:sha('e'),name:'DJ Sona Ultimate Remix'});
  const files=await archiveFiles(built.file);
  const wad=files.find(file=>/^WAD\/Sona\.wad\.client$/i.test(file.name)).bytes;
  const bin=readWadFile(wad,'data/characters/sona/skins/skin0.bin');
  const text=bin.toString('latin1');
  assert.match(text,/ASSETS\/Characters\/Sona\/Skins\/Base\/Sona\.skl/i,'the form body draws at the base path');
  assert.doesNotMatch(text,/Skins\/Skin77\/Genre1/i,'LTK Manager sees no other skin\'s mesh');
  // Every entry in the built WAD must have a unique hash (no Genre2/Genre3 overwriting Genre1).
  const count=wad.readUInt32LE(268),hashes=new Set();
  for(let i=0;i<count;i++)hashes.add(wad.readBigUInt64LE(272+i*32));
  assert.equal(hashes.size,count,'no duplicate WAD entries');
  const sonaWad=path.join(LEAGUE,'Game','DATA','FINAL','Champions','Sona.wad.client');
  const orig=await readWadFilesOnDisk(sonaWad,[
    'ASSETS/Characters/Sona/Skins/Skin77/Genre1/Sona_Skin77_Genre1.skl',
    'ASSETS/Characters/Sona/Skins/Skin77/Genre1/Sona_Skin77_Genre1.skn',
    'ASSETS/Sounds/Wwise2016/SFX/Characters/Sona/Skins/Skin77/Sona_Skin77_MUS_audio.wpk',
  ]);
  assert.ok(readWadFile(wad,'assets/characters/sona/skins/base/sona.skl').equals(rebuildMesh(orig.get('ASSETS/Characters/Sona/Skins/Skin77/Genre1/Sona_Skin77_Genre1.skl'))),'Base/Sona.skl is Genre1, not Genre2');
  assert.ok(readWadFile(wad,'assets/characters/sona/skins/base/sona.skn').equals(rebuildMesh(orig.get('ASSETS/Characters/Sona/Skins/Skin77/Genre1/Sona_Skin77_Genre1.skn'))),'Base/Sona.skn is Genre1, not Genre2');
  assert.ok(readWadFile(wad,'assets/sounds/wwise2016/sfx/characters/sona/skins/base/sona_base_mus_audio.wpk')?.equals(orig.get('ASSETS/Sounds/Wwise2016/SFX/Characters/Sona/Skins/Skin77/Sona_Skin77_MUS_audio.wpk')),'the 68 MB music WPK is packed');
  const localeRow=files.find(file=>/^WAD\/Sona\.[a-z]{2}_[A-Z]{2}\.wad\.client$/i.test(file.name));
  assert.ok(localeRow,'localized VO WAD is packed');
  const lang=localeRow.name.match(/\.([a-z]{2}_[A-Z]{2})\.wad\.client$/i)[1];
  assert.ok(readWadFile(localeRow.bytes,`assets/sounds/wwise2016/vo/${lang}/characters/sona/skins/base/sona_base_vo_events.bnk`),'full VO event bank is packed');
  assert.ok(readWadFile(localeRow.bytes,`assets/sounds/wwise2016/vo/${lang}/characters/sona/skins/base/sona_base_vo_audio.wpk`),'skin77 VO audio WPK is packed');
}));

test('DJ Sona Ultimate Remix carries its starting genre\'s effects on the base slot (12.6)',{skip:!installed?unavailable:false},()=>withDir(async dir=>{
  const {binHash}=await import('../src/skin-slots.mjs');
  const {field,objectFields}=await import('../src/bin-values.mjs');
  const builder=new RiotSkinBuilder({cacheDir:dir,league:async()=>LEAGUE});
  const built=await builder.build({champion:37,id:37077,sha:sha('e'),name:'DJ Sona Ultimate Remix'});
  const wad=(await archiveFiles(built.file)).find(file=>/^WAD\/Sona\.wad\.client$/i.test(file.name)).bytes;
  const bin=parseBin(readWadFile(wad,'data/characters/sona/skins/skin0.bin'));
  const resources=binHash('characters/sona/skins/skin0/resources');
  const skin=bin.objects.find(object=>object.hash===binHash('characters/sona/skins/skin0'));
  assert.equal(field(objectFields(skin.body),'mResourceResolver').value,resources,'the skin reads the map on the base slot');
  const map=new Map(field(objectFields(bin.objects.find(object=>object.hash===resources).body),'resourceMap').value.entries.map(([key,value])=>[key.value,value.value]));
  const particle=name=>binHash(`Characters/Sona/Skins/Skin77/Particles/${name}`);
  // Gear 1 (Genre1) fills what the skin's own map leaves empty or gives to base Sona.
  assert.equal(map.get(binHash('Sona_Skin77_Recall_01')),particle('Sona_Skin77_Recall_01'),'recall');
  assert.equal(map.get(0x15a3aa21),particle('Sona_Skin77_Q_Zone'),'Q zone');
  assert.equal(map.get(0x8b93a212),particle('Sona_Skin77_Q_PCReady_Shark01'),'power-chord-ready rings');
  assert.equal(map.get(0xa2d1f556),particle('Sona_Skin77_BA_Mis'),'its own basic attack, not base Sona\'s');
  assert.equal(map.get(0x6add51f6),particle('Sona_Skin77_Q_Mis'),'ability effects stay');
}));

test('secondary meshes in other BIN objects never overwrite skin0\'s own body model (12.3)',{skip:!installed?unavailable:false},()=>withDir(async dir=>{
  const builder=new RiotSkinBuilder({cacheDir:dir,league:async()=>LEAGUE});
  // Ezreal 81025 also has Spell4_WeaponMesh in skin25.bin; skin0 must keep Ezreal_Skin25.skl/.skn.
  const built=await builder.build({champion:81,id:81025,sha:sha('f'),name:''});
  const files=await archiveFiles(built.file);
  const wad=files.find(file=>/^WAD\/Ezreal\.wad\.client$/i.test(file.name)).bytes;
  const ezWad=path.join(LEAGUE,'Game','DATA','FINAL','Champions','Ezreal.wad.client');
  const orig=await readWadFilesOnDisk(ezWad,['ASSETS/Characters/Ezreal/Skins/Skin25/Ezreal_Skin25.skl']);
  assert.ok(readWadFile(wad,'assets/characters/ezreal/skins/base/ezreal_base.skl').equals(rebuildMesh(orig.get('ASSETS/Characters/Ezreal/Skins/Skin25/Ezreal_Skin25.skl'))),'skin0 keeps Ezreal_Skin25.skl, not Spell4_WeaponMesh');
}));

test('a skin the installed League does not ship is refused in plain words',{skip:!installed?unavailable:false},()=>withDir(async dir=>{
  const builder=new RiotSkinBuilder({cacheDir:dir,league:async()=>LEAGUE});
  await assert.rejects(builder.build({champion:103,id:103127,sha:sha('b'),name:'Missing'}),/not part of the installed League/);
}));
