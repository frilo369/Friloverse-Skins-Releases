import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {archiveFiles,buildCustomSkinCopy} from '../src/custom-skin-compat.mjs';
import {xxh64} from '../src/league-icons.mjs';
import {actionsOf,addBankEvents,baseAudioTag,buildVoiceBank,leagueBanks,leagueLocaleWads,moveAudioToBase,removeBankEvents,wwiseHash} from '../src/skin-audio.mjs';
import {binHash,parseBin,readWadFile,writeBin,writeWad,writeZip} from '../src/skin-slots.mjs';

const u16=value=>{const out=Buffer.alloc(2);out.writeUInt16LE(value);return out;};
const u32=value=>{const out=Buffer.alloc(4);out.writeUInt32LE(value>>>0);return out;};
const string=text=>Buffer.concat([u16(Buffer.byteLength(text)),Buffer.from(text)]);
const field=(name,kind,bytes)=>Buffer.concat([u32(binHash(name)),Buffer.from([kind]),bytes]);
const strings=items=>{
  const body=Buffer.concat([u32(items.length),...items.map(string)]);
  return Buffer.concat([Buffer.from([16]),u32(body.length),body]);
};
const embed=(name,fields)=>{
  const body=Buffer.concat([u16(fields.length),...fields]);
  return Buffer.concat([u32(binHash(name)),u32(body.length),body]);
};
const unit=(name,paths,events,extra=[])=>embed('BankUnit',[
  field('Name',16,string(name)),field('BankPath',128,strings(paths)),
  ...(events?[field('Events',128,strings(events))]:[]),...extra,
]);
const units=items=>{
  const body=Buffer.concat([u32(items.length),...items]);
  return Buffer.concat([Buffer.from([131]),u32(body.length),body]);
};
function skinBin(alias,slot,tags,bankUnits){
  const key=binHash(`characters/${alias}/skins/skin${slot}`);
  const audio=embed('SkinAudioProperties',[field('TagEventList',128,strings(tags)),field('BankUnits',129,units(bankUnits))]);
  const body=Buffer.concat([u32(key),u16(2),field('ChampionSkinName',16,string('BaseAhri')),field('SkinAudioProperties',131,audio)]);
  return writeBin({version:3,dependencies:[],objects:[{type:binHash('SkinCharacterDataProperties'),hash:key,body}],tail:Buffer.alloc(0)});
}
const hircObject=(type,id,rest)=>Buffer.concat([Buffer.from([type]),u32(rest.length+4),u32(id),rest]);
const eventObject=(name,actions)=>hircObject(4,wwiseHash(name),Buffer.concat([Buffer.from([actions.length]),...actions.map(u32)]));
function bank(id,language,objects){
  const header=Buffer.alloc(40);header.writeUInt32LE(145,0);header.writeUInt32LE(id,4);header.writeUInt32LE(language,8);
  const hirc=Buffer.concat([u32(objects.length),...objects]);
  return Buffer.concat([Buffer.from('BKHD'),u32(40),header,Buffer.from('HIRC'),u32(hirc.length),hirc]);
}
function hirc(bytes){
  const out=[];let at=48;
  assert.equal(bytes.toString('latin1',at,at+4),'HIRC');
  const count=bytes.readUInt32LE(at+8);at+=12;
  for(let i=0;i<count;i++){const size=bytes.readUInt32LE(at+1);out.push({type:bytes[at],id:bytes.readUInt32LE(at+5),raw:bytes.subarray(at,at+5+size)});at+=5+size;}
  assert.equal(at,bytes.length,'the chunk ends where it says');
  return out;
}
const SFX='ASSETS/Sounds/Wwise2016/SFX/Characters/Ahri/Skins/Skin27/Ahri_Skin27_SFX_events.bnk';
const VO='ASSETS/Sounds/Wwise2016/VO/en_US/Characters/Ahri/Skins/Skin27/Ahri_Skin27_VO_events.bnk';
const VOTAG='ASSETS/Sounds/Wwise2016/VO/Characters/Ahri/Skins/Skin27/Ahri_Skin27_VO_basetag_events.bnk';
const base=skinBin('ahri',0,['Ahri'],[unit('Ahri_Base_SFX',['x.bnk'],['Play_sfx_Ahri_Q'])]);
const sfxBank=()=>bank(wwiseHash('Ahri_Skin27_SFX_events'),wwiseHash('SFX'),[
  hircObject(3,70,Buffer.from([1,2,3])),eventObject('Play_sfx_AhriSkin27_Q',[70]),eventObject('Stop_sfx_AhriSkin27_Q',[70]),
]);
const voBank=()=>bank(wwiseHash('Ahri_Skin27_VO_events'),wwiseHash('English(US)'),[
  hircObject(2,5,Buffer.from([9])),hircObject(3,80,Buffer.from([4])),hircObject(3,81,Buffer.from([5])),hircObject(3,82,Buffer.from([6])),
  eventObject('Play_vo_AhriSkin27_Q',[81,80]),eventObject('Play_vo_AhriSkin27_Unused',[82]),
]);
const decode=(bytes,alias='ahri',slot=0)=>{
  const key=binHash(`characters/${alias}/skins/skin${slot}`);
  const body=parseBin(bytes).objects.find(row=>row.hash===key).body,text=[];
  for(let at=0;at+2<body.length;at++){
    const size=body.readUInt16LE(at);
    if(size<3||at+2+size>body.length)continue;
    const value=body.toString('latin1',at+2,at+2+size);
    if(/^[A-Za-z0-9_/.]+$/.test(value)){text.push(value);at+=1+size;}
  }
  return text;
};

