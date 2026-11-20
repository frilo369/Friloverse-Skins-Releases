import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PartyCoordinator,STEALTH_MARK,skinKey} from '../src/party-coordinator.mjs';
import {PartyClient} from '../src/fryilo-party/desktop-ui/party.mjs';
import {versionMark} from '../src/party-version.mjs';
import {cleanMemberName} from '../src/fryilo-party/party-relay/src/protocol.mjs';

const sha=letter=>letter.repeat(40);
const friend=(champion='aatrox',letter='a',name='Peer skin')=>({source:'custom',championId:champion,relative:name,sha:sha(letter)});
function fixture(dir){
  const f={files:[],sent:[],found:{},lookups:[],pick:null};
  f.party=new PartyCoordinator({dataDir:dir,version:'0.2.0',localPick:()=>f.pick,
    findSkin:async(champion,key)=>{f.lookups.push(`${champion}:${key[0]}`);if(f.findError)throw new Error(f.findError);return f.found[`${champion}:${key}`]||null;},
    onFiles:files=>{f.files=files;}});
  f.party.client.session={code:'ABCD'};f.party.roomSkins=[friend()];
  f.party.client.sendSnapshot=(skins,mods)=>{f.sent.push({skins,mods});};
  f.party.client.setPlaying=()=>{};
  return f;
}

test('recently chosen party icons are saved in order without duplicates',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    f.party.client.session=null;
    await Promise.all(['1','2','3','4','5','6','7'].map(icon=>f.party.saveProfile('Player',icon,{rememberIcon:true})));
    assert.deepEqual(f.party.profile.recentIcons,['7','6','5','4','3','2']);
    await f.party.saveProfile('Player','3',{rememberIcon:true});
    assert.deepEqual(f.party.profile.recentIcons,['3','7','6','5','4','2']);
    await f.party.saveProfile('   ','3');
    assert.equal(f.party.profile.name,'Player','an empty box keeps the last name');
    await f.party.saveProfile('Renamed','3');
    f.party.profile={name:'',icon:'',recentIcons:[]};await f.party.load();clearTimeout(f.party.timer);
    assert.equal(f.party.profile.name,'Renamed');assert.deepEqual(f.party.profile.recentIcons,['3','7','6','5','4','2']);
  }finally{f.party.dispose();assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));await rm(dir,{recursive:true,force:true});}
});

test('a party name keeps twelve characters and loses the thirteenth',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    f.party.client.session=null;
    await f.party.saveProfile('ABCDEFGHIJKL','');
    assert.equal(f.party.profile.name,'ABCDEFGHIJKL');
    await f.party.saveProfile('ABCDEFGHIJKLM','');
    assert.equal(f.party.profile.name,'ABCDEFGHIJKL');
    assert.equal(cleanMemberName('ABCDEFGHIJKLM'),'ABCDEFGHIJKL','the copy of the relay rule matches');
    const html=await readFile(new URL('../src/ui/dashboard.html',import.meta.url),'utf8');
    assert.match(html,/id="name" maxlength="12"/);
    assert.doesNotMatch(html,/name-hint/);
  }finally{f.party.dispose();assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));await rm(dir,{recursive:true,force:true});}
});

test('a party that ended or refused the player does not hide the next room behind its revision',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    f.party.schedule=()=>{};
    f.party.roomSkins=[];f.party.receive([],15);
    assert.equal(f.party.roomRevision,15);
    // The relay refuses or ends a room without the coordinator's leave().
    f.party.client.session=null;f.party.client.setState({status:'idle',members:[],error:'Party not found.'});
    assert.equal(f.party.roomRevision,0);
    f.party.client.session={code:'WXYZ'};
    const key={source:'custom',championId:'zed',relative:'Zed skin',sha:'b'.repeat(40)};
    f.party.receive([key],2);
    assert.deepEqual(f.party.roomSkins,[key]);
  }finally{f.party.client.session=null;f.party.dispose();assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));await rm(dir,{recursive:true,force:true});}
});

