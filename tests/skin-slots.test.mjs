import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import {binHash,buildSlotMod,parseBin,readWadFile,retargetBin,writeWad,writeZip} from '../src/skin-slots.mjs';
import {teamSkinSlots} from '../src/league-client.mjs';
import {SkinChoices} from '../src/skin-choices.mjs';
import {setRiotSkinsOff} from '../src/riot-skin-availability.mjs';

// Riot picks are tested for the day LTK allows them again; tests/riot-skins-off.test.mjs covers 10.6.
setRiotSkinsOff(false);

const u32=value=>{const out=Buffer.alloc(4);out.writeUInt32LE(value>>>0);return out;};
const object=(type,hash,...rest)=>({type:binHash(type),hash,body:Buffer.concat([u32(hash),...rest])});
/** A property BIN, laid out by hand so the test does not trust the code under test. */
function bin(objects,dependencies=[],tail=Buffer.alloc(0)){
  const parts=[Buffer.from('PROP','latin1'),u32(3),u32(dependencies.length)];
  for(const file of dependencies){const size=Buffer.alloc(2);size.writeUInt16LE(file.length);parts.push(size,Buffer.from(file));}
  parts.push(u32(objects.length));
  for(const row of objects)parts.push(u32(row.type));
  for(const row of objects)parts.push(u32(row.body.length),row.body);
  parts.push(tail);
  return Buffer.concat(parts);
}
const key=(champion,slot,end='')=>binHash(`characters/${champion}/skins/skin${slot}${end}`);
/** A base skin as packages have them: its skin object links its resources, and others link it. */
function ahri(dependencies=[],extra=Buffer.alloc(0)){
  return bin([
    object('SkinCharacterDataProperties',key('ahri',0),u32(key('ahri',0,'/resources')),extra),
    object('ResourceResolver',key('ahri',0,'/resources'),u32(1234)),
    object('Other',binHash('something/else'),u32(key('ahri',0)),u32(777)),
  ],dependencies);
}
const has=(bytes,value)=>bytes.includes(u32(value));

test('names are hashed the way League names its objects',()=>{
  assert.equal(binHash('ResourceResolver'),binHash('resourceresolver'));
  // FNV-1a of "a", a published test vector.
  assert.equal(binHash('a'),0xe40c292c);
});

test('the two top-level keys move to the selected skin, and nothing else changes',async()=>{
  const moved=await retargetBin(ahri(),'ahri',66);
  const parsed=parseBin(moved);
  assert.deepEqual(parsed.objects.map(row=>row.hash),[key('ahri',66),key('ahri',66,'/resources'),binHash('something/else')]);
  assert.ok(!has(moved,key('ahri',0)));
  assert.ok(!has(moved,key('ahri',0,'/resources')));
  assert.ok(has(parsed.objects[0].body,key('ahri',66,'/resources')),'the skin still links its resources');
  assert.ok(has(parsed.objects[2].body,key('ahri',66)),'and whatever linked the skin follows it');
  assert.ok(has(moved,1234)&&has(moved,777));
  assert.equal(moved.length,ahri().length);
});

test('what is not a base skin to move is left alone',async()=>{
  assert.equal(await retargetBin(ahri(),'ahri',0),null,'the base skin needs no copy');
  assert.equal(await retargetBin(ahri(),'ahri',1000),null);
  assert.equal(await retargetBin(ahri(),'lux',5),null,'another champion\'s file');
  assert.equal(await retargetBin(Buffer.from('PTCHxxxxxxxxxxxx'),'ahri',5),null);
  assert.equal(await retargetBin(Buffer.alloc(3),'ahri',5),null);
  const noResolver=bin([object('SkinCharacterDataProperties',key('ahri',0))]);
  assert.equal(await retargetBin(noResolver,'ahri',5),null);
  const occupied=bin([...parseBin(ahri()).objects,object('SkinCharacterDataProperties',key('ahri',5))]);
  assert.equal(await retargetBin(occupied,'ahri',5),null);
});

test('a skin that links another skin keeps that link',async()=>{
  const file='DATA/Characters/Ahri/Skins/Skin86.bin';
  const parsed=parseBin(await retargetBin(ahri([file]),'ahri',5,async()=>assert.fail('nothing to read')));
  assert.deepEqual(parsed.dependencies,[file]);
});

