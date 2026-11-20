import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {championFromDraft,championFromGameflow,customFromSession,guideReady,guideTarget,mapFromSession,modeForQueue,nextSighting,queueFromSession} from '../src/guide-match.mjs';
import {GuideWatcher} from '../src/guide-lcu.mjs';
import {MayhemData,buildDate} from '../src/guide-data.mjs';
import {parseMayhemBuild} from '../src/ui/guide/mayhem-data.mjs';
import {saveMayhemGuide} from '../src/ui/guide/mayhem-cache.mjs';
import {parseShortcut,shortcutFromEvent,systemHotkeyWord} from '../src/guide-shortcut.mjs';

const champions=[{key:'103',name:'Ahri'},{key:'145',name:"Kai'Sa"}];
const picked=id=>({localPlayerCellId:2,myTeam:[{cellId:1,championId:103},{cellId:2,championId:id}]});
test('the League queue and map select the correct source and champion slug',()=>{
  for(const [queue,mode] of [[1700,'arena'],[1740,'arena'],[2400,'mayhem'],[3280,'mayhem'],[450,'aram'],[900,'aram'],[420,'rift'],[3140,'rift']])assert.equal(modeForQueue(queue),mode);
  assert.equal(modeForQueue(12345),null);
  assert.equal(queueFromSession({gameData:{queue:{id:3280}}}),3280);
  assert.equal(mapFromSession({gameData:{map:{id:12}}}),12);
  assert.equal(championFromDraft(picked(145)),145);
  assert.equal(championFromDraft({myTeam:[{championId:145}]}),null);
  const draft=(done,extra={})=>({...picked(145),actions:[[{actorCellId:2,type:'ban',championId:1,completed:true}],[{actorCellId:1,type:'pick',championId:103,completed:true},{actorCellId:2,type:'pick',championId:145,completed:done}]],...extra});
  assert.equal(championFromDraft(draft(false)),null,'selected but not locked in');
  assert.equal(championFromDraft(draft(true)),145,'locked in');
  assert.equal(championFromDraft(draft(false,{timer:{phase:'FINALIZATION'}})),145,'the draft is over, so every pick is final');
  assert.equal(championFromDraft({...picked(145),actions:[]}),145,'League assigned it (ARAM)');
  assert.equal(championFromDraft({...draft(true),myTeam:[{cellId:1,championId:103},{cellId:2,championId:64}]}),64,'a swap after the lock-in is followed');
  assert.equal(nextSighting({phase:'ChampSelect',mode:'rift',champion:null},{phase:'ChampSelect',queue:420,draft:draft(false)}).champion,null,'selecting a champion is not seen');
  for(const [mode,fragment] of [['mayhem','friloverse-guide://local/mayhem.html?champion=145'],['arena','/lol/arena/champions/kaisa/build'],['aram','/lol/aram/champions/kaisa/build'],['rift','/lol/champions/kaisa/build']]){
    const result=guideTarget({phase:'InProgress',champion:145,mode},champions);
    assert.ok(result.url.includes(fragment));
  }
  assert.equal(guideTarget({phase:'ChampSelect',champion:145,mode:'rift'},champions),null);
  assert.equal(guideTarget({phase:'InProgress',champion:145,mode:null},champions),null);
  assert.equal(guideTarget({phase:'InProgress',champion:145,mode:'unknown'},champions),null);
  assert.equal(guideTarget({phase:'InProgress',champion:9999,mode:'rift'},champions),null);
});
test('client-loss expiry uses elapsed time even when reads are slow',async()=>{
  let now=0,online=true,seen;
  const watcher=new GuideWatcher(value=>seen=value,{
    now:()=>now,readConnection:async()=>{if(!online)throw Error('offline');return {};},
    request:async(_client,endpoint)=>endpoint.endsWith('gameflow-phase')?'Lobby':null
  });
  await watcher.poll();assert.equal(seen.phase,'Lobby');
  online=false;now=100;await watcher.poll();now=10099;await watcher.poll();
  assert.equal(seen.phase,'Lobby');now=10100;await watcher.poll();assert.equal(seen.phase,'');
  watcher.stop();
});

