import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildNameMod,hasString,nameKey,shownName,textOf,withOwnRecordKey,xxh3} from '../src/skin-names.mjs';
import zlib from 'node:zlib';
import {existsSync} from 'node:fs';
import {leagueFolder} from '../src/league-client.mjs';
import {archiveFiles} from '../src/custom-skin-compat.mjs';

const MASK=(1n<<38n)-1n;
function table(lines,version=5){
  const rows=Buffer.alloc(8+lines.length*8),parts=[];let offset=0;
  rows.write('RST','latin1');rows[3]=version;rows.writeUInt32LE(lines.length,4);
  lines.forEach(([key,text],index)=>{
    rows.writeBigUInt64LE(BigInt(offset)<<38n|xxh3(key)&MASK,8+index*8);
    const line=Buffer.from(`${text}\0`,'utf8');parts.push(line);offset+=line.length;
  });
  return Buffer.concat([rows,...parts]);
}
const overridesOf=async file=>{
  const rows=await archiveFiles(file);
  assert.deepEqual(rows.map(row=>row.name),['META/info.json'],'only metadata: LTK rejects a copied text table');
  const info=JSON.parse(rows[0].bytes.toString('utf8'));
  assert.equal(info.Layers.base.Name,'base');assert.equal(info.Layers.base.Priority,0);
  return info.Layers.base.StringOverrides;
};

test('xxh3 matches the reference for every length a key can have',()=>{
  for(const [key,hash] of [
    ['game_character_displayname_aatrox',0xbb63c6e04e6ec636n],
    ['game_character_skin_displayname_aatrox_1',0x932731648e28aa25n],
    ['game_character_skin_displayname_monkeyking_12',0x50ff2ff80d421381n],
    ['game_character_skin_displayname_aurelionsol_101',0xc4581e064b2ac0b0n],
    ['game_character_skin_displayname_this_is_a_much_longer_internal_name_to_reach_the_next_branch_of_the_hash_function_ok_1',0x29d8896ab4983dd1n],
  ])assert.equal(xxh3(key),hash,key);
  assert.throws(()=>xxh3('short'),RangeError);
});

test('a selected skin has its own line and the default skin the champion name',()=>{
  assert.equal(nameKey('Aatrox',1),'game_character_skin_displayname_aatrox_1');
  assert.equal(nameKey('MonkeyKing',12),'game_character_skin_displayname_monkeyking_12');
  assert.equal(nameKey('Aatrox',0),'game_character_displayname_aatrox');
});

test('only a real name is shown, without markup',()=>{
  assert.equal(shownName('Justicar Aatrox (Ruby)'),'Justicar Aatrox (Ruby)');
  assert.equal(shownName('  A <b>bold</b>\n name '),'A b bold /b name');
  assert.equal(shownName('Riot skin'),'');assert.equal(shownName('custom skin'),'');assert.equal(shownName(''),'');
  assert.equal(shownName(undefined),'');assert.equal(shownName('x'.repeat(200)).length,80);
});

test('the line is found by its hash in a table this can read',()=>{
  const lines=[['game_character_displayname_aatrox','Aatrox'],['game_character_skin_displayname_aatrox_1','Justicar Aatrox']];
  assert.equal(hasString(table(lines),lines[1][0]),true);
  assert.equal(hasString(table(lines),'GAME_CHARACTER_DISPLAYNAME_AATROX'),true);
  assert.equal(hasString(table(lines),'game_character_displayname_zed'),false);
  assert.equal(hasString(table(lines,4),lines[0][0]),null);
  assert.equal(hasString(Buffer.from('nope'),lines[0][0]),null);
});

test('the mod names the line for every language and is reused',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-names-'));
  try{
    const folder=path.join(dir,'Game','DATA','FINAL','Localized'),out=path.join(dir,'out');
    await mkdir(folder,{recursive:true});
    await writeFile(path.join(folder,'Global.en_US.wad.client'),'x');await writeFile(path.join(folder,'notes.txt'),'x');
    const asked=[],key=nameKey('Aatrox',1);
    const options={alias:'Aatrox',slot:1,name:'Mine',dir:out,league:async()=>dir,read:async(wad,file)=>{asked.push([path.basename(wad),file]);return table([[key,'Theirs']]);}};
    const file=await buildNameMod(options);
    assert.deepEqual(asked,[['Global.en_US.wad.client','data/menu/en_us/lol.stringtable']]);
    assert.deepEqual(await overridesOf(file),{default:{[key]:'Mine'}});
    assert.equal(await buildNameMod(options),file);assert.equal(asked.length,1,'the finished mod is reused');
    assert.equal(await buildNameMod({...options,name:'Other',read:async()=>table([['game_character_displayname_zed','Zed']])}),null);
    assert.equal(await buildNameMod({...options,name:'Unreadable',read:async()=>{throw new Error('locked');}}),null);
  }finally{assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));await rm(dir,{recursive:true,force:true});}
});

