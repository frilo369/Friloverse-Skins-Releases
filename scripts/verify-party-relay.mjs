// Two temporary Friloverse clients against the existing relay. No skin files or
// personal data are sent. Explicit invocation only; no deployment is involved.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import WebSocket from 'ws';
import {PartyClient,createPartyCode} from '../src/fryilo-party/desktop-ui/party.mjs';
import {relayVersion} from '../src/party-version.mjs';
import {STEALTH_MARK} from '../src/party-coordinator.mjs';

const endpoint=process.env.FRILOVERSE_PARTY_URL||'wss://fryilo-party-relay.ogfryilo.workers.dev';
const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
function client(){
  const result={snapshots:[],ended:''};
  result.party=new PartyClient({endpoint,clientId:randomUUID(),reconnectToken:randomBytes(32).toString('hex'),WebSocketImpl:WebSocket,
    onSnapshot:skins=>result.snapshots.push(skins),onEnded:reason=>result.ended=reason});
  result.party.setMeta({app:relayVersion(version),db:''});return result;
}
async function until(predicate,label,ms=12000){
  const end=Date.now()+ms;
  while(Date.now()<end){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error(`Timed out: ${label}`);
}
const host=client(),guest=client(),wrongVersion=client(),code=createPartyCode();
try{
  host.party.create(code,'TestHost','');
  await until(()=>host.party.state.status==='connected','host creation');
  guest.party.join(host.party.state.code,'TestPeer','');
  await until(()=>guest.party.state.status==='connected'&&host.party.state.members.length===2,'join and presence');
  wrongVersion.party.setMeta({app:relayVersion('999.0.0'),db:''});
  wrongVersion.party.join(host.party.state.code,'WrongVer','');
  await until(()=>wrongVersion.party.state.status==='idle'&&Boolean(wrongVersion.party.state.error),'version refusal');
  assert.equal(host.party.state.members.length,2);
  const skin={source:'custom',championId:'aatrox',relative:'Test skin',sha:'a'.repeat(40)};
  host.party.setPlaying('aatrox',false);host.party.sendSnapshot([skin]);
  await until(()=>guest.snapshots.some(skins=>skins.some(s=>s.sha===skin.sha)),'selection relay');
  guest.party.socket.terminate();
  await until(()=>guest.party.state.status==='reconnecting','reconnect begins');
  await until(()=>guest.party.state.status==='connected'&&host.party.state.members.length===2,'authenticated reconnect');
  // Stealth reaches a guest through the deployed relay, and clears again.
  const seenHostMark=()=>guest.party.state.members.find(member=>member.host)?.db;
  host.party.setMeta({app:host.party.meta.app,db:STEALTH_MARK});
  await until(()=>seenHostMark()===STEALTH_MARK,'stealth on');
  host.party.setMeta({app:host.party.meta.app,db:''});
  await until(()=>!seenHostMark(),'stealth off');
  assert.ok(host.party.kick(guest.party.clientId));
  await until(()=>Boolean(guest.ended),'host kick');
  console.log('Live relay: create, join, version refusal, selection, reconnect, stealth, and host removal passed.');
}finally{wrongVersion.party.leave();guest.party.leave();host.party.leave();await new Promise(done=>setTimeout(done,200));}
process.exit(0);
