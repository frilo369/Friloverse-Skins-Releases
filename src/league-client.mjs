import {readFile,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import https from 'node:https';
import path from 'node:path';

const DEFAULT_FOLDER='C:/Riot Games/League of Legends';
const RIOT_SETTINGS='C:/ProgramData/Riot Games/Metadata/league_of_legends.live/league_of_legends.live.product_settings.yaml';
const KEEP_ALIVE_AGENT=new https.Agent({keepAlive:true,maxSockets:4,rejectUnauthorized:false});
const require=createRequire(import.meta.url);
let winProcess=null;
function loadWinProcess(){
  if(process.platform!=='win32')return null;
  if(winProcess!==null)return winProcess;
  try{winProcess=require('./windows-process.cjs');}catch{winProcess=false;}
  return winProcess||null;
}

export function parseProductInstall(text){
  const match=String(text).match(/^\s*product_install_full_path:\s*["']?(.+?)["']?\s*$/m);
  return match?match[1]:null;
}
function withPid(connection,pid){
  const out={port:connection.port,password:connection.password};
  Object.defineProperty(out,'pid',{value:Number.isInteger(pid)&&pid>0?pid:0,enumerable:false,configurable:true});
  return out;
}
export function parseLockfile(text){
  const parts=String(text).trim().split(':'),pid=Number(parts[1]),port=Number(parts[2]);
  if(parts.length!==5||!Number.isInteger(port)||port<1||port>65535||!parts[3]||parts[4]!=='https')return null;
  return withPid({port,password:parts[3]},pid);
}
export function parseClientCmdline(cmdline){
  if(typeof cmdline!=='string'||!cmdline)return null;
  const port=Number(/--app-port=(\d+)/i.exec(cmdline)?.[1]);
  const password=/--remoting-auth-token=([A-Za-z0-9_-]+)/i.exec(cmdline)?.[1];
  if(!Number.isInteger(port)||port<1||port>65535||!password)return null;
  return {port,password};
}

function runningClientInfo(){
  const win=loadWinProcess();
  if(!win)return {pids:new Map(),folders:[],uxPids:[]};
  try{
    const pids=new Map(),folders=[],uxPids=[];
    for(const row of win.listProcesses()){
      if(row.name==='leagueclient.exe'||row.name==='leagueclientux.exe'){
        pids.set(row.pid,row.name);
        if(row.name==='leagueclientux.exe')uxPids.push(row.pid);
        const image=win.queryProcessImage?.(row.pid);
        if(image){
          const dir=path.dirname(image);
          folders.push(dir,path.dirname(dir));
        }
      }
    }
    return {pids,folders:[...new Set(folders)],uxPids};
  }catch{return {pids:new Map(),folders:[],uxPids:[]};}
}

/** Places League may be installed: LTK Manager's choice, Riot's record, and any running client. */
export async function leagueFolders({appData=process.env.APPDATA,read=readFile,includeRunning=true}={}){
  const folders=[];
  try{
    const saved=JSON.parse(await read(path.join(appData,'dev.leaguetoolkit.manager','settings.json'),'utf8'));
    if(typeof saved?.leaguePath==='string'&&saved.leaguePath)folders.push(saved.leaguePath);
  }catch{/* Not set up yet. */}
  try{const riot=parseProductInstall(await read(RIOT_SETTINGS,'utf8'));if(riot)folders.push(riot);}catch{/* Not installed the usual way. */}
  if(includeRunning&&read===readFile){
    for(const dir of runningClientInfo().folders)folders.push(dir);
  }
  folders.push(DEFAULT_FOLDER);
  return [...new Set(folders)];
}
export async function leagueFolder(options){return (await leagueFolders(options))[0];}

let cachedLock=null;

/** The running client's address and one-time password. They are never logged. */
export async function leagueConnection({appData=process.env.APPDATA,read=readFile,modified=async file=>(await stat(file)).mtimeMs}={}){
  const realFs=read===readFile;
  if(realFs&&cachedLock&&cachedLock.appData===appData){
    try{
      const at=await modified(cachedLock.file);
      if(at===cachedLock.mtimeMs)return cachedLock.connection;
    }catch{cachedLock=null;}
  }
  const live=realFs?runningClientInfo():null;
  let best=null,bestFile='',bestAt=-1,bestAlive=false;
  for(const folder of await leagueFolders({appData,read,includeRunning:!!live})){
    try{
      const file=path.join(folder,'lockfile'),found=parseLockfile(await read(file,'utf8'));
      if(!found)continue;
      const alive=!live||!live.pids.size||!found.pid||live.pids.has(found.pid);
      // Prefer a lockfile whose PID matches a live LeagueClient process; tie-break by newest mtime.
      const at=await modified(file).catch(()=>0);
      if((alive&&!bestAlive)||(alive===bestAlive&&at>bestAt)){best=found;bestFile=file;bestAt=at;bestAlive=alive;}
    }catch{/* The client is closed, or lives elsewhere. */}
  }
  if(best&&(bestAlive||!live?.uxPids.length)){
    if(realFs&&bestFile)cachedLock={appData,file:bestFile,mtimeMs:bestAt,connection:best};
    return best;
  }
  // Vanguard-safe fallback when regional clients leave `lockfile` empty or stale.
  if(live?.uxPids.length){
    const win=loadWinProcess();
    for(const pid of live.uxPids){
      const found=parseClientCmdline(win?.queryProcessCmdline?.(pid));
      if(found)return withPid(found,pid);
    }
  }
  if(best)return best;
  cachedLock=null;
  throw new Error('League client unavailable');
}

function send(client,method,endpoint,body,{limit=4*1024*1024,timeout=1800}={}){
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?null:JSON.stringify(body);
    const req=https.request({hostname:'127.0.0.1',port:client.port,path:endpoint,method,auth:`riot:${client.password}`,agent:KEEP_ALIVE_AGENT,rejectUnauthorized:false,timeout,
      headers:payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>limit)req.destroy(new Error('League sent too much data.'));else chunks.push(chunk);});
      res.on('end',()=>{
        if(res.statusCode<200||res.statusCode>=300)return reject(new Error('League endpoint unavailable'));
        const text=Buffer.concat(chunks).toString('utf8');
        if(!text)return resolve(null);
        try{resolve(JSON.parse(text));}catch{reject(new Error('Invalid League response'));}
      });
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(new Error('League did not answer in time.')));req.on('error',reject);
    if(payload)req.write(payload);
    req.end();
  });
}
export const leagueGet=(client,endpoint,options)=>send(client,'GET',endpoint,undefined,options);
export const leaguePatch=(client,endpoint,body,options)=>send(client,'PATCH',endpoint,body,options);