const installedLeague=await leagueFolder().catch(()=>null);
const localized=installedLeague&&path.join(installedLeague,'Game','DATA','FINAL','Localized');
const liveSkip=!zlib.zstdDecompressSync?'This Node runtime has no zstd support; use Node 24':!localized||!existsSync(localized)?'League localized files are not installed':false;
test('real installed string tables have the lines the name mod overrides',{skip:liveSkip},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-real-names-'));
  try{
    for(const slot of [0,27]){
      const key=nameKey('Ahri',slot),label='Friloverse name verification';
      const file=await buildNameMod({alias:'Ahri',slot,name:label,dir,league:async()=>installedLeague});
      assert.ok(file,'installed language tables contain the requested name');
      assert.deepEqual(await overridesOf(file),{default:{[key]:label}});
    }
    assert.equal(await buildNameMod({alias:'Ahri',slot:9999,name:'None',dir,league:async()=>installedLeague}),null);
  }finally{assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));await rm(dir,{recursive:true,force:true});}
});

test('non-English installs find data/menu/en_us/lol.stringtable and slot 0 protects chat/nameplate records',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-names-ko-'));
  try{
    const localized=path.join(dir,'Game','DATA','FINAL','Localized');
    const champs=path.join(dir,'Game','DATA','FINAL','Champions');
    const cfg=path.join(dir,'Config');
    await mkdir(localized,{recursive:true});await mkdir(champs,{recursive:true});await mkdir(cfg,{recursive:true});
    await writeFile(path.join(cfg,'LeagueClientSettings.yaml'),'  globals:\n    locale: "ko_KR"\n');
    await writeFile(path.join(localized,'Global.ko_KR.wad.client'),'x');
    await writeFile(path.join(champs,'Elise.wad.client'),'x');
    const mkRecord=key=>{const b=Buffer.from(key,'utf8'),len=Buffer.alloc(2);len.writeUInt16LE(b.length);return Buffer.concat([Buffer.from('PROP'),len,b,Buffer.from([0])]);};
    const tbl=table([['game_character_displayname_elise','엘리스']]);
    assert.equal(textOf(tbl,'game_character_displayname_elise'),'엘리스');
    const patched=withOwnRecordKey(mkRecord('game_character_displayname_elise'),'elise');
    assert.ok(patched?.toString('utf8').includes('fril_character_displayname_elise'));
    const asked=[];
    const file=await buildNameMod({
      alias:'Elise',slot:0,name:'Blood Moon Elise',dir:path.join(dir,'out'),league:async()=>dir,
      keepChampionInChat:true,
      read:async(wad,inside)=>{
        asked.push([path.basename(wad),inside]);
        if(inside==='data/menu/en_us/lol.stringtable')return tbl;
        if(inside==='data/characters/elise/elise.bin'||inside==='data/characters/elisespider/elisespider.bin')return mkRecord('game_character_displayname_elise');
        return null;
      },
    });
    assert.ok(file);
    assert.equal(asked[0][0],'Global.ko_KR.wad.client');
    assert.equal(asked[0][1],'data/menu/en_us/lol.stringtable');
    const rows=await archiveFiles(file);
    assert.ok(rows.some(r=>r.name==='RAW/data/characters/elise/elise.bin'));
    assert.ok(rows.some(r=>r.name==='RAW/data/characters/elisespider/elisespider.bin'));
    const info=JSON.parse(rows.find(r=>r.name==='META/info.json').bytes.toString('utf8'));
    assert.deepEqual(info.Layers.base.StringOverrides.default,{
      game_character_displayname_elise:'Blood Moon Elise',
      fril_character_displayname_elise:'엘리스',
    });
  }finally{await rm(dir,{recursive:true,force:true});}
});