test('a skin\'s own events also answer to the base skin\'s tag',async()=>{
  const bytes=skinBin('ahri',0,['Ahri','AhriSkin27'],[
    unit('Ahri_Skin27_SFX',[SFX],['Play_sfx_AhriSkin27_Q','Stop_sfx_AhriSkin27_Q','Set_Switch_Ahri_Footsteps']),
    unit('Ahri_Skin27_VO',[VO],['Play_vo_AhriSkin27_Q'],[field('VoiceOver',1,Buffer.from([1]))]),
  ]);
  const moved=await moveAudioToBase({bytes,alias:'ahri',base,read:async file=>file===SFX?sfxBank():file===VO?voBank():null});
  const text=decode(moved.bytes);
  assert.ok(!text.includes('AhriSkin27'),'LTK Manager refuses a base skin whose tag names another skin');
  assert.ok(!text.includes('Ahri_Skin27_SFX'),'or whose unit does');
  assert.ok(text.includes('Ahri_Base_SFX')&&text.includes('Ahri_Base_VO'));
  for(const event of ['Play_sfx_AhriSkin27_Q','Play_sfx_Ahri_Q','Stop_sfx_Ahri_Q','Play_vo_AhriSkin27_Q','Play_vo_Ahri_Q'])assert.ok(text.includes(event),`${event} is listed`);
  assert.ok(!text.includes('Set_Switch_Ahri_Footsteps_x'));
  assert.ok(text.indexOf(VOTAG)>text.indexOf(VO),'the new voice bank loads after the events it copies');
  assert.equal(moved.files.length,2);
  const sfx=moved.files.find(row=>row.file===SFX).bytes;
  const ids=hirc(sfx).filter(row=>row.type===4).map(row=>row.id);
  assert.deepEqual(ids,['Play_sfx_AhriSkin27_Q','Stop_sfx_AhriSkin27_Q','Play_sfx_Ahri_Q','Stop_sfx_Ahri_Q'].map(wwiseHash));
  assert.equal(sfx.readUInt32LE(12),wwiseHash('Ahri_Skin27_SFX_events'),'an existing bank keeps its ID');
  const voice=moved.files.find(row=>row.file===VOTAG).bytes;
  assert.equal(voice.readUInt32LE(12),wwiseHash('Ahri_Skin27_VO_basetag_events'),'a new bank\'s ID comes from its name');
  assert.equal(voice.readUInt32LE(16),wwiseHash('SFX'),'and it belongs to no language');
  const objects=hirc(voice);
  assert.deepEqual(objects.map(row=>row.type),[3,3,4]);
  assert.deepEqual(objects.map(row=>row.id),[81,80,wwiseHash('Play_vo_Ahri_Q')],'only the actions its events run');
});

test('a later tag\'s event wins, whatever order the units are in',async()=>{
  const bytes=skinBin('ahri',0,['Ahri','AhriSkin80','AhriSkin79'],[
    unit('Ahri_Skin79_SFX',['a/skin79_events.bnk'],['Play_sfx_AhriSkin79_Q']),
    unit('Ahri_Skin80_SFX',['a/skin80_events.bnk'],['Play_sfx_AhriSkin80_Q','Play_sfx_AhriSkin80_W']),
  ]);
  const banks={'a/skin79_events.bnk':bank(1,1,[eventObject('Play_sfx_AhriSkin79_Q',[1])]),'a/skin80_events.bnk':bank(2,1,[eventObject('Play_sfx_AhriSkin80_Q',[1]),eventObject('Play_sfx_AhriSkin80_W',[1])])};
  const moved=await moveAudioToBase({bytes,alias:'ahri',base,read:async file=>banks[file]});
  const inBank=file=>hirc(moved.files.find(row=>row.file===file).bytes).filter(row=>row.type===4).map(row=>row.id);
  assert.ok(inBank('a/skin79_events.bnk').includes(wwiseHash('Play_sfx_Ahri_Q')));
  assert.ok(!inBank('a/skin80_events.bnk').includes(wwiseHash('Play_sfx_Ahri_Q')));
  assert.ok(inBank('a/skin80_events.bnk').includes(wwiseHash('Play_sfx_Ahri_W')));
  const text=decode(moved.bytes);
  assert.equal(text.filter(row=>row==='Ahri_Base_SFX').length,1,'a skin\'s units become one');
  assert.ok(text.includes('a/skin79_events.bnk')&&text.includes('a/skin80_events.bnk'));
});

test('the base tag is the base skin\'s tag, not its name',()=>{
  const lee=skinBin('leesin',0,['LeeSin'],[]);
  assert.equal(baseAudioTag(lee,'leesin'),'LeeSin');
  const gangplank=skinBin('gangplank',0,['Gangplank_Base','Gangplank'],[]);
  assert.equal(baseAudioTag(gangplank,'gangplank'),'Gangplank');
  assert.equal(baseAudioTag(skinBin('reksai',0,['Reksai'],[]),'reksai'),'Reksai');
  assert.equal(baseAudioTag(Buffer.from('nope'),'ahri'),'ahri','an unreadable base skin falls back to the champion');
});

