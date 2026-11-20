// Watches a champion select and the game's start from outside Friloverse, so a missed skin can be
// told apart: what League did, what was on screen and what the player clicked, on one clock.
//   node scripts/watch-launch.mjs [--minutes=30]
// Changes nothing: it only reads League's client, Windows' windows, the mouse and the logs.
// Writes watch-logs/<time>/watch.log. (No screenshots: Windows' antivirus blocks a hidden screen capture.)
// It ends by itself 30 s after a game is in progress (a new draft starts that count again), or after --minutes.
import {createRequire} from 'node:module';
import {mkdirSync,appendFileSync,statSync,openSync,readSync,closeSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {leagueConnection,leagueGet,draftTimeLeft} from '../src/league-client.mjs';

const require=createRequire(import.meta.url);
const koffi=require('koffi');
const {listProcesses}=require('../src/windows-process.cjs');

const arg=name=>process.argv.find(item=>item.startsWith(`--${name}=`))?.split('=')[1];
const MINUTES=Number(arg('minutes'))||30;
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const folder=path.resolve('watch-logs',stamp);mkdirSync(folder,{recursive:true});
const logFile=path.join(folder,'watch.log');
const t0=Date.now();
function log(kind,text){
  const now=new Date(),line=`${now.toISOString()} +${String(Date.now()-t0).padStart(7)} ${kind.padEnd(8)} ${text}`;
  console.log(line);appendFileSync(logFile,line+'\n');
}

// --- Windows -------------------------------------------------------------------------------
const user=koffi.load('user32.dll');
const RECT=koffi.struct('WatchRect',{left:'int32',top:'int32',right:'int32',bottom:'int32'});
const POINT=koffi.struct('WatchPoint',{x:'int32',y:'int32'});
const findWindow=user.func('void * __stdcall FindWindowExW(void *parent, void *after, str16 klass, str16 title)');
const windowRect=user.func('bool __stdcall GetWindowRect(void *window, _Out_ WatchRect *rect)');
const isVisible=user.func('bool __stdcall IsWindowVisible(void *window)');
const isIconic=user.func('bool __stdcall IsIconic(void *window)');
const foreground=user.func('void * __stdcall GetForegroundWindow()');
const windowPid=user.func('uint32 __stdcall GetWindowThreadProcessId(void *window, _Out_ uint32 *pid)');
const windowText=user.func('int __stdcall GetWindowTextW(void *window, _Out_ uint16 *text, int max)');
const keyState=user.func('int16 __stdcall GetAsyncKeyState(int key)');
const cursorPos=user.func('bool __stdcall GetCursorPos(_Out_ WatchPoint *point)');
const fromPoint=user.func('void * __stdcall WindowFromPoint(WatchPoint point)');
const ancestor=user.func('void * __stdcall GetAncestor(void *window, uint32 flags)');
const exStyle=user.func('intptr_t __stdcall GetWindowLongPtrW(void *window, int index)');

const WATCHED=new Set(['leagueclientux.exe','league of legends.exe','friloverse-skins.exe','ltk-manager.exe']);
let names=new Map(),namesAt=0;
function refreshNames(){names=new Map(listProcesses().map(row=>[row.pid,row.name]));namesAt=Date.now();}
const nameOf=pid=>{if(!names.has(pid)&&Date.now()-namesAt>200)refreshNames();return names.get(pid)||`pid ${pid}`;};
const pidOf=hwnd=>{const out=[0];windowPid(hwnd,out);return out[0];};
const titleOf=hwnd=>{const buffer=new Uint16Array(256),length=windowText(hwnd,buffer,256);return String.fromCharCode(...buffer.slice(0,Math.max(0,length)));};
const rectOf=hwnd=>{const rect={};return windowRect(hwnd,rect)?`${rect.left},${rect.top} ${rect.right-rect.left}x${rect.bottom-rect.top}`:'?';};
const describe=hwnd=>hwnd?`${nameOf(pidOf(hwnd))} "${titleOf(hwnd)}" @${rectOf(hwnd)}`:'nothing';

/** Every top-level window of League, its game, Friloverse and LTK: shown or not, where. */
function windows(){
  const rows=[];let hwnd=null;
  while((hwnd=findWindow(null,hwnd,null,null))){
    const name=nameOf(pidOf(hwnd));
    if(!WATCHED.has(name))continue;
    const title=titleOf(hwnd);
    // Input-method helpers and League's tiny hidden windows are noise.
    if(title==='Default IME'||title==='MSCTFIME UI')continue;
    const box={};windowRect(hwnd,box);
    if(!isVisible(hwnd)&&(!title||box.right-box.left<200))continue;
    const topmost=(Number(exStyle(hwnd,-20))&0x8)?' topmost':'';
    rows.push(`${name} "${title}" ${isVisible(hwnd)?(isIconic(hwnd)?'minimized':'shown'):'hidden'}${topmost} @${rectOf(hwnd)}`);
  }
  return rows.sort();
}

// --- League's client ---------------------------------------------------------------------------
let phase='',lastDraft='',inProgressAt=0,client=null,leagueBusy=false;
async function league(){
  if(leagueBusy)return;leagueBusy=true;
  try{
    client||=await leagueConnection();
    const now=await leagueGet(client,'/lol-gameflow/v1/gameflow-phase',{timeout:800});
    if(now!==phase){log('phase',`${phase||'(none)'} -> ${now}`);phase=now;if(now==='ChampSelect')inProgressAt=0;if(now==='InProgress')inProgressAt||=Date.now();}
    if(phase==='ChampSelect'){
      const session=await leagueGet(client,'/lol-champ-select/v1/session',{timeout:800}).catch(()=>null);
      const me=session?.myTeam?.find(row=>row.cellId===session.localPlayerCellId);
      const left=draftTimeLeft(session);
      const text=`stage ${session?.timer?.phase||'?'} | clock ${left==null?'none':`${(left/1000).toFixed(0)} s`} | champion ${me?.championId??'?'} skin ${me?.selectedSkinId??'?'}`;
      if(text!==lastDraft){log('draft',text);lastDraft=text;}
    }
  }catch(error){
    if(phase!=='(unreachable)'){log('league',`client unreachable: ${error.message}`);phase='(unreachable)';}
    client=null;
  }finally{leagueBusy=false;}
}

// --- Logs written by Friloverse and LTK --------------------------------------------------------
const data=path.join(process.env.APPDATA,'friloverse-skins');
const ltkLogs=path.join(process.env.APPDATA,'dev.leaguetoolkit.manager','logs');
const tails=new Map();
function newestLtk(){try{return readdirSync(ltkLogs).filter(name=>name.startsWith('ltk-manager')).map(name=>path.join(ltkLogs,name)).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs)[0];}catch{return null;}}
function tail(file,kind,keep=()=>true){
  if(!file)return;
  let size;try{size=statSync(file).size;}catch{return;}
  if(!tails.has(file)){tails.set(file,size);return;}
  const from=tails.get(file);
  if(size<from){tails.set(file,0);return;}
  if(size===from)return;
  const handle=openSync(file,'r'),buffer=Buffer.alloc(size-from);
  try{readSync(handle,buffer,0,buffer.length,from);}finally{closeSync(handle);}
  tails.set(file,size);
  for(const line of buffer.toString('utf8').split(/\r?\n/))if(line.trim()&&keep(line))log(kind,line.slice(0,400));
}
function tailAll(){
  tail(path.join(data,'hold.log'),'hold');
  tail(path.join(data,'errors.log'),'friloverse');
  tail(newestLtk(),'ltk',line=>!/\bDEBUG\b|\bTRACE\b/.test(line));
}

