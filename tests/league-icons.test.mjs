import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {LeagueIcons,iconId,readTable,xxh64} from '../src/league-icons.mjs';

const ASSETS='plugins/rcp-be-lol-game-data/global/default/v1';
const JPEG=Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3]),PNG=Buffer.from('89504e470d0a1a0a0102','hex');

function wad(files){
  const sorted=files.map(file=>({...file,hash:xxh64(file.path)})).sort((a,b)=>a.hash<b.hash?-1:a.hash>b.hash?1:0);
  const head=Buffer.alloc(272);head.write('RW','latin1');head[2]=3;head[3]=4;head.writeUInt32LE(sorted.length,268);
  const table=Buffer.alloc(sorted.length*32);let offset=272+table.length;const bodies=[];
  sorted.forEach((file,index)=>{
    const at=index*32;table.writeBigUInt64LE(file.hash,at);table.writeUInt32LE(offset,at+8);
    table.writeUInt32LE(file.stored.length,at+12);table.writeUInt32LE(file.size??file.stored.length,at+16);table[at+20]=file.kind??0;
    bodies.push(file.stored);offset+=file.stored.length;
  });
  return Buffer.concat([head,table,...bodies]);
}
async function league(first,second){
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-icons-'));
  const folder=path.join(root,'Plugins','rcp-be-lol-game-data');await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'default-assets.wad'),wad(first));
  if(second)await writeFile(path.join(folder,'default-assets2.wad'),wad(second));
  return {root,folder,icons:new LeagueIcons({leaguePath:async()=>root})};
}

test('the file names match the published XXH64 test values',()=>{
  assert.equal(xxh64('').toString(16),'ef46db3751d8e999');
  assert.equal(xxh64('abc').toString(16),'44bc2cf5ad770999');
  assert.equal(xxh64('Nobody inspects the spammish repetition').toString(16),'fbcea83c8a378bf1');
});

