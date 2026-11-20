import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SkinDatabase} from '../src/skin-database.mjs';

function crc32(buffer){let crc=0xffffffff;for(const byte of buffer){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^(-(crc&1)&0xedb88320);}return (crc^0xffffffff)>>>0;}
function zip(files){
  const local=[],central=[];let offset=0;
  for(const [name,value] of Object.entries(files)){
    const filename=Buffer.from(name),data=Buffer.from(value),crc=crc32(data);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(filename.length,26);
    const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt32LE(crc,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(filename.length,28);record.writeUInt32LE(offset,42);
    local.push(header,filename,data);central.push(record,filename);offset+=header.length+filename.length+data.length;
  }
  const index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(central.length/2,8);end.writeUInt16LE(central.length/2,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,index,end]);
}
async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-db-')),dbRoot=path.join(root,'Custom Skins'),dir=path.join(dbRoot,'Wukong');
  await mkdir(dir,{recursive:true});const file=path.join(dir,'Test Skin.fantome');
  const original=zip({'META/info.json':JSON.stringify({Name:'Sun Wukong',Author:'Artist',Version:'1.0'}),'WAD/MonkeyKing.wad.client':'test data'});
  await writeFile(file,original);
  const db=new SkinDatabase({root:dbRoot,champions:[{id:'MonkeyKing',name:'Wukong'}]});
  return {root,file,original,db};
}
async function clean(root){assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}

test('champion aliases find archive metadata, and the file behind a card is unchanged',async()=>{
  const f=await fixture();
  try{
    const found=await f.db.list('MonkeyKing');assert.equal(found.available,true);assert.equal(found.skins.length,1);
    assert.equal(found.skins[0].name,'Sun Wukong');assert.equal(found.skins[0].author,'Artist');assert.equal(found.skins[0].kind,'custom');
    const pick=await f.db.resolve(found.skins[0].id,'Wukong');
    assert.equal(pick.file,f.file);assert.equal(pick.label,'Sun Wukong');assert.match(pick.key,/^[0-9a-f]{40}$/);
    assert.deepEqual(await readFile(f.file),f.original);
  }finally{await clean(f.root);}
});

test('changed packages and unrelated champions are refused',async()=>{
  const f=await fixture();
  try{
    const found=await f.db.list('Wukong');
    await assert.rejects(f.db.resolve(found.skins[0].id,'Aatrox'),/selected champion/i);
    await writeFile(f.file,Buffer.concat([f.original,Buffer.from('changed')]));
    await assert.rejects(f.db.resolve(found.skins[0].id,'Wukong'),/changed/i);
  }finally{await clean(f.root);}
});

test('custom mods are listed separately and need no champion',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-mods-'));
  try{
    const dir=path.join(root,'Custom Mods');await mkdir(dir);
    await writeFile(path.join(dir,'Minions.fantome'),zip({'META/info.json':JSON.stringify({Name:'Minecraft Minions',Author:'Frog'})}));
    const db=new SkinDatabase({root:dir,mode:'mods'});
    const found=await db.list('');assert.equal(found.skins.length,1);assert.match(found.skins[0].id,/^moddb:/);
    assert.equal((await db.resolve(found.skins[0].id)).label,'Minecraft Minions');
  }finally{await clean(root);}
});

test('archives are found again by their Git blob hash for party sharing',async()=>{
  const f=await fixture();
  try{
    const {createHash}=await import('node:crypto');
    const blob=createHash('sha1').update(`blob ${f.original.length}\0`).update(f.original).digest('hex');
    const found=await f.db.list('Wukong');
    assert.equal(await f.db.findArchive('monkeyking',blob),found.skins[0].id);
    assert.equal(await f.db.findArchive('monkeyking','0'.repeat(40)),null);
    assert.equal(await f.db.findArchive('Aatrox',blob),null);
    assert.equal((await f.db.resolve(found.skins[0].id,'Wukong')).key,blob);
  }finally{await clean(f.root);}
});

test('a missing folder is reported, not an error',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-db-'));
  try{assert.deepEqual(await new SkinDatabase({root:path.join(root,'none')}).list('Ahri'),{skins:[],available:false});}
  finally{await clean(root);}
});

import {lstat as realLstat,readdir as realReaddir} from 'node:fs/promises';
const denied=()=>Object.assign(new Error('operation not permitted'),{code:'EPERM'});

