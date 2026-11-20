import {normalizePartyVersion as cleanAppVersion} from '../../shared/party-version.mjs';
export {cleanAppVersion};
/** New messages are an optional extension of protocol 5; older clients keep their barrier. */
export function supportsIndependentLaunch(app) {
  const match=/^(\d+)\.(\d+)\./.exec(cleanAppVersion(app));
  return Boolean(match && (Number(match[1])>12 || Number(match[1])===12 && Number(match[2])>=12));
}

/** Hosts can remove members, and a host leaving closes the party (13.11). A
 * room of older clients keeps its earlier rules on the same relay. */
export function supportsHostControls(app) {
  const match=/^(\d+)\.(\d+)\./.exec(cleanAppVersion(app));
  return Boolean(match && (Number(match[1])>13 || Number(match[1])===13 && Number(match[2])>=11));
}

/** Close codes that end a membership for good: the client must not rejoin. */
export const KICKED_CLOSE = 4012;
export const DISBANDED_CLOSE = 4013;

/** A party name, as long as the client draws it beside the member's icon. */
export const MAX_MEMBER_NAME = 12;

export const PARTY_CODE_PATTERN = /^[A-Z0-9]{4}$/;
export const MEMBER_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

export function cleanMemberName(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,MAX_MEMBER_NAME);
}

/** The Arena item a member chose as their icon, as an item id or nothing. */
export function cleanMemberIcon(value) {
  const icon = String(value ?? '').trim();
  return /^[0-9]{1,10}$/.test(icon) ? icon : '';
}

/** The skin database a member has installed, as the date of its commit and the
 * commit's id (`2026-09-27T14:24:11Z~6550e69c67ea`), or nothing. The date is what
 * orders two databases; the id is what tells two of the same day apart. */
export function cleanDatabaseVersion(value) {
  const version = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z~[0-9a-f]{7,40}$/.test(version) ? version : '';
}

/** A champion id as skin keys carry it, or nothing. */
function cleanChampionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 40 ? value : null;
}

export function validSkinKey(value) {
  return Boolean(value &&
    (value.source === 'official' || value.source === 'custom') &&
    typeof value.championId === 'string' && value.championId.length > 0 && value.championId.length <= 40 &&
    typeof value.relative === 'string' && value.relative.length > 0 && value.relative.length <= 500 &&
    !value.relative.includes('..'));
}

/** Standalone packages are matched by contents, never by a PC's import id. */
export function validModKey(value) {
  return Boolean(value && typeof value.sha === 'string' && /^[0-9a-f]{40}$/.test(value.sha)
    && typeof value.relative === 'string' && value.relative.length > 0 && value.relative.length <= 500
    && !value.relative.includes('..') && !/[\u0000-\u001f\u007f]/.test(value.relative)
    && !/^(?:[a-z]:|[\\/])/i.test(value.relative)
    && /\.(?:fantome|modpkg)$/i.test(value.relative));
}

function cleanModKey(mod) { return {relative:mod.relative.replaceAll('\\','/'),sha:mod.sha}; }

export function aggregateMemberMods(memberStates={}) {
  const byContents=new Map();
  for(const [,state] of Object.entries(memberStates).sort(([left],[right])=>left.localeCompare(right))) {
    for(const mod of Array.isArray(state?.mods) ? state.mods : []) {
      if(validModKey(mod) && !byContents.has(mod.sha)) byContents.set(mod.sha,cleanModKey(mod));
    }
  }
  return [...byContents.values()].sort((left,right)=>left.sha.localeCompare(right.sha));
}

export function allMembersReady(members) {
  return Array.isArray(members) && members.length > 0 && members.every(member=>member?.ready === true);
}

/** Whether a message is dropped for arriving too fast.
 *
 * Only skin and icon messages are bursty, and a burst must never swallow a Ready
 * press or a Leave: those are one click each, and losing one costs a round. */
export function isRateLimited(messageType, messageCount) {
  const bursty = messageType === 'sync' || messageType === 'member-icon' || messageType === 'member-meta' || messageType === 'launch-begin' || messageType === 'launch-fallback';
  return bursty && messageCount > 5;
}

