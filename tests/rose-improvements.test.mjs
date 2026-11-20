import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';

import {parseLtkLogLines,checkLtkBuiltins,LtkLogTail} from '../src/ltk-log-tail.mjs';
import {DiagnosticsStore} from '../src/diagnostics-state.mjs';
import {SkinHistory} from '../src/skin-history.mjs';
import {isGlobalIp,parseDohAnswer,connectWithFailover,clearPreferredAddresses} from '../src/party-transport.mjs';
import {sanitizeReportText,collectReport} from '../src/log-report.mjs';
import {isRateLimitResponse,limitedError,RateLimitGuard} from '../src/github-refs.mjs';
import {swiftplaySlotsFromLobby,isLobbyPickLobby,modeForQueue} from '../src/guide-match.mjs';
import {parseClientCmdline,draftLaunchImminent} from '../src/league-client.mjs';
import {GuideWatcher} from '../src/guide-lcu.mjs';
import {subcharactersOf,formRecordsOf} from '../src/champion-subcharacters.mjs';
import {parseBin,writeBin,writeZip} from '../src/skin-slots.mjs';
import {readValue} from '../src/bin-values.mjs';
import {decodeMsgpack} from '../src/modpkg.mjs';
import {inspectDownload} from '../src/divine-skins.mjs';
import {DraftVisibility,nextView} from '../src/model.mjs';
import {GameHold} from '../src/game-hold.mjs';
import {SkinEngine} from '../src/engine.mjs';
import {PartyCoordinator} from '../src/party-coordinator.mjs';
import {buildCustomSkinCopy} from '../src/custom-skin-compat.mjs';
import {writeWad} from '../src/skin-slots.mjs';
import {writeAtomic} from '../src/atomic-file.mjs';

const require=createRequire(import.meta.url);
const winAcct=require('../src/windows-account.cjs');

async function withDir(run){
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-rose-'));
  try{return await run(dir);}finally{await rm(dir,{recursive:true,force:true});}
}

test('windows-account strips RUNASADMIN while keeping other compat tokens and detects HKLM/LTK/League flags',async()=>{
  assert.equal(winAcct.withoutRunAsAdmin('~ RUNASADMIN HIGHDPIAWARE'),'~ HIGHDPIAWARE');
  assert.equal(winAcct.withoutRunAsAdmin('~ RUNASADMIN'),'');
  assert.equal(winAcct.withoutRunAsAdmin('RUNASADMIN'),'');
  const calls=[];
  const mockExec=async(_cmd,args)=>{
    calls.push(args);
    const key=args[1]||'';
    if(args[0]==='query'&&key.startsWith('HKCU\\')){
      return {stdout:'    C:\\App\\ltk_launcher.exe    REG_SZ    ~ RUNASADMIN HIGHDPIAWARE\r\n'};
    }
    if(args[0]==='query'&&key.startsWith('HKLM\\')){
      return {stdout:'    C:\\Program Files\\LTK Manager\\ltk-manager.exe    REG_SZ    ~ RUNASADMIN\r\n    C:\\Riot Games\\League of Legends\\LeagueClient.exe    REG_SZ    RUNASADMIN\r\n'};
    }
    return {stdout:''};
  };
  if(process.platform==='win32'){
    const res=await winAcct.checkLtkAndLauncherSettings({launcherPath:'C:\\App\\ltk_launcher.exe',exec:mockExec});
    assert.equal(res.clearedLauncher,true);
    assert.ok(calls.some(a=>a[0]==='add'&&a.includes('~ HIGHDPIAWARE')),'preserved other compat flags while removing RUNASADMIN');
    assert.ok(res.issues.some(i=>i.code==='LTK_ELEVATED'));
    const league=await winAcct.checkLeagueElevation({pid:0,exec:mockExec});
    assert.ok(league.issues.some(i=>i.code==='LEAGUE_ELEVATED'));
  }
});

