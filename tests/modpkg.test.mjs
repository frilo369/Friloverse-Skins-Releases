import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {decodeMsgpack,modpkgFiles,modpkgWadNames,readModpkgCard} from '../src/modpkg.mjs';
import {inspectDownload} from '../src/divine-skins.mjs';
import {hasShaderWads,packageFiles} from '../src/custom-skin-compat.mjs';
import {readWadFile,wadRows} from '../src/skin-slots.mjs';
import {xxh64} from '../src/league-icons.mjs';
import {SkinDatabase} from '../src/skin-database.mjs';

// MessagePack for the test's own info: maps, arrays and strings.
function msgpack(value){
  if(typeof value==='string'){const b=Buffer.from(value,'utf8');return Buffer.concat([b.length<32?Buffer.from([0xa0|b.length]):Buffer.from([0xd9,b.length]),b]);}
  if(value===null)return Buffer.from([0xc0]);
  if(typeof value==='number')return Buffer.from([value]);
  if(Array.isArray(value))return Buffer.concat([Buffer.from([0x90|value.length]),...value.map(msgpack)]);
  const keys=Object.keys(value);
  return Buffer.concat([Buffer.from([0x80|keys.length]),...keys.flatMap(key=>[msgpack(key),msgpack(value[key])])]);
}

/** A .modpkg as LTK writes one. Each file: {path, wad (index or null for _meta_), layer, bytes, zstd}. */
function modpkg({files,wads,layers=['base'],version=1}){
  const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
  const head=[Buffer.from('_modpkg_'),u32(version),u32(0),u32(files.length),u32(layers.length)];
  for(const name of layers)head.push(u32(name.length),Buffer.from(name),Buffer.alloc(4));
  head.push(u32(files.length),...files.map(row=>Buffer.from(`${row.path}\0`)));
  head.push(u32(wads.length),...wads.map(name=>Buffer.from(`${name}\0`)));
  let start=Buffer.concat(head).length;start=start+7&~7;
  const tableEnd=start+files.length*61,records=Buffer.alloc(files.length*61),data=[];
  let offset=tableEnd;
  files.forEach((row,index)=>{
    const stored=row.zstd?zlib.zstdCompressSync(row.bytes):row.bytes,at=index*61;
    records.writeBigUInt64LE(xxh64(row.path.toLowerCase()),at);records.writeBigUInt64LE(BigInt(offset),at+8);records[at+16]=row.zstd?1:0;
    records.writeBigUInt64LE(BigInt(stored.length),at+17);records.writeBigUInt64LE(BigInt(row.bytes.length),at+25);
    records.writeUInt32LE(index,at+49);
    records.writeUInt32LE(row.wad===null?0xFFFFFFFF:row.layer??0,at+53);
    records.writeUInt32LE(row.wad===null?0xFFFFFFFF:row.wad,at+57);
    data.push(stored);offset+=stored.length;
  });
  const header=Buffer.concat(head);
  return Buffer.concat([header,Buffer.alloc(start-header.length),records,...data]);
}

const INFO={schema_version:1,name:'velvet-ahri',display_name:'Velvet Ahri',description:'Mine.',version:'1.2.0',authors:[{name:'Rora',role:null},'Pim'],layers:[{name:'base',priority:0}]};
const SKIN=Buffer.from('skin bin '.repeat(200));
const FILES=[
  {path:'_meta_/info.msgpack',wad:null,bytes:msgpack(INFO)},
  {path:'_meta_/thumbnail.webp',wad:null,bytes:Buffer.from('RIFF....WEBPVP8 picture')},
  {path:'data/characters/ahri/skins/skin0.bin',wad:0,bytes:SKIN,zstd:true},
  {path:'assets/velvet/ahri.tex',wad:0,bytes:Buffer.from('texture')},
  {path:'assets/velvet/chroma.tex',wad:0,layer:1,bytes:Buffer.from('a chroma layer')},
  {path:'assets/sounds/vo.bnk',wad:1,bytes:Buffer.from('french voice')},
  {path:'shaders/custom.bin',wad:2,bytes:Buffer.from('shader')},
];
const WADS=['ahri.wad.client','ahri.fr_fr.wad.client','shaders.wad.client'];
const LEAGUE=new Map([['ahri.wad.client','Ahri.wad.client'],['ahri.en_us.wad.client','Ahri.en_US.wad.client'],['shaders.wad.client','Shaders.wad.client']]);

async function withPackage(bytes,run,name='Velvet Ahri.modpkg'){
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-modpkg-'));
  try{const dir=path.join(root,'LocalSkins','Ahri');await mkdir(dir,{recursive:true});const file=path.join(dir,name);await writeFile(file,bytes);await run(file,root);}
  finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
}

const skipZstd=typeof zlib.zstdCompressSync==='function'?false:'This Node runtime has no zstd support; use Node 24';