test('a chroma of the selected skin takes in the game\'s file rather than link itself',async()=>{
  const self='DATA/Characters/Ahri/Skins/Skin86.bin',asked=[];
  const game=bin([
    object('SkinCharacterDataProperties',key('ahri',86),u32(4444)),
    object('Animations',binHash('its/animations'),u32(5555)),
  ],['DATA/Shared.bin']);
  const moved=await retargetBin(ahri([self]),'ahri',86,async file=>{asked.push(file);return game;});
  assert.deepEqual(asked,['data/characters/ahri/skins/skin86.bin']);
  const parsed=parseBin(moved);
  assert.deepEqual(parsed.dependencies,['DATA/Shared.bin'],'the link to itself is gone');
  assert.ok(parsed.objects.some(row=>row.hash===binHash('its/animations')),'what it inherited is kept');
  const skin=parsed.objects.find(row=>row.hash===key('ahri',86));
  assert.ok(!has(skin.body,4444),'the chosen skin wins over the original');
  assert.equal(await retargetBin(ahri([self]),'ahri',86,async()=>null),null,'without the original it cannot be moved');
});

test('a skin using the selected skin\'s resources gets the game\'s, not its own stub',async()=>{
  const self='data/characters/ahri/skins/skin86.bin';
  const source=bin([
    object('SkinCharacterDataProperties',key('ahri',0),u32(key('ahri',86,'/resources'))),
    object('ResourceResolver',key('ahri',0,'/resources')),
  ],[self]);
  const game=bin([object('ResourceResolver',key('ahri',86,'/resources'),u32(9999))]);
  const parsed=parseBin(await retargetBin(source,'ahri',86,async()=>game));
  assert.ok(has(parsed.objects.find(row=>row.hash===key('ahri',86,'/resources')).body,9999));
});

async function withDir(run){
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-slots-'));
  try{await run(dir);}finally{await rm(dir,{recursive:true,force:true});}
}
const SKIN=champion=>`data/characters/${champion}/skins/skin0.bin`;
async function zipFiles(file){
  const zip=await yauzl.openPromise(file,{autoClose:false,validateEntrySizes:true}),out={};
  for await(const entry of zip.eachEntry()){
    const chunks=[];for await(const chunk of await zip.openReadStreamPromise(entry))chunks.push(chunk);
    out[entry.fileName]=Buffer.concat(chunks);
  }
  zip.close();return out;
}
const packageFile=async(dir,wadName,files)=>{
  const file=path.join(dir,'source.fantome');
  await writeFile(file,writeZip([{name:'META/info.json',bytes:Buffer.from('{"Name":"Source"}')},{name:`WAD/${wadName}`,bytes:writeWad(files)}]));
  return file;
};

test('the small mod is a real package holding only the moved file, never a skin0',()=>withDir(async dir=>{
  const file=await packageFile(dir,'Ahri.wad.client',[{file:SKIN('ahri'),bytes:ahri()},{file:'assets/some.dds',bytes:Buffer.from('art')}]);
  const out=await buildSlotMod({file,champion:'Ahri',slot:66,dir:path.join(dir,'slots')});
  const inside=await zipFiles(out);
  assert.deepEqual(Object.keys(inside).sort(),['META/info.json','WAD/Ahri.wad.client']);
  const info=JSON.parse(inside['META/info.json']);
  assert.match(info.Name,/^Friloverse ahri skin 66 /);
  const wad=inside['WAD/Ahri.wad.client'];
  assert.equal(wad.readUInt32LE(268),1);
  assert.equal(readWadFile(wad,SKIN('ahri')),null,'the original keeps skin0, and LTK\'s check of it');
  assert.equal(parseBin(readWadFile(wad,'data/characters/ahri/skins/skin66.bin')).objects[0].hash,key('ahri',66));
}));

test('each skin and slot gets its own mod, and building again reuses it',()=>withDir(async dir=>{
  const file=await packageFile(dir,'Ahri.wad.client',[{file:SKIN('ahri'),bytes:ahri()}]);
  const slots=path.join(dir,'slots');
  const first=await buildSlotMod({file,champion:'ahri',slot:5,dir:slots});
  assert.equal(await buildSlotMod({file,champion:'ahri',slot:5,dir:slots}),first);
  assert.notEqual(await buildSlotMod({file,champion:'ahri',slot:6,dir:slots}),first);
}));

test('Zed\'s shadow follows his skin, and a package without one is fine',()=>withDir(async dir=>{
  const shadow=bin([object('SkinCharacterDataProperties',key('zedshadow',0)),object('ResourceResolver',key('zedshadow',0,'/resources'))]);
  const zed=bin([object('SkinCharacterDataProperties',key('zed',0)),object('ResourceResolver',key('zed',0,'/resources'))]);
  const file=await packageFile(dir,'Zed.wad.client',[{file:SKIN('zed'),bytes:zed},{file:SKIN('zedshadow'),bytes:shadow}]);
  const wad=(await zipFiles(await buildSlotMod({file,champion:'Zed',slot:3,dir:path.join(dir,'slots')})))['WAD/Zed.wad.client'];
  assert.equal(wad.readUInt32LE(268),2);
  assert.ok(readWadFile(wad,'data/characters/zedshadow/skins/skin3.bin'));
}));

