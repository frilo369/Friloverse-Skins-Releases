import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {xxh64} from '../src/league-icons.mjs';
import {fitShaders} from '../src/skin-shaders.mjs';
import {parseBin,readWadFile,wadRows,writeBin,writeWad} from '../src/skin-slots.mjs';

const LIST='assets/shaders/list.bin';
const object=(hash,text)=>{const body=Buffer.concat([Buffer.alloc(4),Buffer.from(text)]);body.writeUInt32LE(hash);return {type:7,hash,body};};
const bin=objects=>writeBin({version:3,dependencies:[],objects,tail:Buffer.alloc(0)});

async function withLeague(run){
  const league=await mkdtemp(path.join(tmpdir(),'friloverse-shaders-'));
  try{
    const final=path.join(league,'Game','DATA','FINAL');
    await mkdir(path.join(final,'Shaders'),{recursive:true});
    await writeFile(path.join(final,'Shaders','Shaders.wad.client'),writeWad([{file:LIST,bytes:bin([object(1,'riot new'),object(2,'riot other')])}]));
    await writeFile(path.join(final,'ShaderCache.dx11.wad.client'),writeWad([{file:'riot.program',bytes:Buffer.from('riot program')}]));
    return await run(league);
  }finally{await rm(league,{recursive:true,force:true});}
}

test('a skin keeps its own shaders on League\'s current list, and no old Riot files',()=>withLeague(async league=>{
  const files=await fitShaders([
    {name:'WAD/MasterYi.wad.client',bytes:Buffer.from('skin')},
    {name:'WAD/Shaders.wad.client',bytes:writeWad([{file:LIST,bytes:bin([object(1,'riot old'),object(9,'anime toon')])},{file:'assets/shaders/old.ps',bytes:Buffer.from('x')}])},
    {name:'WAD/ShaderCache.dx11.wad.client',bytes:writeWad([{file:'riot.program',bytes:Buffer.from('old')},{file:'toon.program',bytes:Buffer.from('toon')}])},
  ],league);
  assert.deepEqual(files.map(row=>row.name),['WAD/MasterYi.wad.client','WAD/Shaders.wad.client','WAD/ShaderCache.dx11.wad.client']);
  const shaders=files[1].bytes,list=parseBin(readWadFile(shaders,LIST));
  assert.deepEqual(list.objects.map(row=>row.body.subarray(4).toString()),['riot new','riot other','anime toon']);
  assert.ok(readWadFile(shaders,'assets/shaders/old.ps').equals(Buffer.from('x')),'a file League does not have stays');
  const cache=files[2].bytes;
  assert.deepEqual(wadRows(cache).map(row=>row.hash),[xxh64('toon.program')]);
}));

test('a skin with nothing of its own in its shader WADs loses them, loose files too',()=>withLeague(async league=>{
  const files=await fitShaders([
    {name:'WAD/Shaders.wad.client',bytes:writeWad([{file:LIST,bytes:bin([object(1,'riot old')])}])},
    {name:'WAD/ShaderCache.dx11.wad.client/riot.program',bytes:Buffer.from('old')},
    {name:`WAD/ShaderCache.dx11.wad.client/${xxh64('toon.program').toString(16).padStart(16,'0')}.bin`,bytes:Buffer.from('toon')},
  ],league);
  assert.deepEqual(files.map(row=>row.name),[`WAD/ShaderCache.dx11.wad.client/${xxh64('toon.program').toString(16).padStart(16,'0')}.bin`]);
}));

test('without League\'s shader WADs a skin\'s are left out',async()=>{
  const files=await fitShaders([{name:'WAD/Shaders.wad.client',bytes:writeWad([{file:LIST,bytes:bin([object(9,'toon')])}])}],path.join(tmpdir(),'no-league-here'));
  assert.deepEqual(files,[]);
});