test('a companion keeps its own tag, and another skin\'s borrowed event is left',async()=>{
  const bytes=skinBin('shaco',0,['Shaco','ShacoSkin54'],[
    unit('Shaco_Skin54_SFX',['s_events.bnk'],['Play_sfx_ShacoSkin54_Q','Play_sfx_ShacoBoxSkin54_Hit','Play_sfx_ShacoSkin80_Idle']),
  ]);
  const shaco=skinBin('shaco',0,['Shaco'],[]);
  const moved=await moveAudioToBase({bytes,alias:'shaco',base:shaco,read:async()=>bank(1,1,[eventObject('Play_sfx_ShacoSkin54_Q',[1]),eventObject('Play_sfx_ShacoBoxSkin54_Hit',[1]),eventObject('Play_sfx_ShacoSkin80_Idle',[1])])});
  const ids=hirc(moved.files[0].bytes).map(row=>row.id);
  assert.ok(ids.includes(wwiseHash('Play_sfx_Shaco_Q')));
  assert.ok(ids.includes(wwiseHash('Play_sfx_ShacoBox_Hit')));
  assert.ok(!ids.includes(wwiseHash('Play_sfx_Shaco_Idle')));
});

test('a strict Riot package drops every skin-named tag and event, suffix or not',async()=>{
  const sfx='ASSETS/Sounds/Wwise2016/SFX/Characters/Sona/Skins/Skin77/Sona_Skin77_SFX_events.bnk';
  const mus='ASSETS/Sounds/Wwise2016/MUS/Characters/Sona/Skins/Skin77/Sona_Skin77_MUS_events.bnk';
  const vo='ASSETS/Sounds/Wwise2016/VO/en_US/Characters/Sona/Skins/Skin77/Sona_Skin77_VO_events.bnk';
  const bytes=skinBin('sona',0,['Sona','SonaSkin77','SonaDJGenre01Skin06','SonaSkin06Genre01'],[
    unit('Sona_Skin77_SFX',[sfx],['Play_sfx_SonaSkin77_Q','Play_sfx_SonaSkin77Blue_Transition','Play_sfx_SonaSkin06Genre01_Attack','Play_sfx_SonaSkin80_Idle']),
    unit('Sona_Skin77_MUS',[mus],['Play_mus_sona_skin77_Blue_E']),
    unit('Sona_Skin77_VO',[vo],['Play_vo_SonaSkin77_Form1'],[field('VoiceOver',1,Buffer.from([1]))]),
  ]);
  const sonaBase=skinBin('sona',0,['Sona'],[unit('Sona_Base_SFX',['x.bnk'],['Play_sfx_Sona_Q'])]);
  const banks={
    [sfx]:bank(wwiseHash('Sona_Skin77_SFX_events'),wwiseHash('SFX'),[
      hircObject(3,70,Buffer.from([1])),eventObject('Play_sfx_SonaSkin77_Q',[70]),
      eventObject('Play_sfx_SonaSkin77Blue_Transition',[70]),eventObject('Play_sfx_SonaSkin06Genre01_Attack',[70]),
      eventObject('Play_sfx_SonaSkin80_Idle',[70]),
    ]),
    [mus]:bank(wwiseHash('Sona_Skin77_MUS_events'),wwiseHash('SFX'),[
      hircObject(3,70,Buffer.from([1])),eventObject('Play_mus_sona_skin77_Blue_E',[70]),
    ]),
    [vo]:bank(wwiseHash('Sona_Skin77_VO_events'),wwiseHash('English(US)'),[
      hircObject(3,70,Buffer.from([1])),eventObject('Play_vo_SonaSkin77_Form1',[70]),
    ]),
  };
  const moved=await moveAudioToBase({bytes,alias:'sona',base:sonaBase,read:async file=>banks[file]||null,strictBase:true});
  const text=decode(moved.bytes,'sona');
  for(const value of text)assert.doesNotMatch(value,/sona[a-z0-9_]*?skin\d+/i,`${value} names another skin`);
  for(const event of ['Play_sfx_Sona_Q','Play_sfx_SonaBlue_Transition','Play_sfx_SonaGenre01_Attack','Play_mus_Sona_Blue_E','Play_vo_Sona_Form1'])assert.ok(text.includes(event),`${event} is listed under the base tag`);
  assert.ok(!text.includes('Play_sfx_SonaSkin80_Idle'));
  const sfxIds=hirc(moved.files.find(row=>/sona_base_sfx_events\.bnk$/i.test(row.file)).bytes).map(row=>row.id);
  assert.ok(sfxIds.includes(wwiseHash('Play_sfx_Sona_Q')));
  assert.ok(sfxIds.includes(wwiseHash('Play_sfx_SonaBlue_Transition')));
  assert.ok(sfxIds.includes(wwiseHash('Play_sfx_SonaGenre01_Attack')));
  const musIds=hirc(moved.files.find(row=>/sona_base_mus_events\.bnk$/i.test(row.file)).bytes).map(row=>row.id);
  assert.ok(musIds.includes(wwiseHash('Play_mus_Sona_Blue_E')));
});

