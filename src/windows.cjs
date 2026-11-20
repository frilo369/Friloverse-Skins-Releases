const koffi = require('koffi');
const user = koffi.load('user32.dll');
const kernel = koffi.load('kernel32.dll');
const dwm = koffi.load('dwmapi.dll');
const RECT = koffi.struct('FriloverseRect', { left:'int32', top:'int32', right:'int32', bottom:'int32' });
const POINT = koffi.struct('FriloversePoint', { x:'int32', y:'int32' });
const find = user.func('void * __stdcall FindWindowExW(void *parent, void *after, str16 klass, str16 title)');
const getRect = user.func('bool __stdcall GetClientRect(void *window, _Out_ FriloverseRect *rect)');
const getWindowRect = user.func('bool __stdcall GetWindowRect(void *window, _Out_ FriloverseRect *rect)');
const toScreen = user.func('bool __stdcall ClientToScreen(void *window, _Inout_ FriloversePoint *point)');
const visible = user.func('bool __stdcall IsWindowVisible(void *window)');
const minimized = user.func('bool __stdcall IsIconic(void *window)');
const foreground = user.func('void * __stdcall GetForegroundWindow()');
const setForeground = user.func('bool __stdcall SetForegroundWindow(void *window)');
const showWindow = user.func('bool __stdcall ShowWindowAsync(void *window, int command)');
const createWindow = user.func('void * __stdcall CreateWindowExW(uint32 exStyle, str16 klass, str16 title, uint32 style, int x, int y, int width, int height, void *parent, void *menu, void *instance, void *param)');
const destroyWindow = user.func('bool __stdcall DestroyWindow(void *window)');
const setWindowPos = user.func('bool __stdcall SetWindowPos(void *window, void *after, int x, int y, int width, int height, uint32 flags)');
const setWindowOrder = user.func('__stdcall', 'SetWindowPos', 'bool', ['void *', 'intptr_t', 'int', 'int', 'int', 'int', 'uint32']);
const windowLong = user.func('intptr_t __stdcall GetWindowLongPtrW(void *window, int index)');
const sendMessage = user.func('intptr_t __stdcall SendMessageW(void *window, uint32 message, uintptr_t wparam, intptr_t lparam)');
const isWindow = user.func('bool __stdcall IsWindow(void *window)');
const keyState = user.func('int16 __stdcall GetAsyncKeyState(int key)');
const threadId = kernel.func('uint32 __stdcall GetCurrentThreadId()');
const attachInput = user.func('bool __stdcall AttachThreadInput(uint32 attach, uint32 target, bool connect)');
const sendTimeout = user.func('intptr_t __stdcall SendMessageTimeoutW(void *window, uint32 msg, uintptr_t wparam, intptr_t lparam, uint32 flags, uint32 timeout, _Out_ uintptr_t *result)');
const getPid = user.func('uint32 __stdcall GetWindowThreadProcessId(void *window, _Out_ uint32 *pid)');
const open = kernel.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const query = kernel.func('bool __stdcall QueryFullProcessImageNameW(void *process, uint32 flags, _Out_ uint16 *name, _Inout_ uint32 *length)');
const close = kernel.func('bool __stdcall CloseHandle(void *handle)');
const className = user.func('int __stdcall GetClassNameW(void *window, _Out_ uint16 *name, int max)');
const setDwmAttribute = dwm.func('int32 __stdcall DwmSetWindowAttribute(void *window, uint32 attribute, _In_ int32 *value, uint32 size)');

