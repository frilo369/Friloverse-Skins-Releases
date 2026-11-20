import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {leagueFolder} from '../src/league-client.mjs';
import {readWadFilesOnDisk} from '../src/skin-slots.mjs';
import {isRebuilt,rebuildMesh} from '../src/mesh-rebuild.mjs';

const zstd=typeof zlib.zstdDecompressSync==='function';
const wad=await leagueFolder().then(folder=>path.join(folder,'Game','DATA','FINAL','Champions','Ahri.wad.client')).catch(()=>null);
const available=zstd&&wad&&await access(wad).then(()=>true,()=>false);
const skip=!zstd?'This Node runtime has no zstd support; use Node 24':!available?'The installed League has no Ahri WAD':false;
const paths=[
  'assets/characters/ahri/skins/skin88/ahri_skin88.skl',
  'assets/characters/ahri/skins/skin88/ahri_skin88.skn',
  'assets/characters/ahri/skins/base/ahri_base.skl',
];
const models=available?await readWadFilesOnDisk(wad,paths):null;

test('a skeleton gains one null joint and is still the same skeleton',{skip},()=>{
  const source=models.get(paths[0]);
  const rebuilt=rebuildMesh(source);
  // 100-byte joint + its 8-byte table entry + the appended name and padding.
  assert.equal(rebuilt.length,source.length+120);
  assert.equal(rebuilt.readUInt32LE(0),rebuilt.length);
  assert.equal(rebuilt.readUInt16LE(14),source.readUInt16LE(14)+1,'one more joint');
  assert.equal(isRebuilt(rebuilt),true);
  assert.equal(isRebuilt(source),false);
  assert.throws(()=>rebuildMesh(rebuilt),/already has a null joint/,'a rebuilt skeleton is not rebuilt twice');
});

test('a mesh gains one vertex, a copy of its last, and no triangle uses it',{skip},()=>{
  const source=models.get(paths[1]);
  const rebuilt=rebuildMesh(source);
  assert.equal(rebuilt.length,source.length+52,'one vertex');
  assert.equal(isRebuilt(rebuilt),true);
  assert.equal(isRebuilt(source),false);
});

test('the base skin skeleton is rebuilt too, under the base path',{skip},()=>{
  const rebuilt=rebuildMesh(models.get(paths[2]));
  assert.equal(isRebuilt(rebuilt),true);
  assert.ok(rebuilt.length>models.get(paths[2]).length);
});

test('a file that is neither a skeleton nor a mesh is refused',()=>{
  assert.throws(()=>rebuildMesh(Buffer.from('not a model at all')),/neither a League skeleton nor a mesh/);
});
