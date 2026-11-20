import {createHash} from 'node:crypto';
import {compareVersions} from './fryilo-party/desktop-ui/party.mjs';

// Who can share a party. Only what travels between PCs decides that: a hash and a champion,
// the same on every PC. Bump this only when that changes. It used to be the app version, and
// with silent updates friends were refused for up to an hour each time one PC updated first.
export const PARTY_COMPATIBILITY='friloverse-party-1';

// The relay's version-refusal text is sent as a WebSocket close reason, which
// cannot exceed 123 bytes. Keep both version tags short even for long app labels.
// 40 bits encoded in base 36 give a stable eight-character version fingerprint.
export function relayVersion(version){
  const digest=createHash('sha256').update(String(version)).digest('hex').slice(0,10);
  return `13.11.0-d${BigInt(`0x${digest}`).toString(36).padStart(8,'0')}`;
}

// The app version and Stealth travel in the member's database field, which the deployed relay
// already shares with everyone. It must look like a date~hash or the relay drops it, so 4.5.0
// is written 0004-05-00T00:00:00Z. The hash part says whether Stealth is on.
const STEALTH_HASH='5ea17f0',PLAIN_HASH='f11e0f0';
/** What a host on 4.4 or older sends for Stealth: a date, not a version. */
export const LEGACY_STEALTH=`2000-01-01T00:00:00Z~${STEALTH_HASH}`;
const MARK=/^(\d{4})-(\d{2})-(\d{2})T00:00:00Z~([0-9a-f]{7})$/;

export function versionMark(version,{stealth=false}={}){
  const [major,minor,patch]=String(version).split('.').map(Number);
  const pad=(value,size)=>String(Number.isSafeInteger(value)&&value>=0?value:0).padStart(size,'0').slice(-size);
  return `${pad(major,4)}-${pad(minor,2)}-${pad(patch,2)}T00:00:00Z~${stealth?STEALTH_HASH:PLAIN_HASH}`;
}
/** The version a member announced, or '' for a copy too old to say. */
export function markVersion(db){
  const found=MARK.exec(String(db||''));
  if(!found||String(db)===LEGACY_STEALTH)return '';
  return `${Number(found[1])}.${Number(found[2])}.${Number(found[3])}`;
}
export function isStealthMark(db){return String(db||'').endsWith(`~${STEALTH_HASH}`);}
/** The newest version anyone here announced, when it is newer than this copy. */
export function newerVersion(members,mine){
  let newest='';
  for(const member of members||[]){
    const version=markVersion(member?.db);
    if(version&&compareVersions(version,mine)>0&&(!newest||compareVersions(version,newest)>0))newest=version;
  }
  return newest;
}