test('icons and the catalogue are read from either archive',async()=>{
  const {root,icons}=await league([
    {path:`${ASSETS}/profile-icons/1.jpg`,stored:JPEG},
    {path:`${ASSETS}/profile-icons/2.png`,stored:gzipSync(PNG),size:PNG.length,kind:1},
  ],[{path:`${ASSETS}/summoner-icons.json`,stored:Buffer.from('[{"id":7}]')}]);
  try{
    assert.deepEqual(await icons.read('1'),{bytes:JPEG,type:'image/jpeg'});
    assert.deepEqual(await icons.read(2),{bytes:PNG,type:'image/png'});
    assert.equal(await icons.read('3'),null);
    assert.deepEqual(await icons.catalogue(),[{id:7}]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('chroma pictures are read from the archive by champion and chroma number',async()=>{
  const {root,icons}=await league([{path:`${ASSETS}/champion-chroma-images/266/266004.png`,stored:gzipSync(PNG),size:PNG.length,kind:1}]);
  try{
    assert.deepEqual(await icons.chroma('266','266004'),{bytes:PNG,type:'image/png'});
    assert.equal(await icons.chroma('266','266005'),null);
    for(const [champion,id] of [['..','266004'],['266','../1'],['','266004'],['266','']])assert.equal(await icons.chroma(champion,id),null,`${champion}/${id}`);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('chroma pictures follow the path League\'s skins.json gives, and the old path stays a fallback',async()=>{
  const skins={266001:{id:266001,chromas:[
    {id:266004,chromaPath:'/lol-game-data/assets/ASSETS/Characters/Aatrox/Skins/Skin01/ChromaPreview.ChromaAssetMigration.png'},
    {id:266006,chromaPath:'/lol-game-data/assets/../../evil.png'},
  ]}};
  const {root,icons}=await league([
    {path:'plugins/rcp-be-lol-game-data/global/default/assets/characters/aatrox/skins/skin01/chromapreview.chromaassetmigration.png',stored:PNG},
    {path:`${ASSETS}/skins.json`,stored:Buffer.from(JSON.stringify(skins))},
    {path:`${ASSETS}/champion-chroma-images/266/266005.png`,stored:PNG},
  ]);
  try{
    assert.deepEqual(await icons.chroma('266','266004'),{bytes:PNG,type:'image/png'});
    assert.deepEqual(await icons.chroma('266','266005'),{bytes:PNG,type:'image/png'});
    assert.equal(await icons.chroma('266','266006'),null);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the Mayhem guide reads game pictures and lists by path, and nothing outside them',async()=>{
  const {root,icons}=await league([
    {path:'plugins/rcp-be-lol-game-data/global/default/assets/ux/cherry/augments/icons/eureka_large.png',stored:PNG},
    {path:`${ASSETS}/items.json`,stored:Buffer.from('[1]')},
  ]);
  try{
    assert.deepEqual(await icons.gameFile('ASSETS/UX/Cherry/Augments/Icons/Eureka_large.png'),{bytes:PNG,type:'image/png'});
    assert.deepEqual((await icons.gameFile('v1/items.json')).bytes,Buffer.from('[1]'));
    for(const bad of ['../x.png','assets/../v1/items.json','plugins/x.png','assets//x.png','assets/x.exe','v1/missing.json'])assert.equal(await icons.gameFile(bad),null,bad);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a patched archive is reread, and broken content is never served',async()=>{
  const {root,folder,icons}=await league([{path:`${ASSETS}/profile-icons/1.jpg`,stored:Buffer.from('not an image')}]);
  try{
    assert.equal(await icons.read('1'),null);
    await writeFile(path.join(folder,'default-assets.wad'),wad([{path:`${ASSETS}/profile-icons/1.jpg`,stored:JPEG},{path:`${ASSETS}/profile-icons/9.jpg`,stored:JPEG}]));
    assert.deepEqual((await icons.read('9')).bytes,JPEG);
    await writeFile(path.join(folder,'default-assets.wad'),'nonsense');
    assert.equal(await icons.read('9'),null);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a damaged table size never sizes a buffer: too many entries or more than the file holds',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-icons-'));
  try{
    const file=path.join(root,'default-assets.wad'),whole=wad([{path:`${ASSETS}/profile-icons/1.jpg`,stored:JPEG}]);
    for(const count of [0xffffffff,500001,2,0]){
      const bytes=Buffer.from(whole);bytes.writeUInt32LE(count,268);
      await writeFile(file,bytes);
      assert.equal(await readTable(file),null,`count ${count}`);
    }
    await writeFile(file,whole);
    assert.equal((await readTable(file)).length,32);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a table read that fails is tried again, and pictures asked for together share one read',async()=>{
  const {root,icons}=await league([{path:`${ASSETS}/profile-icons/1.jpg`,stored:JPEG}]);
  let reads=0,locked=true;
  icons.readArchiveTable=async file=>{
    reads++;
    if(locked)throw Object.assign(new Error('busy'),{code:'EBUSY'});
    return readTable(file);
  };
  try{
    assert.equal(await icons.read('1'),null,'Riot holds the file');
    locked=false;reads=0;
    const pictures=await Promise.all([icons.read('1'),icons.read('1'),icons.read('1')]);
    for(const picture of pictures)assert.deepEqual(picture?.bytes,JPEG);
    assert.equal(reads,1,'one read of the table for three pictures');
    await icons.read('1');
    assert.equal(reads,1,'the table is kept once read');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('no League install and strange IDs simply give nothing',async()=>{
  const icons=new LeagueIcons({leaguePath:async()=>path.join(tmpdir(),'friloverse-no-such-league')});
  assert.equal(await icons.read('1'),null);assert.equal(await icons.catalogue(),null);
  for(const value of ['../1','','1.jpg','99999999999','4294967296'])assert.equal(iconId(value),null,value);
  assert.equal(iconId('4294967295'),4294967295);
});

test('FrYiLoCo\'s recent history and catalogue rules carry over',async()=>{
  await import('../src/ui/party-icons.js');
  const {recentPartyIcons,partyIconsFromLocalCatalogue,partyIconSections,isEsportsTeamIcon,PARTY_ICON_CATEGORIES}=globalThis.FriloversePartyIcons;
  assert.deepEqual(recentPartyIcons(['1','2','3'],'2'),['2','1','3'],'choosing again moves it to the front');
  assert.deepEqual(recentPartyIcons(['1','2','3','4','5','6','7'],''),['1','2','3','4','5','6']);
  assert.deepEqual(recentPartyIcons(['91'],'',{91:'9'}),['9'],'a duplicate artwork resolves to its main icon');
  assert.deepEqual(recentPartyIcons('nonsense',''),[]);
  const local=[
    {id:50,title:'New Icon',imagePath:'/lol-game-data/assets/v1/profile-icons/50.jpg',rarities:[{region:'riot',rarity:1}],yearReleased:2030},
    {id:51,title:'Ranked Season 3 Reward',imagePath:'/lol-game-data/assets/v1/profile-icons/51.jpg'},
    {id:52,title:'Team Icon',esportsTeam:'T1',imagePath:'/lol-game-data/assets/v1/profile-icons/52.jpg'},
  ];
  const merged=partyIconsFromLocalCatalogue(local,[{id:'773512',name:'Portal',category:'item',path:'arena-icons/773512.png'}]);
  assert.deepEqual(merged.map(icon=>icon.summonerId??icon.id).sort(),[50,'773512'].sort());
  assert.equal(isEsportsTeamIcon({id:3,esportsTeam:'T1',title:'T1'}),true);
  const sections=partyIconSections(merged,'new','all');
  assert.equal(sections[0].icons[0].summonerId,50);
  assert.equal(PARTY_ICON_CATEGORIES[0].id,'illustration');
});
