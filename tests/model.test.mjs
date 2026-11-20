import test from 'node:test';
import assert from 'node:assert/strict';
import {clientCovered,championKey,inParty,DraftVisibility,matchingSkins,nextView,overlayBounds,readCustomCards,shownVersion,unwrap,launcherBounds,centeredOn,phaseLabel} from '../src/model.mjs';

test('the status line uses words, and a new phase still shows',()=>{
  assert.equal(phaseLabel('ChampSelect'),'Champion select');
  assert.equal(phaseLabel('InProgress'),'In game');
  assert.equal(phaseLabel('WaitingForStats'),'Game ended');
  assert.equal(phaseLabel('SomethingNew'),'SomethingNew');
  assert.equal(phaseLabel(undefined),'');
});

test('a freeze hides the draft until a new champion select, even across a connection blip',()=>{
  const visibility=new DraftVisibility();
  const draft={phase:'ChampSelect',connected:true};
  assert.deepEqual(visibility.observe(draft),{active:true,closed:false});
  assert.deepEqual(visibility.observe({...draft,frozen:true}),{active:false,closed:true});
  assert.deepEqual(visibility.observe(draft),{active:false,closed:false});
  visibility.observe({phase:'',connected:false});
  assert.equal(visibility.observe(draft).active,false);
  for(const phase of ['GameStart','Reconnect','InProgress','WaitingForStats','Lobby']){
    assert.equal(visibility.observe({phase,connected:true}).active,false);
  }
  assert.equal(visibility.observe(draft).active,true);
});

test('a party counts while in a room or getting back to one', () => {
  assert.equal(inParty({status:'connected',code:'ABCD'}),true);
  assert.equal(inParty({status:'reconnecting',code:'ABCD'}),true);
  assert.equal(inParty({status:'idle',code:''}),false);
  assert.equal(inParty({status:'idle',code:'ABCD'}),false);
  assert.equal(inParty(null),false);
});

test('champion entry, swap, manual fold, disconnect and re-entry',()=>{
  let state={champion:null,mode:'hidden'};
  const status={connected:true,phase:'ChampSelect',championName:'Aatrox'};
  state=nextView(state,status);assert.equal(state.mode,'open');
  state.mode='tab';assert.equal(nextView(state,status).mode,'tab');
  assert.equal(nextView({champion:'Wukong',mode:'tab'},{connected:true,phase:'ChampSelect',championName:'MonkeyKing'}).mode,'tab');
  state=nextView(state,{...status,championName:'Briar'});assert.equal(state.mode,'open');
  state=nextView(state,{...status,phase:'InProgress'});assert.deepEqual(state,{champion:null,mode:'hidden'});
  assert.equal(nextView(state,status).mode,'open');
  assert.equal(nextView(state,{...status,connected:false}).mode,'hidden');
  assert.deepEqual(nextView({champion:null,mode:'hidden'},{...status,championName:null}),{champion:null,mode:'hidden'},'a draft with no champion yet shows no overlay at all');
  assert.deepEqual(nextView({champion:'Aatrox',mode:'tab'},{...status,championName:null}),{champion:null,mode:'hidden'},'League no longer naming the champion hides the overlay again');
  assert.deepEqual(nextView({champion:null,mode:'hidden'},status),{champion:'Aatrox',mode:'open'},'the panel opens by itself once League names the champion');
  assert.equal(nextView(state,{...status,championName:null,phase:'Lobby'}).mode,'hidden');
});
test('a match phase alone never shows a skin panel without confirmed reconnect availability',()=>{
  for(const mode of ['open','tab','hidden']){
    for(const phase of ['GameStart','InProgress','Reconnect','Lobby','None','WaitingForStats','PreEndOfGame','EndOfGame','']){
      assert.deepEqual(nextView({champion:'Ahri',mode},{connected:true,phase,championName:'Ahri'},
        {allowStarting:true,reconnect:true}),{champion:null,mode:'hidden'},`${mode}: ${phase}`);
    }
  }
});
test('library selection uses champion identity and excludes creator-only entries',()=>{
  const library={mods:[{id:'1',champion:"Kai'Sa"},{id:'2',champion:'Kaisa',creatorHub:true},{id:'3',champion:'Aatrox'}]};
  assert.deepEqual(matchingSkins(library,'KaiSa').map(m=>m.id),['1']);
  assert.deepEqual(matchingSkins(library,null),[]);
  assert.equal(championKey('Cho’Gath'),'chogath');
  for(const [id,name] of [['MonkeyKing','Wukong'],['Nunu','Nunu & Willump'],['Renata','Renata Glasc']]){
    assert.equal(championKey(id),championKey(name));
    assert.equal(matchingSkins({mods:[{id:'skin',champion:id}]},name).length,1);
  }
});
test('placement follows reference and negative-origin monitors',()=>{
  const rect={x:0,y:0,width:1672,height:941};
  assert.deepEqual(overlayBounds(rect,'open'),{x:298,y:405,width:1076,height:453});
  assert.deepEqual(overlayBounds(rect,'tab'),{x:602,y:792,width:468,height:58});
  assert.deepEqual(overlayBounds({...rect,x:-1672,y:50},'tab'),{x:-1070,y:842,width:468,height:58});
  for(const width of [1024,1280,1600,1920]){
    const r={x:0,y:0,width,height:width*9/16};
    const open=overlayBounds(r,'open');assert.ok(open.y+open.height<r.height*.92);
  }
});
test('LTK Manager failure envelopes are never treated as success',()=>{
  assert.equal(unwrap({ok:true,value:42}),42);
  assert.throws(()=>unwrap({ok:false,error:'busy'}),/busy/);
  assert.equal(unwrap(null),null);
});

