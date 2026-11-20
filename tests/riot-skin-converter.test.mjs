import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {convertRiotDatabaseSkin} from '../src/riot-skin-converter.mjs';
import {archiveFiles} from '../src/custom-skin-compat.mjs';
import {baseSkinName} from '../src/bin-compat.mjs';
import {binHash,parseBin,readWadFile,writeWad,writeZip} from '../src/skin-slots.mjs';

const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0);return b;};
const string=text=>Buffer.concat([u16(Buffer.byteLength(text)),Buffer.from(text)]);
const field=(name,type,value)=>Buffer.concat([u32(binHash(name)),Buffer.from([type]),value]);
const container=value=>Buffer.concat([u32(1),u32(value.length),value]);
const mesh=text=>field('SkinMesh',131,container(string(text)));
const audio=text=>field('SkinAudioProperties',16,string(text));
const name=text=>field('ChampionSkinName',16,string(text));
const object=fields=>({type:binHash('SkinCharacterDataProperties'),body:Buffer.concat([u32(binHash('characters/ahri/skins/skin0')),u16(fields.length),...fields])});
const bin=fields=>Buffer.concat([Buffer.from('PROP'),u32(3),u32(1),string('DATA/Other.bin'),u32(1),u32(object(fields).type),u32(object(fields).body.length),object(fields).body,Buffer.from('tail')]);
async function withDir(work){
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-convert-'));
  try{await work(dir);}finally{await rm(dir,{recursive:true,force:true});}
}

test('a chroma with particle meshes converts to the base skin instead of being refused',()=>withDir(async dir=>{
  // League's base skin: one body model at the base path and a base skin name.
  const base=bin([name('Ahri'),mesh('ASSETS/Characters/Ahri/Skins/Base/Ahri_Base.skl')]);
  const league=path.join(dir,'League');
  await mkdir(path.join(league,'Game','DATA','FINAL','Champions'),{recursive:true});
  await writeFile(path.join(league,'Game','DATA','FINAL','Champions','Ahri.wad.client'),
    writeWad([{file:'data/characters/ahri/skins/skin0.bin',bytes:base}]));
  // FrYiLoCo's package: the skin's own body, a particle model with no base counterpart,
  // and an audio label that names the skin rather than the base.
  const source=bin([
    name('AhriSkin27'),
    mesh('ASSETS/Characters/Ahri/Skins/Skin27/Ahri_Skin27.skl'),
    mesh('ASSETS/Characters/Ahri/Skins/Skin27/Particles/Spell3_Hand_01.skl'),
    audio('AhriSkin27'),
  ]);
  const archive=path.join(dir,'source.fantome');
  await writeFile(archive,writeZip([
    {name:'META/info.json',bytes:Buffer.from(JSON.stringify({Name:'Spirit Blossom Ahri'}))},
    {name:'WAD/Ahri.wad.client',bytes:writeWad([{file:'data/characters/ahri/skins/skin0.bin',bytes:source}])},
  ]));
  const result=await convertRiotDatabaseSkin({
    file:archive,champion:'Ahri',skinId:'103027',league,outputDir:path.join(dir,'out'),
    relativeOutput:path.join('103','103027','103027.fantome'),
  });
  const files=await archiveFiles(result.file);
  const wad=files.find(row=>/ahri\.wad\.client$/i.test(row.name)).bytes;
  const converted=readWadFile(wad,'data/characters/ahri/skins/skin0.bin');
  assert.equal(baseSkinName(converted,'ahri'),'Ahri','LTK sees League base skin data');
  assert.equal(parseBin(converted).objects.length,1);
  const text=converted.toString('latin1');
  assert.match(text,/ASSETS\/Characters\/Ahri\/Skins\/Base\/Ahri_Base\.skl/,'the body model moves to the base path');
  assert.doesNotMatch(text,/Skins\/Skin27\/Ahri_Skin27\.skl/i,'the body no longer names another skin');
  assert.match(text,/Skins\/Skin27\/Particles\/Spell3_Hand_01\.skl/,'a particle model the base skin lacks stays where the game ships it');
  assert.match(text,/AhriBase27/,'the audio label is made the base skin\'s');
  assert.doesNotMatch(text,/AhriSkin27/);
}));

