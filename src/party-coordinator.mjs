import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import WebSocket from 'ws';
import {PartyClient,compareVersions,createPartyCode,normalizePartyCode} from './fryilo-party/desktop-ui/party.mjs';
import {championKey,shownVersion} from './model.mjs';
import {LEGACY_STEALTH,PARTY_COMPATIBILITY,isStealthMark,markVersion,newerVersion,relayVersion,versionMark} from './party-version.mjs';
import {connectWithFailover} from './party-transport.mjs';
import {writeAtomic} from './atomic-file.mjs';

const SERVICE='wss://fryilo-party-relay.ogfryilo.workers.dev';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// A closing connection only reports its close once the relay has hung up too, which could leave a
// kicked player looking at the party for 30 s more. The close frame has already said why by then.
// Uses multi-IP + DoH failover so ISP Cloudflare IP blocks (e.g. LaLiga) route around blocked IPs.
class PartySocket extends WebSocket{
  constructor(url){
    super(url,{
      closeTimeout:1000,
      createConnection:(options,callback)=>{
        const host=options.hostname||options.host;
        const secure=String(url).startsWith('wss:');
        const port=Number(options.port)||(secure?443:80);
        connectWithFailover(host,port,{secure}).then(sock=>callback(null,sock),err=>callback(err));
      },
    });
  }
}
const SHA=/^[0-9a-f]{40}$/;
// Long enough to not hammer GitHub, short enough to still make this match.
const FIND_RETRY=10*1000;
const VERSION_REFUSED=/Everyone in (?:a|the) party (?:needs|must use)|Update FrYiLoCo/i;
// Long enough for a friend's new Riot list to arrive, short enough to still show this match.
const ART_RETRY=30*1000;
// Stealth was this exact mark up to 4.4. A host on 4.5 or newer sends its version with it.
export const STEALTH_MARK=LEGACY_STEALTH;
// These reports mean a member needs nobody to wait for them. 'armed' may still choose.
const CHOOSING=new Set(['selected','armed']);
// Host hand-over (6.0). The deployed relay closes a party when its host leaves, and it cannot
// change, so every member works out the same new host and room code from the room they were in:
// the new host opens that room and the others join it. Copies older than 6.0 cannot take part.
const HANDOVER_SINCE='6.0.0';
const HANDOVER_LIMIT=25*1000,JOIN_FIRST=600,JOIN_AGAIN=1000;
const HOST_LEFT=/host left/i;
const CODE_ALPHABET='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const digest=text=>createHash('sha256').update(text).digest();

/**
 * Who hosts after the host has gone, and the room codes to use (a second and third in case the
 * first is taken): random to the players, but the same on every PC, as each works it out from
 * the same room. Null when nobody left can host.
 */
export function successor(room,{leaving=room?.hostId}={}){
  const ids=[...new Set((room?.members||[]).filter(member=>member.id!==leaving&&member.id!==room.hostId)
    .filter(member=>{const version=markVersion(member.db);return version&&compareVersions(version,HANDOVER_SINCE)>=0;})
    .map(member=>member.id))].sort();
  if(!ids.length||!room.code)return null;
  const hostId=ids[digest(`${room.code}|${ids.join(',')}`).readUInt32BE(0)%ids.length];
  const codes=[0,1,2].map(attempt=>[...digest(`${room.code}|${hostId}|${attempt}`).subarray(0,4)].map(byte=>CODE_ALPHABET[byte%CODE_ALPHABET.length]).join(''));
  return {hostId,hostName:room.members.find(member=>member.id===hostId)?.name||'A friend',codes};
}

/** What a room is told about a pick: the hash of the archive, never the file. */
export function skinKey(champion,pick){
  const championId=championKey(champion);
  if(!pick||!SHA.test(pick.key||'')||!/^[a-z0-9]{1,40}$/.test(championId))return null;
  const relative=String(pick.label||'Custom skin').replace(/[\u0000-\u001f\u007f/\\]/g,' ').replace(/\.\.+/g,'.').trim().slice(0,120)||'Custom skin';
  return {source:'custom',championId,relative,sha:pick.key};
}

const MAX_MEMBER_NAME=12;