test('an active match sighting survives a long outage and follows the first recovered phase',async()=>{
  for(const phase of ['ChampSelect','GameStart','InProgress','Reconnect','WaitingForStats','PreEndOfGame']){
    let now=1000,online=false,nextPhase='Lobby';
    const watcher=new GuideWatcher(()=>{},{now:()=>now,
      readConnection:async()=>{if(!online)throw Error('offline');return {};},
      request:async(_,endpoint)=>endpoint.endsWith('gameflow-phase')?nextPhase:null,
    });
    watcher.sighting={phase,champion:103,mode:'aram'};
    assert.equal(watcher.connected,true);
    await watcher.poll();now+=60000;await watcher.poll();
    assert.equal(watcher.connected,false,'keeping the match does not claim the client is connected');
    assert.deepEqual(watcher.sighting,{phase,champion:103,mode:'aram'});
    online=true;now+=2000;await watcher.poll();
    assert.equal(watcher.connected,true);
    assert.deepEqual(watcher.sighting,{phase:'Lobby',champion:null,mode:null});
    watcher.stop();
  }
});
test('draft swaps and incomplete readings do not reuse the wrong mode or champion',()=>{
  let sighting=nextSighting({phase:'Lobby',mode:null,champion:null},{phase:'ChampSelect',queue:3280,map:12,draft:picked(103)});
  sighting=nextSighting(sighting,{phase:'ChampSelect',queue:null,map:12,draft:picked(145)});
  assert.deepEqual(sighting,{phase:'ChampSelect',mode:'mayhem',champion:145});
  sighting=nextSighting(sighting,{phase:'GameStart',queue:null,map:12,draft:null});
  assert.equal(sighting.mode,'mayhem');assert.equal(sighting.champion,145);assert.ok(guideReady(sighting));
  sighting=nextSighting(sighting,{phase:'InProgress',queue:null,map:null,draft:{}});
  assert.equal(sighting.champion,145);
  sighting=nextSighting(sighting,{phase:'Reconnect',queue:null,map:null,draft:null});
  assert.equal(guideReady(sighting),true);
  assert.ok(guideTarget(sighting,champions),'Reconnect keeps the same guide available');
  sighting=nextSighting(sighting,{phase:'Lobby'});
  assert.deepEqual(sighting,{phase:'Lobby',mode:null,champion:null});
  sighting=nextSighting(sighting,{phase:'ChampSelect',queue:3220,map:12,custom:true,draft:picked(103)});
  assert.equal(sighting.mode,'aram');
  // A moment without a champion keeps it; longer, and it really has none.
  const empty={phase:'ChampSelect',queue:3220,map:12,custom:true,draft:picked(0)};
  sighting=nextSighting(sighting,{...empty,now:1000});
  assert.equal(sighting.champion,103);assert.equal(sighting.lostAt,1000);
  sighting=nextSighting(sighting,{...empty,now:2500});
  assert.equal(sighting.champion,103);assert.equal(sighting.lostAt,1000);
  const back=nextSighting(sighting,{...empty,draft:picked(103),now:2600});
  assert.equal(back.champion,103);assert.equal('lostAt' in back,false);
  sighting=nextSighting(sighting,{...empty,now:3000});
  assert.equal(sighting.champion,null);assert.equal('lostAt' in sighting,false);
  assert.equal(nextSighting(sighting,{...empty,now:3300}).champion,null);
});

test('an unknown queue on the ARAM map is not guessed to be standard ARAM',()=>{
  const previous={phase:'Lobby',mode:null,champion:null};
  const reading={phase:'ChampSelect',queue:99999,map:12,draft:picked(103)};
  assert.equal(nextSighting(previous,reading).mode,null);
  assert.equal(nextSighting(previous,{...reading,custom:true}).mode,'aram');
  assert.equal(customFromSession({gameData:{isCustomGame:true}}),true);
  assert.equal(customFromSession({gameData:{isCustomGame:false}}),false);
  const mayhem={phase:'ChampSelect',mode:'mayhem',champion:103};
  assert.equal(nextSighting(mayhem,{phase:'GameStart',queue:null,map:12}).mode,'mayhem');
});
test('joining mid-match recovers only the local player and rejects conflicting picks',async()=>{
  const player={puuid:'abc-123',summonerId:17};
  const session={gameData:{queueId:450,teamOne:[{puuid:'other-999',championId:145},{puuid:'abc-123',championId:103}]}};
  assert.equal(championFromGameflow(session,player),103);
  assert.equal(championFromGameflow(session,{}),null);
  assert.equal(championFromGameflow({gameData:{teamOne:[{puuid:'abc-123',championId:103},{puuid:'abc-123',championId:145}]}},player),null);
  const replies={'/lol-gameflow/v1/gameflow-phase':'InProgress','/lol-gameflow/v1/session':session,'/lol-summoner/v1/current-summoner':player};
  let seen;
  const watcher=new GuideWatcher(value=>seen=value,{readConnection:async()=>({}),request:async(_,endpoint)=>{if(!(endpoint in replies))throw Error('missing');return replies[endpoint];}});
  await watcher.poll();assert.deepEqual(seen,{phase:'InProgress',mode:'aram',champion:103});
  watcher.stop();
});

test('each new draft has an identity even if the main poll misses the intervening lobby',async()=>{
  let phase='ChampSelect';
  const watcher=new GuideWatcher(()=>{},{readConnection:async()=>({}),
    request:async(_,endpoint)=>endpoint.endsWith('gameflow-phase')?phase:null});
  await watcher.poll();assert.equal(watcher.draftId,1);
  await watcher.poll();assert.equal(watcher.draftId,1);
  phase='Lobby';await watcher.poll();
  phase='ChampSelect';await watcher.poll();assert.equal(watcher.draftId,2);
  watcher.stop();
});

