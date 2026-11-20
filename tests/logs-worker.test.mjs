import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{claimCode} from '../logs-worker/src/worker.mjs';

/** An in-memory R2 bucket that keeps R2's create-only rule and lets other requests in between calls. */
function bucket(){
  const objects=new Map(),turn=()=>new Promise(resolve=>setImmediate(resolve));
  return {objects,
    async head(key){await turn();return objects.has(key)?{key}:null;},
    async put(key,value,options={}){
      await turn();
      const onlyIf=options.onlyIf instanceof Headers?options.onlyIf:null;
      if(onlyIf?.get('If-None-Match')==='*'&&objects.has(key))return null;
      objects.set(key,{value,customMetadata:options.customMetadata});
      return {key};
    },
    async delete(key){objects.delete(key);},
  };
}
const report=()=>new Request('https://logs.example/reports',{method:'POST',
  headers:{'x-friloverse-version':'10.5.0','x-friloverse-name':'Frilo'},body:new Uint8Array([0x50,0x4b,3,4,...new Uint8Array(30)])});

test('two reports that draw the same code at the same moment get different codes',async()=>{
  const LOGS=bucket();
  // Both draw AAAA first; whoever loses the claim draws again.
  const draws=()=>{const queue=['AAAA','BBBB'];return ()=>queue.shift()||'CCCC';};
  const [one,two]=await Promise.all([claimCode(LOGS,code=>`one-${code}`,draws()),claimCode(LOGS,code=>`two-${code}`,draws())]);
  assert.notEqual(one.code,two.code);
  assert.equal(LOGS.objects.get(`codes/${one.code}`).value,one.key);
  assert.equal(LOGS.objects.get(`codes/${two.code}`).value,two.key);
});

test('a code a report already holds is never given out again',async()=>{
  const LOGS=bucket();LOGS.objects.set('codes/AAAA',{value:'old.zip'});
  const draws=['AAAA','BBBB'];
  const {code}=await claimCode(LOGS,drawn=>`new-${drawn}`,()=>draws.shift());
  assert.equal(code,'BBBB');
  assert.equal(LOGS.objects.get('codes/AAAA').value,'old.zip');
});

test('each report sent at once finds its own report by its code',async()=>{
  const LOGS=bucket(),env={LOGS};
  const answers=await Promise.all(Array.from({length:8},()=>worker.fetch(report(),env).then(response=>response.json())));
  assert.equal(new Set(answers.map(answer=>answer.code)).size,8);
  for(const {code,key} of answers){
    assert.equal(LOGS.objects.get(`codes/${code}`).value,key);
    assert.ok(LOGS.objects.has(key));
  }
});

test('a report that could not be stored gives its code back',async()=>{
  const LOGS=bucket(),put=LOGS.put;
  LOGS.put=async(key,...rest)=>{if(key.endsWith('.zip'))throw new Error('R2 is down');return put(key,...rest);};
  await assert.rejects(worker.fetch(report(),{LOGS}),/R2 is down/);
  assert.equal([...LOGS.objects.keys()].length,0);
});

// 12.9: Divine downloads, one record per skin, nothing about the player.
const download=(body,headers={'x-friloverse-version':'12.9.0'})=>new Request('https://logs.example/divine-downloads',{method:'POST',headers,body:JSON.stringify(body)});
const row={route:'/Frog/iron-darius',champion:'Darius',file:'iron-darius-v1.0.0.fantome',size:36658102,sha:'a'.repeat(40)};
function records(){
  const objects=new Map();
  return {objects,async get(key){return objects.has(key)?{json:async()=>JSON.parse(objects.get(key))}:null;},async put(key,value){objects.set(key,value);}};
}

test('each Divine download counts once on its skin record, and a new file version is listed first',async()=>{
  const DOWNLOADS=records(),env={DOWNLOADS};
  assert.equal((await worker.fetch(download(row),env)).status,200);
  assert.equal((await worker.fetch(download({...row,file:'Iron Darius.fantome'}),env)).status,200);
  const reworked=await worker.fetch(download({...row,sha:'b'.repeat(40),size:5}),env);
  assert.deepEqual(await reworked.json(),{ok:true,count:3});
  const saved=JSON.parse(DOWNLOADS.objects.get('skins/frog/iron-darius.json'));
  assert.equal(saved.url,'https://divineskins.gg/Frog/iron-darius');
  assert.equal(saved.champion,'Darius');
  assert.equal(saved.added,false);
  assert.deepEqual(saved.files.map(file=>file.sha[0]),['b','a']);
  assert.equal(saved.files[1].file,'Iron Darius.fantome');
  assert.ok(!JSON.stringify(saved).includes('cf-connecting-ip'));
});

test('the owner\'s added mark survives later downloads',async()=>{
  const DOWNLOADS=records();
  DOWNLOADS.objects.set('skins/frog/iron-darius.json',JSON.stringify({count:4,added:true,firstSeen:'2026-11-01T00:00:00.000Z',files:[]}));
  await worker.fetch(download(row),{DOWNLOADS});
  const saved=JSON.parse(DOWNLOADS.objects.get('skins/frog/iron-darius.json'));
  assert.equal(saved.count,5);assert.equal(saved.added,true);assert.equal(saved.firstSeen,'2026-11-01T00:00:00.000Z');
});

test('only a Friloverse download of a Divine skin page is kept',async()=>{
  const DOWNLOADS=records(),env={DOWNLOADS};
  assert.equal((await worker.fetch(download(row,{}),env)).status,400);
  for(const bad of [{route:'/mods/lol'},{route:'/download/Frog/iron-darius'},{route:'/a/../b'},{champion:'<b>'},{size:0},{sha:'xyz'},{file:''}])
    assert.equal((await worker.fetch(download({...row,...bad}),env)).status,400,JSON.stringify(bad));
  assert.equal((await worker.fetch(new Request('https://logs.example/divine-downloads'),env)).status,405);
  assert.equal(DOWNLOADS.objects.size,0);
});