test('an event naming its skin twice moves the first tag, not the last (Ahri voice)',async()=>{
  const vo='ASSETS/Sounds/Wwise2016/VO/en_US/Characters/Ahri/Skins/Skin04/Ahri_Skin04_VO_events.bnk';
  const bytes=skinBin('ahri',0,['Ahri','AhriSkin04'],[
    unit('Ahri_Skin04_VO',[vo],['Play_vo_AhriSkin04_AhriE_cast3DSkin04'],[field('VoiceOver',1,Buffer.from([1]))]),
  ]);
  const ahriBase=skinBin('ahri',0,['Ahri'],[unit('Ahri_Base_VO',['base_events.bnk'],['Play_vo_Ahri_AhriE_cast3D'])]);
  const voice=bank(wwiseHash('Ahri_Skin04_VO_events'),wwiseHash('English(US)'),[
    hircObject(3,70,Buffer.from([1])),eventObject('Play_vo_AhriSkin04_AhriE_cast3DSkin04',[70]),
  ]);
  const moved=await moveAudioToBase({bytes,alias:'ahri',base:ahriBase,read:async file=>file===vo?voice:null});
  const built=moved.files.find(row=>/vo.*basetag_events\.bnk$/i.test(row.file));
  assert.ok(built,'the voice bank was written');
  const ids=hirc(built.bytes).map(row=>row.id);
  assert.ok(ids.includes(wwiseHash('Play_vo_Ahri_AhriE_cast3DSkin04')),'the first tag is now the base tag');
  assert.ok(!ids.includes(wwiseHash('Play_vo_AhriSkin04_AhriE_cast3D')),'a clone that still names skin 4 is wrong');
});

test('a unit with no event list can gain the skin\'s events',async()=>{
  const bytes=skinBin('yasuo',0,['YasuoSkin09'],[
    unit('Yasuo_Base_SFX',['base_events.bnk'],null),
    unit('Yasuo_Skin09_SFX',['skin_events.bnk'],['Play_sfx_YasuoSkin09_Q']),
  ]);
  const yasuo=skinBin('yasuo',0,['Yasuo'],[]);
  const moved=await moveAudioToBase({bytes,alias:'yasuo',base:yasuo,read:async file=>file==='skin_events.bnk'?bank(1,1,[eventObject('Play_sfx_YasuoSkin09_Q',[1])]):null});
  const key=binHash('characters/yasuo/skins/skin0'),body=parseBin(moved.bytes).objects.find(row=>row.hash===key).body.toString('latin1');
  assert.ok(body.includes('Play_sfx_Yasuo_Q'));
  assert.ok(body.includes('skin_events.bnk')&&body.includes('base_events.bnk'));
  assert.ok(!/YasuoSkin09\x00|\x0bYasuoSkin09/.test(body),'the tag has gone');
  assert.ok(body.includes('Yasuo\u0000')||body.includes('Yasuo'),'and the base tag has taken its place');
});

test('a bank that cannot be read costs its sounds, not the skin',async()=>{
  const bytes=skinBin('ahri',0,['Ahri','AhriSkin27'],[unit('Ahri_Skin27_SFX',[SFX],['Play_sfx_AhriSkin27_Q'])]);
  const moved=await moveAudioToBase({bytes,alias:'ahri',base,read:async()=>null});
  const text=decode(moved.bytes);
  assert.deepEqual(moved.files,[]);
  assert.ok(!text.includes('AhriSkin27'));
  assert.ok(text.includes('Ahri_Base_SFX'));
});

test('a skin already on the base tag is left byte for byte, older relabelled tags are not',async()=>{
  const plain=skinBin('ahri',0,['Ahri'],[unit('Ahri_Base_SFX',['x.bnk'],['Play_sfx_Ahri_Q'])]);
  assert.equal((await moveAudioToBase({bytes:plain,alias:'ahri',base,read:async()=>null})).bytes,plain);
  const old=skinBin('ahri',0,['Ahri','AhriBase27'],[unit('Ahri_Base27_SFX',['y_events.bnk'],['Play_sfx_AhriSkin27_Q'])]);
  const moved=await moveAudioToBase({bytes:old,alias:'ahri',base,read:async()=>bank(1,1,[eventObject('Play_sfx_AhriSkin27_Q',[1])])});
  const text=decode(moved.bytes);
  assert.ok(!text.includes('AhriBase27')&&!text.includes('Ahri_Base27_SFX'));
  assert.ok(text.includes('Play_sfx_Ahri_Q'));
});

test('an unknown BIN shape falls back to relabelling, so the skin is still accepted',async()=>{
  const key=binHash('characters/ahri/skins/skin0');
  const body=Buffer.concat([u32(key),u16(2),field('Other',99,Buffer.alloc(4)),field('TagEventList',16,string('AhriSkin27'))]);
  const bytes=writeBin({version:3,dependencies:[],objects:[{type:binHash('SkinCharacterDataProperties'),hash:key,body}],tail:Buffer.alloc(0)});
  const moved=await moveAudioToBase({bytes,alias:'ahri',base,read:async()=>null});
  assert.deepEqual(moved.files,[]);
  assert.ok(moved.bytes.toString('latin1').includes('AhriBase27'));
});

async function customCopy(entries){
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-audio-'));
  try{
    const champions=path.join(root,'league','Game','DATA','FINAL','Champions');
    await mkdir(champions,{recursive:true});
    await writeFile(path.join(champions,'Ahri.wad.client'),writeWad([{file:'data/characters/ahri/skins/skin0.bin',bytes:base}]));
    const file=path.join(root,'skin.fantome');
    await writeFile(file,writeZip([{name:'META/info.json',bytes:Buffer.from('{"Name":"Custom"}')},...entries]));
    const copy=await buildCustomSkinCopy({file,champion:'Ahri',dir:path.join(root,'out'),league:path.join(root,'league')});
    return await archiveFiles(copy.file);
  }finally{await rm(root,{recursive:true,force:true});}
}
const INSIDE='data/characters/ahri/skins/skin0.bin';
const customBin=()=>skinBin('ahri',0,['Ahri','AhriSkin27'],[unit('Ahri_Skin27_SFX',[SFX],['Play_sfx_AhriSkin27_Q'])]);
const hexName=file=>`${xxh64(file.toLowerCase()).toString(16).padStart(16,'0')}.bnk`;

