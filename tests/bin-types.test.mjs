import test from 'node:test';
import assert from 'node:assert/strict';
import {binHash,parseBin,writeWad,readWadFile} from '../src/skin-slots.mjs';
import {convertBinTypes,convertWadTypes} from '../src/bin-types.mjs';

const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0);return b;};
const string=text=>Buffer.concat([u16(Buffer.byteLength(text)),Buffer.from(text)]);
const field=(name,type,value)=>Buffer.concat([u32(binHash(name)),Buffer.from([type]),value]);
const struct=(cls,fields)=>{const body=Buffer.concat([u16(fields.length),...fields]);return Buffer.concat([u32(binHash(cls)),u32(body.length),body]);};
const list=(item,values)=>{const body=Buffer.concat([u32(values.length),...values]);return Buffer.concat([Buffer.from([item]),u32(body.length),body]);};
const object=(cls,hash,fields)=>({type:binHash(cls),body:Buffer.concat([u32(hash),u16(fields.length),...fields])});
function bin(objects,tail=Buffer.from('tail-exact')){
  return Buffer.concat([Buffer.from('PROP'),u32(3),u32(1),string('DATA/Other.bin'),u32(objects.length),...objects.map(row=>u32(row.type)),...objects.flatMap(row=>[u32(row.body.length),row.body]),tail]);
}
const material=type=>struct('StaticMaterialDef',[field('name',16,string('Skin/Materials/Glow')),...type,field('kept',7,u32(9))]);
const skin=(type,inner=material(type))=>object('SkinCharacterDataProperties',binHash('characters/ekko/skins/skin3'),[
  field('skinClassification',7,u32(1)),
  field('materials',128,list(131,[inner])),
  field('mesh',131,material([])),
]);

test('an inline material type stored as u32 becomes u8, with every enclosing size',()=>{
  const source=bin([skin([field('type',7,u32(3))]),{type:binHash('Other'),body:Buffer.concat([u32(1),u16(1),field('type',7,u32(3))])}]);
  const before=Buffer.from(source),result=convertBinTypes(source);
  assert.equal(result.changed,1);
  assert.deepEqual(result.bytes,bin([skin([field('type',3,Buffer.from([3]))]),{type:binHash('Other'),body:Buffer.concat([u32(1),u16(1),field('type',7,u32(3))])}]));
  assert.equal(result.bytes.length,source.length-3);
  assert.deepEqual(parseBin(result.bytes).tail,Buffer.from('tail-exact'));
  assert.deepEqual(source,before,'the original buffer stays untouched');
});

test('nothing to change, a value too big for u8, or an unreadable BIN gives null',()=>{
  assert.equal(convertBinTypes(bin([skin([field('type',3,Buffer.from([3]))])])),null);
  assert.equal(convertBinTypes(bin([skin([])])),null);
  assert.equal(convertBinTypes(bin([skin([field('type',7,u32(300))])])),null);
  // A struct that says it is one byte longer than its fields: nothing is rewritten.
  const wrong=material([field('type',7,u32(3))]);wrong.writeUInt32LE(wrong.readUInt32LE(4)+1,4);
  assert.equal(convertBinTypes(bin([skin([],Buffer.concat([wrong,Buffer.from([0])]))])),null);
  assert.equal(convertBinTypes(Buffer.from('not a bin')),null);
});

test('a WAD has its BINs narrowed whatever they are called, and other members kept',()=>{
  const narrow=bin([skin([field('type',7,u32(3))])]);
  const wad=writeWad([{file:'data/characters/ekko/skins/skin3.bin',bytes:narrow},{file:'assets/a.dds',bytes:Buffer.from('DDS texture')}]);
  const result=convertWadTypes(wad);
  assert.equal(result.changed,1);
  assert.deepEqual(readWadFile(result.wad,'assets/a.dds'),Buffer.from('DDS texture'));
  assert.deepEqual(readWadFile(result.wad,'data/characters/ekko/skins/skin3.bin'),convertBinTypes(narrow).bytes);
  assert.equal(convertWadTypes(writeWad([{file:'assets/a.dds',bytes:Buffer.from('DDS texture')}])),null);
});

const u32Type=field('type',7,u32(3)),u8Type=field('type',3,Buffer.from([3]));
const named=(value,extra=[],type=u32Type)=>bin([object('SkinCharacterDataProperties',binHash('characters/pantheon/skins/skin0'),[
  field('skinClassification',7,u32(1)),...value,...extra,field('materials',128,list(131,[material([type])])),
])]);

test('text saved as a hash is written out again from a word of the skin name',()=>{
  const source=named([field('OverrideOnScreenName',17,u32(binHash('Radahn')))]);
  const result=convertBinTypes(source,{names:['Radahn Pantheon','Radahn Pantheon']});
  assert.equal(result.changed,2);
  assert.deepEqual(result.bytes,named([field('OverrideOnScreenName',16,string('Radahn'))],[],u8Type));
});

test('hashed text that no name matches is left out, with the field count lowered',()=>{
  const keep=field('kept',16,string('x'));
  const result=convertBinTypes(named([field('OverrideOnScreenName',17,u32(binHash('Unknown')))],[keep]),{names:['Radahn Pantheon']});
  assert.equal(result.changed,2);
  assert.deepEqual(result.bytes,named([],[keep],u8Type));
  // Already text: untouched.
  assert.equal(convertBinTypes(bin([object('SkinCharacterDataProperties',1,[field('OverrideOnScreenName',16,string('Radahn'))])]),{names:['Radahn']}),null);
});