test('LtkLogTail parses VRF, overlay refusals, late joins, broken mod entries, and heavy builtins',()=>withDir(async dir=>{
  const sample=[
    '[ltk-dll] ltk_patcher_dll::verify: overlay verified 2 wad(s)',
    '[ltk-dll] ltk_patcher_dll::verify: host verification failed, refusing overlay: [VRF00000007] (27688)',
    '[ltk-dll] ltk_patcher_dll::verify: host verification failed, refusing overlay: [VRF00000003] (0x80096010)',
    '[ltk-dll] overlay verification failed, disabling overlay: base-skin check: skin0 skeleton',
    '[ltk-dll] joined too late, not overlaying',
    '[ltk-dll] DLL never attached after 30 s',
    '[ltk-host] Incident recorded: Unsupported Game Build id=inc-1 verdict=PatcherOutOfDate',
    '[ltk] Skipping broken mod entry aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    '[ltk] Swept mod health in 42.5 s',
  ].join('\n');
  const parsed=parseLtkLogLines(sample);
  assert.equal(parsed.verifiedWads,2);
  assert.deepEqual(parsed.brokenModIds,['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
  const codes=new Set(parsed.findings.map(f=>f.code));
  assert.ok(codes.has('LTK_HOST_REFUSED'));
  assert.ok(codes.has('LTK_OVERLAY_REFUSED'));
  assert.ok(codes.has('LTK_LATE_JOIN'));
  assert.ok(codes.has('LTK_DLL_NOT_ATTACHED'));
  assert.ok(codes.has('LTK_INCIDENT_PATCHEROUTOFDATE'));
  assert.ok(codes.has('LTK_SLOW_MOD_CHECK'));
  assert.equal(parsed.findings.filter(f=>f.code==='LTK_HOST_REFUSED'&&f.signature).length,1);

  await writeFile(path.join(dir,'settings.json'),JSON.stringify({builtinMods:{baseSkins:'allChampions'}}));
  const heavy=await checkLtkBuiltins(dir);
  assert.equal(heavy?.code,'LTK_HEAVY_BUILTINS');

  await mkdir(path.join(dir,'logs'),{recursive:true});
  const logFile=path.join(dir,'logs','ltk-manager.2026-11-20.log');
  await writeFile(logFile,'initial line\n');
  const tail=new LtkLogTail({ltkDir:dir});
  await tail.mark();
  assert.equal((await tail.poll()).findings.length,0);
  await writeFile(logFile,'initial line\n[ltk-dll] joined too late, not overlaying\n');
  assert.equal((await tail.poll()).findings[0]?.code,'LTK_LATE_JOIN');
}));

test('DiagnosticsStore and SkinHistory persist atomically with session scoping',()=>withDir(async dir=>{
  let t=10000;
  const store=new DiagnosticsStore({dataDir:dir,now:()=>t});
  await store.load();
  assert.equal(store.report({code:'LTK_ELEVATED',title:'LTK elevated',detail:'d',fix:'f'}),true);
  assert.equal(store.report({code:'LTK_ELEVATED',title:'LTK elevated',detail:'d',fix:'f'}),false,'deduped');
  assert.equal(store.snapshot().length,1);
  assert.equal(store.snapshot()[0].thisSession,true);
  await store.saving;
  const store2=new DiagnosticsStore({dataDir:dir,now:()=>t+5000});
  await store2.load();
  assert.equal(store2.snapshot().length,1,'persistent setup code survives restart');
  assert.equal(store2.snapshot()[0].thisSession,true);
  assert.equal(store2.resolve('LTK_ELEVATED'),true);
  assert.equal(store2.snapshot().length,0);
  await store2.saving;

  const hist=new SkinHistory(dir);
  await hist.load();
  hist.set("Kai'Sa",{id:'riot:145001',label:'Bullet Angel Kai\'Sa'});
  await hist.saving;
  const hist2=new SkinHistory(dir);
  await hist2.load();
  assert.equal(hist2.get('kaisa')?.id,'riot:145001');
  hist2.clear('KaiSa');
  assert.equal(hist2.get('kaisa'),null);
  await hist2.saving;
}));

test('party-transport filters non-global IPs and fails over from blocked system IP to DoH IP',async()=>{
  clearPreferredAddresses();
  assert.equal(isGlobalIp('104.21.10.5'),true);
  assert.equal(isGlobalIp('0.0.0.0'),false);
  assert.equal(isGlobalIp('127.0.0.1'),false);
  assert.equal(isGlobalIp('192.168.1.1'),false);
  assert.equal(isGlobalIp('10.0.0.1'),false);
  assert.equal(isGlobalIp('::1'),false);
  assert.equal(isGlobalIp('2606:4700::6815:a05'),true);
  assert.deepEqual(parseDohAnswer({Status:0,Answer:[{type:1,data:'0.0.0.0'},{type:1,data:'104.21.10.5'}]},1),['104.21.10.5']);

  const attempted=[];
  const fakeSock=new EventEmitter();
  const sock=await connectWithFailover('relay.example.com',443,{
    secure:false,
    lookup:async()=>[{address:'1.1.1.1'}],
    doh:async()=>['2.2.2.2'],
    connect:async ip=>{
      attempted.push(ip);
      if(ip==='1.1.1.1')throw new Error('ECONNRESET');
      return fakeSock;
    },
  });
  assert.equal(sock,fakeSock);
  assert.deepEqual(attempted,['1.1.1.1','2.2.2.2']);
});

test('log-report scrubs secrets/tokens/SIDs and bundles LTF launcher & API logs',()=>withDir(async dir=>{
  const scrubbed=sanitizeReportText(
    'C:\\Users\\alice\\AppData --remoting-auth-token=secret123 Authorization: Bearer abc.def wss://r/?reconnect=0123456789abcdef0123456789abcdef S-1-5-21-111-222-333-1001 "puuid":"abc-123"'
  );
  assert.doesNotMatch(scrubbed,/alice|secret123|abc\.def|0123456789abcdef|111-222-333|abc-123/);
  assert.match(scrubbed,/<user>/);
  assert.match(scrubbed,/<redacted-sid>/);

  await mkdir(path.join(dir,'ltf'),{recursive:true});
  await writeFile(path.join(dir,'ltf','ltk_launcher.log'),'[launch] spawned pid = 42\n');
  await writeFile(path.join(dir,'ltf','ltk_api.log'),'token=deadbeef\n');
  const {files}=await collectReport({dataDir:dir,ltkDir:path.join(dir,'ltk')});
  assert.ok(files.some(f=>f.name==='ltf/ltk_launcher.log'));
  const api=files.find(f=>f.name==='ltf/ltk_api.log');
  assert.ok(api&&!api.bytes.includes('deadbeef'));
}));

test('github-refs discriminates 403 rate limits, clamps clock skew, and persists cooldowns',()=>withDir(async dir=>{
  const headers=map=>({get:k=>map[k.toLowerCase()]??null});
  assert.equal(isRateLimitResponse({status:403,headers:headers({'x-ratelimit-remaining':'50'})}),false);
  assert.equal(isRateLimitResponse({status:403,headers:headers({'x-ratelimit-remaining':'0'})}),true);
  assert.equal(isRateLimitResponse({status:429,headers:headers({})}),true);
  const now=1_700_000_000_000;
  const err=limitedError({status:403,headers:headers({'x-ratelimit-reset':String(Math.floor(now/1000)+999999)})},{now,maxWait:2*3600*1000});
  assert.equal(err.retryAt,now+2*3600*1000,'clamped to 2 hours');

  const g1=new RateLimitGuard(dir,{now:()=>now});
  await g1.note(now+999_999_000);
  assert.equal(g1.blockedUntil,now+2*3600*1000,'guard clamps clock skew to 2 hours');
  const g2=new RateLimitGuard(dir,{now:()=>now+1000});
  await g2.load();
  assert.equal(g2.allowed(),false);
}));

test('Swiftplay slots, cmdline parsing, draftLaunchImminent, and WaitingForStats disconnect cleanup',async()=>{
  assert.equal(modeForQueue(480),'rift');
  const lobby={gameConfig:{queueId:480,gameMode:'SWIFTPLAY'},localMember:{playerSlots:[{championId:103,skinId:103027},{championId:238,skinId:238000}]}};
  assert.equal(isLobbyPickLobby(lobby),true);
  assert.deepEqual(swiftplaySlotsFromLobby(lobby),[
    {championId:103,skinSlot:27,position:''},
    {championId:238,skinSlot:0,position:''},
  ]);
  assert.deepEqual(parseClientCmdline('LeagueClientUx.exe "--app-port=54321" "--remoting-auth-token=Tok_123-ab"'),{port:54321,password:'Tok_123-ab'});
  assert.equal(draftLaunchImminent({timer:{phase:'BAN_PICK',isInfinite:false}}),false);
  assert.equal(draftLaunchImminent({timer:{phase:'FINALIZATION',isInfinite:false}}),true);
  assert.equal(draftLaunchImminent({timer:{phase:'PLANNING',isInfinite:true}}),true);

  let now=1000,online=true;
  const sightings=[];
  const watcher=new GuideWatcher(s=>sightings.push(s),{
    now:()=>now,
    listen:()=>({use(){},stop(){}}),
    readConnection:async()=>{if(!online)throw new Error('closed');return {port:1,password:'p'};},
    request:async(_c,ep)=>ep.includes('gameflow-phase')?'WaitingForStats':null,
  });
  await watcher.poll({urgent:true});
  assert.equal(watcher.sighting.phase,'WaitingForStats');
  online=false;
  await watcher.poll({urgent:true});
  now+=60_000;
  await watcher.poll({urgent:true});
  assert.equal(watcher.sighting.phase,'WaitingForStats','brief outage keeps post-game sighting');
  now+=5*60*1000;
  await watcher.poll({urgent:true});
  assert.equal(watcher.sighting.phase,'','WaitingForStats clears once League stays closed');
});

test('PTCH BIN header, 61-champ subcharacters, LIST(NONE) DoS guard, MsgPack depth guard, and Divine zip-slip',()=>withDir(async dir=>{
  assert.ok(subcharactersOf('Elise').includes('elisespider'));
  assert.ok(subcharactersOf('Nidalee').includes('nidaleecougar'));
  assert.ok(formRecordsOf('Shyvana').includes('shyvanadragon'));

  const prop=writeBin({version:2,dependencies:[],objects:[],tail:Buffer.alloc(0)});
  const ptch=Buffer.concat([Buffer.from('PTCH'),Buffer.alloc(8),prop]);
  assert.ok(parseBin(ptch),'parseBin accepts PTCH-prefixed BINs');

  // LIST(NONE, size=4, count=1000) must throw immediately instead of looping
  const badList=Buffer.alloc(9);badList[0]=0;badList.writeUInt32LE(4,1);badList.writeUInt32LE(1000,5);
  assert.throws(()=>readValue(badList,128,0),/zero-width NONE/);

  // Deeply nested MsgPack (> 32 levels) throws damaged
  assert.throws(()=>decodeMsgpack(Buffer.alloc(40,0x91)),/damaged/);

  // Zip-slip paths in Divine download are rejected (both relative traversal and drive-letter paths)
  const evilZip=path.join(dir,'evil.fantome');
  await writeAtomic(evilZip,writeZip([{name:'../evil.txt',bytes:Buffer.from('x')},{name:'WAD/Ahri.wad.client',bytes:Buffer.from('x')}]));
  await assert.rejects(inspectDownload(evilZip,'evil.fantome',[{id:'Ahri',name:'Ahri'}]),/unsafe file path|invalid relative path/i);
  const driveZip=path.join(dir,'drive.fantome');
  await writeAtomic(driveZip,writeZip([{name:'C:/evil.txt',bytes:Buffer.from('x')},{name:'WAD/Ahri.wad.client',bytes:Buffer.from('x')}]));
  await assert.rejects(inspectDownload(driveZip,'drive.fantome',[{id:'Ahri',name:'Ahri'}]),/unsafe file path|invalid|absolute path/i);
}));

test('Swiftplay overlay view, GameHold matchmaking arming, and SkinEngine 2-slot pre-staging',async()=>{
  // nextView and DraftVisibility open in Swiftplay Lobby/Matchmaking/ReadyCheck, and stay hidden in normal lobbies.
  assert.deepEqual(nextView({champion:null,mode:'hidden'},{connected:true,phase:'Lobby',championName:'Ahri'}),{champion:null,mode:'hidden'});
  assert.deepEqual(nextView({champion:null,mode:'hidden'},{connected:true,phase:'Lobby',swiftplay:true,championName:'Ahri'}),{champion:'Ahri',mode:'open'});
  const dv=new DraftVisibility();
  assert.equal(dv.observe({phase:'Lobby',connected:true,swiftplay:false}).active,false);
  assert.equal(dv.observe({phase:'Lobby',connected:true,swiftplay:true}).active,true);

  // GameHold arms when Swiftplay enters Matchmaking/ReadyCheck and seals when jumping directly to GameStart.
  const sent=[];let armed=0;
  const engineStub={settled:true,status:'ready',setHold(){},repatch(){}};
  const hold=new GameHold({
    engine:engineStub,party:{missing:[],settling:false,report(){}},
    start:()=>{armed++;return {send:w=>sent.push(w),close(){}};},
  });
  hold.schedule=()=>{};
  hold.observe('Lobby',{swiftplaySearching:false});
  assert.equal(armed,0);
  hold.observe('Matchmaking',{swiftplaySearching:true});
  assert.equal(armed,1);
  assert.equal(hold.choicesOpen(),true);
  hold.observe('ReadyCheck',{swiftplaySearching:true});
  assert.ok(sent.includes('fast'));
  hold.observe('GameStart',{swiftplaySearching:false});
  assert.ok(hold.closesAt>0,'Swiftplay GameStart triggers settle without ChampSelect');
  hold.dispose();

  // SkinEngine accepts a 2-slot personal array and stages both in wanted() during Swiftplay.
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-sp-'));
  try{
    const engine=new SkinEngine({bridge:{connected:false},dataDir:dir});
    engine.setSwiftplay(true);
    engine.setPersonal([
      {key:'a1',file:'a.fantome',alias:'Ahri',label:'Ahri Skin'},
      {key:'z1',file:'z.fantome',alias:'Zed',label:'Zed Skin'},
    ]);
    assert.equal(engine.staging,true);
    assert.deepEqual(engine.wanted().map(f=>f.key),['a1','z1']);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('PartyCoordinator filters sitting-out members when matchChampions is set (keeping both teams)',()=>withDir(async dir=>{
  const delivered=[];
  const sha1='1'.repeat(40),sha2='2'.repeat(40),sha3='3'.repeat(40);
  const coord=new PartyCoordinator({
    dataDir:dir,version:'12.9.0',
    findSkin:async(champ,sha)=>({key:sha,file:`${champ}.fantome`,alias:champ,label:champ}),
    onFiles:files=>delivered.push(files.map(f=>f.alias).sort()),
  });
  coord.client.session={code:'ABCD'};
  coord.ownChampion='Ahri';
  coord.roomSkins=[
    {source:'custom',championId:'zed',relative:'Zed Skin',sha:sha1},
    {source:'custom',championId:'lux',relative:'Lux Skin',sha:sha2},
    {source:'custom',championId:'teemo',relative:'Teemo Sitting Out',sha:sha3},
  ];
  // Match roster includes ally Zed and enemy Lux (custom 5v5), but NOT Teemo.
  coord.setMatchChampions(['Ahri','Zed','Lux']);
  await coord.reconcile();
  assert.deepEqual(delivered.at(-1),['lux','zed']);
  // Clearing matchChampions restores full room staging.
  coord.setMatchChampions(null);
  await coord.reconcile();
  assert.deepEqual(delivered.at(-1),['lux','teemo','zed']);
  coord.dispose();
}));

test('buildCustomSkinCopy synthesizes META/info.json for WAD-only community zip packs',()=>withDir(async dir=>{
  const src=path.join(dir,'CommunityPack.zip');
  await writeAtomic(src,writeZip([{name:'WAD/Global.wad.client',bytes:writeWad([{file:'assets/test.txt',bytes:Buffer.from('hi')}])}]));
  const built=await buildCustomSkinCopy({file:src,champion:'',dir:path.join(dir,'out'),league:dir});
  assert.ok(built.file.endsWith('.fantome'));
}));