const BASE_SFX='ASSETS/Sounds/Wwise2016/SFX/Characters/Ahri/Skins/Base/Ahri_Base_SFX_events.bnk';

test('a custom skin keeps its own sounds on strict base paths through its prepared copy',async()=>{
  const wad=writeWad([{file:INSIDE,bytes:customBin()},{file:SFX,bytes:sfxBank()}]);
  const files=await customCopy([{name:'WAD/Ahri.wad.client',bytes:wad}]);
  const out=files.find(row=>row.name==='WAD/Ahri.wad.client').bytes;
  const text=decode(readWadFile(out,INSIDE));
  assert.ok(text.includes('Play_sfx_Ahri_Q'));
  assert.ok(text.includes(BASE_SFX));
  for(const value of text)assert.doesNotMatch(value,/ahri[a-z0-9]*?_?skin\d+/i,`${value} must not name another skin`);
  assert.ok(hirc(readWadFile(out,BASE_SFX)).some(row=>row.id===wwiseHash('Play_sfx_Ahri_Q')));
});

test('a custom skin whose bank is nowhere still strips skin-named audio from skin0',async()=>{
  const bin=customBin();
  const files=await customCopy([{name:'WAD/Ahri.wad.client',bytes:writeWad([{file:INSIDE,bytes:bin}])}]);
  const text=decode(readWadFile(files.find(row=>row.name==='WAD/Ahri.wad.client').bytes,INSIDE));
  assert.ok(text.includes('Play_sfx_Ahri_Q'));
  for(const value of text)assert.doesNotMatch(value,/ahri[a-z0-9]*?_?skin\d+/i,`${value} must not name another skin`);
});

test('a custom skin that is a folder of loose files keeps its sounds on strict base paths too',async()=>{
  const folder='WAD/Ahri.wad.client/';
  const files=await customCopy([{name:`${folder}${INSIDE}`,bytes:customBin()},{name:`${folder}${hexName(SFX)}`,bytes:sfxBank()}]);
  const moved=files.find(row=>row.name.toLowerCase()===`${folder}${BASE_SFX}`.toLowerCase());
  assert.ok(moved,'moved bank written at Skins/Base path');
  assert.ok(hirc(moved.bytes).some(row=>row.id===wwiseHash('Play_sfx_Ahri_Q')));
  const text=decode(files.find(row=>row.name===`${folder}${INSIDE}`).bytes);
  assert.ok(text.includes('Play_sfx_Ahri_Q'));
  for(const value of text)assert.doesNotMatch(value,/ahri[a-z0-9]*?_?skin\d+/i,`${value} must not name another skin`);
});

test('custom skins with already-stripped tags still clean lingering SkinN events and paths, keeping basetag banks (12.5)',async()=>{
  const sfx19='ASSETS/Sounds/Wwise2016/SFX/Characters/Ekko/Skins/Skin19/Ekko_Skin19_SFX_events.bnk';
  const vo19='ASSETS/Sounds/Wwise2016/VO/en_US/Characters/Ekko/Skins/Skin19/Ekko_Skin19_VO_events.bnk';
  const voStub='ASSETS/Sounds/Wwise2016/VO/Characters/Ekko/Skins/Skin19/Ekko_Skin19_VO_basetag_events.bnk';
  const ekkoBase=skinBin('ekko',0,['Ekko'],[unit('Ekko_Base_SFX',['x.bnk'],['Play_sfx_Ekko_Q'])]);
  const bytes=skinBin('ekko',0,['Ekko'],[
    unit('Ekko_Base_SFX',[sfx19],['Play_sfx_EkkoSkin19_Dance3D','Play_sfx_Ekko_Dance3D']),
    unit('Ekko_Base_VO',[vo19,voStub],['Play_vo_EkkoSkin19_Death3D'],[field('VoiceOver',1,Buffer.from([1]))]),
  ]);
  const banks={
    [sfx19]:bank(wwiseHash('Ekko_Skin19_SFX_events'),wwiseHash('SFX'),[hircObject(3,70,Buffer.from([1])),eventObject('Play_sfx_EkkoSkin19_Dance3D',[70])]),
    [vo19]:bank(wwiseHash('Ekko_Skin19_VO_events'),wwiseHash('English(US)'),[hircObject(2,5,Buffer.from([9])),hircObject(3,80,Buffer.from([1])),eventObject('Play_vo_EkkoSkin19_Death3D',[80])]),
    [voStub]:bank(wwiseHash('Ekko_Skin19_VO_basetag_events'),wwiseHash('SFX'),[hircObject(3,80,Buffer.from([1])),eventObject('Play_vo_Ekko_Death3D',[80])]),
  };
  const moved=await moveAudioToBase({bytes,alias:'ekko',base:ekkoBase,read:async file=>banks[file]||null,strictBase:true});
  const text=decode(moved.bytes,'ekko');
  for(const value of text)assert.doesNotMatch(value,/ekko[a-z0-9]*?_?skin\d+/i,`${value} names another skin`);
  const voTag='ASSETS/Sounds/Wwise2016/VO/Characters/Ekko/Skins/Base/Ekko_Base_VO_basetag_events.bnk';
  assert.ok(text.includes(voTag),'the basetag bank moves to the base path, not dropped');
  assert.ok(text.includes('Play_sfx_Ekko_Dance3D')&&text.includes('Play_vo_Ekko_Death3D'));
  assert.equal(moved.files.length,2);
  assert.ok(hirc(moved.files.find(row=>/SFX_events/.test(row.file)).bytes).some(row=>row.id===wwiseHash('Play_sfx_Ekko_Dance3D')));
  assert.ok(hirc(moved.files.find(row=>row.file===voTag).bytes).some(row=>row.id===wwiseHash('Play_vo_Ekko_Death3D')),'its base-named voice events stay reachable');
  assert.equal(moved.localeFiles.length,1);
  assert.ok(hirc(moved.localeFiles[0].bytes).some(row=>row.id===wwiseHash('Play_vo_Ekko_Death3D')));
});

