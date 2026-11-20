// Three temporary members on the real relay: the host leaves, and the other two must end up in one
// new room under the host every PC worked out (src/party-coordinator.mjs `successor`). Then the new
// host leaves too, and the last member must end up hosting a room of its own, not stranded.
// It installs nothing and does not touch LTK Manager.
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PartyCoordinator,successor} from '../src/party-coordinator.mjs';

const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const dirs=await Promise.all(['a','b','c'].map(name=>mkdtemp(path.join(tmpdir(),`friloverse-handover-${name}-`))));
const player=dataDir=>new PartyCoordinator({dataDir,version,findSkin:async()=>null});
const until=async(what,check,limit=300)=>{
  for(let i=0;i<limit;i++){if(check())return;await new Promise(done=>setTimeout(done,100));}
  throw new Error(`Timed out: ${what}`);
};
const [host,bea,cal]=dirs.map(player);
const connected=party=>party.client.state.status==='connected';
try{
  await host.enter('create',{name:'Hana',icon:''});
  await until('the room opened',()=>connected(host));
  const code=host.client.state.code;
  await bea.enter('join',{name:'Bea',icon:'',code});await cal.enter('join',{name:'Cal',icon:'',code});
  await until('everyone is in',()=>[host,bea,cal].every(party=>connected(party)&&party.client.state.members.length===3));
  host.setStealth(true);
  await until('stealth reached everyone',()=>[host,bea,cal].every(party=>party.snapshot().stealth===true));
  const plan=successor({code,hostId:host.client.clientId,members:bea.client.state.members});
  const started=Date.now();
  await host.leave();
  await until('the two left are in one new room',()=>[bea,cal].every(party=>connected(party)&&party.client.state.code===plan.codes[0]&&party.client.state.members.length===2));
  for(const party of [bea,cal]){
    assert.equal(party.client.state.members.find(member=>member.host)?.id,plan.hostId,'the host every PC worked out');
    assert.equal(party.handover,null);
    assert.equal(party.snapshot().stealth,true,'Stealth stayed on across the hand-over');
  }
  console.log(`The host left; ${plan.hostName} hosts room ${plan.codes[0]} (was ${code}) with Stealth preserved, everyone moved in ${Date.now()-started} ms.`);
  console.log(`Notices: ${JSON.stringify([bea,cal].map(party=>party.snapshot().notice))}`);
  // The new host leaves too: the last one keeps a party of one, as its own host.
  const [newHost,last]=plan.hostId===bea.client.clientId?[bea,cal]:[cal,bea];
  await newHost.leave();
  await until('the last member hosts a room of its own',()=>connected(last)&&last.client.state.members.length===1&&last.client.state.members[0].host);
  console.log(`The second host left as well; ${last.profile.name} now hosts ${last.client.state.code} alone. Party hand-over check passed.`);
}finally{
  for(const party of [host,bea,cal])party.dispose();
  await new Promise(done=>setTimeout(done,300));
  for(const dir of dirs)await rm(dir,{recursive:true,force:true});
}
process.exit(0);
