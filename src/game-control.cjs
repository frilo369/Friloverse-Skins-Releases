// The Windows calls that freeze, release and end a League game process.
const koffi=require('koffi');
const {listProcesses}=require('./windows-process.cjs');

const kernel=koffi.load('kernel32.dll'),nt=koffi.load('ntdll.dll');
const openProcess=kernel.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const closeProcess=kernel.func('bool __stdcall CloseHandle(void *handle)');
const waitFor=kernel.func('uint32 __stdcall WaitForSingleObject(void *handle, uint32 ms)');
const terminate=kernel.func('bool __stdcall TerminateProcess(void *handle, uint32 code)');
const times=kernel.func('bool __stdcall GetProcessTimes(void *handle, _Out_ uint64 *created, _Out_ uint64 *ended, _Out_ uint64 *kernel, _Out_ uint64 *user)');
const lastError=kernel.func('uint32 __stdcall GetLastError()');
const suspend=nt.func('int32 __stdcall NtSuspendProcess(void *handle)');
const resume=nt.func('int32 __stdcall NtResumeProcess(void *handle)');

const SYNCHRONIZE=0x00100000,QUERY=0x1000,SUSPEND_RESUME=0x0800,TERMINATE=0x0001;
const ERROR_ACCESS_DENIED=5,ERROR_INVALID_PARAMETER=87;
/** Windows refused: Riot Vanguard protects the game from being frozen or ended. */
const STATUS_ACCESS_DENIED=0xc0000022;
// Windows counts time in 100 ns steps since 1601.
const EPOCH_MS=11644473600000;

/**
 * A handle that stays this process even if Windows reuses its number. Null if it has ended.
 * Only what a freeze needs, as FrYiLoCo asks: see `openGameToEnd` for the right to end it.
 */
function openGame(pid,access=SYNCHRONIZE|QUERY|SUSPEND_RESUME){
  const handle=openProcess(access,false,pid);
  if(handle)return handle;
  const code=lastError();
  if(code===ERROR_INVALID_PARAMETER)return null;
  const error=new Error(`League could not be reached (Windows error ${code}). Run Friloverse with the same permissions as League.`);
  // The same refusal as a freeze: the guard tries again, then lets the game start.
  if(code===ERROR_ACCESS_DENIED)error.status=STATUS_ACCESS_DENIED;
  throw error;
}
/** A second handle, for ending a frozen game. */
const openGameToEnd=pid=>openGame(pid,SYNCHRONIZE|TERMINATE);
/** When a game started, for the record when a freeze was refused. Null if Windows will not say. */
function gameCreated(pid){
  let handle=null;
  try{
    handle=openGame(pid,QUERY);
    return handle?processCreated(handle):null;
  }catch{return null;}
  finally{if(handle)closeHandle(handle);}
}
function check(status,what){
  if(status<0){
    const error=new Error(`Could not ${what} League (NTSTATUS ${(status>>>0).toString(16)}).`);
    error.status=status>>>0;
    throw error;
  }
}
/**
 * Windows can refuse to hold the game. NtSuspendProcess may already have stopped some
 * of its threads when it does, so a refused hold is always undone before it is reported:
 * a half-frozen game would hang instead of loading.
 */
function suspendGame(handle){
  const status=suspend(handle);
  if(status>=0)return;
  try{resume(handle);}catch{/* Nothing more can be done from here. */}
  check(status,'hold');
}
const resumeGame=handle=>check(resume(handle),'release');
const closeHandle=handle=>{closeProcess(handle);};
const processExited=handle=>waitFor(handle,0)===0;
function terminateGame(handle){
  if(!terminate(handle,1)&&!processExited(handle))throw new Error(`Could not restart League (Windows error ${lastError()}).`);
}
/** When this process started, in JavaScript's milliseconds. */
function processCreated(handle){
  const created=[0],ended=[0],inKernel=[0],inUser=[0];
  if(!times(handle,created,ended,inKernel,inUser))throw new Error('Could not read when League started.');
  return Number(BigInt(created[0])/10000n)-EPOCH_MS;
}
/**
 * Releases any League game frozen by a guard that was killed outright. Harmless on a game
 * that is not frozen: releasing only undoes a hold, and never makes one run ahead.
 */
function releaseStranded(names=new Set(['league of legends.exe','league of legends (tm) client.exe'])){
  let released=0;
  for(const {pid,name} of listProcesses()){
    if(!names.has(name))continue;
    let handle=null;
    try{
      handle=openGame(pid,SYNCHRONIZE|SUSPEND_RESUME);
      if(handle){resumeGame(handle);released++;}
    }catch{/* Nothing more can be done from here. */}
    finally{if(handle)closeHandle(handle);}
  }
  return released;
}
module.exports={listProcesses,openGame,openGameToEnd,gameCreated,processCreated,processExited,suspendGame,resumeGame,terminateGame,closeHandle,releaseStranded,STATUS_ACCESS_DENIED};