test('strict base audio keeps other-champion skin references in kill/encounter VO lines (12.5)',async()=>{
  const vo='ASSETS/Sounds/Wwise2016/VO/en_US/Characters/Zed/Skins/Skin13/Zed_Skin13_VO_events.bnk';
  const zedBase=skinBin('zed',0,['Zed'],[]);
  const bytes=skinBin('zed',0,['Zed'],[
    unit('Zed_Base_VO',[vo],['Play_vo_ZedSkin13_Attack2DJinxSkin13','Play_vo_Zed_Kill3DKaynSkin02']),
  ]);
  const voice=bank(wwiseHash('Zed_Skin13_VO_events'),wwiseHash('English(US)'),[
    hircObject(3,70,Buffer.from([1])),eventObject('Play_vo_ZedSkin13_Attack2DJinxSkin13',[70]),
  ]);
  const moved=await moveAudioToBase({bytes,alias:'zed',base:zedBase,read:async file=>file===vo?voice:null,strictBase:true});
  const text=decode(moved.bytes,'zed');
  assert.ok(text.includes('Play_vo_Zed_Attack2DJinxSkin13'),'ZedSkin13 becomes Zed while keeping JinxSkin13');
  assert.ok(text.includes('Play_vo_Zed_Kill3DKaynSkin02'),'other-champion skin reference is preserved');
});

for(const order of ['skin bank first','base bank first'])test(`strict base audio keeps both a SkinN bank and the base bank it would land on, ${order} (12.5)`,async()=>{
  const baseSfx='ASSETS/Sounds/Wwise2016/SFX/Characters/Ahri/Skins/Base/Ahri_Base_SFX_events.bnk';
  const movedSfx='ASSETS/Sounds/Wwise2016/SFX/Characters/Ahri/Skins/Base/Ahri_Base_SFX_2_events.bnk';
  const baseBank=bank(wwiseHash('Ahri_Base_SFX_events'),wwiseHash('SFX'),[hircObject(3,1,Buffer.from([0])),eventObject('Play_sfx_Ahri_W',[1])]);
  const bytes=skinBin('ahri',0,['Ahri'],[
    unit('Ahri_Base_SFX',order==='skin bank first'?[SFX,baseSfx]:[baseSfx,SFX],['Play_sfx_AhriSkin27_Q','Play_sfx_Ahri_W']),
  ]);
  const moved=await moveAudioToBase({bytes,alias:'ahri',base,read:async file=>file===SFX?sfxBank():baseBank,strictBase:true});
  const text=decode(moved.bytes);
  assert.equal(text.filter(value=>value===baseSfx).length,1,'the base bank is listed once');
  assert.equal(text.filter(value=>value===movedSfx).length,1,'the skin bank takes a free base path');
  const at=file=>moved.files.find(row=>row.file===file).bytes;
  assert.ok(hirc(at(movedSfx)).some(row=>row.id===wwiseHash('Play_sfx_Ahri_Q')),'the Skin27 bank keeps its events and gains the base-tag one');
  assert.ok(hirc(at(baseSfx)).some(row=>row.id===wwiseHash('Play_sfx_Ahri_W')),'the base bank is not replaced');
});