async function threeSkins(){
  const f=await fixture(),dir=path.dirname(f.file),other=name=>path.join(dir,`${name}.fantome`);
  for(const name of ['Second','Third'])await writeFile(other(name),zip({'META/info.json':JSON.stringify({Name:name})}));
  return {...f,dbRoot:path.dirname(dir),other};
}

test('first card reads overlap with a limit and retain sorted order and cached hashes',async()=>{
  const f=await threeSkins();let active=0,peak=0,hashes=0;
  try{
    for(let n=0;n<5;n++)await writeFile(f.other(`Extra${n}`),f.original);
    const db=new SkinDatabase({root:f.dbRoot,io:{hash:async()=>{
      hashes++;peak=Math.max(peak,++active);
      await new Promise(done=>setTimeout(done,15));active--;return 'a'.repeat(40);
    }}});
    const first=await db.list('Wukong');
    assert.ok(peak>1);assert.ok(peak<=4);assert.equal(first.skins.length,8);
    const files=first.skins.map(skin=>db.entries.get(skin.id).file);
    assert.deepEqual(files,[...files].sort((a,b)=>a.localeCompare(b,'en')));
    await db.list('Wukong');assert.equal(hashes,8,'unchanged archives are not hashed again');
  }finally{await clean(f.root);}
});

test('one file that cannot be read costs only itself',async()=>{
  const f=await threeSkins(),told=[];
  try{
    const io={lstat:async(file,...rest)=>{if(file===f.other('Second'))throw denied();return realLstat(file,...rest);}};
    const db=new SkinDatabase({root:f.dbRoot,champions:[{id:'MonkeyKing',name:'Wukong'}],io,onProblem:row=>told.push(row)});
    const found=await db.list('Wukong');
    assert.deepEqual(found.skins.map(skin=>skin.name).sort(),['Sun Wukong','Third']);
    assert.equal(found.problems.length,1);
    await db.list('Wukong');
    assert.equal(told.length,1,'a list read every 3 s tells it once');
    assert.match(told[0].file,/Second\.fantome$/);
  }finally{await clean(f.root);}
});

test('a file that vanished mid-read is simply not listed',async()=>{
  const f=await threeSkins();
  try{
    const io={lstat:async(file,...rest)=>{if(file===f.other('Second'))throw Object.assign(new Error('gone'),{code:'ENOENT'});return realLstat(file,...rest);}};
    const found=await new SkinDatabase({root:f.dbRoot,champions:[{id:'MonkeyKing',name:'Wukong'}],io}).list('Wukong');
    assert.equal(found.skins.length,2);
    assert.equal(found.problems,undefined);
  }finally{await clean(f.root);}
});

test('a locked file keeps its card, and its picture is tried again',async()=>{
  const f=await threeSkins();
  let locked=true,hashed=0;
  try{
    const io={hash:async file=>{if(file===f.other('Second')&&locked)throw Object.assign(new Error('locked'),{code:'EBUSY'});hashed++;return 'a'.repeat(40);}};
    const db=new SkinDatabase({root:f.dbRoot,champions:[{id:'MonkeyKing',name:'Wukong'}],io});
    const found=await db.list('Wukong');
    assert.equal(found.skins.length,3);
    assert.equal(found.problems.length,1);
    locked=false;const before=hashed;
    assert.equal((await db.list('Wukong')).problems,undefined);
    assert.equal(hashed,before+1,'only the one that failed is hashed again');
  }finally{await clean(f.root);}
});

test('an unreadable subfolder costs what is in it, but an unreadable library is still an error',async()=>{
  const f=await threeSkins(),sub=path.join(path.dirname(f.file),'Locked');
  await mkdir(sub);
  try{
    const io={readdir:async(dir,...rest)=>{if(dir===sub)throw denied();return realReaddir(dir,...rest);}};
    const found=await new SkinDatabase({root:f.dbRoot,champions:[{id:'MonkeyKing',name:'Wukong'}],io}).list('Wukong');
    assert.equal(found.skins.length,3);
    assert.equal(found.problems.length,1);
    const whole={readdir:async()=>{throw denied();}};
    await assert.rejects(new SkinDatabase({root:f.dbRoot,champions:[{id:'MonkeyKing',name:'Wukong'}],io:whole}).list('Wukong'),/not permitted/);
  }finally{await clean(f.root);}
});

