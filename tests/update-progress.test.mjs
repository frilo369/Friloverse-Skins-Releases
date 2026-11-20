import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile,appendFile,utimes} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expectedDownloads,releaseEntries,releaseEntry,watchUpdateDownload} from '../src/update-progress.mjs';
import {finishReleases,parseReleases,prepareDelta,previousBuild} from '../scripts/release-feed.mjs';

// A 6.4 release as release-feed.mjs writes it: the full package by name, deltas by address.
const H=c=>c.repeat(40);
const DELTA_RELEASES=[`${H('A')} friloverse-skins-6.4.0-full.nupkg 150000000`,
  `${H('B')} https://github.com/frilo369/Friloverse-Skins-Releases/releases/download/v6.3.0/friloverse-skins-6.3.0-delta.nupkg 2000000`,
  `${H('C')} https://github.com/frilo369/Friloverse-Skins-Releases/releases/download/v6.4.0/friloverse-skins-6.4.0-delta.nupkg 3000000`].join('\r\n');

test('the bar follows what Squirrel downloads: deltas when they cover the gap, else the full package',()=>{
  const rows=releaseEntries(DELTA_RELEASES);
  assert.deepEqual(expectedDownloads(rows,'6.3.0').map(row=>row.name),['friloverse-skins-6.4.0-delta.nupkg']);
  assert.deepEqual(expectedDownloads(rows,'6.2.0').map(row=>row.name),['friloverse-skins-6.3.0-delta.nupkg','friloverse-skins-6.4.0-delta.nupkg']);
  assert.deepEqual(expectedDownloads(rows,'6.4.0'),[]);
  // Deltas bigger than the full package: the full package.
  assert.deepEqual(expectedDownloads(releaseEntries(`${H('A')} x-2.0.0-full.nupkg 10\n${H('B')} x-2.0.0-delta.nupkg 50`),'1.0.0').map(row=>row.name),['x-2.0.0-full.nupkg']);
  assert.equal(releaseEntry(DELTA_RELEASES).name,'friloverse-skins-6.4.0-full.nupkg');
});

test('a release lists its full package first by name and the last deltas by address',async()=>{
  const dist=await mkdtemp(path.join(os.tmpdir(),'fv-feed-'));
  try{
    const old=path.join(dist,'6.3.0','setup'),now=path.join(dist,'6.4.0','setup');
    await mkdir(old,{recursive:true});await mkdir(now,{recursive:true});
    await writeFile(path.join(old,'RELEASES'),`${H('D')} friloverse-skins-6.3.0-full.nupkg 4\r\n${H('B')} https://github.com/frilo369/Friloverse-Skins-Releases/releases/download/v6.3.0/friloverse-skins-6.3.0-delta.nupkg 2`);
    await writeFile(path.join(old,'friloverse-skins-6.3.0-full.nupkg'),'full');
    const previous=await previousBuild(dist,'6.4.0');
    assert.equal(previous.version,'6.3.0');
    await prepareDelta(now,previous);
    assert.equal((await readFile(path.join(now,'RELEASES'),'utf8')),`${H('D')} friloverse-skins-6.3.0-full.nupkg 4`);
    // What Squirrel adds when it packs 6.4.
    await appendFile(path.join(now,'RELEASES'),`\r\n${H('C')} friloverse-skins-6.4.0-delta.nupkg 3\r\n${H('A')} friloverse-skins-6.4.0-full.nupkg 9`);
    const {delta}=await finishReleases(now,'6.4.0',{previous});
    assert.equal(delta.name,'friloverse-skins-6.4.0-delta.nupkg');
    const rows=parseReleases(await readFile(path.join(now,'RELEASES'),'utf8'));
    assert.deepEqual(rows.map(row=>row.file),['friloverse-skins-6.4.0-full.nupkg',
      'https://github.com/frilo369/Friloverse-Skins-Releases/releases/download/v6.3.0/friloverse-skins-6.3.0-delta.nupkg',
      'https://github.com/frilo369/Friloverse-Skins-Releases/releases/download/v6.4.0/friloverse-skins-6.4.0-delta.nupkg']);
    // The borrowed 6.3 package does not go up with 6.4.
    await assert.rejects(readFile(path.join(now,'friloverse-skins-6.3.0-full.nupkg')));
  }finally{await rm(dist,{recursive:true,force:true});}
});

// What update.electronjs.org really sends (6.2, 2026-11-08): the package by its whole address.
const FEED_RELEASES='\uFEFFE48148C43C1A098F45B066C1F69E2F3ACA522821 https://github.com/frilo369/Friloverse-Skins-Releases/releases/download/v6.2.0/friloverse-skins-6.2.0-full.nupkg 153509501';

test('the package name is the end of the address the feed lists',()=>{
  assert.deepEqual(releaseEntry(FEED_RELEASES),{name:'friloverse-skins-6.2.0-full.nupkg',size:153509501});
  assert.deepEqual(releaseEntry('E48148C43C1A098F45B066C1F69E2F3ACA522821 friloverse-skins-6.2.0-full.nupkg 10'),{name:'friloverse-skins-6.2.0-full.nupkg',size:10});
  // The full package wins over a delta.
  assert.equal(releaseEntry(`${'A'.repeat(40)} x-6.2.0-delta.nupkg 5\r\n${'B'.repeat(40)} https://h/x-6.2.0-full.nupkg?raw=1 9`).name,'x-6.2.0-full.nupkg');
  assert.equal(releaseEntry('nothing here'),null);
  assert.equal(releaseEntry(`${'A'.repeat(40)} https://h/..%2F..%2Fx.nupkg 5`),null);
});

test('a finished file left by an earlier attempt does not count as downloaded',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fv-update-'));
  const seen=[];let tick=null;
  try{
    const file=path.join(dir,'friloverse-skins-6.2.0-full.nupkg');
    await writeFile(file,Buffer.alloc(153509501>>12));
    const long=new Date(Date.now()-3600*1000);await utimes(file,long,long);
    const stop=watchUpdateDownload({feed:'https://feed/6.1.0',packagesDir:dir,every:10,
      fetchFn:async()=>new Response(FEED_RELEASES),onProgress:value=>seen.push(value),
      setTimer:fn=>{tick=fn;return 1;},clearTimer:()=>{tick=null;}});
    for(let i=0;i<50&&!tick;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(seen.at(-1).bytes,0);
    stop();
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('the bar follows the package as Squirrel writes it',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fv-update-'));
  const seen=[];let tick=null;
  try{
    const stop=watchUpdateDownload({feed:'https://feed/6.1.0',packagesDir:dir,every:10,
      fetchFn:async()=>new Response(FEED_RELEASES),onProgress:value=>seen.push(value),
      setTimer:fn=>{tick=fn;return 1;},clearTimer:()=>{tick=null;}});
    for(let i=0;i<50&&!tick;i++)await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(seen.at(-1),{bytes:0,total:153509501});
    const file=path.join(dir,'friloverse-skins-6.2.0-full.nupkg');
    await writeFile(file,Buffer.alloc(1000));tick();await new Promise(r=>setTimeout(r,30));
    assert.equal(seen.at(-1).bytes,1000);
    await appendFile(file,Buffer.alloc(4000));tick();await new Promise(r=>setTimeout(r,30));
    assert.equal(seen.at(-1).bytes,5000);
    stop();assert.equal(tick,null);
  }finally{await rm(dir,{recursive:true,force:true});}
});