// --- The loop ---------------------------------------------------------------------------------
let lastWindows='',lastGames='',lastFront='',mouseDown=false,tick=0;
refreshNames();tailAll();
log('start',`watching for ${MINUTES} min; writing ${folder}`);
for(const row of windows())log('window',row);
lastWindows=windows().join('\n');

function look(){
  tick++;
  // The mouse, every 10 ms: a click and exactly what it landed on.
  const down=(keyState(0x01)&0x8000)!==0;
  if(down!==mouseDown){
    mouseDown=down;
    const point={};cursorPos(point);
    const hit=fromPoint(point),root=hit?ancestor(hit,2):null;
    log(down?'click':'release',`at ${point.x},${point.y} on ${describe(root)}`);
  }
  if(tick%5)return;
  // Windows, the game process and the foreground, every 50 ms.
  refreshNames();
  const games=[...names].filter(([,name])=>name==='league of legends.exe').map(([pid])=>pid).join(',');
  if(games!==lastGames){log('game',games?`League of Legends.exe running: pid ${games}`:'no game process');lastGames=games;}
  const rows=windows(),text=rows.join('\n');
  if(text!==lastWindows){
    const before=new Set(lastWindows.split('\n')),after=new Set(rows);
    for(const row of before)if(row&&!after.has(row))log('window',`- ${row}`);
    for(const row of rows)if(!before.has(row))log('window',`+ ${row}`);
    lastWindows=text;
  }
  const front=describe(foreground());
  if(front!==lastFront){log('front',front);lastFront=front;}
  if(tick%10===0){void league();tailAll();}
}
const timer=setInterval(()=>{
  try{look();}catch(error){log('error',error.message);}
  const over=Date.now()-t0>MINUTES*60000||(inProgressAt&&Date.now()-inProgressAt>30000);
  if(over){clearInterval(timer);tailAll();log('end',`done. Log: ${logFile}`);process.exit(0);}
},10);
