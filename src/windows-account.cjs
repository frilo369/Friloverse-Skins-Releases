// Windows account, UAC, process-elevation, and AppCompatFlags\Layers (`RUNASADMIN`) preflight
// checks + automatic cleanup of `RUNASADMIN` on `ltk_launcher.exe`.
//
// LTK Manager refuses to patch when:
//  - Windows runs every program elevated (EnableLUA == 0 or built-in Administrator shell),
//  - League or Riot executables carry `RUNASADMIN` (or LeagueClient runs elevated),
//  - LTK Manager / ltk_patcher_host.exe / ltk_launcher.exe carry `RUNASADMIN` (error 740 / VRF00000007).
const {execFile}=require('node:child_process');
const path=require('node:path');
const {promisify}=require('node:util');

const execFileAsync=promisify(execFile);
const LAYERS_SUBKEY='Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers';
const POLICIES_KEY='HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';
const LEAGUE_EXE=/(?:^|\\)(?:league|riot)[^\\]*\.exe$/i;
const LTK_EXE=/(?:^|\\)(?:ltk[- ]manager|ltk_patcher_host)\.exe$/i;

let winNative=null;
function loadNative(){
  if(process.platform!=='win32')return null;
  if(winNative!==null)return winNative;
  try{
    const koffi=require('koffi');
    const kernel=koffi.load('kernel32.dll');
    const advapi=koffi.load('advapi32.dll');
    const user32=koffi.load('user32.dll');
    winNative={
      openProcess:kernel.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      closeHandle:kernel.func('bool __stdcall CloseHandle(void *handle)'),
      openToken:advapi.func('bool __stdcall OpenProcessToken(void *proc, uint32 access, void **token)'),
      getTokenInfo:advapi.func('bool __stdcall GetTokenInformation(void *token, uint32 cls, void *buf, uint32 len, uint32 *ret)'),
      getShellWindow:user32.func('void * __stdcall GetShellWindow()'),
      getWindowThreadProcessId:user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, uint32 *pid)'),
    };
  }catch{winNative=false;}
  return winNative||null;
}

const TOKEN_QUERY=0x0008,PROCESS_QUERY_LIMITED_INFORMATION=0x1000;
const TOKEN_ELEVATION=20,TOKEN_INTEGRITY_LEVEL=25;
const SECURITY_MANDATORY_HIGH_RID=0x3000;

/** Whether `pid` has an elevated token (read-only, PROCESS_QUERY_LIMITED_INFORMATION only). */
function processElevated(pid){
  const n=loadNative();
  if(!n||!Number.isInteger(pid)||pid<=0)return null;
  const proc=n.openProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid);
  if(!proc)return null;
  const tokenOut=[null];
  try{
    if(!n.openToken(proc,TOKEN_QUERY,tokenOut)||!tokenOut[0])return null;
    try{
      const buf=Buffer.alloc(8),ret=[0];
      if(!n.getTokenInfo(tokenOut[0],TOKEN_ELEVATION,buf,4,ret))return null;
      return buf.readUInt32LE(0)!==0;
    }finally{n.closeHandle(tokenOut[0]);}
  }finally{n.closeHandle(proc);}
}

/** Mandatory integrity RID of `pid` (0x2000 = Medium, 0x3000 = High, 0x4000 = System), or null. */
function processIntegrityRid(pid){
  const n=loadNative();
  if(!n||!Number.isInteger(pid)||pid<=0)return null;
  const proc=n.openProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid);
  if(!proc)return null;
  const tokenOut=[null];
  try{
    if(!n.openToken(proc,TOKEN_QUERY,tokenOut)||!tokenOut[0])return null;
    try{
      const buf=Buffer.alloc(256),ret=[0];
      if(!n.getTokenInfo(tokenOut[0],TOKEN_INTEGRITY_LEVEL,buf,buf.length,ret))return null;
      // TOKEN_MANDATORY_LABEL: SID_AND_ATTRIBUTES { PSID Sid, DWORD Attributes } followed by SID bytes.
      // On 64-bit Windows, SID begins immediately after the 16-byte struct; its SubAuthorityCount is byte +1
      // and the integrity RID is the last 4-byte SubAuthority.
      const sidAt=process.arch==='x64'||process.arch==='arm64'?16:8;
      if(ret[0]<sidAt+12)return null;
      const subCount=buf[sidAt+1];
      const ridAt=sidAt+8+(subCount-1)*4;
      if(subCount<1||ridAt+4>ret[0])return null;
      return buf.readUInt32LE(ridAt);
    }finally{n.closeHandle(tokenOut[0]);}
  }finally{n.closeHandle(proc);}
}

