import test from 'node:test';
import assert from 'node:assert/strict';
import {readWadFile,writeWad} from '../src/skin-slots.mjs';
import {replaceWadFile} from '../src/custom-skin-compat.mjs';

const skin='data/characters/ahri/skins/skin0.bin';
test('replacing a WAD member preserves unrelated packed members byte for byte',()=>{
  const model=Buffer.from('custom mesh bytes that must be retained');
  const wad=writeWad([{file:skin,bytes:Buffer.from('old longer skin bin')},{file:'assets/custom.skn',bytes:model}]);
  const original=Buffer.from(wad),replacement=Buffer.from('new bin');
  const output=replaceWadFile(wad,skin,replacement);
  assert.deepEqual(wad,original,'input is never changed');
  assert.deepEqual(readWadFile(output,skin),replacement);
  assert.deepEqual(readWadFile(output,'assets/custom.skn'),model);
  const table=wad.subarray(272,336),other=[0,32].find(at=>table.readUInt32LE(at+16)===model.length);
  const outputTable=output.subarray(272,336);
  assert.deepEqual(outputTable.subarray(other+12,other+32),table.subarray(other+12,other+32),'other compression and checksum metadata are retained');
});

test('a malformed WAD or absent base BIN cannot become a prepared archive',()=>{
  assert.throws(()=>replaceWadFile(Buffer.alloc(12),skin,Buffer.alloc(1)),/Unsupported/);
  const wad=writeWad([{file:'unrelated',bytes:Buffer.from('model')}]);
  assert.throws(()=>replaceWadFile(wad,skin,Buffer.alloc(1)),/exactly once/);
  const bad=Buffer.from(wad);bad.writeUInt32LE(0xffffffff,280);
  assert.throws(()=>replaceWadFile(bad,'unrelated',Buffer.alloc(1)),/Incomplete/);
});

test('a skin whose data sits in the locale WAD is split into the main WAD and the locale overrides',async()=>{
  const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');
  const os=await import('node:os'),path=await import('node:path');
  const {moveChampionDataToMainWad}=await import('../src/custom-skin-compat.mjs');
  const root=await mkdtemp(path.join(os.tmpdir(),'friloverse-locale-'));
  try{
    const folder=path.join(root,'Game','DATA','FINAL','Champions');
    await mkdir(folder,{recursive:true});
    const bank='assets/sounds/wwise2016/vo/en_us/characters/ahri/skins/base/ahri_base_vo_audio.bnk';
    await writeFile(path.join(folder,'Ahri.en_US.wad.client'),writeWad([{file:bank,bytes:Buffer.from('league vo')}]));
    const skin0=Buffer.from('custom skin0'),model=Buffer.from('custom model'),vo=Buffer.from('custom vo');
    const wad=writeWad([{file:skin,bytes:skin0},{file:'assets/mine/ahri.skn',bytes:model},{file:bank,bytes:vo}]);
    const info={name:'META/info.json',bytes:Buffer.from('{}')};
    const out=await moveChampionDataToMainWad([{name:'WAD/ahri.en_us.wad.client',bytes:wad},info],{champion:'Ahri',league:root});
    assert.deepEqual(out.map(row=>row.name),['WAD/Ahri.wad.client','WAD/Ahri.en_US.wad.client','META/info.json']);
    const main=out[0].bytes,locale=out[1].bytes;
    assert.deepEqual(readWadFile(main,skin),skin0);
    assert.deepEqual(readWadFile(main,'assets/mine/ahri.skn'),model);
    assert.equal(readWadFile(main,bank),null,'a file League keeps in its locale WAD stays there');
    assert.deepEqual(readWadFile(locale,bank),vo);
    assert.equal(readWadFile(locale,skin),null);
    // Nothing to do: the main WAD is there, or the locale WAD holds no skin of the champion.
    const plain=[{name:'WAD/Ahri.wad.client',bytes:wad},{name:'WAD/Ahri.en_US.wad.client',bytes:wad}];
    assert.equal(await moveChampionDataToMainWad(plain,{champion:'Ahri',league:root}),plain);
    const voice=[{name:'WAD/Ahri.en_US.wad.client',bytes:writeWad([{file:bank,bytes:vo}])}];
    assert.equal(await moveChampionDataToMainWad(voice,{champion:'Ahri',league:root}),voice);
    // A locale League does not have: every file goes to the main WAD.
    const other=await moveChampionDataToMainWad([{name:'WAD/Ahri.fr_FR.wad.client',bytes:wad}],{champion:'Ahri',league:root});
    assert.deepEqual(other.map(row=>row.name),['WAD/Ahri.wad.client']);
    assert.deepEqual(readWadFile(other[0].bytes,bank),vo);
  }finally{await rm(root,{recursive:true,force:true});}
});
