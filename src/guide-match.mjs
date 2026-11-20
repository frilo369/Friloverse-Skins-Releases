// Local match identification, adapted from FrYiLoCo's insights watcher.
const queues={
  arena:new Set([1700,1701,1704,1710,1720,1731,1732,1740,1750]),
  mayhem:new Set([2400,2401,2403,2405,2410,2450,3240,3270,3280]),
  aram:new Set([450,62,63,64,65,900,930,931]),
  rift:new Set([400,420,430,440,480,490,700,830,840,850,3140]),
};
export const LOBBY_PICK_QUEUES=new Set([480,490]);
export const LOBBY_PICK_MODES=new Set(['SWIFTPLAY','BRAWL']);
const active=phase=>['GameStart','InProgress','Reconnect'].includes(phase);
export const guideReady=sighting=>active(sighting?.phase)&&['rift','aram','arena','mayhem'].includes(sighting.mode)&&validChampion(sighting.champion);
const validChampion=id=>Number.isSafeInteger(id)&&id>0&&id<=10000;
export function modeForQueue(id){return Object.keys(queues).find(mode=>queues[mode].has(id))||null;}
export function modeForMap(id){return id===12?'aram':[1,11].includes(id)?'rift':null;}
export function isLobbyPickLobby(lobby){
  const config=lobby?.gameConfig;
  const queueId=Number(config?.queueId??lobby?.queueId);
  const mode=String(config?.gameMode??lobby?.gameMode??'').toUpperCase();
  return LOBBY_PICK_QUEUES.has(queueId)||LOBBY_PICK_MODES.has(mode);
}
/** Extracts up to two queued champions and their chosen League skin slots from a Swiftplay/Quickplay lobby. */
export function swiftplaySlotsFromLobby(lobby){
  if(!isLobbyPickLobby(lobby))return [];
  const local=lobby?.localMember;
  if(!local||typeof local!=='object')return [];
  const rawSlots=Array.isArray(local.playerSlots)&&local.playerSlots.length
    ?local.playerSlots
    :[{championId:local.primaryChampionId,skinId:local.primarySkinId},{championId:local.secondaryChampionId,skinId:local.secondarySkinId}];
  const out=[],seen=new Set();
  for(const slot of rawSlots){
    const championId=Number(slot?.championId);
    if(!validChampion(championId)||seen.has(championId))continue;
    seen.add(championId);
    const skinId=Number(slot?.skinId);
    const skinSlot=Number.isSafeInteger(skinId)&&Math.floor(skinId/1000)===championId?skinId%1000:0;
    out.push({championId,skinSlot,position:String(slot?.positionPreference||'')});
  }
  return out;
}
function walk(value,read){
  if(!value||typeof value!=='object')return null;
  const found=read(value);if(Number.isSafeInteger(found))return found;
  for(const child of Object.values(value)){const result=walk(child,read);if(result!==null)return result;}
  return null;
}
export const queueFromSession=session=>walk(session,value=>Number.isSafeInteger(value.queueId)?value.queueId:value.queue?.id);
export const mapFromSession=session=>walk(session,value=>Number.isSafeInteger(value.map?.id)?value.map.id:value.mapId);
export const customFromSession=session=>session?.isCustomGame===true||session?.gameData?.isCustomGame===true;
// League fills in the draft row while the player only has a champion selected, so the row alone
// proves nothing: the player's own pick has to be finished. No pick of their own means League
// assigned the champion (ARAM and the like). The row stays the answer after that, for swaps.
function pickConfirmed(session,member){
  if(session.timer?.phase==='FINALIZATION')return true;
  const actions=Array.isArray(session.actions)?session.actions.flat():[];
  const ownPicks=actions.filter(action=>action?.type==='pick'&&action.actorCellId===session.localPlayerCellId);
  if(ownPicks.length)return ownPicks.every(action=>action.completed===true);
  // No pick action exists for this player (ARAM, or pre-pick intent): ensure not merely intenting.
  if(member?.isPickIntenting===true||(Number.isSafeInteger(member?.championPickIntent)&&member.championPickIntent>0&&!member.championId))return false;
  return true;
}
export function championFromDraft(session){
  if(!Number.isSafeInteger(session?.localPlayerCellId)||session.localPlayerCellId<0||!Array.isArray(session.myTeam))return null;
  const member=session.myTeam.find(row=>row?.cellId===session.localPlayerCellId);
  if(!member||!pickConfirmed(session,member))return null;
  return validChampion(member.championId)?member.championId:null;
}
export function championFromGameflow(session,player){
  const puuid=value=>typeof value?.puuid==='string'&&/[1-9a-f]/i.test(value.puuid)?value.puuid:null;
  const summoner=value=>Number.isSafeInteger(value?.summonerId)&&value.summonerId>0?value.summonerId:null;
  const ownPuuid=puuid(player),ownId=summoner(player);
  if(!ownPuuid&&!ownId)return null;
  const found=new Set();
  for(const field of ['playerChampionSelections','teamOne','teamTwo']){
    for(const row of Array.isArray(session?.gameData?.[field])?session.gameData[field]:[]){
      const other=puuid(row);
      const same=ownPuuid&&other?ownPuuid===other:!!ownId&&ownId===summoner(row);
      if(same&&validChampion(row.championId))found.add(row.championId);
    }
  }
  return found.size===1?[...found][0]:null;
}
// League's draft can read as having no champion for a moment; longer than this, it really has none.
const CHAMPION_BLIP=2000;
export function nextSighting(previous,reading){
  const phase=reading.phase,continuing=active(phase)&&(active(previous.phase)||previous.phase==='ChampSelect');
  const draft=phase==='ChampSelect';
  if(!draft&&!active(phase))return {phase,mode:null,champion:null};
  let mode=modeForQueue(reading.queue);
  if(!mode&&reading.queue==null&&(continuing||draft&&previous.phase==='ChampSelect'))mode=previous.mode;
  // The same map is used by different queues (including Mayhem). Only use a
  // map as the fallback when the client explicitly identifies a custom game.
  if(!mode&&reading.custom===true)mode=modeForMap(reading.map);
  let champion=(continuing||draft&&previous.phase==='ChampSelect')?previous.champion:null,lostAt;
  if(reading.draft!==undefined&&reading.draft!==null){
    const picked=championFromDraft(reading.draft);
    if(draft&&!picked&&champion){
      const now=reading.now??Date.now();
      lostAt=previous.lostAt??now;
      if(now-lostAt>=CHAMPION_BLIP){champion=null;lostAt=undefined;}
    }else if(draft||picked)champion=picked;
  }
  if(!champion&&active(phase)&&validChampion(reading.recovered))champion=reading.recovered;
  return {phase,mode:mode||null,champion:champion||null,...(lostAt===undefined?{}:{lostAt})};
}
export function championSlug(name){return String(name||'').toLowerCase().replace(/[^a-z0-9 -]/g,'').trim().replace(/[ -]+/g,'-');}
export function guideTarget(sighting,champions){
  if(!guideReady(sighting))return null;
  const champion=champions.find(row=>Number(row.key)===sighting.champion);
  if(sighting.mode==='mayhem')return {mode:'mayhem',champion:sighting.champion,url:`friloverse-guide://local/mayhem.html?champion=${sighting.champion}`};
  const slug=championSlug(champion?.name);if(!slug)return null;
  const segment=sighting.mode==='rift'?'':`${sighting.mode}/`;
  return {mode:sighting.mode,champion:sighting.champion,url:`https://www.metasrc.com/lol/${segment}champions/${slug}/build`};
}