test('a really damaged archive is a broken card, told once, and a whole one is not',async()=>{
  const {root,file,db}=await fixture();
  const told=[];db.onProblem=row=>told.push(row);
  try{
    await writeFile(path.join(path.dirname(file),'Damaged.fantome'),Buffer.from('this is not a zip archive at all, only some bytes'));
    const first=await db.list('Wukong');
    assert.equal(first.skins.find(skin=>skin.name==='Damaged').broken,true);
    assert.equal(first.skins.find(skin=>skin.name==='Sun Wukong').broken,false);
    await db.list('Wukong');
    assert.equal(told.length,1,'it is listed every 3 s, and said once');
    assert.match(told[0].problem,/damaged/);
  }finally{await clean(root);}
});

test('a file another program has open is not called damaged, and is read again',async()=>{
  const {root,file}=await fixture();
  try{
    let locked=true;
    const db=new SkinDatabase({root:path.join(root,'Custom Skins'),champions:[{id:'MonkeyKing',name:'Wukong'}],io:{open:async(name,options)=>{
      if(locked)throw Object.assign(new Error('EBUSY: resource busy or locked, open'),{code:'EBUSY',syscall:'open'});
      return (await import('yauzl')).default.openPromise(name,options);
    }}});
    const held=(await db.list('Wukong')).skins[0];
    assert.equal(held.broken,false);
    assert.equal(held.name,path.basename(file,'.fantome'));
    locked=false;
    const free=(await db.list('Wukong')).skins[0];
    assert.equal(free.broken,false);
    assert.equal(free.name,'Sun Wukong','the same size and date, read again');
  }finally{await clean(root);}
});

test('a mod is judged by its own format: a zip by being one, a .modpkg by its reader (10.1)',async()=>{
  const {root}=await fixture();
  try{
    const folder=path.join(root,'mods');await mkdir(folder);
    // A .modpkg is prepared from what src/modpkg.mjs reads, so one it cannot read could never load.
    await writeFile(path.join(folder,'Packed.modpkg'),Buffer.from('_modpkg_ is its own format'));
    await writeFile(path.join(folder,'Odd.fantome'),zip({'META/info.json':'{not json'}));
    const {skins}=await new SkinDatabase({root:folder,mode:'mods'}).list('');
    assert.deepEqual(skins.map(skin=>[skin.name,skin.broken]),[['Odd',false],['Packed',true]]);
  }finally{await clean(root);}
});

test('a custom skin whose metadata cannot be read is broken, as it could not be prepared',async()=>{
  const {root,file,db}=await fixture();
  try{
    await writeFile(path.join(path.dirname(file),'Odd.fantome'),zip({'META/info.json':'{not json'}));
    assert.equal((await db.list('Wukong')).skins.find(skin=>skin.name==='Odd').broken,true);
  }finally{await clean(root);}
});

test('old pictures are let go past the budget and come back when listed',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-db-')),dbRoot=path.join(root,'Custom Skins');
  try{
    for(const champion of ['Ahri','Lux','Zed']){
      await mkdir(path.join(dbRoot,champion),{recursive:true});
      await writeFile(path.join(dbRoot,champion,'Skin.fantome'),zip({'META/info.json':JSON.stringify({Name:champion}),'META/image.png':Buffer.alloc(1000,champion.charCodeAt(0))}));
    }
    const db=new SkinDatabase({root:dbRoot,champions:[],imageBytes:2000});
    const hash=listed=>listed.skins[0].id.slice(3);
    const picture=id=>db.embeddedImage(id)?.bytes.length||0;
    const ahri=hash(await db.list('Ahri')),lux=hash(await db.list('Lux'));
    assert.equal(picture(ahri),1000);assert.equal(picture(lux),1000);
    await db.list('Ahri');// used again: Lux is now the oldest
    const zed=hash(await db.list('Zed'));
    assert.equal(picture(zed),1000,'what was just listed is never let go');
    assert.equal(picture(ahri),1000);
    assert.equal(picture(lux),0);
    const back=await db.list('Lux');
    assert.match(back.skins[0].image,/^friloverse-icon:/);
    assert.equal(picture(lux),1000);
  }finally{await clean(root);}
});

test('a version at the end of a file name is dropped, also after an underscore',async()=>{
  const source=await readFile(new URL('../src/skin-database.mjs',import.meta.url),'utf8');
  const code=/function nameFromFile\(file\)\{.+\}/.exec(source)[0];
  const nameFromFile=new Function('path',`${code};return nameFromFile;`)(path);
  assert.equal(nameFromFile('Star_Guardian_v1.2.fantome'),'Star Guardian');
  assert.equal(nameFromFile('Star_Guardian-v2.modpkg'),'Star Guardian');
  assert.equal(nameFromFile('Plain Name.fantome'),'Plain Name');
});
