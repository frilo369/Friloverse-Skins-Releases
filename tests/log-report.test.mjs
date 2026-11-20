import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import {gamesStart,linesSince,zipFiles,collectReport,sendReport} from '../src/log-report.mjs';

const hold=[
  '2026-11-08T01:00:00.000Z guard started',
  '2026-11-08T01:00:30.000Z guard: suspended 1 created 1',
  '2026-11-08T02:00:00.000Z guard started',
  '2026-11-08T02:00:30.000Z guard: closed',
  '2026-11-08T03:00:00.000Z guard started',
  '2026-11-08T03:00:40.000Z guard: suspended 2 created 2',
  '2026-11-08T04:00:00.000Z guard started',
  '2026-11-08T04:00:20.000Z guard could not freeze the game',
  '2026-11-08T05:00:00.000Z guard started',
  '2026-11-08T05:00:20.000Z guard: suspended 3 created 3',
].join('\n');

test('the last three games start with the draft before each, less two minutes', () => {
  // A dodge (no freeze) is not a game.
  assert.equal(gamesStart(hold),Date.parse('2026-11-08T03:00:00.000Z')-120000);
  assert.equal(gamesStart(hold,{games:1}),Date.parse('2026-11-08T05:00:00.000Z')-120000);
  assert.equal(gamesStart(hold,{games:9}),Date.parse('2026-11-08T01:00:00.000Z')-120000);
});

test('with no game yet, the last day is sent', () => {
  const now=Date.parse('2026-11-08T05:00:00Z');
  assert.equal(gamesStart('',{now}),now-24*3600*1000);
});

test('lines with no time of their own stay with the line before', () => {
  const text='2026-11-08T01:00:00Z old\n  old trace\n2026-11-08T03:00:00.5Z new\n  new trace\n';
  assert.equal(linesSince(text,Date.parse('2026-11-08T02:00:00Z')),'2026-11-08T03:00:00.5Z new\n  new trace\n');
  assert.equal(linesSince(text,Date.parse('2026-11-09T00:00:00Z')),'');
});

async function unzip(buffer){
  const zip=await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true},(error,file)=>error?reject(error):resolve(file)));
  const files={};
  await new Promise((resolve,reject)=>{
    zip.on('entry',entry=>zip.openReadStream(entry,(error,stream)=>{
      if(error)return reject(error);
      const chunks=[];stream.on('data',chunk=>chunks.push(chunk));stream.on('end',()=>{files[entry.fileName]=Buffer.concat(chunks).toString('utf8');zip.readEntry();});
    }));
    zip.on('end',resolve);zip.on('error',reject);zip.readEntry();
  });
  return files;
}

test('the zip is deflated and reads back whole', async () => {
  const long='2026-11-08T03:00:00Z the same line again\n'.repeat(5000);
  const zip=zipFiles([{name:'a.log',bytes:long},{name:'ltk/b.log',bytes:Buffer.from('b')}]);
  assert.ok(zip.length<long.length/10);
  assert.deepEqual(await unzip(zip),{'a.log':long,'ltk/b.log':'b'});
});