test('Divine imports identify the base-layer champion and reject a truncated .modpkg',async()=>{
  const bytes=modpkg({files:[{path:'texture',wad:0,bytes:SKIN},{path:'optional',wad:1,layer:1,bytes:SKIN}],
    wads:['ahri.wad.client','lux.wad.client'],layers:['base','extra']});
  await withPackage(bytes,async file=>{
    const champions=[{id:'Ahri',name:'Ahri'},{id:'Lux',name:'Lux'}];
    assert.deepEqual(await inspectDownload(file,'Velvet.modpkg',champions),{name:'Velvet.modpkg',suggested:'Ahri'});
    await writeFile(file,bytes.subarray(0,-1));
    await assert.rejects(inspectDownload(file,'Velvet.modpkg',champions),/damaged/);
  });
});

test('MessagePack reads what a package\'s info holds',()=>{
  assert.deepEqual(decodeMsgpack(msgpack(INFO)),INFO);
  assert.deepEqual(decodeMsgpack(Buffer.from([0x92,0xcd,0x01,0x00,0xff])),[256,-1]);
  assert.throws(()=>decodeMsgpack(Buffer.from([0xc7,1,1,0])),/damaged/);
});

test('a .modpkg card has its name, authors, version and thumbnail',{skip:skipZstd},async()=>{
  await withPackage(modpkg({files:FILES,wads:WADS,layers:['base','chroma']}),async file=>{
    const card=await readModpkgCard(file);
    assert.deepEqual({...card,image:undefined},{name:'Velvet Ahri',author:'Rora, Pim',version:'1.2.0',image:undefined});
    assert.equal(card.image.type,'image/webp');
    assert.equal(card.image.bytes.toString(),'RIFF....WEBPVP8 picture');
    assert.deepEqual(await modpkgWadNames(file),WADS);
  });
});

test('a .modpkg reads as a Fantome: League\'s WAD names, its base layer, stored bytes kept',{skip:skipZstd},async()=>{
  await withPackage(modpkg({files:FILES,wads:WADS,layers:['base','chroma']}),async file=>{
    const files=await modpkgFiles(file,{names:LEAGUE});
    // French is not installed here, so League would never read that WAD.
    assert.deepEqual(files.map(row=>row.name),['WAD/Ahri.wad.client','WAD/Shaders.wad.client','META/info.json']);
    const wad=files[0].bytes;
    assert.deepEqual(readWadFile(wad,'data/characters/ahri/skins/skin0.bin'),SKIN);
    assert.equal(readWadFile(wad,'assets/velvet/ahri.tex').toString(),'texture');
    // Another layer is an option LTK offers; the skin itself is the base layer.
    assert.equal(readWadFile(wad,'assets/velvet/chroma.tex'),null);
    const rows=wadRows(wad);
    assert.deepEqual(rows.map(row=>row.flags[0]),rows.map(row=>row.size===SKIN.length?3:0));
    assert.ok(rows.every((row,index)=>!index||rows[index-1].hash<row.hash));
    assert.deepEqual(JSON.parse(files[2].bytes),{Name:'Velvet Ahri',Author:'Rora, Pim',Version:'1.2.0',Description:'Mine.'});
    // Preparing reads it the same way, and finds its shader WAD.
    assert.equal(await hasShaderWads(file),true);
    assert.deepEqual((await packageFiles(file,null)).map(row=>row.name),['WAD/ahri.wad.client','WAD/ahri.fr_fr.wad.client','WAD/shaders.wad.client','META/info.json']);
  });
});

test('a .modpkg Friloverse cannot read is told apart, never half-read',{skip:skipZstd},async()=>{
  await withPackage(modpkg({files:FILES,wads:WADS,version:2}),async file=>{
    await assert.rejects(modpkgFiles(file),/newer than Friloverse can read/);
  });
  await withPackage(modpkg({files:FILES,wads:WADS}).subarray(0,300),async file=>{
    await assert.rejects(modpkgFiles(file),/damaged/);
  });
  await withPackage(modpkg({files:FILES.filter(row=>row.wad!==0&&row.wad!==2),wads:WADS}),async file=>{
    await assert.rejects(modpkgFiles(file,{names:LEAGUE}),/nothing for this League/);
  });
});

test('a local .modpkg gets its own name and picture on its card, and a damaged one is marked',{skip:skipZstd},async()=>{
  await withPackage(modpkg({files:FILES,wads:WADS}),async(file,root)=>{
    await writeFile(path.join(path.dirname(file),'broken.modpkg'),'_modpkg_ nonsense');
    const database=new SkinDatabase({root:path.join(root,'LocalSkins'),champions:[{id:'Ahri',key:'103',name:'Ahri'}],local:true});
    const {skins,problems}=await database.list('Ahri');
    assert.deepEqual(skins.map(skin=>[skin.name,skin.author,skin.broken]),[['broken','',true],['Velvet Ahri','Rora, Pim',false]]);
    assert.equal(skins[1].image,`friloverse-icon://local/${skins[1].id.slice(6)}`);
    assert.equal(database.embeddedImage(skins[1].id.slice(6)).type,'image/webp');
    assert.equal(problems.length,1);
    assert.equal((await database.resolve(skins[1].id,'Ahri')).file,file);
  });
});
