import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket,{WebSocketServer} from 'ws';
import {LeagueEvents,TOPICS,socketRequest} from '../src/league-events.mjs';
import {GuideWatcher} from '../src/guide-lcu.mjs';
import {draftReading} from '../src/league-client.mjs';

const until=async done=>{for(let i=0;i<1000&&!done();i++)await new Promise(next=>setTimeout(next,5));assert.ok(done(),'it never happened');};

/** A stand-in for League's client: the same socket, without Riot's certificate. */
async function standIn(){
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise(done=>server.once('listening',done));
  const s={server,port:server.address().port,sockets:[],requests:[],subscribed:[]};
  server.on('connection',(socket,request)=>{
    s.sockets.push(socket);s.requests.push({authorization:request.headers.authorization,protocol:socket.protocol});
    socket.on('message',data=>s.subscribed.push(JSON.parse(String(data))));
  });
  s.open=client=>{const {protocol,options}=socketRequest(client);return new WebSocket(`ws://127.0.0.1:${client.port}/`,protocol,options);};
  s.close=()=>new Promise(done=>{for(const socket of server.clients)socket.terminate();server.close(done);});
  return s;
}

test('the request to League\'s client: this PC only, its password in the header, never in the address',()=>{
  const {url,protocol,options}=socketRequest({port:54321,password:'secret'});
  assert.equal(url,'wss://127.0.0.1:54321/');
  assert.equal(protocol,'wamp');
  assert.equal(options.headers.Authorization,`Basic ${Buffer.from('riot:secret').toString('base64')}`);
  assert.equal(options.rejectUnauthorized,false,'Riot\'s certificate is self-signed');
});

test('it asks for the phase and the draft, and passes on only those',async()=>{
  const s=await standIn(),heard=[];
  const events=new LeagueEvents(topic=>heard.push(topic),{open:s.open});
  try{
    events.use({port:s.port,password:'secret'});
    await until(()=>s.subscribed.length===2&&events.live);
    assert.deepEqual(s.requests,[{authorization:`Basic ${Buffer.from('riot:secret').toString('base64')}`,protocol:'wamp'}]);
    assert.deepEqual(s.subscribed,TOPICS.map(topic=>[5,topic]));
    assert.deepEqual(heard,['open'],'whatever changed while nobody listened is looked at');
    const socket=s.sockets[0];
    socket.send(JSON.stringify([8,TOPICS[0],{uri:'/lol-gameflow/v1/gameflow-phase',eventType:'Update',data:'GameStart'}]));
    socket.send('not json');
    socket.send(JSON.stringify([8,'OnJsonApiEvent_lol-chat_v1_me',{}]));
    socket.send(JSON.stringify([3,TOPICS[0]]));
    socket.send(JSON.stringify([8,TOPICS[1],{uri:'/lol-champ-select/v1/session',eventType:'Update',data:{}}]));
    await until(()=>heard.length>=3);
    assert.deepEqual(heard,['open',TOPICS[0],TOPICS[1]]);
    // The same client again is already listened to.
    events.use({port:s.port,password:'secret'});
    await new Promise(done=>setTimeout(done,30));
    assert.equal(s.sockets.length,1);
  }finally{events.stop();await s.close();}
});

test('a lost socket is opened again, but not in a hurry; a restarted client at once',async()=>{
  const s=await standIn();let now=1000;
  const events=new LeagueEvents(()=>{},{open:s.open,now:()=>now,retry:2000});
  try{
    const client={port:s.port,password:'one'};
    events.use(client);await until(()=>events.live);
    s.sockets[0].terminate();await until(()=>!events.live&&!events.socket);
    now=2999;events.use(client);
    await new Promise(done=>setTimeout(done,30));
    assert.equal(s.sockets.length,1,'not again inside two seconds');
    now=3000;events.use(client);await until(()=>events.live);
    assert.equal(s.sockets.length,2);
    // League's client was restarted: a new password, so the old socket is of no use.
    events.use({port:s.port,password:'two'});await until(()=>s.sockets.length===3&&events.live);
    assert.equal(s.requests[2].authorization,`Basic ${Buffer.from('riot:two').toString('base64')}`);
    events.stop();
    assert.equal(events.live,false);
    events.use(client);
    await new Promise(done=>setTimeout(done,30));
    assert.equal(s.sockets.length,3,'nothing after it was stopped');
  }finally{events.stop();await s.close();}
});

test('a client that cannot be reached, or an incomplete answer, costs nothing',async()=>{
  const opened=[];
  const events=new LeagueEvents(()=>{},{open:client=>{opened.push(client);throw new Error('refused');}});
  events.use({});events.use({port:1});events.use(null);
  assert.equal(opened.length,0,'nothing to connect to');
  events.use({port:1,password:'x'});
  assert.equal(opened.length,1);
  assert.equal(events.live,false);
  events.stop();
});

