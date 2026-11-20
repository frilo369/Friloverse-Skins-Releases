import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,rm,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gitBlobHash} from '../src/git-blob.mjs';
import {pruneWithdrawn,withdrawnRows,withdrawnSkins} from '../src/withdrawn-skins.mjs';

async function library(){
  const root=await mkdtemp(path.join(tmpdir(),'friloverse-withdrawn-'));
  const write=async(relative,text)=>{const file=path.join(root,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text);return file;};
  return {root,write};
}

test('a withdrawn skin goes by its contents, whatever it is called, and nothing else does',async()=>{
  const {root,write}=await library();
  try{
    const broken=await write('Fiora/Renamed by the player.fantome','broken skin');
    const same=await write('Fiora/Mine.fantome','my own skin');
    const sized=await write('Talon/Same size.fantome','broken s1in');
    const other=await write('Talon/notes.txt','broken skin');
    const row={sha:await gitBlobHash(broken,11),size:11,name:'Broken'};
    const removed=await pruneWithdrawn({roots:[root,path.join(root,'missing')],rows:[row],remove:unlink});
    assert.deepEqual(removed,[broken]);
    assert.deepEqual((await readdir(path.join(root,'Fiora'))),['Mine.fantome']);
    assert.equal(await readFile(same,'utf8'),'my own skin');
    assert.equal(await readFile(sized,'utf8'),'broken s1in');
    assert.equal(await readFile(other,'utf8'),'broken skin');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('only a file of the right size is hashed, so a check costs almost nothing',async()=>{
  const {root,write}=await library();
  try{
    await write('A/one.fantome','12345');await write('A/two.fantome','1234567');
    const hashed=[];
    await pruneWithdrawn({roots:[root],rows:[{sha:'a'.repeat(40),size:5}],remove:unlink,hash:async file=>{hashed.push(path.basename(file));return 'b'.repeat(40);}});
    assert.deepEqual(hashed,['one.fantome']);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a file that cannot be removed now does not stop the rest, and is tried again later',async()=>{
  const {root,write}=await library();
  try{
    const first=await write('A/one.fantome','same');const second=await write('B/two.fantome','same');
    const row={sha:await gitBlobHash(first,4),size:4};
    const removed=await pruneWithdrawn({roots:[root],rows:[row],remove:async file=>{if(file===first)throw new Error('in use');await unlink(file);}});
    assert.deepEqual(removed,[second]);
    assert.deepEqual(await pruneWithdrawn({roots:[root],rows:[row],remove:unlink}),[first]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the app carries the removed skins itself, and adds what GitHub says',async()=>{
  const live={sha:'c'.repeat(40),size:9,name:'Newly removed'};
  const rows=await withdrawnSkins({fetchFn:async url=>({ok:url.includes('Custom-Skins-2'),json:async()=>({removed:[live]})})});
  assert.ok(rows.some(row=>row.name==='Blood Queen Fiora'&&row.sha==='f7ff45db39ada819b281f884c8f7fecb3238d1ae'));
  assert.ok(rows.some(row=>row.name==='Demon of Lightning Talon'&&row.sha==='3424c589461f194a5c5385aead316283c190a64b'));
  assert.ok(rows.includes(live));
});

test('GitHub out of reach only leaves the list the app carries, and a damaged list names nothing',async()=>{
  const rows=await withdrawnSkins({fetchFn:async()=>{throw new Error('offline');}});
  assert.equal(rows.length,2);
  assert.deepEqual(withdrawnRows({removed:[{sha:'not a hash',size:1},{sha:'a'.repeat(40)},null]}),[]);
  assert.deepEqual(withdrawnRows('nonsense'),[]);
});