function pid(window) { const out=[0]; getPid(window,out); return out[0]; }
function clientWindow() {
  let hwnd = null;
  while ((hwnd = find(null, hwnd, null, 'League of Legends'))) {
    const handle=open(0x1000,false,pid(hwnd));
    if(!handle) continue;
    let isClient=false;
    try {
      const length=[1024], name=Buffer.alloc(2048);
      isClient=query(handle,0,name,length) && /\\LeagueClientUx\.exe$/i.test(name.toString('utf16le',0,length[0]*2));
    } finally { close(handle); }
    if(!isClient || !visible(hwnd) || minimized(hwnd)) continue;
    const rect={}, origin={x:0,y:0};
    if(!getRect(hwnd,rect) || !toScreen(hwnd,origin)) continue;
    return { hwnd, pid:pid(hwnd), x:origin.x, y:origin.y, width:rect.right, height:rect.bottom };
  }
  return null;
}
function foregroundPid() { const hwnd=foreground(); return hwnd ? pid(hwnd) : 0; }
/** The window in front: its process, whether it can be seen, and where it is. Null when there is none. */
function foregroundWindow(){
  const hwnd=foreground();
  if(!hwnd)return null;
  const rect={},found=getWindowRect(hwnd,rect);
  return {pid:pid(hwnd),visible:visible(hwnd)&&!minimized(hwnd),rect:found?{x:rect.left,y:rect.top,width:rect.right-rect.left,height:rect.bottom-rect.top}:null};
}
/** A program's file name, for the log. Empty when Windows will not say. */
function processName(id){
  if(!id)return '';
  const handle=open(0x1000,false,id);
  if(!handle)return '';
  try{
    const length=[1024],name=Buffer.alloc(2048);
    return query(handle,0,name,length)?name.toString('utf16le',0,length[0]*2).split('\\').pop():'';
  }finally{close(handle);}
}
/** Brings the League client forward even when it is minimized. */
function restoreClient(){
  let hwnd=null;
  while((hwnd=find(null,hwnd,null,'League of Legends'))){
    const handle=open(0x1000,false,pid(hwnd));
    if(!handle)continue;
    let isClient=false;
    try{
      const length=[1024],name=Buffer.alloc(2048);
      isClient=query(handle,0,name,length)&&/\\LeagueClientUx\.exe$/i.test(name.toString('utf16le',0,length[0]*2));
    }finally{close(handle);}
    if(!isClient||!visible(hwnd))continue;
    if(minimized(hwnd))showWindow(hwnd,9);
    return setForeground(hwnd);
  }
  return false;
}
/** Puts a window back at the very top without activating it. True when it had lost its always-on-top. */
function raisePanel(handle){
  const hwnd=koffi.decode(handle,'void *');
  if(!hwnd)return false;
  const dropped=(Number(windowLong(hwnd,-20))&0x8)===0; // GWL_EXSTYLE, WS_EX_TOPMOST
  setWindowOrder(hwnd,-1,0,0,0,0,0x213); // HWND_TOPMOST; no move, size, activation or owner reorder
  return dropped;
}
function focusClient() { const client=clientWindow(); return client ? setForeground(client.hwnd) : false; }
function sameWindow(a,b){return !!a&&!!b&&koffi.address(a)===koffi.address(b);}
function foregroundSnapshot(){const handle=foreground();return handle?{handle,pid:pid(handle)}:null;}
function foregroundRect(previous=null){
  for(const candidate of [foreground(),previous?.handle]){
    if(!candidate||!isWindow(candidate))continue;
    const rect={};if(!getWindowRect(candidate,rect))continue;
    const width=rect.right-rect.left,height=rect.bottom-rect.top;
    if(width>=100&&height>=100)return {x:rect.left,y:rect.top,width,height};
  }
  return null;
}
function keyDown(key){return (keyState(key)&0x8000)!==0;}
function mouseDown(){return keyDown(1)||keyDown(2);}
function shortcutDown(binding){
  const down=keyDown;
  const mods=binding.modifiers;
  return down(binding.key)&&down(0x11)===mods.includes('Ctrl')&&down(0x12)===mods.includes('Alt')&&
    down(0x10)===mods.includes('Shift')&&(down(0x5b)||down(0x5c))===mods.includes('Super');
}
function focusGuide(handle){
  const hwnd=koffi.decode(handle,'void *');
  if(!hwnd)return false;
  if(sameWindow(foreground(),hwnd))return true;
  setForeground(hwnd);
  if(sameWindow(foreground(),hwnd))return true;
  const current=foreground();
  if(!current)return false;
  const ignored=[0];if(!sendTimeout(current,0,0,0,3,50,ignored))return false;
  const other=getPid(current,[0]),own=threadId();
  if(!other||other===own){setForeground(hwnd);return sameWindow(foreground(),hwnd);}
  const attached=attachInput(own,other,true);
  if(!attached)return false;
  try{setForeground(hwnd);}finally{attachInput(own,other,false);}
  return sameWindow(foreground(),hwnd);
}
function gameWindow(){
  let hwnd=null;
  while((hwnd=find(null,hwnd,null,'League of Legends (TM) Client'))){
    if(!visible(hwnd))continue;
    const name=processName(pid(hwnd));
    if(!name||/^league of legends\.exe$/i.test(name))return hwnd;
  }
  return null;
}
/** Brings the running game forward, restoring it if it minimized itself. */
function focusGame(target){
  const game=target||gameWindow();
  if(!game)return false;
  const box=Buffer.alloc(8);box.writeBigUInt64LE(BigInt(koffi.address(game)));
  if(minimized(game)){
    // Restoring activates it. A second activation on top made a game that minimizes
    // when it loses focus drop straight back down, so only step in if it did not come up.
    showWindow(game,9); // SW_RESTORE
    setTimeout(()=>{if(!sameWindow(foreground(),game))focusGuide(box);},80);
    return true;
  }
  return focusGuide(box);
}
function isGame(snapshot){return sameWindow(snapshot?.handle,gameWindow());}
function sameHandle(snapshot,handle){return sameWindow(snapshot?.handle,koffi.decode(handle,'void *'));}
/** Whether a foreground window is Windows' own Alt+Tab switcher, not where it lands. */
function isSwitcher(snapshot){
  if(!snapshot?.handle)return false;
  const name=Buffer.alloc(512),length=className(snapshot.handle,name,256);
  return /^(XamlExplorerHostIslandWindow|MultitaskingViewFrame|TaskSwitcherWnd|ForegroundStaging)$/.test(name.toString('utf16le',0,length*2));
}
/** Which launcher a process is: 'league', 'riot', or '' for anything else. */
function clientKind(id){
  const name=processName(id);
  return /^leagueclientux\.exe$/i.test(name)?'league':/^riot ?client(ux)?\.exe$/i.test(name)?'riot':'';
}
// Skip Windows' open/maximize animation so a prepared guide appears at once.
function disableTransitions(handle){
  const hwnd=koffi.decode(handle,'void *');
  return !!hwnd&&setDwmAttribute(hwnd,3,[1],4)===0; // DWMWA_TRANSITIONS_FORCEDISABLED
}
// Return to the window the guide was opened from. A fullscreen game minimizes
// when it loses focus, and Windows would otherwise activate an unrelated window.
function returnTo(previous){
  if(!previous?.handle||!isWindow(previous.handle)||!previous.pid||previous.pid===process.pid||pid(previous.handle)!==previous.pid)return false;
  if(minimized(previous.handle))showWindow(previous.handle,9); // SW_RESTORE
  return setForeground(previous.handle);
}
// WM_SETHOTKEY offers a second Windows activation path when a fullscreen game
// suppresses WM_HOTKEY. The 1px helper is off-screen and never appears in Alt+Tab.
function createSystemHotkey(){
  const handle=createWindow(0x80,'STATIC','',0x80000000,-32000,-32000,1,1,null,null,null,null);
  if(!handle)return null;
  if(!setWindowPos(handle,null,0,0,0,0,0x57)){destroyWindow(handle);return null;}
  return {
    isForeground:()=>sameWindow(foreground(),handle),
    arm:word=>{const result=Number(sendMessage(handle,0x32,word,0));if(result===1)return true;sendMessage(handle,0x32,0,0);return false;},
    disarm:()=>{sendMessage(handle,0x32,0,0);},
    restore:previous=>{
      if(!sameWindow(foreground(),handle)||!previous?.handle||!isWindow(previous.handle)||pid(previous.handle)!==previous.pid)return false;
      return setForeground(previous.handle);
    },
    destroy:()=>{sendMessage(handle,0x32,0,0);destroyWindow(handle);}
  };
}
module.exports={raisePanel,restoreClient,clientWindow,foregroundPid,foregroundWindow,processName,foregroundSnapshot,foregroundRect,focusClient,keyDown,mouseDown,shortcutDown,focusGuide,focusGame,isGame,sameHandle,isSwitcher,clientKind,createSystemHotkey,disableTransitions,returnTo};