test('custom mod-supplied localized VO banks override League VO in locale WADs (12.5)',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-custom-vo-'));
  try{
    const folder=path.join(root,'Game','DATA','FINAL','Champions');
    await mkdir(folder,{recursive:true});
    const source='ASSETS/Sounds/Wwise2016/VO/en_US/Characters/Ahri/Skins/Skin27/Ahri_Skin27_VO_audio.wpk';
    const target='ASSETS/Sounds/Wwise2016/VO/en_US/Characters/Ahri/Skins/Base/Ahri_Base_VO_audio.wpk';
    await writeFile(path.join(folder,'Ahri.en_US.wad.client'),writeWad([{file:source,bytes:Buffer.from('league-voice')}]));
    const customVoice=Buffer.from('custom-anime-voice');
    const wads=await leagueLocaleWads(root,'Ahri',[{source,file:target,bytes:customVoice,clones:[],event:false}],{customSources:new Set([source.toLowerCase()])});
    assert.equal(wads.length,1);
    assert.ok(wads[0].files[0].bytes.equals(customVoice));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a custom skin\'s copy leaves out League\'s shader WADs, packed or loose',async()=>{
  const bin=customBin(),shader={file:'assets/shaders/old.ps',bytes:Buffer.from('old shader')};
  const files=await customCopy([
    {name:'WAD/Ahri.wad.client',bytes:writeWad([{file:INSIDE,bytes:bin}])},
    {name:'WAD/Shaders.wad.client',bytes:writeWad([shader])},
    {name:'WAD/ShaderCache.dx11.wad.client',bytes:writeWad([shader])},
    {name:'WAD/ShaderCache.glsl.wad.client/0123456789abcdef.bin',bytes:shader.bytes},
  ]);
  assert.deepEqual(files.map(row=>row.name).sort(),['META/info.json','WAD/Ahri.wad.client']);
});

test('adding events changes nothing else in the bank, and repeats are skipped',()=>{
  const source=sfxBank();
  const out=addBankEvents(source,[{source:'Play_sfx_AhriSkin27_Q',target:'Play_sfx_Ahri_Q'},{source:'Play_sfx_AhriSkin27_Q',target:'Play_sfx_Ahri_Q'},{source:'Missing',target:'Play_sfx_Ahri_Missing'}]);
  const before=hirc(source),after=hirc(out);
  assert.equal(after.length,before.length+1);
  before.forEach((row,index)=>assert.ok(row.raw.equals(after[index].raw)));
  assert.ok(after.at(-1).raw.subarray(9).equals(before[1].raw.subarray(9)),'the copy runs the same actions');
  assert.equal(addBankEvents(source,[{source:'Missing',target:'Other'}]),null);
  assert.equal(buildVoiceBank(voBank(),[{source:'Missing',target:'Other'}],'name'),null);
});

const twoBanks=()=>skinBin('ahri',0,['Ahri','AhriSkin27'],[
  unit('Ahri_Skin27_SFX',[SFX],['Play_sfx_AhriSkin27_Q']),
  unit('Ahri_Skin27_VO',[VO],['Play_vo_AhriSkin27_Q'],[field('VoiceOver',1,Buffer.from([1]))]),
]);
test('a malformed bank costs only its own sounds',async()=>{
  const malformed=voBank();malformed.writeUInt32LE(999,56);
  const moved=await moveAudioToBase({bytes:twoBanks(),alias:'ahri',base,read:async file=>file===SFX?sfxBank():malformed});
  assert.equal(moved.complete,false);
  assert.deepEqual(moved.files.map(row=>row.file),[SFX]);
  assert.ok(hirc(moved.files[0].bytes).some(row=>row.id===wwiseHash('Play_sfx_Ahri_Q')));
});
test('a bank that fails to read costs only its own sounds too',async()=>{
  const moved=await moveAudioToBase({bytes:twoBanks(),alias:'ahri',base,read:async file=>{if(file===VO)throw new Error('read failed');return sfxBank();}});
  assert.equal(moved.complete,false);
  assert.deepEqual(moved.files.map(row=>row.file),[SFX]);
});
test('metadata that starts with a byte order mark still prepares',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-audio-'));
  try{
    const champions=path.join(root,'league','Game','DATA','FINAL','Champions');
    await mkdir(champions,{recursive:true});
    await writeFile(path.join(champions,'Ahri.wad.client'),writeWad([{file:INSIDE,bytes:base}]));
    const file=path.join(root,'skin.fantome');
    const info=Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]),Buffer.from('{"Name":"Custom"}')]);
    await writeFile(file,writeZip([{name:'META/info.json',bytes:info},{name:'WAD/Ahri.wad.client',bytes:writeWad([{file:INSIDE,bytes:customBin()}])}]));
    const copy=await buildCustomSkinCopy({file,champion:'Ahri',dir:path.join(root,'out'),league:path.join(root,'league')});
    const written=(await archiveFiles(copy.file)).find(row=>row.name==='META/info.json').bytes.toString('utf8');
    assert.match(JSON.parse(written).Name,/^Friloverse prepared Ahri /);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a strict Riot package keeps full localized VO banks and audio WPKs in localeFiles (12.3)',async()=>{
  const voEvents='ASSETS/Sounds/Wwise2016/VO/en_US/Characters/Sona/Skins/Skin77/Sona_Skin77_VO_events.bnk';
  const voWpk='ASSETS/Sounds/Wwise2016/VO/en_US/Characters/Sona/Skins/Skin77/Sona_Skin77_VO_audio.wpk';
  const bytes=skinBin('sona',0,['Sona','SonaSkin77'],[
    unit('Sona_Skin77_VO',[voEvents,voWpk],['Play_vo_SonaSkin77_Form1'],[field('VoiceOver',1,Buffer.from([1]))]),
  ]);
  const sonaBase=skinBin('sona',0,['Sona'],[]);
  const vo=bank(wwiseHash('Sona_Skin77_VO_events'),wwiseHash('English(US)'),[
    hircObject(2,5,Buffer.from([9])),hircObject(3,70,Buffer.from([1])),eventObject('Play_vo_SonaSkin77_Form1',[70]),
  ]);
  const wpkBytes=Buffer.from('r3d2-skin77-voice');
  const moved=await moveAudioToBase({bytes,alias:'sona',base:sonaBase,read:async file=>file===voEvents?vo:file===voWpk?wpkBytes:null,strictBase:true});
  assert.equal(moved.files.length,0,'localized VO files go into localeFiles, not the main champion WAD');
  assert.equal(moved.localeFiles.length,2);
  const movedEvents=moved.localeFiles.find(row=>/sona_base_vo_events\.bnk$/i.test(row.file));
  assert.ok(movedEvents,'full VO_events.bnk moved to Skins/Base');
  const objects=hirc(movedEvents.bytes);
  assert.ok(objects.some(row=>row.type===2&&row.id===5),'sound nodes stay intact so actions resolve');
  assert.ok(objects.some(row=>row.type===4&&row.id===wwiseHash('Play_vo_Sona_Form1')),'base-tag VO event added');
  const movedWpk=moved.localeFiles.find(row=>/sona_base_vo_audio\.wpk$/i.test(row.file));
  assert.ok(movedWpk?.bytes.equals(wpkBytes),'skin77 VO WPK moved to Skins/Base');
});