test('stealth hides other members, and only the host can set it',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    f.party.schedule=()=>{};
    const me=f.party.client.clientId,skin={relative:'Secret skin',championId:'aatrox'};
    const room=(hostMark,guestMark='',selfHost=true)=>{
      f.party.client.state.members=[{id:me,host:selfHost,db:selfHost?hostMark:guestMark,playing:'ahri',skin:{relative:'Mine',championId:'ahri'}},
        {id:'other-member',host:!selfHost,db:selfHost?guestMark:hostMark,playing:'aatrox',skin}];
    };
    room('');
    f.party.missing=[{champion:'aatrox',name:'Secret skin'}];
    let view=f.party.snapshot();
    assert.equal(view.stealth,false);assert.equal(view.members[1].skin.relative,'Secret skin');assert.equal(view.missing.length,1);
    room(STEALTH_MARK);view=f.party.snapshot();
    assert.equal(view.stealth,true);
    assert.equal(view.members[1].skin,null);assert.equal(view.members[1].playing,null);assert.equal(view.members[1].hidden,true);
    assert.equal(view.members[0].skin.relative,'Mine','you still see your own pick');assert.deepEqual(view.missing,[]);
    assert.doesNotMatch(JSON.stringify(view),/Secret skin|aatrox/);
    // A guest's mark means nothing.
    f.party.knownStealth=null;room('',STEALTH_MARK);assert.equal(f.party.snapshot().stealth,false);
    // A host away for a moment keeps the last answer; none known stays hidden.
    room(STEALTH_MARK);f.party.snapshot();f.party.client.state.members=[f.party.client.state.members[1]];f.party.client.state.members[0].host=false;
    assert.equal(f.party.snapshot().stealth,true);
    f.party.knownStealth=false;assert.equal(f.party.snapshot().stealth,false);
    f.party.knownStealth=null;assert.equal(f.party.snapshot().stealth,true);
    // Guests are refused; the host's choice is what connects next, and a new room starts open.
    room('','',false);assert.throws(()=>f.party.setStealth(true),/host/);
    room('');f.party.setStealth(true);assert.equal(f.party.client.meta.db,versionMark('0.2.0',{stealth:true}));
    f.party.resetRoom();assert.equal(f.party.client.meta.db,versionMark('0.2.0'));assert.equal(f.party.knownStealth,null);
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a change the relay dropped can be sent again',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    const sent=[];f.party.client.socket={readyState:1,send:message=>sent.push(JSON.parse(message)),close(){}};
    f.party.client.state.status='connected';
    f.party.client.state.members=[{id:f.party.client.clientId,host:true,db:''}];
    f.party.setStealth(true);f.party.setStealth(true);
    const stealthOn=versionMark('0.2.0',{stealth:true});assert.deepEqual(sent.map(message=>message.db),[stealthOn,stealthOn]);
    f.party.client.state.members[0].db=stealthOn;f.party.setStealth(true);
    assert.equal(sent.length,2,'nothing to resend once the relay has it');
    f.party.client.socket=null;
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('party messages stay plain, and an ended party leaves no stale status',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    f.party.schedule=()=>{};
    f.party.error='Everyone in the party must use FrYiLoCo 13.11.0-d123. Sam has 13.11.0-d456.';
    assert.equal(f.party.snapshot().error,'Everyone in the party must use the same Friloverse version.');
    f.party.error='';
    f.party.status='Connecting to the party…';
    f.party.client.session=null;f.party.client.setState({status:'idle',members:[],error:'Party not found.'});
    assert.equal(f.party.status,'');assert.equal(f.party.snapshot().syncStatus,'');
    // A second click while the first is saving must not start a second room.
    f.party.roomSkins=[];let rooms=0;f.party.client.create=()=>{rooms++;f.party.client.session={code:'ABCD'};};
    await Promise.all([f.party.enter('create',{name:'Tester'}),f.party.enter('create',{name:'Tester'})]);
    assert.equal(rooms,1);
    f.party.client.session=null;
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a friend\'s skin is found by its contents and handed to the engine',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    const file={key:sha('a'),file:'C:/a.fantome',label:'Peer skin'};
    f.found[`aatrox:${sha('a')}`]=file;
    f.party.ownChampion='Briar';
    await f.party.reconcile();
    assert.deepEqual(f.files,[file]);assert.deepEqual(f.party.missing,[]);
    assert.match(f.party.snapshot().syncStatus,/ready/);
    await f.party.reconcile();
    assert.equal(f.lookups.length,1,'it is only looked for once');
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a friend on this player\'s own champion never replaces their choice',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    f.found[`aatrox:${sha('a')}`]={key:sha('a'),file:'C:/a.fantome'};
    f.party.ownChampion='Aatrox';
    await f.party.reconcile();
    assert.deepEqual(f.files,[]);assert.deepEqual(f.lookups,[]);
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a skin this PC cannot get is reported, and an odd key is refused',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    f.party.roomSkins=[friend('zed','b','Zed skin'),{source:'official',championId:'ahri',relative:'Odd'},{source:'custom',championId:'lux',relative:'No hash'}];
    await f.party.reconcile();
    assert.deepEqual(f.party.missing.map(row=>row.name),['Zed skin','Odd','No hash']);
    assert.deepEqual(f.files,[]);
    assert.deepEqual(f.lookups,['zed:b'],'only a proper content hash is looked up');
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a failed download is explained, waits, and can be retried',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    f.party.schedule=()=>{};
    f.findError='offline';
    await f.party.reconcile();
    assert.match(f.party.snapshot().error,/offline/);assert.equal(f.party.snapshot().syncFailed,true);
    await f.party.reconcile();
    assert.equal(f.lookups.length,1,'not tried again straight away');
    delete f.findError;f.found[`aatrox:${sha('a')}`]={key:sha('a'),file:'C:/a.fantome'};
    await f.party.retry();await f.party.reconcile();
    assert.equal(f.files.length,1);assert.equal(f.party.snapshot().error,'');
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('stealth never names a friend\'s skin in a status',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    const seen=[];f.party.onChange=()=>{seen.push(JSON.stringify(f.party.snapshot()));};
    f.party.client.state.members=[{id:'room-host',host:true,db:STEALTH_MARK}];
    f.party.roomSkins=[friend('zed','b','Secret Zed')];
    await f.party.reconcile();
    assert.ok(seen.length);assert.ok(seen.every(view=>!view.includes('Secret Zed')));
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('leaving a party takes friends\' skins away',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    f.found[`aatrox:${sha('a')}`]={key:sha('a'),file:'C:/a.fantome'};
    await f.party.reconcile();assert.equal(f.files.length,1);
    f.party.client.session=null;f.party.resetRoom();
    await f.party.reconcile();
    assert.deepEqual(f.files,[]);
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('the room is told about a pick once, and only by its hash',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    f.party.schedule=()=>{};
    f.party.observe('Ahri','ChampSelect');
    assert.deepEqual(f.sent.at(-1),{skins:[],mods:[]});
    f.pick={key:sha('c'),file:'C:/private/path.fantome',label:'Dynasty/Ahri'};
    f.party.refreshLocal();
    assert.deepEqual(f.sent.at(-1).skins,[{source:'custom',championId:'ahri',relative:'Dynasty Ahri',sha:sha('c')}]);
    assert.doesNotMatch(JSON.stringify(f.sent.at(-1)),/private/);
    const count=f.sent.length;
    f.party.refreshLocal();f.party.observe('Ahri','ChampSelect');
    assert.equal(f.sent.length,count,'nothing new is sent when nothing changed');
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('the pick stays through loading so friends in draft still see it',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    f.party.schedule=()=>{};
    f.party.observe('Ahri','ChampSelect');
    f.party.observe(null,'GameStart');assert.equal(f.party.ownChampion,'Ahri');
    f.party.observe(null,'InProgress');assert.equal(f.party.ownChampion,'Ahri');
    f.party.observe(null,'Lobby');assert.equal(f.party.ownChampion,null);
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a bad pick is never sent',()=>{
  assert.equal(skinKey('Ahri',null),null);
  assert.equal(skinKey('Ahri',{key:'short'}),null);
  assert.equal(skinKey('',{key:sha('a')}),null);
});

test('the game waits only for connected friends still choosing, never for a failure',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    const client=f.party.client;
    client.clientId='me';client.preparationSupported=true;
    client.state={...client.state,status:'connected',members:[
      {id:'me',name:'Me'},{id:'a',name:'Sam',preparation:'selected'},{id:'b',name:'Alex',preparation:'prepared'},
      {id:'c',name:'Kim'},{id:'d',name:'Lee',preparation:'error'},{id:'e',name:'Bo',preparation:'partial'},
    ]};
    assert.deepEqual(f.party.choosing(),['Sam','Kim']);
    client.state={...client.state,status:'reconnecting'};
    assert.deepEqual(f.party.choosing(),[],'a lost connection never holds the game');
    client.state={...client.state,status:'connected'};client.preparationSupported=false;
    assert.deepEqual(f.party.choosing(),[]);
    client.preparationSupported=true;client.session=null;
    assert.deepEqual(f.party.choosing(),[]);
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a friend\'s pick counts as unfinished from arriving until its file is found',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    assert.equal(f.party.settling,false);
    f.found[`aatrox:${sha('a')}`]={key:'x',file:'x'};
    f.party.schedule(0);
    assert.equal(f.party.settling,true);
    await new Promise(done=>setTimeout(done,20));
    for(let i=0;i<50&&f.party.busy;i++)await new Promise(done=>setTimeout(done,5));
    assert.equal(f.party.settling,false);
    assert.equal(f.files.length,1);
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('the same room said again is not a friend\'s skin to look for',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    const skins=[{source:'custom',championId:'zed',relative:'Zed.fantome',sha:sha('z')}];
    f.party.receive(skins,4);
    assert.equal(f.party.settling,true,'a new room is looked at');
    for(let i=0;i<60&&f.party.settling;i++)await new Promise(done=>setTimeout(done,10));
    assert.equal(f.party.settling,false);
    f.party.receive(JSON.parse(JSON.stringify(skins)),4);
    assert.equal(f.party.settling,false,'nothing changed, so nothing holds a ready game');
    f.party.receive([],5);
    assert.equal(f.party.settling,true,'a real change is looked at');
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('this PC\'s state goes to the room, and only while in a party',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    const said=[];f.party.client.setPreparation=state=>said.push(state);
    f.party.report('prepared');
    f.party.client.session=null;f.party.report('selected');
    assert.deepEqual(said,['prepared']);
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a friend\'s skin this PC lacks is looked for now and then, not on every look',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    await f.party.reconcile();clearTimeout(f.party.timer);
    assert.equal(f.lookups.length,1);
    const key=[...f.party.retryAt.keys()][0];
    f.party.retryAt.set(key,Date.now()-1);
    await f.party.reconcile();clearTimeout(f.party.timer);
    assert.equal(f.lookups.length,2);
    assert.ok(f.party.retryAt.get(key)>Date.now(),'an old time would count as due, and League would wait for it');
    f.party.scheduled=false;
    f.party.observe(null,'ChampSelect');clearTimeout(f.party.timer);
    assert.equal(f.party.scheduled,false);assert.equal(f.party.settling,false);
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a friend who changed their mind leaves nothing to look for',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    await f.party.reconcile();clearTimeout(f.party.timer);
    f.party.roomSkins=[];
    await f.party.reconcile();clearTimeout(f.party.timer);
    assert.equal(f.party.retryAt.size,0);
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a connection blip does not make the whole party prepare again',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    const resynced=[];f.party.client.resync=(skins,mods)=>{resynced.push({skins,mods});return false;};
    f.party.client.onReady();
    assert.equal(resynced.length,1);assert.equal(f.sent.length,0);
    f.party.ownChampion='lux';f.pick={key:sha('b'),label:'Mine'};f.party.refreshLocal();
    assert.equal(f.sent.length,1,'a real change is still sent');
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('an app update does not split a party, and a refusal looks for an update once',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));
  const refused=[];
  const make=version=>new PartyCoordinator({dataDir:dir,version,onVersionRefused:()=>refused.push(version)});
  const older=make('4.3.0'),newer=make('4.4.0');
  try{
    assert.equal(older.client.meta.app,newer.client.meta.app);
    const error='Everyone in the party must use FrYiLoCo 13.11.0-dabc. A party member has 13.11.0-ddef.';
    older.client.setState({error});older.client.setState({error});
    assert.deepEqual(refused,['4.3.0']);
    assert.match(older.snapshot().error,/same Friloverse version/);
  }finally{older.dispose();newer.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a joiner is told about a newer version in the party, and only then',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    f.party.schedule=()=>{};
    const room=(...members)=>{f.party.client.state.members=members;};
    room({id:f.party.client.clientId,db:versionMark('0.2.0')},{id:'host',host:true,db:versionMark('4.6.0')});
    assert.equal(f.party.snapshot().updateTo,'4.6','in the numbers players see');
    assert.equal(f.party.snapshot().members[1].version,'4.6.0');
    room({id:f.party.client.clientId,db:versionMark('0.2.0')},{id:'host',host:true,db:versionMark('0.1.0')});
    assert.equal(f.party.snapshot().updateTo,'');
    // Stealth hides picks, not the version.
    room({id:f.party.client.clientId,db:versionMark('0.2.0')},{id:'host',host:true,db:versionMark('4.6.0',{stealth:true})});
    assert.equal(f.party.snapshot().stealth,true);assert.equal(f.party.snapshot().updateTo,'4.6');
  }finally{f.party.client.session=null;f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('every member\'s skin gets its picture by hash, but never through Stealth',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const asked=[];
  const f=fixture(dir);
  try{
    f.party.schedule=()=>{};
    f.party.artFor=async(champion,key)=>{asked.push(`${champion}:${key[0]}`);return {image:`art/${champion}.jpg`,fallback:''};};
    const self=f.party.client.clientId;
    f.party.client.state.members=[{id:self,skin:friend('aatrox','a')},{id:'host',host:true,skin:friend('zed','b'),db:versionMark('0.2.0')}];
    f.party.emit();await new Promise(done=>setTimeout(done,10));
    assert.deepEqual(asked,['aatrox:a','zed:b'],'a player\'s own skin too');
    let view=f.party.snapshot();
    assert.equal(view.members[0].art.image,'art/aatrox.jpg');assert.equal(view.members[1].art.image,'art/zed.jpg');
    f.party.emit();await new Promise(done=>setTimeout(done,10));
    assert.equal(asked.length,2,'looked up once');
    f.party.client.state.members[1].db=versionMark('0.2.0',{stealth:true});
    view=f.party.snapshot();
    assert.equal(view.members[1].art,null);assert.equal(view.members[0].art.image,'art/aatrox.jpg');
  }finally{f.party.client.session=null;f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('reports: ready while choosing keeps friends waiting, finished releases them',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    const sent=[];f.party.client.setPreparation=(state,options)=>sent.push([state,options.refresh]);
    f.party.client.preparationSupported=true;
    const self=f.party.client.clientId,marked=versionMark('0.2.0');
    Object.assign(f.party.client.state,{status:'connected',members:[{id:self,db:marked},{id:'a',name:'Sam',db:marked,preparation:'armed'},{id:'b',name:'Alex',db:marked,preparation:'preparing'}]});
    assert.deepEqual(f.party.choosing(),['Sam'],'a friend preparing has already chosen');
    for(const state of ['prepared','partial','error','active','preparing','syncing']){
      f.party.client.state.members[1].preparation=state;f.party.client.state.members[2].preparation=state;
      assert.deepEqual(f.party.choosing(),[],state);
    }
    f.party.report('active');assert.deepEqual(sent.at(-1),['active',true]);
    f.party.client.state.members[0].preparation='active';f.party.report('active');assert.deepEqual(sent.at(-1),['active',false],'echoed: no need to say it again');
    // A friend on 4.4 would wait for a word it does not know.
    f.party.client.state.members[1].db='';
    f.party.report('active');assert.equal(sent.at(-1)[0],'prepared');
  }finally{f.party.client.session=null;f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

// Host hand-over (6.0): the relay closes a room whose host leaves, so the rest move to a new one.
const v6=versionMark('6.0.0');
const member=(id,name,host=false,db=v6)=>({id,name,host,db});
const room=[member('host-id','Hana',true),member('bea-id','Bea'),member('cal-id','Cal'),member('old-id','Olaf',false,versionMark('5.5.0'))];
function moving(f,self){
  f.party.client.clientId=self;f.party.profile.name='Me';f.party.schedule=()=>{};
  f.calls=[];
  f.party.client.create=(code)=>{f.calls.push(['create',code]);f.party.client.session={code};f.party.client.setState({status:'connecting',code});};
  f.party.client.join=(code)=>{f.calls.push(['join',code]);f.party.client.session={code};f.party.client.setState({status:'connecting',code});};
  f.party.client.session={code:'ROOM'};
  f.party.client.setState({status:'connected',code:'ROOM',members:room});
}
// What PartyClient does when the relay closes the room because its host left.
function hostLeft(f){f.party.client.session=null;f.party.client.setState({status:'idle',members:[]});f.party.client.onEnded('The host left, so the party was closed.');}

test('every PC picks the same new host and codes, never the old host or a copy too old to move', async () => {
  const {successor}=await import('../src/party-coordinator.mjs');
  const a=successor({code:'ROOM',hostId:'host-id',members:room});
  const b=successor({code:'ROOM',hostId:'host-id',members:[...room].reverse()});
  assert.deepEqual(a,b);
  assert.ok(['bea-id','cal-id'].includes(a.hostId));
  assert.equal(a.codes.length,3);
  for(const code of a.codes)assert.match(code,/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
  // Random to the players: over many rooms both can be chosen.
  const chosen=new Set(Array.from({length:40},(_,index)=>successor({code:`R${index}`,hostId:'host-id',members:room}).hostId));
  assert.deepEqual([...chosen].sort(),['bea-id','cal-id']);
  assert.equal(successor({code:'ROOM',hostId:'host-id',members:[member('host-id','Hana',true),member('old-id','Olaf',false,versionMark('5.5.0'))]}),null);
});

test('when the host leaves, the new host opens the room and the others join it', async () => {
  const {successor}=await import('../src/party-coordinator.mjs');
  const plan=successor({code:'ROOM',hostId:'host-id',members:room});
  const other=plan.hostId==='bea-id'?'cal-id':'bea-id';
  const dirs=[await mkdtemp(path.join(tmpdir(),'friloverse-party-')),await mkdtemp(path.join(tmpdir(),'friloverse-party-'))];
  const host=fixture(dirs[0]),guest=fixture(dirs[1]);
  try{
    moving(host,plan.hostId);moving(guest,other);
    hostLeft(host);hostLeft(guest);
    assert.deepEqual(host.calls,[['create',plan.codes[0]]]);
    assert.match(host.party.snapshot().notice,/You are the new host/);
    assert.equal(guest.party.snapshot().status,'reconnecting');
    assert.match(guest.party.snapshot().notice,new RegExp(`${plan.hostName} is the new host`));
    // The guest waits a moment, then tries; a room not open yet is tried again.
    await new Promise(resolve=>setTimeout(resolve,700));
    assert.deepEqual(guest.calls,[['join',plan.codes[0]]]);
    guest.party.client.session=null;guest.party.client.setState({status:'idle',members:[],error:'Party not found.'});
    assert.equal(guest.party.snapshot().error,'');
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.deepEqual(guest.calls.at(-1),['join',plan.codes[0]]);
    const moved=[member(plan.hostId,plan.hostName,true),member(other,'Me')];
    host.party.client.setState({status:'connected',code:plan.codes[0],members:moved});
    guest.party.client.setState({status:'connected',code:plan.codes[0],members:moved});
    assert.equal(guest.party.handover,null);
    assert.match(guest.party.snapshot().notice,new RegExp(`so ${plan.hostName} is the host now`));
    assert.match(host.party.snapshot().notice,/you are the host now/);
  }finally{
    for(const f of [host,guest]){f.party.client.session=null;f.party.dispose();}
    for(const dir of dirs)await rm(dir,{recursive:true,force:true});
  }
});

test('a taken code moves the new host to the next one the others also try', async () => {
  const {successor}=await import('../src/party-coordinator.mjs');
  const plan=successor({code:'ROOM',hostId:'host-id',members:room});
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    moving(f,plan.hostId);hostLeft(f);
    assert.equal(f.party.client.codeFactory(),plan.codes[1]);
    assert.equal(f.party.client.codeFactory(),plan.codes[2]);
  }finally{f.party.client.session=null;f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('leaving, being kicked or a version refusal moves nobody', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    moving(f,'bea-id');
    f.party.client.leave=()=>{};
    await f.party.leave();
    hostLeft(f);
    assert.deepEqual(f.calls,[]);
    assert.equal(f.party.handover,undefined);
    moving(f,'bea-id');
    f.party.client.session=null;f.party.client.setState({status:'idle',members:[]});f.party.client.onEnded('The host removed you from the party.');
    assert.deepEqual(f.calls,[]);
    assert.equal(f.party.snapshot().error,'The host removed you from the party.');
  }finally{f.party.client.session=null;f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a host whose own connection went comes back to its party under the new host', async () => {
  const {successor}=await import('../src/party-coordinator.mjs');
  const plan=successor({code:'ROOM',hostId:'host-id',members:room});
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    moving(f,'host-id');
    // Its reconnect finds the room closed by the relay.
    f.party.client.session=null;f.party.client.setState({status:'idle',members:[],error:'Party not found.'});
    assert.ok(f.party.handover);
    await new Promise(resolve=>setTimeout(resolve,700));
    assert.deepEqual(f.calls,[['join',plan.codes[0]]]);
  }finally{f.party.client.session=null;f.party.dispose();await rm(dir,{recursive:true,force:true});}
});

test('why the relay connection closed reaches the log, once per outage',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));
  const lines=[];let time=0;
  const party=new PartyCoordinator({dataDir:dir,version:'4.3.0',onConnection:line=>lines.push(line),now:()=>time});
  try{
    const closed='WebSocket closed: code=1006 intentional=false';
    party.client.onDiagnostic(closed);
    assert.deepEqual(lines,[closed]);
    // Retries while the network is down: every 10 s at most, for as long as it lasts.
    for(let i=0;i<30;i++){time+=10000;party.client.onDiagnostic(closed);}
    assert.equal(lines.length,1);
    time+=10*60*1000;party.client.onDiagnostic(closed);
    assert.equal(lines.length,2,'a new outage later is a new line');
    party.client.onDiagnostic('WebSocket closed: code=1001 intentional=false');
    assert.equal(lines.length,3,'another code is always worth a line');
    party.client.onDiagnostic('preparation sent: revision=1 state=ready');
    party.client.onDiagnostic('WebSocket error; party service could not be reached');
    assert.equal(lines.length,3,'only the closes, so the log stays readable');
  }finally{party.dispose();await rm(dir,{recursive:true,force:true});}
});

function linkClient(){
  let clock=0;const handlers={};
  class Socket{readyState=1;terminated=false;pings=0;on(name,handler){handlers[name]=handler;}ping(){this.pings++;}terminate(){this.terminated=true;}send(){}close(){}}
  let socket;
  const client=new PartyClient({endpoint:'ws://relay',clientId:'member-link',now:()=>clock,WebSocketImpl:class extends Socket{constructor(){super();socket=this;}}});
  client.join('ABCD','Name','');
  return {client,socket:()=>socket,pong:()=>handlers.pong(),advance:ms=>{clock+=ms;}};
}

test('party cards survive a dropped link until the authoritative reconnect snapshot',t=>{
  t.mock.timers.enable({apis:['setInterval','setTimeout']});
  const link=linkClient(),client=link.client;
  try{
    const members=[{id:'member-link',name:'Name',host:true},{id:'friend',name:'Friend'}];
    client.handleMessage(JSON.stringify({type:'ready',revision:1,members,skins:[]}));
    link.socket().onopen();link.socket().onclose({code:1006});
    assert.equal(client.state.status,'reconnecting');assert.equal(client.state.members.length,2);
    t.mock.timers.tick(1000);
    assert.equal(client.state.members.length,2);
    client.handleMessage(JSON.stringify({type:'ready',revision:2,members:[members[0]],skins:[]}));
    assert.equal(client.state.members.length,1,'departed members are removed when the relay answers');
    client.leave();assert.deepEqual(client.state.members,[]);
    client.join('WXYZ','Name','');assert.deepEqual(client.state.members,[],'a different room starts empty');
  }finally{client.leave();}
});
test('a connection that stops answering is ended, so the reconnect brings the room again', t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const link=linkClient();
  t.mock.timers.tick(10000);assert.equal(link.socket().pings,1);link.pong();
  link.advance(10000);t.mock.timers.tick(10000);assert.equal(link.socket().terminated,false);
  link.advance(10000);t.mock.timers.tick(10000);assert.equal(link.socket().terminated,true);
});
test('a relay never seen answering a ping is not held to it', t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const link=linkClient();
  for(let turn=0;turn<5;turn++){link.advance(10000);t.mock.timers.tick(10000);}
  assert.equal(link.socket().terminated,false);
});

test('stealth stays on from the first frame of a host hand-over', async () => {
  const {successor}=await import('../src/party-coordinator.mjs');
  const stealthHost=versionMark('6.0.0',{stealth:true});
  const stealthRoom=[member('host-id','Hana',true,stealthHost),member('bea-id','Bea'),member('cal-id','Cal')];
  const plan=successor({code:'ROOM',hostId:'host-id',members:stealthRoom});
  const other=plan.hostId==='bea-id'?'cal-id':'bea-id';
  const dirs=[await mkdtemp(path.join(tmpdir(),'friloverse-party-')),await mkdtemp(path.join(tmpdir(),'friloverse-party-'))];
  const host=fixture(dirs[0]),guest=fixture(dirs[1]);
  try{
    let dbAtCreate='';
    for(const [f,id] of [[host,plan.hostId],[guest,other]]){
      f.party.client.clientId=id;f.party.profile.name='Me';f.party.schedule=()=>{};
      f.party.client.create=code=>{dbAtCreate=f.party.client.meta.db;f.party.client.session={code};f.party.client.setState({status:'connecting',code});};
      f.party.client.join=code=>{f.party.client.session={code};f.party.client.setState({status:'connecting',code});};
      f.party.client.session={code:'ROOM'};
      f.party.client.setState({status:'connected',code:'ROOM',members:stealthRoom});
    }
    hostLeft(host);hostLeft(guest);
    assert.equal(dbAtCreate,versionMark('0.2.0',{stealth:true}),'the new host opens the replacement room with Stealth already set');
    assert.equal(host.party.snapshot().stealth,true);
    assert.equal(guest.party.snapshot().stealth,true,'guests keep Stealth on while waiting to join the replacement room');
  }finally{
    for(const f of [host,guest]){f.party.client.session=null;f.party.dispose();}
    for(const dir of dirs)await rm(dir,{recursive:true,force:true});
  }
});

test('invalidating the party cache re-checks friends\' skins and dispose drops late lookups', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-party-'));const f=fixture(dir);
  try{
    const first={key:sha('a'),file:'C:/old.fantome',label:'Peer skin'};
    const second={key:sha('a'),file:'C:/new.fantome',label:'Peer skin'};
    f.found[`aatrox:${sha('a')}`]=first;
    f.party.ownChampion='Briar';
    await f.party.reconcile();
    assert.deepEqual(f.files,[first]);
    f.found[`aatrox:${sha('a')}`]=second;
    f.party.schedule=()=>{};
    f.party.invalidateCache();
    await f.party.reconcile();
    assert.deepEqual(f.files,[second],'library updates drop stale cached skin paths');

    // A lookup finishing after dispose must not emit or push files to the engine.
    let finishLookup;
    f.party.found.clear();
    f.party.findSkin=()=>new Promise(resolve=>{finishLookup=resolve;});
    let lateFiles=0,lateEmits=0;
    f.party.onFiles=()=>{lateFiles++;};
    f.party.onChange=()=>{lateEmits++;};
    const running=f.party.reconcile();
    lateEmits=0;
    f.party.dispose();
    finishLookup(second);
    await running;
    assert.equal(lateFiles,0);
    assert.equal(lateEmits,0);
  }finally{f.party.dispose();await rm(dir,{recursive:true,force:true});}
});