test('a package already normalized to the base model is not refused',()=>withDir(async dir=>{
  const base=bin([name('Ahri'),mesh('ASSETS/Characters/Ahri/Skins/Base/Ahri_Base.skl')]);
  const league=path.join(dir,'League');
  await mkdir(path.join(league,'Game','DATA','FINAL','Champions'),{recursive:true});
  await writeFile(path.join(league,'Game','DATA','FINAL','Champions','Ahri.wad.client'),
    writeWad([{file:'data/characters/ahri/skins/skin0.bin',bytes:base}]));
  // A previously converted database package has only base-model paths; lenient
  // mapping must return an empty list, not null, so re-running the converter keeps it.
  const source=bin([name('Ahri'),mesh('ASSETS/Characters/Ahri/Skins/Base/Ahri_Base.skl')]);
  const archive=path.join(dir,'normalized.fantome');
  await writeFile(archive,writeZip([
    {name:'META/info.json',bytes:Buffer.from('{}')},
    {name:'WAD/Ahri.wad.client',bytes:writeWad([{file:'data/characters/ahri/skins/skin0.bin',bytes:source}])},
  ]));
  const result=await convertRiotDatabaseSkin({
    file:archive,champion:'Ahri',skinId:'103027',league,outputDir:path.join(dir,'out'),
    relativeOutput:path.join('103','103027','103027.fantome'),
  });
  const files=await archiveFiles(result.file);
  const converted=readWadFile(files.find(row=>/ahri\.wad\.client$/i.test(row.name)).bytes,'data/characters/ahri/skins/skin0.bin');
  assert.equal(baseSkinName(converted,'ahri'),'Ahri');
}));

test('a package whose body model has no base counterpart is still refused',()=>withDir(async dir=>{
  const base=bin([name('Ahri'),mesh('ASSETS/Characters/Ahri/Skins/Base/Ahri_Base.skl')]);
  const league=path.join(dir,'League');
  await mkdir(path.join(league,'Game','DATA','FINAL','Champions'),{recursive:true});
  await writeFile(path.join(league,'Game','DATA','FINAL','Champions','Ahri.wad.client'),
    writeWad([{file:'data/characters/ahri/skins/skin0.bin',bytes:base}]));
  const source=bin([
    name('AhriSkin27'),
    mesh('ASSETS/Characters/Ahri/Skins/Skin27/Ahri_Skin27.skl'),
    // League's base skin has no .skn here, so this body mesh cannot be retargeted.
    mesh('ASSETS/Characters/Ahri/Skins/Skin27/Ahri_Skin27.skn'),
  ]);
  const archive=path.join(dir,'source.fantome');
  await writeFile(archive,writeZip([
    {name:'META/info.json',bytes:Buffer.from('{}')},
    {name:'WAD/Ahri.wad.client',bytes:writeWad([{file:'data/characters/ahri/skins/skin0.bin',bytes:source}])},
  ]));
  await assert.rejects(convertRiotDatabaseSkin({
    file:archive,champion:'Ahri',skinId:'103027',league,outputDir:path.join(dir,'out'),
    relativeOutput:path.join('103','103027','103027.fantome'),
  }),/does not have one supported source mesh pair/);
}));

test('the source archive is never modified',()=>withDir(async dir=>{
  const base=bin([name('Ahri'),mesh('ASSETS/Characters/Ahri/Skins/Base/Ahri_Base.skl')]);
  const league=path.join(dir,'League');
  await mkdir(path.join(league,'Game','DATA','FINAL','Champions'),{recursive:true});
  await writeFile(path.join(league,'Game','DATA','FINAL','Champions','Ahri.wad.client'),
    writeWad([{file:'data/characters/ahri/skins/skin0.bin',bytes:base}]));
  const source=bin([name('AhriSkin27'),mesh('ASSETS/Characters/Ahri/Skins/Skin27/Ahri_Skin27.skl')]);
  const archive=path.join(dir,'source.fantome');
  await writeFile(archive,writeZip([
    {name:'META/info.json',bytes:Buffer.from('{}')},
    {name:'WAD/Ahri.wad.client',bytes:writeWad([{file:'data/characters/ahri/skins/skin0.bin',bytes:source}])},
  ]));
  const before=await readFile(archive);
  await convertRiotDatabaseSkin({
    file:archive,champion:'Ahri',skinId:'103027',league,outputDir:path.join(dir,'out'),
    relativeOutput:path.join('103','103027','103027.fantome'),
  });
  assert.deepEqual(await readFile(archive),before);
}));