test('an event makes the watcher look now, and once more after a look under way',async()=>{
  let phase='ChampSelect',release=null,asked=0;const seen=[];let poke;const stops=[];
  const watcher=new GuideWatcher(sighting=>seen.push(sighting.phase),{
    readConnection:async()=>({port:1,password:'x'}),
    request:async(_client,endpoint)=>{
      if(!endpoint.endsWith('gameflow-phase'))return null;
      asked++;
      // What League's client held when it was asked.
      const read=phase;
      if(release!==null)await new Promise(go=>{release=go;});
      return read;
    },
    listen:onEvent=>{poke=onEvent;return {use(){},stop(){stops.push(1);}};},
  });
  watcher.poke();await until(()=>seen.length===1);
  assert.deepEqual(seen,['ChampSelect']);
  // A slow look: three events arrive while it is under way.
  release=()=>{};
  const slow=watcher.poll();
  await until(()=>asked===2);
  phase='GameStart';watcher.poke();watcher.poke();watcher.poke();
  assert.equal(asked,2,'one look at a time');
  const first=release;release=null;first();await slow;
  await until(()=>seen.length===3);
  assert.deepEqual(seen,['ChampSelect','ChampSelect','GameStart'],'the look under way read the moment before, so one more follows');
  await new Promise(done=>setTimeout(done,20));
  assert.equal(asked,3,'three events, one more look');
  // start() hands its poke to the socket, and stop() closes it.
  watcher.poll=async()=>{};
  watcher.start();assert.equal(typeof poke,'function');
  watcher.stop();assert.equal(stops.length,1);
});

test('the watcher keeps the draft it read, for the skins selected in the client and the clock',async()=>{
  const draft={localPlayerCellId:0,timer:{adjustedTimeLeftInPhase:9000,internalNowInEpochMs:5000},myTeam:[{cellId:0,championId:103,selectedSkinId:103066}],actions:[]};
  let phase='ChampSelect',used=0;
  const watcher=new GuideWatcher(()=>{},{
    readConnection:async()=>({port:1,password:'x'}),
    request:async(_client,endpoint)=>endpoint.endsWith('gameflow-phase')?phase:endpoint.endsWith('champ-select/v1/session')?draft:null,
  });
  watcher.events={use(){used++;},stop(){}};
  await watcher.poll();
  assert.equal(watcher.draft,draft);
  assert.equal(used,1,'the client that answered is the one to listen to');
  const {slots,left}=draftReading(watcher.draft,5400);
  assert.deepEqual([...slots],[[103,66]]);
  assert.equal(left,8600,'the reading\'s age comes off its clock');
  // The draft closes with the game: an old reading must not pass for the draft's clock.
  phase='GameStart';await watcher.poll();
  assert.equal(watcher.draft,null);
  phase='ChampSelect';await watcher.poll();assert.equal(watcher.draft,draft);
  watcher.readConnection=async()=>{throw new Error('offline');};
  await watcher.poll();
  assert.equal(watcher.draft,null,'no reading while the client is out of reach');
  watcher.stop();
});

test('final skin slots survive disappearing draft data and reset between drafts',async()=>{
  let phase='ChampSelect',game=null;
  let draft={localPlayerCellId:0,myTeam:[{cellId:0,championId:103,selectedSkinId:103066},{cellId:1,championId:99,selectedSkinId:99007}]};
  const watcher=new GuideWatcher(()=>{},{readConnection:async()=>({}),request:async(_client,endpoint)=>
    endpoint.endsWith('gameflow-phase')?phase:endpoint.endsWith('champ-select/v1/session')?draft:game});
  await watcher.poll();
  assert.deepEqual([...watcher.skinSlots],[[103,66],[99,7]]);
  draft={...draft,myTeam:[{cellId:0,championId:103},{cellId:1,championId:99}]};
  await watcher.poll();
  assert.deepEqual([...watcher.skinSlots],[[103,66],[99,7]],'partial reads do not erase a slot');
  phase='GameStart';draft=null;
  game={gameData:{playerChampionSelections:[{championId:103,selectedSkinIndex:103086},{championId:99,selectedSkinIndex:0},
    {championId:238,selectedSkinIndex:55}]}};
  await watcher.poll();
  assert.deepEqual([...watcher.skinSlots],[[103,86],[99,0]],'last-second chroma and base choices are authoritative');
  phase='Reconnect';game=null;
  await watcher.poll();
  assert.deepEqual([...watcher.skinSlots],[[103,86],[99,0]]);
  phase='ChampSelect';
  await watcher.poll();
  assert.equal(watcher.skinSlots.size,0);
});