function shellPid(){
  const n=loadNative();
  if(!n)return 0;
  const hwnd=n.getShellWindow();
  if(!hwnd)return 0;
  const pid=[0];
  n.getWindowThreadProcessId(hwnd,pid);
  return pid[0]||0;
}

/** Parse `reg query` output for a key's string values: `[{name, value}]`. */
function parseRegStrings(stdout){
  const rows=[];
  for(const raw of String(stdout||'').split(/\r?\n/)){
    const match=/^\s+(.+?)\s+REG_SZ\s+(.*)$/i.exec(raw);
    if(match)rows.push({name:match[1].trim(),value:match[2].trim()});
  }
  return rows;
}

const hasRunAsAdmin=value=>/\bRUNASADMIN\b/i.test(String(value||''));

/** Strip only `RUNASADMIN` from an AppCompatFlags\Layers value, keeping all other tokens intact. */
function withoutRunAsAdmin(value){
  const tokens=String(value||'').trim().split(/\s+/).filter(Boolean).filter(token=>token.toUpperCase()!=='RUNASADMIN');
  if(!tokens.length||(tokens.length===1&&tokens[0]==='~'))return '';
  return tokens.join(' ');
}

async function queryLayers(hive,{exec=execFileAsync}={}){
  if(process.platform!=='win32')return [];
  try{
    const {stdout}=await exec('reg',['query',`${hive}\\${LAYERS_SUBKEY}`,'/reg:64'],{windowsHide:true,timeout:3000});
    return parseRegStrings(stdout).map(row=>({...row,hive}));
  }catch{return [];}
}

async function readEnableLua({exec=execFileAsync}={}){
  if(process.platform!=='win32')return null;
  try{
    const {stdout}=await exec('reg',['query',POLICIES_KEY,'/v','EnableLUA','/reg:64'],{windowsHide:true,timeout:3000});
    const match=/EnableLUA\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/i.exec(stdout);
    return match?Number(match[1]):null;
  }catch{return null;}
}

/** Check whether Windows runs every program as administrator (UAC disabled or High-integrity shell). */
async function checkWindowsAccount({exec=execFileAsync}={}){
  if(process.platform!=='win32')return {ok:true,issues:[]};
  const issues=[];
  const enableLua=await readEnableLua({exec});
  const explorer=shellPid();
  const rid=explorer?processIntegrityRid(explorer):null;
  const highShell=rid!==null&&rid>=SECURITY_MANDATORY_HIGH_RID;
  if(enableLua===0||highShell){
    issues.push({
      code:'WINDOWS_ADMIN_SHELL',
      title:'Windows is running every program as administrator',
      detail:enableLua===0
        ?'Windows UAC (EnableLUA) is turned off, so every program starts elevated.'
        :'Your Windows desktop (explorer.exe) is running at High integrity (built-in Administrator account or UAC off).',
      fix:'LTK Manager refuses to patch when Windows runs every program as administrator. Turn Windows User Account Control (UAC) back on, or sign in with a standard Windows account, then restart your PC.',
    });
  }
  return {ok:issues.length===0,enableLua,highShell,issues};
}