export function parseClientMessage(raw) {
  if(typeof raw !== 'string' || raw.length > 131072) return null;
  let message;
  try { message=JSON.parse(raw); } catch { return null; }
  const attempt=typeof message?.attempt==='string' && /^[a-zA-Z0-9-]{8,64}$/.test(message.attempt);
  if(message?.type==='launch-begin' && attempt) return {type:'launch-begin',attempt:message.attempt};
  if(message?.type==='launch-fallback' && attempt && Number.isSafeInteger(message.revision) && message.revision>=0
    && Array.isArray(message.members) && message.members.length>0 && message.members.length<=8
    && new Set(message.members).size===message.members.length && message.members.every(id=>typeof id==='string' && MEMBER_ID_PATTERN.test(id)))
    return {type:'launch-fallback',attempt:message.attempt,revision:message.revision,members:message.members};
  if(message?.type==='launch-preparation' && attempt && Number.isSafeInteger(message.sequence) && message.sequence>0
    && ['prepared','error','partial'].includes(message.state)) return {type:'launch-preparation',attempt:message.attempt,sequence:message.sequence,state:message.state};
  if(message?.type==='preparation'  && Number.isSafeInteger(message.revision) && message.revision>=0 && ['selected','syncing','preparing','prepared','partial','armed','active','error'].includes(message.state)) return {type:'preparation',revision:message.revision,state:message.state};
  if(message?.type === 'sync' && Array.isArray(message.skins) && message.skins.length <= 300 && message.skins.every(validSkinKey)) {
    const hasMods=Object.hasOwn(message,'mods');
    if(hasMods && (!Array.isArray(message.mods) || message.mods.length > 100 || !message.mods.every(validModKey))) return null;
    const hasRevision=Object.hasOwn(message,'clientRevision');
    if(hasRevision && (!Number.isSafeInteger(message.clientRevision) || message.clientRevision < 0)) return null;
    const byChampion=new Map(message.skins.map(skin => [skin.championId,cleanSkinKey(skin)]));
    // The champion this member is playing, so their pick for it wins the room.
    return {type:'sync',clientRevision:hasRevision ? message.clientRevision : null,skins:[...byChampion.values()],playing:cleanChampionId(message.playing),
      ...(hasMods ? {mods:[...new Map(message.mods.map(mod=>[mod.sha,cleanModKey(mod)])).values()]} : {})};
  }
  if(message?.type === 'member-icon' && typeof message.icon === 'string' && (message.icon.trim() === '' || /^[0-9]{1,10}$/.test(message.icon.trim()))) {
    return {type:'member-icon',icon:cleanMemberIcon(message.icon)};
  }
  if(message?.type === 'member-meta' && typeof message.app === 'string' && typeof message.db === 'string') {
    return {type:'member-meta',app:cleanAppVersion(message.app),db:cleanDatabaseVersion(message.db)};
  }
  if(message?.type === 'ready-state' && typeof message.ready === 'boolean') return {type:'ready-state',ready:message.ready,...(attempt?{attempt:message.attempt}:{})};
  if(message?.type === 'leave') return {type:'leave'};
  if(message?.type === 'kick' && typeof message.member === 'string' && MEMBER_ID_PATTERN.test(message.member)) return {type:'kick',member:message.member};
  return null;
}

/**
 * The room's skins: one per champion, the newest member change winning, except
 * that a member's pick for the champion they are playing wins over everyone
 * else's. Without that, a friend's leftover pick for your champion replaced
 * yours whenever they changed any skin of their own.
 */
export function aggregateMemberSkins(memberStates={}) {
  const ordered=Object.entries(memberStates).sort(([leftId,left],[rightId,right]) =>
    (Number(left?.revision) || 0) - (Number(right?.revision) || 0) || leftId.localeCompare(rightId)
  );
  const byChampion=new Map();
  for(const [,state] of ordered) {
    for(const skin of Array.isArray(state?.skins) ? state.skins : []) {
      if(validSkinKey(skin)) byChampion.set(skin.championId,cleanSkinKey(skin));
    }
  }
  for(const [,state] of ordered) {
    const playing=cleanChampionId(state?.playing);
    const own=playing && (Array.isArray(state?.skins) ? state.skins : []).find(skin => validSkinKey(skin) && skin.championId === playing);
    if(own) byChampion.set(playing,cleanSkinKey(own));
    // The owner choosing no replacement is also a choice. Legacy clients
    // without `playing` keep the existing newest-selection behavior.
    else if(playing) byChampion.delete(playing);
  }
  return [...byChampion.values()].sort((left,right)=>left.championId.localeCompare(right.championId));
}

/** A custom skin's key may also carry Git's name for its contents, which is how
 * a member whose copy has another file name still finds it. */
function cleanSkinKey(skin) {
  const key={source:skin.source,championId:skin.championId,relative:skin.relative};
  if(typeof skin.sha === 'string' && /^[0-9a-f]{40}$/.test(skin.sha)) key.sha=skin.sha;
  return key;
}