/** League's own Reconnect button: starts the game of the match in progress again. */
export async function reconnectGame({connect=leagueConnection}={}){
  await send(await connect(),'POST','/lol-gameflow/v1/reconnect');
}
/** Which skin number each champion on the team has selected. Chromas have numbers of their own. */
export async function teamSkinSlots({connect=leagueConnection,get=leagueGet}={}){
  return champSelectSkinSlots(await get(await connect(),'/lol-champ-select/v1/session'));
}
export function champSelectSkinSlots(session){
  const slots=new Map();
  for(const member of Array.isArray(session?.myTeam)?session.myTeam:[]){
    const {championId,selectedSkinId:skin}=member||{};
    if(Number.isSafeInteger(championId)&&championId>0&&Number.isSafeInteger(skin)&&Math.floor(skin/1000)===championId)slots.set(championId,skin%1000);
  }
  return slots;
}

/** Final slots from the match data, for champions we know were on our team. */
export function gameflowSkinSlots(session,team,localChampion){
  const slots=new Map(),ambiguous=new Set();
  const selections=session?.gameData?.playerChampionSelections;
  for(const row of Array.isArray(selections)?selections:[]){
    const {championId,selectedSkinIndex:index}=row||{};
    if(!championId||(!team.has(championId)&&championId!==localChampion)||!Number.isSafeInteger(index)||index<0)continue;
    if(index>=1000&&Math.floor(index/1000)!==championId)continue;
    const slot=index%1000;
    if(slots.has(championId)&&slots.get(championId)!==slot)ambiguous.add(championId);
    slots.set(championId,slot);
  }
  for(const champion of ambiguous)slots.delete(champion);
  return slots;
}
/**
 * Milliseconds left on the draft's clock, or null when it cannot promise any: no clock, paused,
 * or without limit, as in Practice Tool. League can keep serving the same reading, so its age is
 * taken off (FrYiLoCo's `champ_select_clock`).
 */
export function draftTimeLeft(session,now=Date.now()){
  const timer=session?.timer,left=timer?.adjustedTimeLeftInPhase;
  if(!timer||timer.isInfinite||timer.isPaused||!Number.isFinite(left))return null;
  const age=now-timer.internalNowInEpochMs;
  return Math.max(0,left-(age>=0&&age<=300000?age:0));
}
/** Whether the draft clock can actually launch the game right now (FINALIZATION, infinite, or no timer). */
export function draftLaunchImminent(session){
  const phase=String(session?.timer?.phase||'').toUpperCase();
  if(!phase||session?.timer?.isInfinite)return true;
  return phase==='FINALIZATION';
}
/** The team's selected skins and the draft's clock, from one reading. */
export const draftReading=(session,now=Date.now())=>({slots:champSelectSkinSlots(session),left:draftTimeLeft(session,now),imminent:draftLaunchImminent(session)});
export async function readDraft({connect=leagueConnection,get=leagueGet,now=Date.now}={}){
  return draftReading(await get(await connect(),'/lol-champ-select/v1/session'),now());
}
// Nothing here ever changes the skin selected in League's client (owner, 2026-11-18): that
// selection is the player's, and every Friloverse skin is put over it instead (skin-slots.mjs).
