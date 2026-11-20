import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {isFormSkin} from './fryilo-catalog/catalog.mjs';

/**
 * Local Skins (10.0, owner's request): the player's own skins, in
 * `Database\LocalSkins\<Champion>`, one folder per champion made by Friloverse. They are never
 * synced, replaced, withdrawn or shared. A player can import a Divine skin here. A friend has no copy of them, so the party sees a
 * stand-in instead, one of the champion's latest Riot skins (below).
 */
export const LOCAL_SKINS='LocalSkins';
// How many of a champion's newest Riot skins the stand-in is drawn from.
export const STAND_IN_FROM=4;

export function localSkinsRoot(databaseRoot){return path.join(databaseRoot,LOCAL_SKINS);}

/** A champion's name as a Windows folder name: "Kai'Sa", "Dr. Mundo" and "Nunu & Willump" stay as they are. */
export function championFolder(name){
  const clean=String(name||'').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'').replace(/[. ]+$/,'').trim();
  return clean&&!/^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)?clean:'';
}

/**
 * The folder and an empty folder per champion, at every start, so a champion released since
 * gets one with the update that knows it. Folders already there (and the player's files in them)
 * are left alone. Returns how many champion folders could not be made.
 */
export async function ensureLocalSkinFolders(root,champions=[],{makeDir=mkdir}={}){
  await makeDir(root,{recursive:true});
  const names=[...new Set(champions.map(row=>championFolder(row?.name)).filter(Boolean))];
  let failed=0;
  await Promise.all(names.map(name=>makeDir(path.join(root,name),{recursive:true}).catch(()=>{failed++;})));
  return failed;
}

/**
 * A champion's latest Riot skins, newest first: the skins themselves, never their chromas
 * (a level below in the list), selectable forms (900 and up) or the base skin. League numbers
 * a champion's skins in the order they came out, so the highest numbers are the latest.
 */
export function latestRiotSkins(entries=[],count=STAND_IN_FROM){
  return entries.filter(skin=>Number.isSafeInteger(skin?.id)&&skin.id%1000!==0&&!isFormSkin(skin)
    &&String(skin.relative||'').split('/').length===3&&/^[0-9a-f]{40}$/.test(String(skin.sha||'')))
    .sort((a,b)=>b.id-a.id).slice(0,count);
}

/** One of those at random, as the party is told about a pick: its hash and its name. Null if the champion has none. */
export function chooseStandIn(entries,random=Math.random){
  const latest=latestRiotSkins(entries);
  if(!latest.length)return null;
  const skin=latest[Math.min(latest.length-1,Math.floor(random()*latest.length))];
  return {id:`riot:${skin.id}`,key:skin.sha,label:skin.name||'Riot skin'};
}