/** Check LTK Manager & launcher `RUNASADMIN` compat flags; auto-strip HKCU `RUNASADMIN` on `ltk_launcher.exe`. */
async function checkLtkAndLauncherSettings({launcherPath='',exec=execFileAsync}={}){
  if(process.platform!=='win32')return {ok:true,clearedLauncher:false,issues:[]};
  const issues=[];
  let clearedLauncher=false;
  const rows=[...(await queryLayers('HKCU',{exec})),...(await queryLayers('HKLM',{exec}))];
  const normLauncher=launcherPath?path.win32.resolve(launcherPath).toLowerCase():'';
  const ltkHits=[];
  for(const row of rows){
    if(!hasRunAsAdmin(row.value))continue;
    const lower=row.name.toLowerCase();
    if(normLauncher&&lower===normLauncher){
      if(row.hive==='HKCU'){
        const next=withoutRunAsAdmin(row.value);
        try{
          if(next)await exec('reg',['add',`HKCU\\${LAYERS_SUBKEY}`,'/v',row.name,'/t','REG_SZ','/d',next,'/f','/reg:64'],{windowsHide:true,timeout:3000});
          else await exec('reg',['delete',`HKCU\\${LAYERS_SUBKEY}`,'/v',row.name,'/f','/reg:64'],{windowsHide:true,timeout:3000});
          clearedLauncher=true;
          continue;
        }catch{/* Fall through to warning if registry write failed. */}
      }
      issues.push({
        code:'LAUNCHER_ELEVATED',
        title:'Friloverse launcher is set to Run as administrator',
        detail:`${row.name} has RUNASADMIN set in ${row.hive}, which causes error 740 when starting LTK Manager.`,
        fix:'Right-click ltk_launcher.exe → Properties → Compatibility → Change settings for all users → uncheck "Run this program as an administrator".',
      });
    }else if(LTK_EXE.test(lower)){
      ltkHits.push(`${row.hive}: ${row.name}`);
    }
  }
  if(ltkHits.length){
    issues.push({
      code:'LTK_ELEVATED',
      title:'LTK Manager is set to Run as administrator',
      detail:`RUNASADMIN compatibility flag found on: ${ltkHits.join(', ')}.`,
      fix:'Right-click ltk-manager.exe (and ltk_patcher_host.exe) → Properties → Compatibility → uncheck "Run this program as an administrator" (also under "Change settings for all users").',
    });
  }
  return {ok:issues.length===0,clearedLauncher,issues};
}

/** Check League / Riot `RUNASADMIN` compat flags and live client process elevation. */
async function checkLeagueElevation({pid=0,exec=execFileAsync}={}){
  if(process.platform!=='win32')return {ok:true,issues:[]};
  const issues=[];
  const rows=[...(await queryLayers('HKCU',{exec})),...(await queryLayers('HKLM',{exec}))];
  const leagueHits=rows.filter(row=>hasRunAsAdmin(row.value)&&LEAGUE_EXE.test(row.name));
  const liveElevated=pid?processElevated(pid)===true:false;
  if(liveElevated||leagueHits.length){
    issues.push({
      code:'LEAGUE_ELEVATED',
      title:'League of Legends is running as administrator',
      detail:liveElevated
        ?'The running League client process is elevated, so LTK Manager cannot reach it.'
        :`RUNASADMIN compatibility flag found on: ${leagueHits.map(r=>`${r.hive}: ${r.name}`).join(', ')}.`,
      fix:'Right-click LeagueClient.exe, LeagueClientUx.exe, RiotClientServices.exe, and League of Legends.exe → Properties → Compatibility → uncheck "Run this program as an administrator" (including "Change settings for all users"), then restart League.',
    });
  }
  return {ok:issues.length===0,liveElevated,hits:leagueHits,issues};
}

module.exports={
  checkWindowsAccount,checkLtkAndLauncherSettings,checkLeagueElevation,
  parseRegStrings,withoutRunAsAdmin,processElevated,processIntegrityRid,
};
