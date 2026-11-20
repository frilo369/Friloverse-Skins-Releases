// Two temporary clients on the real relay: each one's pick must reach the other as a
// content hash and turn into a file. It installs nothing and does not touch LTK Manager.
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PartyCoordinator} from '../src/party-coordinator.mjs';
import {shownVersion} from '../src/model.mjs';

const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const sha=letter=>letter.repeat(40);
const dirs=await Promise.all(['a','b'].map(name=>mkdtemp(path.join(tmpdir(),`friloverse-party-${name}-`))));
function player(dataDir,champion,letter,label){
  const f={files:[],champion};
  f.party=new PartyCoordinator({dataDir,version,localPick:()=>({key:sha(letter),file:'C:/never-sent.fantome',label}),
    findSkin:async(wanted,key)=>({key,file:`C:/found/${wanted}.fantome`,label:'found'}),onFiles:files=>{f.files=files;}});
  f.party.observe(champion,'ChampSelect');
  return f;
}
const until=async(what,check)=>{
  for(let i=0;i<200;i++){if(check())return;await new Promise(done=>setTimeout(done,100));}
  throw new Error(`Timed out: ${what}`);
};
const host=player(dirs[0],'Aatrox','a','Test Aatrox'),guest=player(dirs[1],'Briar','b','Test Briar');
try{
  await host.party.enter('create',{name:'Host',icon:''});
  await until('the room opened',()=>host.party.client.state.status==='connected');
  const code=host.party.client.state.code;
  await guest.party.enter('join',{name:'Guest',icon:'',code});
  await until('the guest joined',()=>guest.party.client.state.status==='connected');
  await until('the host got the guest\'s skin',()=>host.files.length===1);
  await until('the guest got the host\'s skin',()=>guest.files.length===1);
  assert.equal(host.files[0].file,'C:/found/briar.fantome');
  assert.equal(guest.files[0].file,'C:/found/aatrox.fantome');
  assert.doesNotMatch(JSON.stringify(host.party.roomSkins),/never-sent/);
  console.log('Skins crossed the real relay as hashes:',JSON.stringify(host.party.roomSkins.map(skin=>[skin.championId,skin.relative])));
  // Who the game waits for, as the hold asks: the same report FrYiLoCo's party uses.
  const keepReporting=setInterval(()=>{host.party.report(host.state);guest.party.report(guest.state);},100);
  host.state='selected';guest.state='selected';
  await until('both wait for each other',()=>host.party.choosing().join()==='Guest'&&guest.party.choosing().join()==='Host');
  guest.state='prepared';
  await until('the host saw the guest ready',()=>host.party.choosing().length===0);
  assert.deepEqual(guest.party.choosing(),['Host'],'the guest still waits for the host');
  host.state='prepared';
  await until('the guest saw the host ready',()=>guest.party.choosing().length===0);
  guest.state='selected';
  await until('a friend going back to choosing holds the game again',()=>host.party.choosing().join()==='Guest');
  guest.state='prepared';
  await until('ready again',()=>host.party.choosing().length===0);
  // A new pick changes what everyone needs, so the relay forgets every report until it is sent again.
  const revision=host.party.client.preparationRevision;
  clearInterval(keepReporting);
  host.party.localPick=()=>({key:sha('c'),file:'C:/never-sent.fantome',label:'Second pick'});host.party.lastPersonal='';host.party.refreshLocal();
  await until('a new pick resets the reports',()=>guest.party.client.preparationRevision>revision&&guest.party.choosing().join()==='Host');
  console.log('The whole-party wait works on the real relay.');
  // What the lobby shows travels too: the version behind the update pop-up, each stage, a skin's hash for its picture.
  host.party.setStealth(false);
  guest.party.version='0.1.0';guest.party.resetRoom();
  await until('the guest was told of the newer version',()=>guest.party.snapshot().updateTo===shownVersion(version));
  assert.equal(host.party.snapshot().updateTo,'','the host has nothing to update to');
  assert.equal(guest.party.snapshot().members.find(member=>member.host).version,version);
  const stages=setInterval(()=>{guest.party.report(guest.state);},100);
  for(const stage of ['syncing','preparing','armed','prepared','active']){
    guest.state=stage;
    await until(`the host saw ${stage}`,()=>host.party.snapshot().members.find(member=>!member.host)?.preparation===stage);
  }
  clearInterval(stages);
  assert.match(host.party.snapshot().members.find(member=>!member.host).skin?.sha||'',/^[0-9a-f]{40}$/,'a member\'s skin carries its hash');
  console.log('The version, every stage and the skin\'s hash reached the other PC.');
  await guest.party.leave();
  await until('the guest left',()=>host.party.client.state.members.length===1);
  await until('the host dropped the guest\'s skin',()=>host.files.length===0);
  console.log('Leaving took the skin away. Party relay check passed.');
}finally{
  host.party.dispose();guest.party.dispose();
  await new Promise(done=>setTimeout(done,300));
  for(const dir of dirs)await rm(dir,{recursive:true,force:true});
}
process.exit(0);