test('starting Friloverse on Reconnect recovers the champion from the current match',async()=>{
  const replies={'/lol-gameflow/v1/gameflow-phase':'Reconnect',
    '/lol-gameflow/v1/session':{gameData:{queueId:450,teamOne:[{summonerId:17,championId:103}]}},
    '/lol-summoner/v1/current-summoner':{summonerId:17}};
  const watcher=new GuideWatcher(()=>{},{readConnection:async()=>({}),request:async(_,endpoint)=>replies[endpoint]??null});
  await watcher.poll();assert.equal(watcher.sighting.champion,103);assert.equal(watcher.sighting.phase,'Reconnect');
  watcher.stop();
});
test('Mayhem uses the real source format, caches it, and rejects stale or invalid data',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-guide-'));
  try{
    const build=JSON.parse(await readFile(new URL('./fixtures/mayhem-annie.json',import.meta.url)));
    const rankings=JSON.parse(await readFile(new URL('./fixtures/mayhem-rankings.json',import.meta.url)));
    let now=1800000000,online=true,calls=[];
    const data=new MayhemData(dir,{now:()=>now,fetch:async url=>{
      calls.push(url);if(!online)throw Error('offline');
      return url.includes('fuwen_aram_hero_rank_v2')?rankings:build;
    }});
    const first=await data.guide(1);
    assert.equal(first.rankingDate,'20261101');assert.equal(first.championId,1);
    assert.ok(parseMayhemBuild(first.build.value,1).augments.length>50);
    assert.equal(calls.length,2);
    await data.guide(1);assert.equal(calls.length,2);
    online=false;now+=1000;
    assert.equal((await data.guide(1)).build.stale,true);
    await assert.rejects(data.guide(2),/offline/);
    now+=8*86400;await assert.rejects(data.guide(1),/offline/);
    await assert.rejects(data.guide(60001),/valid champion/);
    assert.throws(()=>buildDate({dtstatdate:'20260231',itemone_json:'x'}),/invalid date/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('Mayhem rankings keep their date, and rankings of another day are not shown',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-guide-'));
  try{
    const build=JSON.parse(await readFile(new URL('./fixtures/mayhem-annie.json',import.meta.url)));
    let day='20261101';
    const data=new MayhemData(dir,{now:()=>1800000000,fetch:async url=>url.includes('fuwen_aram_hero_rank_v2')
      ?{listcollect:'1_1_x_0.5447_0.1382_extra',dtstatdate:day}:build});
    const same=await data.guide(1,true);
    assert.deepEqual(same.rankings.value,{listcollect:'1_1_x_0.5447_0.1382',dtstatdate:'20261101'});
    assert.deepEqual(same.notices,[]);
    day='20261031';
    const other=await data.guide(1,true);
    assert.equal(other.rankings,null);
    assert.match(other.notices[0],/rankings are temporarily unavailable/);
    const storage=new Map();
    saveMayhemGuide({setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)??null},same);
    assert.equal(JSON.parse([...storage.values()][0]).entries[0].rankings.value.dtstatdate,'20261101','the saved copy keeps it too');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('key capture accepts combinations and rejects malformed or held input',()=>{
  assert.equal(shortcutFromEvent({code:'KeyG',ctrlKey:true,shiftKey:true}),'Ctrl+Shift+KeyG');
  assert.equal(shortcutFromEvent({code:'F1',repeat:true}),null);
  assert.deepEqual(parseShortcut('Ctrl+KeyG'),{key:71,modifiers:['Ctrl'],accelerator:'Ctrl+G'});
  assert.equal(parseShortcut('Ctrl+Ctrl+F1'),null);
  assert.equal(parseShortcut('nope'),null);
  assert.equal(systemHotkeyWord(parseShortcut('F1')),0x70);
  assert.equal(systemHotkeyWord(parseShortcut('Ctrl+Alt+F1')),0x670);
  assert.equal(systemHotkeyWord(parseShortcut('Super+F1')),null);
  assert.equal(systemHotkeyWord(parseShortcut('Ctrl+KeyG')),null);
});

test('a lockfile left by a crash does not hide the running client',async()=>{
  const {leagueConnection}=await import('../src/league-client.mjs');
  const appData='C:/data',ltk='D:/Old League',riot='C:/Riot Games/League of Legends';
  const files={
    [path.join(appData,'dev.leaguetoolkit.manager','settings.json')]:JSON.stringify({leaguePath:ltk}),
    [path.join(ltk,'lockfile')]:'LeagueClient:1:1111:stale:https',
    [path.join(riot,'lockfile')]:'LeagueClient:2:2222:fresh:https'
  };
  const read=async file=>{if(file in files)return files[file];throw new Error('missing');};
  const at={[path.join(ltk,'lockfile')]:100,[path.join(riot,'lockfile')]:900};
  assert.deepEqual(await leagueConnection({appData,read,modified:async file=>at[file]}),{port:2222,password:'fresh'});
  at[path.join(ltk,'lockfile')]=1000;
  assert.deepEqual(await leagueConnection({appData,read,modified:async file=>at[file]}),{port:1111,password:'stale'});
  await assert.rejects(leagueConnection({appData,read:async()=>{throw new Error('none');},modified:async()=>0}),/unavailable/);
});
