// Exercises real global key messages and switching using an isolated fullscreen
// peer window. No keys are sent unless that peer or the test guide is foreground.
const {app,BrowserWindow,protocol,globalShortcut}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const koffi=require('koffi');
const user=koffi.load('user32.dll');
const find=user.func('void * __stdcall FindWindowW(str16 klass, str16 title)');
const focus=user.func('bool __stdcall SetForegroundWindow(void *window)');
const allowForeground=user.func('bool __stdcall AllowSetForegroundWindow(uint32 pid)');
const root=path.resolve(process.env.FRILOVERSE_GUIDE_APP_ROOT||path.join(__dirname,'..'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const timings=[];
// Measures key press to guide foreground with a fine poll, for the latency report.
async function timed(label,press){
  const start=process.hrtime.bigint();const pressing=press();
  for(let i=0;i<4000;i++){
    if(guide.win?.isFocused()&&tracker.foregroundPid()===process.pid){
      const ms=Number(process.hrtime.bigint()-start)/1e6;timings.push([label,ms]);await pressing;return ms;
    }
    await wait(1);
  }
  await pressing;throw new Error(`Timed out waiting for ${label}.`);
}
let tracker;
async function until(predicate,label){
  for(let i=0;i<160;i++){if(await predicate())return;await wait(50);}
  throw new Error(`Timed out waiting for ${label}.`);
}
let presses=0;
function peerPress(keys,hold=100){
  const id=++presses;
  return new Promise(resolve=>{const done=message=>{if(message?.pressed===id){peer.off('message',done);resolve();}};peer.on('message',done);peer.send({press:keys,hold,id});});
}
const shortcut=()=>peerPress([0x11,0x12,0x70]);
const f1=()=>peerPress([0x70]);
const altTab=()=>peerPress([0x12,0x09],80);
protocol.registerSchemesAsPrivileged([{scheme:'friloverse-guide',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.setPath('userData',process.env.FRILOVERSE_FOCUS_DIR?path.join(process.env.FRILOVERSE_FOCUS_DIR,'host'):path.join(os.tmpdir(),`friloverse-focus-test-${process.pid}`));
app.on('window-all-closed',event=>event.preventDefault());
let guide,peer,anchor;
app.whenReady().then(async()=>{
  const {noGameProcess}=await import(pathToFileURL(path.join(root,'src/lcu-safety.mjs')));
  if(!await noGameProcess())throw new Error('A League game is running or cannot be checked; focus testing was skipped.');
  const {GuideController}=require(path.join(root,'src/guide.cjs'));
  const {guideTarget,guideReady}=await import(pathToFileURL(path.join(root,'src/guide-match.mjs')));
  const {parseShortcut,systemHotkeyWord}=await import(pathToFileURL(path.join(root,'src/guide-shortcut.mjs')));
  const {MayhemData}=await import(pathToFileURL(path.join(root,'src/guide-data.mjs')));
  tracker=require(path.join(root,'src/windows.cjs'));
  const champions=JSON.parse(await fs.readFile(path.join(root,'src/ui/champions.json'),'utf8'));
  anchor=new BrowserWindow({show:false});
  guide=new GuideController({app,tracker,champions,guideTarget,guideReady,parseShortcut,systemHotkeyWord,MayhemData});
  await guide.initialize();guide.data.fetch=async()=>{throw Error('Isolated focus test');};
  guide.setShortcut('Ctrl+Alt+F1');
  guide.observe({phase:'GameStart',mode:'mayhem',champion:1});
  assert.equal(guide.win.isVisible(),false);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  peer=spawn(process.execPath,[path.join(__dirname,'verify-focus-peer.cjs')],{env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  await new Promise((resolve,reject)=>{peer.once('message',resolve);peer.once('error',reject);peer.once('exit',()=>reject(new Error('Fullscreen peer exited early.')));});
  anchor.show();anchor.focus();tracker.focusGuide(anchor.getNativeWindowHandle());
  await until(()=>tracker.foregroundPid()===process.pid,'the isolated test window');
  assert.ok(allowForeground(peer.pid),'could not grant the isolated fullscreen peer focus');
  peer.send('show');
  await until(()=>tracker.foregroundPid()===peer.pid,'the isolated fullscreen window');
  await wait(350);
  const peerHandle=find(null,`Friloverse Focus Test ${peer.pid}`);assert.ok(peerHandle,'fullscreen peer has a taskbar window');
  assert.ok(guide.systemArmed||guide.systemBlocked,'system hotkey setup completed');
  assert.equal(guide.win.isAlwaysOnTop(),false);
  guide.loaded=new Promise(()=>{}); // A slow source must not delay foreground activation.
  assert.ok(await timed('first shortcut',shortcut)<1500,'a slow page must not hold up the shortcut');
  assert.ok(guide.win.isMaximized(),'the guide opens maximized');
  await wait(400);
  assert.equal(guide.win.isAlwaysOnTop(),false);
  await altTab();
  await until(()=>tracker.foregroundPid()===peer.pid,'Alt+Tab back to fullscreen');
  await wait(450);assert.equal(tracker.foregroundPid(),peer.pid,'the guide must not reclaim focus');
  await timed('reopen after Alt+Tab',shortcut);
  await wait(400);
  assert.ok(focus(peerHandle),'the fullscreen window can be activated from the taskbar');
  await until(()=>tracker.foregroundPid()===peer.pid,'taskbar return to fullscreen');
  await wait(450);assert.equal(tracker.foregroundPid(),peer.pid);
  // Exercise the polling fallback even when another program owns RegisterHotKey.
  if(guide.registered){globalShortcut.unregister(guide.registered);guide.registered='';}
  await timed('polling fallback',shortcut);
  await wait(400);assert.ok(focus(peerHandle));
  await until(()=>tracker.foregroundPid()===peer.pid,'fullscreen before the system-hotkey check');
  // A game can also refuse the input-attach handover. Then only the Windows
  // activation hotkey (WM_SETHOTKEY helper) may bring the guide forward.
  const attach=tracker.focusGuide;
  tracker.focusGuide=handle=>tracker.foregroundPid()===process.pid?attach(handle):false;
  try{
    await wait(400);assert.ok(guide.systemArmed,'the Windows activation hotkey is armed over the game');
    await timed('activation hotkey only',shortcut);
  }finally{tracker.focusGuide=attach;}
  await wait(400);assert.ok(focus(peerHandle));
  await until(()=>tracker.foregroundPid()===peer.pid,'fullscreen before held-key check');
  await wait(400);
  const held=peerPress([0x11,0x12,0x70],1600);
  try{
    await until(()=>guide.win?.isFocused(),'held shortcut');
    assert.ok(focus(peerHandle));
    await wait(500);assert.equal(tracker.foregroundPid(),peer.pid,'a held key must not pull focus back');
  }finally{await held;}
  // Closing the guide returns to a game that minimized itself, and prepares
  // the next guide so the following F1 shows a loaded page at once.
  peer.send('minimize');await wait(300);
  const closedWindow=guide.win;closedWindow.close();
  await until(()=>tracker.foregroundPid()===peer.pid,'the minimized game after closing the guide');
  await until(()=>guide.win&&guide.win!==closedWindow&&!guide.win.isVisible()&&!guide.win.webContents.isLoading(),'a prepared replacement guide');
  await wait(400);await timed('after closing with X',shortcut);
  assert.equal(guide.win.webContents.isLoading(),false,'the reopened guide is already loaded');
  assert.ok(focus(peerHandle));await until(()=>tracker.foregroundPid()===peer.pid,'fullscreen before programmatic close');
  guide.close();await wait(450);
  if(tracker.foregroundPid()!==peer.pid)assert.ok(focus(peerHandle));
  await timed('after the guide was closed',shortcut);
  await wait(400);guide.setShortcut('F1');assert.ok(focus(peerHandle));
  await until(()=>tracker.foregroundPid()===peer.pid,'fullscreen before plain F1');
  await wait(400);await timed('plain F1',f1);
  await wait(400);assert.ok(focus(peerHandle));await until(()=>tracker.foregroundPid()===peer.pid,'fullscreen after plain F1');
  await wait(400);assert.equal(tracker.foregroundPid(),peer.pid,'plain F1 must not reclaim focus after switching');
  guide.observe({phase:'Lobby',mode:null,champion:null});
  assert.equal(guide.win,null);assert.equal(guide.keyTimer,null);
  for(const [label,ms] of timings)console.log(`  ${label}: ${ms.toFixed(1)} ms to foreground`);
  console.log('Fullscreen stand-in passed: F1, Alt+Tab, taskbar focus, polling, held key, and reopen.');
}).then(()=>finish(0),error=>{console.error(error.stack||error);finish(1);});
function finish(code){
  try{guide?.dispose();anchor?.destroy();peer?.send('quit');}catch{}
  if(peer)setTimeout(()=>{if(peer.exitCode===null)peer.kill();},500).unref?.();
  app.exit(code);
}