test('the League icon sits over the top-left logo and scales with the client',()=>{
  assert.deepEqual(launcherBounds({x:100,y:200,width:1600,height:900}),{x:120,y:212,width:72,height:72});
  assert.deepEqual(launcherBounds({x:0,y:0,width:1024,height:576}),{x:15,y:9,width:54,height:54});
  assert.deepEqual(launcherBounds({x:0,y:0,width:3840,height:2160}),{x:30,y:18,width:108,height:108});
  assert.deepEqual(launcherBounds({x:0,y:0,width:5120,height:900}),{x:20,y:12,width:72,height:72},'an ultrawide scales by its height');
});

test('the opened window is centred on the client unless it is larger',()=>{
  assert.deepEqual(centeredOn({x:100,y:50,width:1600,height:900},{width:1200,height:800}),{x:300,y:100});
  assert.deepEqual(centeredOn({x:100,y:50,width:1024,height:576},{width:1220,height:850}),{x:100,y:50});
});

test('versions are shown as two parts',()=>{
  assert.equal(shownVersion('1.5.0'),'1.5');assert.equal(shownVersion('2.0.0'),'2.0');assert.equal(shownVersion('1.0.4'),'1.0.4');
});

test('only a window really in front of League hides the panel',()=>{
  const client={pid:10,x:100,y:100,width:1600,height:900};
  const over={x:0,y:0,width:2560,height:1440},ownPid=20;
  // League itself, or nothing at all: a closing LTK can leave nothing in front.
  assert.equal(clientCovered(client,{pid:10,visible:true,rect:over},{ownPid}),false);
  assert.equal(clientCovered(client,null,{ownPid}),false);
  // A hidden window, as LTK Manager starting up, covers nothing.
  assert.equal(clientCovered(client,{pid:30,visible:false,rect:over},{ownPid}),false);
  assert.equal(clientCovered(client,{pid:30,visible:true,rect:null},{ownPid}),false);
  // Another monitor, and a small window at the edge.
  assert.equal(clientCovered(client,{pid:30,visible:true,rect:{x:2560,y:0,width:1920,height:1080}},{ownPid}),false);
  assert.equal(clientCovered(client,{pid:30,visible:true,rect:{x:0,y:0,width:300,height:300}},{ownPid}),false);
  // A real window over League hides it, and so does Friloverse's own lobby.
  assert.equal(clientCovered(client,{pid:30,visible:true,rect:over},{ownPid}),true);
  assert.equal(clientCovered(client,{pid:20,visible:true,rect:over},{ownPid}),true);
  // The panel itself being clicked never does.
  assert.equal(clientCovered(client,{pid:20,visible:true,rect:over},{ownPid,overlayFocused:true}),false);
});

test('a custom folder that cannot be read costs only the custom cards',async()=>{
  const good=await readCustomCards(async()=>({skins:['a']}),'Ahri','ahri',null,1);
  assert.deepEqual(good,{champion:'ahri',at:1,skins:['a'],error:''});
  const broken=async()=>{throw new Error('Folder is locked');};
  assert.deepEqual(await readCustomCards(broken,'Ahri','ahri',good,2),{champion:'ahri',at:2,skins:['a'],error:'Folder is locked'},'the last good list stands');
  assert.deepEqual(await readCustomCards(broken,'Zed','zed',good,3),{champion:'zed',at:3,skins:[],error:'Folder is locked'},'never another champion\'s');
});