test('a package packed out of order is still read',()=>withDir(async dir=>{
  const good=writeWad([{file:SKIN('ahri'),bytes:ahri()},{file:'assets/a.dds',bytes:Buffer.from('a')},{file:'assets/b.dds',bytes:Buffer.from('b')}]);
  const shuffled=Buffer.from(good);
  // The table's rows, reversed: a binary search misses most of what is there.
  for(let row=0;row<3;row++)good.copy(shuffled,272+row*32,272+(2-row)*32,272+(3-row)*32);
  assert.ok(readWadFile(shuffled,SKIN('ahri')));
  const file=path.join(dir,'shuffled.fantome');
  await writeFile(file,writeZip([{name:'META/info.json',bytes:Buffer.from('{}')},{name:'WAD/Ahri.wad.client',bytes:shuffled}]));
  assert.ok(await buildSlotMod({file,champion:'Ahri',slot:9,dir:path.join(dir,'slots')}));
}));

test('a package holding its WAD as a folder of loose files works too',()=>withDir(async dir=>{
  const zed=bin([object('SkinCharacterDataProperties',key('zed',0)),object('ResourceResolver',key('zed',0,'/resources'))]);
  const shadow=bin([object('SkinCharacterDataProperties',key('zedshadow',0)),object('ResourceResolver',key('zedshadow',0,'/resources'))]);
  const file=path.join(dir,'folder.fantome');
  await writeFile(file,writeZip([
    {name:'META/info.json',bytes:Buffer.from('{}')},
    {name:'WAD/Zed.wad.client/data/characters/Zed/skins/skin0.bin',bytes:zed},
    {name:'WAD/Zed.wad.client/data/characters/zedshadow/skins/skin0.bin',bytes:shadow},
    {name:'WAD/Zed.wad.client/assets/art.dds',bytes:Buffer.from('art')},
  ]));
  const wad=(await zipFiles(await buildSlotMod({file,champion:'Zed',slot:3,dir:path.join(dir,'slots')})))['WAD/Zed.wad.client'];
  assert.equal(parseBin(readWadFile(wad,'data/characters/zed/skins/skin3.bin')).objects[0].hash,key('zed',3));
  assert.ok(readWadFile(wad,'data/characters/zedshadow/skins/skin3.bin'));
}));

test('a package with no skin data of its own gets the base skin data from League at the slot',()=>withDir(async dir=>{
  const slots=path.join(dir,'slots'),asked=[];
  // Big Smoke Nasus: only the base skin's model and art, no skin0.bin.
  const assetsOnly=await packageFile(dir,'Ahri.wad.client',[{file:'assets/some.dds',bytes:Buffer.from('art')}]);
  const league=async(wad,file)=>{asked.push([wad,file]);return file===SKIN('ahri')?ahri():null;};
  const out=await buildSlotMod({file:assetsOnly,champion:'ahri',slot:5,dir:slots,original:league});
  const inside=await zipFiles(out);
  assert.deepEqual(asked,[['Ahri.wad.client',SKIN('ahri')]]);
  const wad=inside['WAD/Ahri.wad.client'];
  assert.equal(readWadFile(wad,SKIN('ahri')),null,'never a skin0');
  assert.equal(parseBin(readWadFile(wad,'data/characters/ahri/skins/skin5.bin')).objects[0].hash,key('ahri',5));
  // Rick Sanchez Viktor: a voice WAD only, so League's own spelling names the copy's WAD.
  const voiceOnly=await packageFile(dir,'Ahri.en_US.wad.client',[{file:'assets/voice.wpk',bytes:Buffer.from('vo')}]);
  const voiced=await zipFiles(await buildSlotMod({file:voiceOnly,champion:'ahri',slot:5,dir:slots,original:league,wadName:async()=>'Ahri.wad.client'}));
  assert.ok(readWadFile(voiced['WAD/Ahri.wad.client'],'data/characters/ahri/skins/skin5.bin'));
}));

test('a package whose own skin data cannot be moved says so instead of failing the skin',()=>withDir(async dir=>{
  const slots=path.join(dir,'slots');
  const broken=await packageFile(dir,'Ahri.wad.client',[{file:SKIN('ahri'),bytes:Buffer.from('PTCHxxxxxxxxxxxx')}]);
  assert.equal(await buildSlotMod({file:broken,champion:'ahri',slot:5,dir:slots,original:async()=>ahri()}),null,'never League data over the package data');
  const unreadable=writeWad([{file:SKIN('ahri'),bytes:ahri()}]);
  unreadable[272+20]=15;
  const corrupt=path.join(dir,'unreadable.fantome');
  await writeFile(corrupt,writeZip([{name:'WAD/Ahri.wad.client',bytes:unreadable}]));
  await assert.rejects(buildSlotMod({file:corrupt,champion:'ahri',slot:5,dir:slots,original:async()=>ahri()}),/skin file could not be read/);
  const noLeague=await packageFile(dir,'Ahri.wad.client',[{file:'assets/some.dds',bytes:Buffer.from('art')}]);
  assert.equal(await buildSlotMod({file:noLeague,champion:'ahri',slot:5,dir:slots,original:async()=>{throw new Error('no League');}}),null);
  assert.equal(await readFile(path.join(slots,'x')).catch(()=>null),null);
}));

