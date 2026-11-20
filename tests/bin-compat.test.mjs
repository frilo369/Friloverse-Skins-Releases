import test from 'node:test';
import assert from 'node:assert/strict';
import {binHash,parseBin} from '../src/skin-slots.mjs';
import {baseSkinName,bodyMeshPaths,meshPairs,renameBaseSkin,useBaseSkinMesh} from '../src/bin-compat.mjs';

const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0);return b;};
const string=text=>Buffer.concat([u16(Buffer.byteLength(text)),Buffer.from(text)]);
const field=(name,type,value)=>Buffer.concat([u32(binHash(name)),Buffer.from([type]),value]);
const name=text=>field('ChampionSkinName',16,string(text));
const container=value=>Buffer.concat([u32(1),u32(value.length),value]);
const mesh=text=>field('SkinMesh',131,container(string(text)));
const skin=(fields,hash=binHash('characters/ahri/skins/skin0'))=>({type:binHash('SkinCharacterDataProperties'),body:Buffer.concat([u32(hash),u16(fields.length),...fields])});
function bin(objects,dependencies=['DATA/Other.bin'],tail=Buffer.from('tail-exact')){
  return Buffer.concat([Buffer.from('PROP'),u32(3),u32(dependencies.length),...dependencies.map(string),u32(objects.length),...objects.map(row=>u32(row.type)),...objects.flatMap(row=>[u32(row.body.length),row.body]),tail]);
}

test('only the base skin direct name changes, including all enclosing lengths',()=>{
  const fields=[field('SkinClassification',7,u32(1)),name('AhriSkin66'),field('KeepThis',16,string('AhriSkin66'))];
  const other={type:123,body:Buffer.concat([u32(4321),name('AhriSkin66')])};
  const source=bin([other,skin(fields),{type:987,body:Buffer.from('unchanged-raw-object')}]);
  const before=Buffer.from(source),changed=renameBaseSkin(source,'Ahri','Ahri');
  assert.ok(changed);
  assert.equal(changed.length,source.length-6);
  assert.equal(baseSkinName(changed,'ahri'),'Ahri');
  assert.deepEqual(changed,bin([other,skin([fields[0],name('Ahri'),fields[2]]),{type:987,body:Buffer.from('unchanged-raw-object')}]));
  assert.deepEqual(source,before,'the original buffer stays untouched');
  assert.deepEqual(parseBin(changed).dependencies,parseBin(source).dependencies);
  assert.deepEqual(parseBin(changed).tail,parseBin(source).tail);
});

test('a nested decoy is skipped by its struct size and remains untouched',()=>{
  const nested=Buffer.concat([u16(1),name('WrongNestedName')]);
  const embed=field('Nested',131,Buffer.concat([u32(123),u32(nested.length),nested]));
  const source=bin([skin([embed,name('AhriSkin66')])]);
  assert.equal(baseSkinName(source,'ahri'),'AhriSkin66');
  const changed=renameBaseSkin(source,'ahri','Ahri');
  assert.deepEqual(changed,bin([skin([embed,name('Ahri')])]));
  assert.equal(baseSkinName(bin([skin([embed])]),'ahri'),null);
});

test('containers, optionals, maps and null structs do not hide the direct field',()=>{
  const items=Buffer.concat([u32(1),string('AhriSkin66')]);
  const fields=[
    field('Container',128,Buffer.concat([Buffer.from([16]),u32(items.length),items])),
    field('EmptyMap',134,Buffer.concat([Buffer.from([17,16]),u32(4),u32(0)])),
    field('Optional',133,Buffer.concat([Buffer.from([16,1]),string('AhriSkin66')])),
    field('Null',130,u32(0)),name('AhriSkin66'),
  ];
  assert.equal(baseSkinName(bin([skin(fields)]),'ahri'),'AhriSkin66');
  assert.deepEqual(renameBaseSkin(bin([skin(fields)]),'ahri','Ahri'),bin([skin([...fields.slice(0,-1),name('Ahri')])]));
});

test('legacy numbering and wide direct hash values retain their bytes',()=>{
  const nested=Buffer.concat([u16(1),name('Nested')]);
  const legacy=field('Nested',20,Buffer.concat([u32(123),u32(nested.length),nested]));
  assert.equal(baseSkinName(bin([skin([legacy,name('AhriSkin66')])]),'ahri'),'AhriSkin66');
  const wide=field('WideHash',17,Buffer.from('fedcba9876543210','hex'));
  const source=bin([skin([wide,name('AhriSkin66')])]);
  assert.deepEqual(renameBaseSkin(source,'ahri','Ahri'),bin([skin([wide,name('Ahri')])]));
});