test('a report holds the last games of every log and a summary', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'fv-logs-'));
  try{
    const data=path.join(root,'data'),ltk=path.join(root,'ltk');
    await mkdir(path.join(ltk,'logs'),{recursive:true});await mkdir(data,{recursive:true});
    await writeFile(path.join(data,'hold.log'),hold);
    await writeFile(path.join(data,'errors.log'),'2026-11-08T00:00:00Z 5.5.0 too old\n2026-11-08T03:30:00Z 5.5.0 panel: Ahri: open\n');
    await writeFile(path.join(ltk,'logs','ltk-manager.2026-11-08.log'),'2026-11-08T02:00:00Z INFO before\n2026-11-08T05:00:21Z INFO overlay verified 1 wad(s)\n');
    const {files}=await collectReport({dataDir:data,ltkDir:ltk,now:Date.parse('2026-11-08T05:10:00Z'),summary:{version:'6.0.0'},note:'no skin'});
    const byName=Object.fromEntries(files.map(file=>[file.name,file.bytes.toString()]));
    assert.equal(byName['friloverse-errors.log'],'2026-11-08T03:30:00Z 5.5.0 panel: Ahri: open\n');
    assert.match(byName['ltk/ltk-manager.2026-11-08.log'],/^2026-11-08T05:00:21Z INFO overlay verified/);
    assert.doesNotMatch(byName['ltk/ltk-manager.2026-11-08.log'],/before/);
    assert.match(byName['friloverse-hold.log'],/^2026-11-08T03:00:00.000Z guard started/);
    const summary=JSON.parse(byName['summary.json']);
    assert.equal(summary.note,'no skin');assert.equal(summary.version,'6.0.0');assert.equal(summary.from,'2026-11-08T02:58:00.000Z');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('sending returns the code, and a refusal comes back in words', async () => {
  let sent;
  const ok=async(url,options)=>{sent={url,options};return new Response(JSON.stringify({code:'ABC234'}),{status:200});};
  assert.equal(await sendReport({zip:Buffer.from('PK'),version:'6.0.0',name:'Frilo',fetchFn:ok,endpoint:'https://x/reports'}),'ABC234');
  assert.equal(sent.options.headers['x-friloverse-version'],'6.0.0');
  const busy=async()=>new Response(JSON.stringify({error:'Logs were just sent from this PC. Try again in a minute.'}),{status:429});
  await assert.rejects(sendReport({zip:Buffer.from('PK'),version:'6.0.0',fetchFn:busy}),/just sent/);
  const down=async()=>{throw new Error('ECONNREFUSED');};
  await assert.rejects(sendReport({zip:Buffer.from('PK'),version:'6.0.0',fetchFn:down}),/no connection/);
});

test('a name a request header cannot carry does not stop the report',async()=>{
  const headers=[];
  const service=async(url,options)=>{headers.push(new Headers(options.headers));return new Response(JSON.stringify({code:'ABC234'}),{status:200});};
  assert.equal(await sendReport({zip:Buffer.from('PK'),version:'6.0.0',name:'Şen_Frilo',fetchFn:service,endpoint:'https://x/reports'}),'ABC234');
  assert.equal(await sendReport({zip:Buffer.from('PK'),version:'6.0.0',name:'Фрило',fetchFn:service,endpoint:'https://x/reports'}),'ABC234');
  assert.equal(await sendReport({zip:Buffer.from('PK'),version:'6.0.0',name:'two\r\nlines',fetchFn:service,endpoint:'https://x/reports'}),'ABC234');
  assert.deepEqual(headers.map(row=>row.get('x-friloverse-name')),['en_Frilo','','twolines']);
});

test('a report leaves the Windows account out of paths, however they are spelled',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'friloverse-report-'));
  try{
    const now=Date.parse('2026-11-08T05:01:00Z'),at='2026-11-08T05:00:00.000Z';
    await writeFile(path.join(dir,'hold.old.log'),`2026-11-08T04:00:00.000Z guard started\n2026-11-08T04:00:20.000Z guard: suspended 1 created 1\n`);
    await writeFile(path.join(dir,'hold.log'),`${at} guard started\n${at} guard: suspended 2 created 2\n${at} C:\\Users\\Ann Lee\\AppData\\x.log\n`);
    await writeFile(path.join(dir,'errors.log'),`${at} {"file":"C:\\\\Users\\\\Ann Lee\\\\a"} D:/Users/Ann Lee/b\n`);
    const {files}=await collectReport({dataDir:dir,ltkDir:path.join(dir,'none'),now,note:'C:\\Users\\Ann Lee\\note'});
    const all=files.map(file=>String(file.bytes)).join('\n');
    assert.doesNotMatch(all,/Ann Lee/);
    assert.match(all,/C:\\Users\\<user>\\AppData/);
    assert.match(all,/C:\\\\Users\\\\<user>\\\\a/);
    assert.match(all,/D:\/Users\/<user>\/b/);
    const hold=String(files.find(file=>file.name==='friloverse-hold.log').bytes);
    assert.match(hold,/suspended 1 created 1/,'a game on the far side of a log move is still sent');
    assert.match(hold,/suspended 2 created 2/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