test('nothing in Friloverse can change the skin selected in the League client',async()=>{
  const client=await import('../src/league-client.mjs');
  assert.equal(client.useBaseSkin,undefined);
  assert.equal(client.restoreClientSkin,undefined);
  for(const file of ['src/main.cjs','src/league-client.mjs','src/engine.mjs','src/skin-choices.mjs']){
    const text=await readFile(new URL(`../${file}`,import.meta.url),'utf8');
    assert.ok(!text.includes('my-selection'),`${file} must never write League's skin selection`);
  }
});

test('the selected numbers are read from the team, chromas included',async()=>{
  const team=async session=>teamSkinSlots({connect:async()=>({}),get:async()=>session});
  const slots=await team({myTeam:[
    {championId:103,selectedSkinId:103086},
    {championId:266,selectedSkinId:266000},
    {championId:238,selectedSkinId:238},
    {championId:0,selectedSkinId:0},
    {championId:11,selectedSkinId:'x'},
    null,
  ]});
  assert.deepEqual([...slots],[[103,86],[266,0]],'another champion\'s number or a blank seat is not one');
  assert.equal((await team(null)).size,0);
});

test('a pick says whose it is, by League\'s own spelling',async()=>{
  const champions=[{id:'MonkeyKing',key:'62',name:'Wukong'}];
  const choices=new SkinChoices({champions,
    database:{resolve:async id=>({id,key:'c',file:'c.fantome'}),findArchive:async()=>'local'},
    catalogue:{forChampion:async()=>[{id:62001}],ensure:async()=>({id:62001,sha:'r',file:'r.fantome'}),find:async()=>({id:62001,sha:'r',file:'r.fantome'})},
  });
  assert.equal((await choices.choose('custom','Wukong')).alias,'MonkeyKing');
  assert.equal((await choices.choose('riot:62001','Wukong')).alias,'MonkeyKing');
  assert.equal((await choices.findByContents('Wukong','c')).alias,'MonkeyKing');
  choices.database.findArchive=async()=>null;
  assert.equal((await choices.findByContents('Wukong','r')).alias,'MonkeyKing');
});

test('a blocked Riot skin from a friend is refused for any champion, not just Viego',async()=>{
  const champions=[{id:'Hecarim',key:'120',name:'Hecarim'}];
  const skins=[
    {id:120031,sha:'h'.repeat(40),relative:'120/120031/120031.fantome'},
    {id:120041,sha:'i'.repeat(40),relative:'120/120041/120041.fantome'},
  ];
  const choices=new SkinChoices({champions,random:()=>0,database:{findArchive:async()=>null},
    catalogue:{listed:()=>skins,forChampion:async()=>skins,ensure:async()=>{},
      find:async(_number,sha)=>{const skin=skins.find(row=>row.sha===sha);return skin?{...skin,file:'120.fantome'}:null;}},
  });
  await assert.rejects(choices.findByContents('Hecarim',skins[0].sha),/Winterblessed Hecarim/);
  assert.equal((await choices.findByContents('Hecarim',skins[1].sha)).id,'riot:120041');
});

test('the rebuilt Viego family is offered for personal and party play',async()=>{
  const champions=[{id:'Viego',key:'234',name:'Viego'}];
  const skins=[234021,234043,234994,234995,234996,234997,234998,234999].map(id=>({id,
    sha:String(id).padEnd(40,'0'),relative:`234/${id}/${id}.fantome`}));
  const choices=new SkinChoices({champions,random:()=>0,
    database:{findArchive:async()=>null},localDatabase:{resolve:async()=>({id:'local:x',key:'x',file:'x.fantome'})},
    catalogue:{forChampion:async()=>skins,listed:()=>skins,ensure:async(_number,id)=>({...skins.find(skin=>skin.id===id),file:'viego.fantome'}),
      find:async(_number,sha)=>({...skins.find(skin=>skin.sha===sha),file:'viego.fantome'})},
  });
  for(const skin of skins){
    assert.equal((await choices.choose(`riot:${skin.id}`,'Viego')).id,`riot:${skin.id}`);
    assert.equal((await choices.findByContents('Viego',skin.sha)).id,`riot:${skin.id}`);
  }
  await choices.choose('local:x','Viego');
  assert.equal(choices.partyPick('Viego').id,'riot:234043','the latest ordinary Riot skin stands in for the local skin');
});