test('a champion League spells differently still finds its voice files and packs its locale WAD',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-audio-'));
  try{
    const folder=path.join(root,'Game','DATA','FINAL','Champions');
    await mkdir(folder,{recursive:true});
    const file='ASSETS/Sounds/Wwise2016/VO/en_US/Characters/FiddleSticks/Skins/Skin1/FiddleSticks_Skin1_VO_events.bnk';
    const wpk='ASSETS/Sounds/Wwise2016/VO/en_US/Characters/FiddleSticks/Skins/Skin1/FiddleSticks_Skin1_VO_audio.wpk';
    const wpkBytes=Buffer.from('r3d2-fiddle-vo');
    await writeFile(path.join(folder,'FiddleSticks.en_US.wad.client'),writeWad([{file,bytes:voBank()},{file:wpk,bytes:wpkBytes}]));
    const found=await leagueBanks(root,'Fiddlesticks')(file);
    assert.ok(found?.equals(voBank()));
    const wads=await leagueLocaleWads(root,'Fiddlesticks',[
      {source:file,file:file.replace(/Skin1/g,'Base'),clones:[{source:'Play_vo_AhriSkin27_Q',target:'Play_vo_Ahri_Q'}],event:true},
      {source:wpk,file:wpk.replace(/Skin1/g,'Base'),clones:[],event:false},
    ]);
    assert.equal(wads.length,1);
    assert.equal(wads[0].wadName,'FiddleSticks.en_US.wad.client');
    assert.equal(wads[0].files.length,2);
    assert.ok(hirc(wads[0].files[0].bytes).some(row=>row.id===wwiseHash('Play_vo_Ahri_Q')));
    assert.ok(wads[0].files[1].bytes.equals(wpkBytes));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('non-English locale WADs resolve en_US VO paths, Wwise varuint decodes big-endian and BKHD<=122, and conflicting base events are stripped',async()=>{
  // Big-endian 7-bit varuint: 130 = (1 << 7) | 2 -> [0x81, 0x02]
  const actionIds=Array.from({length:130},(_,i)=>i+1);
  const rawBig=Buffer.concat([Buffer.alloc(9),Buffer.from([0x81,0x02]),...actionIds.map(u32)]);
  assert.equal(actionsOf({raw:rawBig},134).length,130);
  assert.equal(actionsOf({raw:rawBig},134)[129],130);
  // BKHD <= 122 uses u32 action count
  const rawOld=Buffer.concat([Buffer.alloc(9),u32(2),u32(11),u32(22)]);
  assert.deepEqual(actionsOf({raw:rawOld},120),[11,22]);
  // removeBankEvents strips conflicting event IDs while leaving non-matching objects intact
  const src=sfxBank();
  const stripped=removeBankEvents(src,new Set([wwiseHash('Play_sfx_AhriSkin27_Q')]));
  assert.ok(stripped);
  assert.equal(hirc(stripped).some(row=>row.id===wwiseHash('Play_sfx_AhriSkin27_Q')),false);
  // Non-English locale WAD stores VO under en_US path hash
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-ko-vo-'));
  try{
    const champs=path.join(root,'Game','DATA','FINAL','Champions');
    const cfg=path.join(root,'Config');
    await mkdir(champs,{recursive:true});await mkdir(cfg,{recursive:true});
    await writeFile(path.join(cfg,'LeagueClientSettings.yaml'),'  globals:\n    locale: "ko_KR"\n');
    const enPath='ASSETS/Sounds/Wwise2016/VO/en_US/Characters/Ahri/Skins/Skin27/Ahri_Skin27_VO_audio.wpk';
    const basePath='ASSETS/Sounds/Wwise2016/VO/en_US/Characters/Ahri/Skins/Base/Ahri_Base_VO_audio.wpk';
    const koBytes=Buffer.from('korean-voice-bytes');
    await writeFile(path.join(champs,'Ahri.ko_KR.wad.client'),writeWad([{file:enPath,bytes:koBytes}]));
    await writeFile(path.join(champs,'Ahri.en_US.wad.client'),writeWad([{file:enPath,bytes:Buffer.from('english-voice')}]));
    assert.ok((await leagueBanks(root,'Ahri')(enPath))?.equals(koBytes),'reads active client locale first under en_US path');
    const wads=await leagueLocaleWads(root,'Ahri',[{source:enPath,file:basePath,clones:[],event:false}]);
    assert.equal(wads.length,1,'packs only the active client locale WAD');
    assert.equal(wads[0].wadName,'Ahri.ko_KR.wad.client');
    assert.equal(wads[0].files[0].file,basePath,'keeps en_US path hash inside locale WAD');
    assert.ok(wads[0].files[0].bytes.equals(koBytes));
  }finally{await rm(root,{recursive:true,force:true});}
});