test('absent, duplicate, wrong-class and already-correct names are not edited',()=>{
  assert.equal(renameBaseSkin(bin([skin([name('Ahri')])]),'ahri','Ahri'),null);
  assert.equal(renameBaseSkin(bin([skin([name('AhriSkin66')])]),'lux','Lux'),null);
  assert.equal(baseSkinName(bin([skin([name('First'),name('Second')])]),'ahri'),null);
  assert.equal(baseSkinName(bin([skin([])]),'ahri'),null);
  const wrong=skin([name('AhriSkin66')]);wrong.type=binHash('WrongClass');
  assert.equal(renameBaseSkin(bin([wrong]),'ahri','Ahri'),null);
  assert.equal(baseSkinName(bin([skin([name('One')]),skin([name('Two')])]),'ahri'),null);
});

test('unknown kinds and invalid/truncated property ranges are rejected',()=>{
  assert.equal(baseSkinName(bin([skin([field('Unknown',99,Buffer.alloc(0)),name('AhriSkin66')])]),'ahri'),null);
  assert.equal(baseSkinName(bin([skin([field('ChampionSkinName',7,u32(1))])]),'ahri'),null);
  const source=bin([skin([name('AhriSkin66')])],[],Buffer.alloc(0));
  for(let size=0;size<source.length;size++){
    assert.equal(renameBaseSkin(source.subarray(0,size),'ahri','Ahri'),null,`prefix ${size}`);
  }
  const badLength=Buffer.from(source),body=parseBin(badLength).objects[0].body;
  body.writeUInt16LE(65535,11);
  assert.equal(baseSkinName(badLength,'ahri'),null);
  assert.equal(renameBaseSkin(source,'ahri',''),null);
  assert.equal(renameBaseSkin(source,'ahri','Ahri\u0000'),null);
});

// The mesh mapping a base-slot Riot package needs (12.2).
const BASE=['ASSETS/Characters/Ahri/Skins/Base/Ahri_Base.skl','ASSETS/Characters/Ahri/Skins/Base/Ahri_Base.skn'];

test('a skin that reuses the base model needs no model moved, even beside its own particle models',()=>{
  const base=bin([skin([name('Ahri'),...BASE.map(mesh)])]);
  // A texture-only version: its data names the base model and particles League already ships.
  const source=bin([skin([name('AhriSkin7'),...BASE.map(mesh),mesh('ASSETS/Characters/Ahri/Skins/Base/Particles/Ahri_Base_Q.skl')])]);
  assert.deepEqual(meshPairs(source,base,'ahri',{lenient:true}),[]);
  assert.deepEqual(meshPairs(source,base,'ahri'),[]);
  assert.equal(baseSkinName(source,'ahri'),'AhriSkin7','the data itself is unchanged');
  assert.equal(useBaseSkinMesh(source,'ahri',base,{lenient:true}).length,source.length);
});

test('a form body model in its own folder moves onto the base model (DJ Sona)',()=>{
  const base=bin([skin([name('BaseSona'),...BASE.map(mesh)])]);
  // DJ Sona's Ultimate Remix: the body lives in a Genre1 folder under the skin.
  const source=bin([skin([name('SonaSkin77'),
    mesh('ASSETS/Characters/Ahri/Skins/Skin77/Genre1/Ahri_Skin77_Genre1.skl'),
    mesh('ASSETS/Characters/Ahri/Skins/Skin77/Genre1/Ahri_Skin77_Genre1.skn')])]);
  assert.deepEqual(bodyMeshPaths(source,'ahri'),[
    'ASSETS/Characters/Ahri/Skins/Skin77/Genre1/Ahri_Skin77_Genre1.skl',
    'ASSETS/Characters/Ahri/Skins/Skin77/Genre1/Ahri_Skin77_Genre1.skn',
  ]);
  assert.deepEqual(meshPairs(source,base,'ahri',{lenient:true}),[
    ['ASSETS/Characters/Ahri/Skins/Skin77/Genre1/Ahri_Skin77_Genre1.skl','ASSETS/Characters/Ahri/Skins/Base/Ahri_Base.skl'],
    ['ASSETS/Characters/Ahri/Skins/Skin77/Genre1/Ahri_Skin77_Genre1.skn','ASSETS/Characters/Ahri/Skins/Base/Ahri_Base.skn'],
  ]);
});

test('a skin with its own body model still moves it onto the base path',()=>{
  const base=bin([skin([name('Ahri'),...BASE.map(mesh)])]);
  const source=bin([skin([name('AhriSkin7'),
    mesh('ASSETS/Characters/Ahri/Skins/Skin7/Ahri_Skin7.skl'),
    mesh('ASSETS/Characters/Ahri/Skins/Skin7/Particles/Ahri_Spell3.skl')])]);
  assert.equal(meshPairs(source,base,'ahri'),null,'a particle with no base counterpart is not ignored unless asked');
  assert.deepEqual(meshPairs(source,base,'ahri',{lenient:true}),[[
    'ASSETS/Characters/Ahri/Skins/Skin7/Ahri_Skin7.skl','ASSETS/Characters/Ahri/Skins/Base/Ahri_Base.skl',
  ]]);
});