export class PartyCoordinator {
  constructor({dataDir,version,localPick=()=>null,findSkin=async()=>null,artFor=async()=>null,onFiles=()=>{},onChange=()=>{},onVersionRefused=()=>{},onConnection=()=>{},now=Date.now,endpoint=SERVICE,WebSocketImpl=PartySocket}) {
    Object.assign(this,{dataDir,version,localPick,findSkin,artFor,onFiles,onChange,onVersionRefused,onConnection,now});this.art=new Map();
    this.settingsPath=path.join(dataDir,'party-profile.json');
    this.profile={name:'',icon:'',recentIcons:[]};this.profileQueue=Promise.resolve();this.roomSkins=[];this.roomRevision=0;
    this.status='';this.error='';this.missing=[];this.busy=false;this.generation=0;this.timer=null;
    this.scheduled=false;this.disposed=false;this.syncFailed=false;this.found=new Map();this.retryAt=new Map();
    this.ownChampion=null;this.matchChampions=null;this.lastPersonal='';this.knownStealth=null;this.lastClose=null;
    this.client=new PartyClient({endpoint,clientId:randomUUID(),reconnectToken:randomBytes(32).toString('hex'),WebSocketImpl,
      onDiagnostic:text=>this.noteConnection(text),
      onChange:next=>{
        if(this.disposed)return;
        if(this.handover&&this.followHandover(next))return;
        // The room as it last was, so a host who leaves can be followed by everyone else.
        if(next.status==='connected'&&next.members.length)this.lastRoom={code:next.code,hostId:next.members.find(member=>member.host)?.id||'',
          members:next.members.map(({id,name,db})=>({id,name,db})),stealth:this.stealth()};
        // Someone whose connection was lost while the host left comes back to a closed room, and
        // follows the party too (the old host included, if it was its own connection that went).
        if(next.status==='idle'&&/Party not found/i.test(next.error||'')&&this.lastRoom&&!this.leaving
          &&this.handOver({rejoining:this.lastRoom.hostId===this.client?.clientId}))return;
        // A refused, ended or kicked party leaves no session. Forget its room
        // revision too, or a later room's lower revisions would be ignored.
        if(next.status==='idle'&&!this.client?.session)this.resetRoom();
        if(VERSION_REFUSED.test(next.error||'')&&!this.refusalSeen){this.refusalSeen=true;this.onVersionRefused();}
        this.emit();
      },onReady:()=>{this.lastPersonal='';this.refreshLocal({reconnected:true});},
      onSnapshot:(skins,_authoritative,revision)=>this.receive(skins,revision),
      onEnded:reason=>{
        if(HOST_LEFT.test(reason)&&this.handOver())return;
        this.lastRoom=null;this.error=reason;this.syncFailed=false;this.resetRoom();this.emit();
      }});
    // Friloverse cannot accidentally join a FrYiLoCo room.
    // The relay enables host controls for protocol-5 clients tagged 13.11+.
    // A compact Friloverse-specific fingerprint keeps the relay's WebSocket
    // version-refusal reason inside its 123-byte limit.
    this.client.setMeta({app:relayVersion(PARTY_COMPATIBILITY),db:versionMark(version)});
  }
  /** Why the relay connection closed, for the log. While it keeps failing, retrying every 10 s at most, that is one line. */
  noteConnection(text){
    if(!/^WebSocket closed/.test(text))return;
    const at=this.now(),repeat=text===this.lastClose?.text&&at-this.lastClose.at<60000;
    this.lastClose={text,at};
    if(!repeat)this.onConnection(text);
  }
  async load(){
    try{
      const p=JSON.parse(await readFile(this.settingsPath,'utf8'));
      const recent=Array.isArray(p.recentIcons)?p.recentIcons.filter(icon=>typeof icon==='string'&&/^\d{1,10}$/.test(icon)):[];
      const icon=String(p.icon||'');
      this.profile={name:String(p.name||'').slice(0,MAX_MEMBER_NAME),icon:/^\d{1,10}$/.test(icon)?icon:'',recentIcons:[...new Set(recent)].slice(0,6)};
    }catch{}
    this.emit();
  }
  snapshot(){
    let room=this.client.snapshot();
    // Between rooms while the party moves: still the party, not the lobby's start page.
    if(this.handover&&room.status!=='connected')room={...room,status:'reconnecting',code:this.handover.code,members:this.handover.members,error:''};
    const error=String(this.error||room.error||'');
    const displayedError=/Everyone in (?:a|the) party (?:needs|must use)/i.test(error)?'Everyone in the party must use the same Friloverse version.':error.replaceAll('FrYiLoCo','Friloverse');
    // Hidden here, so the windows never receive what Stealth keeps from them.
    const stealth=this.stealth();
    const shown=room.members.map(member=>({...member,version:markVersion(member.db),art:this.artOf(member)}));
    const members=stealth?shown.map(member=>member.id===this.client.clientId?member:{...member,playing:null,skin:null,art:null,hidden:true}):shown;
    const updateTo=newerVersion(room.members,this.version);
    return {...room,members,stealth,notice:this.notice||'',updateTo:updateTo?shownVersion(updateTo):'',selfId:this.client.clientId,profile:{...this.profile},syncing:this.busy,syncFailed:this.syncFailed,
      syncStatus:this.status,error:displayedError,missing:stealth?[]:[...this.missing]};
  }
  emit(){if(this.disposed)return;this.findArt();this.onChange(this.snapshot());}
  /** The picture for a member's skin, once this PC has found it. */
  artOf(member){
    const skin=member?.skin;
    return skin?.sha?this.art.get(`${championKey(skin.championId)}:${skin.sha}`)?.art||null:null;
  }
  /** Only the hash travels, so each PC looks the picture up by itself, once. */
  findArt(){
    for(const member of this.client?.state.members||[]){
      const skin=member.skin,champion=championKey(skin?.championId);
      if(!champion||!SHA.test(skin?.sha||''))continue;
      const key=`${champion}:${skin.sha}`,known=this.art.get(key);
      if(known&&(known.art||known.pending||this.now()<known.retryAt))continue;
      this.art.set(key,{art:null,pending:true});
      Promise.resolve().then(()=>this.artFor(champion,skin.sha)).catch(()=>null).then(art=>{
        this.art.set(key,{art:art||null,pending:false,retryAt:this.now()+ART_RETRY});
        if(art&&!this.disposed)this.emit();
      });
    }
  }
  /** Only the host's word counts. A room whose host has not been seen stays hidden. */
  stealth(){
    if(!this.client.session&&!this.handover)return false;
    const host=this.client.state.members.find(member=>member.host);
    if(host)this.knownStealth=isStealthMark(host.db);
    return this.knownStealth??true;
  }
  setStealth(on){
    const self=this.client.state.members.find(member=>member.id===this.client.clientId);
    if(!self?.host)throw new Error('Only the party host can change Stealth.');
    const db=versionMark(this.version,{stealth:on});
    if(!this.client.setMeta({app:this.client.meta.app,db})&&self.db!==db&&this.client.socket?.readyState===1){
      // The relay dropped the last change for arriving too fast: say it again.
      this.client.socket.send(JSON.stringify({type:'member-meta',...this.client.meta}));
    }
  }
  /** Drop everything learned from the previous room; restoration follows. */
  resetRoom(){
    const hadSkins=this.roomSkins.length>0;
    this.roomSkins=[];this.roomRevision=0;this.missing=[];this.lastPersonal='';this.knownStealth=null;this.found.clear();this.retryAt.clear();
    if(this.client)this.client.setMeta({app:this.client.meta.app,db:versionMark(this.version)});
    // Otherwise the footer keeps saying "Connecting…" after a refused join.
    this.status='';
    if(hadSkins){this.generation++;this.schedule(0);}
  }
  /** Local skin libraries changed (sync, withdrawal, new manifest): drop cached lookups. */
  invalidateCache(){
    this.found.clear();this.retryAt.clear();
    for(const [key,value] of this.art)if(!value.art&&!value.pending)this.art.delete(key);
    if(this.client.session&&!this.disposed){this.generation++;this.schedule(0);this.emit();}
  }
  saveProfile(name,icon,{rememberIcon=false}={}){
    const save=this.profileQueue.then(async()=>{
      const clean=String(name??'').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,MAX_MEMBER_NAME);
      const image=/^\d{1,10}$/.test(String(icon||''))?String(icon):'';
      const recentIcons=rememberIcon&&image?[image,...this.profile.recentIcons.filter(item=>item!==image)].slice(0,6):[...this.profile.recentIcons];
      // An empty box never forgets the name: the last one stays selected.
      const next={name:clean||this.profile.name,icon:image,recentIcons};
      await writeAtomic(this.settingsPath,JSON.stringify(next),{durable:true});
      this.profile=next;if(this.client.session)this.client.setIcon(image);this.emit();
    });
    this.profileQueue=save.catch(()=>{});return save;
  }
  /**
   * The host left and the relay closed the room: move everyone still here to the new host's room.
   * False when there is nobody to move to, and the party simply ends as before.
   */
  handOver({rejoining=false}={}){
    const room=this.lastRoom;this.lastRoom=null;
    if(!room||this.disposed||!this.profile.name)return false;
    const plan=successor(room,{leaving:rejoining?this.client.clientId:room.hostId});
    if(!plan)return false;
    const mine=plan.hostId===this.client.clientId;
    this.handover={...plan,mine,attempt:0,code:plan.codes[0],deadline:this.now()+HANDOVER_LIMIT,stealth:room.stealth,
      members:room.members.filter(member=>member.id!==room.hostId||member.id===this.client.clientId).map(member=>({...member,host:member.id===plan.hostId}))};
    this.error='';this.syncFailed=false;this.resetRoom();
    // Preserve Stealth across the handover from the first frame so picks never leak while moving.
    this.knownStealth=room.stealth;
    if(mine&&room.stealth)this.client.setMeta({app:this.client.meta.app,db:versionMark(this.version,{stealth:true})});
    clearTimeout(this.noticeTimer);
    this.notice=mine?'The host left. You are the new host: the party is moving to your room…':`The host left. ${plan.hostName} is the new host: moving the party…`;
    clearTimeout(this.handoverTimer);
    if(mine){
      // A taken code moves on to the next one everybody else will also try.
      let next=1;this.client.codeFactory=()=>plan.codes[next++]||createPartyCode();
      try{this.client.create(plan.codes[0],this.profile.name,this.profile.icon);}catch{this.endHandover();return false;}
    }else this.handoverTimer=setTimeout(()=>this.joinHandover(),JOIN_FIRST);
    this.emit();
    return true;
  }
  /** A member tries the new room until the new host has opened it. */
  joinHandover(){
    const plan=this.handover;
    if(!plan||plan.mine||this.disposed)return;
    if(this.now()>plan.deadline){this.endHandover('The host left, and the party could not move to the new host. Join again with their code.');return;}
    // The first code nearly always works; the others only if it was taken.
    plan.code=plan.codes[Math.floor(plan.attempt/6)%plan.codes.length];plan.attempt++;
    try{this.client.join(plan.code,this.profile.name,this.profile.icon);}catch{this.endHandover();}
  }
  /** What the client says while the party moves. True when the hand-over handled it. */
  followHandover(next){
    const plan=this.handover;
    if(next.status==='connected'){
      this.handover=null;clearTimeout(this.handoverTimer);this.client.codeFactory=()=>createPartyCode();
      this.notice=plan.mine?'The host left, so you are the host now.':`The host left, so ${plan.hostName} is the host now.`;
      clearTimeout(this.noticeTimer);this.noticeTimer=setTimeout(()=>{this.notice='';this.emit();},15000);this.noticeTimer.unref?.();
      if(plan.mine&&plan.stealth)try{this.setStealth(true);}catch{/* The room shows without it. */}
      return false;
    }
    if(next.status==='idle'&&!this.client.session){
      // Not open yet: try again. A new host that could not open any room gives up.
      if(!plan.mine&&/Party not found/i.test(next.error||'')){clearTimeout(this.handoverTimer);this.handoverTimer=setTimeout(()=>this.joinHandover(),JOIN_AGAIN);this.emit();return true;}
      this.endHandover(next.error?`The party could not move to the new host: ${next.error}`:undefined);return true;
    }
    this.emit();return true;
  }
  endHandover(message='The host left, so the party was closed.'){
    this.handover=null;clearTimeout(this.handoverTimer);clearTimeout(this.noticeTimer);this.client.codeFactory=()=>createPartyCode();
    if(this.client.session)this.client.leave();
    this.notice='';this.error=message;this.resetRoom();this.emit();
  }
  async enter(mode,{name,icon,code}={}) {
    if(!['create','join'].includes(mode))throw new Error('Unknown party action.');
    await this.saveProfile(name,icon);
    if(!this.profile.name)throw new Error('Enter your name first.');
    // A second click while the first was still saving the profile.
    if(this.client.session)return;
    const roomCode=mode==='create'?createPartyCode():normalizePartyCode(code);
    if(!/^[A-Z0-9]{4}$/.test(roomCode))throw new Error('Enter a four-character party code.');
    if(this.handover)this.endHandover('');
    clearTimeout(this.noticeTimer);this.lastRoom=null;this.notice='';
    this.resetRoom();
    this.refusalSeen=false;
    this.error='';this.syncFailed=false;this.status='Connecting to the party…';this.missing=[];
    try{this.client[mode](roomCode,this.profile.name,this.profile.icon);}
    catch(error){this.status='';throw error;}
    this.emit();
  }
  async leave(){
    // Leaving is not losing the host: nothing follows a party this player left.
    clearTimeout(this.noticeTimer);this.leaving=true;this.lastRoom=null;this.notice='';
    if(this.handover){this.handover=null;clearTimeout(this.handoverTimer);this.client.codeFactory=()=>createPartyCode();}
    try{this.client.leave();}finally{this.leaving=false;}
    this.resetRoom();this.generation++;
    this.error='';this.missing=[];this.status='';
    this.schedule(0);this.emit();
  }
  kick(id){return this.client.kick(id);}
  receive(skins,revision){
    if(!Number.isSafeInteger(revision)||revision<this.roomRevision)return;
    const next=Array.isArray(skins)?skins:[];
    // The same room said again (a resync, a member's report) changes nothing to look for. Looking
    // anyway counted as "getting a friend's skin" and could keep a ready game waiting.
    if(revision===this.roomRevision&&JSON.stringify(next)===JSON.stringify(this.roomSkins)){this.emit();return;}
    this.roomRevision=revision;this.roomSkins=next;this.generation++;
    this.schedule(150);this.emit();
  }
  /** Champions present in the current match (myTeam + theirTeam). Empty/null disables filtering. */
  setMatchChampions(champions){
    const keys=champions?[...champions].map(championKey).filter(Boolean).sort():[];
    const sig=keys.join(',');
    const prev=this.matchChampions?[...this.matchChampions].sort().join(','):'';
    if(sig===prev)return;
    this.matchChampions=keys.length?new Set(keys):null;
    if(this.client.session){this.generation++;this.schedule(0);}
  }
  /** League stops reporting the pick after launch, and peers still in draft need it. */
  observe(champion,phase){
    const next=champion||(['GameStart','InProgress','Reconnect'].includes(phase)?this.ownChampion:null);
    if(next!==this.ownChampion){
      this.ownChampion=next;this.generation++;
      if(this.client.session)this.schedule(0);
    }
    if(this.client.session)this.refreshLocal();
    else if(this.retryAt.size===0&&this.syncFailed){this.syncFailed=false;}
    const due=[...this.retryAt.values()].some(time=>time<=this.now());
    if(due&&!this.busy&&this.client.session)this.schedule(0);
  }
  /** Tell the room what this player has chosen. Nothing is sent when it is the same. */
  refreshLocal({reconnected=false}={}){
    if(!this.client.session)return;
    const champion=this.ownChampion,identity=skinKey(champion,this.localPick(champion));
    const current=JSON.stringify([championKey(champion)||null,identity]);
    if(current===this.lastPersonal)return;
    this.lastPersonal=current;
    this.client.setPlaying(championKey(champion)||null,false);
    // After a blip the relay still holds this. A new revision would make the whole party
    // prepare again, and League wait for them, just because one connection hiccuped.
    if(reconnected)this.client.resync(identity?[identity]:[],[]);
    else this.client.sendSnapshot(identity?[identity]:[],[]);
    this.emit();
  }
  schedule(delay=350){
    if(this.disposed)return;
    clearTimeout(this.timer);this.scheduled=true;
    this.timer=setTimeout(()=>{this.scheduled=false;void this.reconcile();},delay);this.timer.unref?.();
  }
  /** A friend's choice is still being turned into a file on this PC. */
  get settling(){return !!this.client.session&&(this.busy||this.scheduled);}
  /** Tell the room how this PC stands. The relay forgets it when anyone's skins change. */
  report(state){
    if(!this.client.session)return;
    const room=this.client.state;
    // A copy of 4.4 or older does not know 'active' and would wait for it.
    const word=state==='active'&&room.members.some(member=>member.id!==this.client.clientId&&!markVersion(member.db))?'prepared':state;
    // More stages mean more reports, and one the relay missed would stick: say it again until it is echoed.
    this.client.setPreparation(word,{refresh:room.members.find(member=>member.id===this.client.clientId)?.preparation!==word});
  }
  /**
   * Friends whose choice may still change: still in their grace period ('selected', 'armed'), or
   * with no report yet, as the relay forgets every report when anyone's skins change. A friend
   * whose PC is still preparing has chosen, so it holds nobody back (owner's decision, 2026-11-08).
   */
  choosing(){
    const room=this.client.state;
    if(!this.client.session||room.status!=='connected'||!this.client.preparationSupported)return [];
    return room.members.filter(member=>member.id!==this.client.clientId&&(!member.preparation||CHOOSING.has(member.preparation)))
      .map(member=>member.name||'a friend');
  }
  /** Find each friend's skin here; the engine loads them for this match. */
  async reconcile(){
    if(this.disposed)return;
    if(this.busy){this.rerun=true;return;}
    this.busy=true;this.rerun=false;
    const generation=this.generation;
    try{
      const own=championKey(this.ownChampion);
      const wanted=this.client.session?this.roomSkins:[];
      const files=new Map(),missing=[],current=new Set();let failed='',waiting=false;
      for(const selection of wanted){
        const champion=championKey(selection?.championId);
        if(!champion||champion===own)continue;
        // Skip sitting-out party members on champions not in this match (includes both teams for custom 5v5s).
        if(this.matchChampions?.size&&!this.matchChampions.has(champion))continue;
        const name=String(selection?.relative||'Custom skin').slice(0,120);
        if(selection?.source!=='custom'||!SHA.test(selection.sha||'')){missing.push({champion,name});continue;}
        const key=`${champion}:${selection.sha}`;
        current.add(key);
        let file=this.found.get(key);
        if(!file&&(this.retryAt.get(key)||0)<=this.now()){
          this.status=this.stealth()?'Getting a friend\'s skin…':`Getting ${name}…`;this.emit();
          try{
            file=await this.findSkin(champion,selection.sha);
            if(file){this.found.set(key,file);this.retryAt.delete(key);}
            // Always a new time: an old one counts as due, and held League back as "getting skins ready".
            else{this.retryAt.set(key,this.now()+FIND_RETRY);waiting=true;}
          }catch(error){this.retryAt.set(key,this.now()+FIND_RETRY);failed=error.message;}
        }else if(!file&&this.retryAt.has(key))waiting=true;
        if(this.disposed||generation!==this.generation)return;
        if(file)files.set(champion,file);
        else missing.push({champion,name});
      }
      // A friend who changed their mind leaves nothing to look for, and nothing due.
      for(const key of [...this.retryAt.keys()])if(!current.has(key))this.retryAt.delete(key);
      if(this.disposed||generation!==this.generation)return;
      this.missing=missing;this.onFiles([...files.values()]);
      this.syncFailed=!!failed||waiting&&this.syncFailed;
      if(failed)this.error=`A friend's skin could not be loaded: ${failed}`;
      else if(!waiting&&/^A friend's skin/.test(this.error))this.error='';
      this.status=!this.client.session?'':missing.length?'Some friends\' skins are not available on this PC.':wanted.length?'Party skins are ready for this match.':'';
    }finally{
      this.busy=false;if(!this.disposed)this.emit();
      if(!this.disposed&&(this.rerun||generation!==this.generation))this.schedule(250);
    }
  }
  async retry(){
    this.error='';this.syncFailed=false;this.retryAt.clear();this.found.clear();this.generation++;this.schedule(0);this.emit();
  }
  dispose(){this.disposed=true;this.generation++;clearTimeout(this.timer);clearTimeout(this.handoverTimer);clearTimeout(this.noticeTimer);this.client.leave();}
}
