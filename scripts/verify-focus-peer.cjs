// Separate, disposable stand-in for a fullscreen game; no League process is used.
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
const os=require('node:os');
app.setPath('userData',process.env.FRILOVERSE_FOCUS_DIR?path.join(process.env.FRILOVERSE_FOCUS_DIR,'peer'):path.join(os.tmpdir(),`friloverse-focus-peer-${process.pid}`));
let window;
app.whenReady().then(async()=>{
  window=new BrowserWindow({title:`Friloverse Focus Test ${process.pid}`,fullscreen:true,show:false,backgroundColor:'#17344c'});
  await window.loadURL('data:text/html,<title>Friloverse Focus Test</title><body style="background:%2317344c;color:white;font:24px Segoe UI">Friloverse isolated focus test</body>');
  window.setTitle(`Friloverse Focus Test ${process.pid}`);
  process.send?.({ready:true});
});
// 'minimize' imitates an exclusive-fullscreen game that minimizes on losing focus.
// Keys are injected from this stand-in game, not from Friloverse's test process:
// Windows lets the process that injects input take the foreground, which
// would hide a real foreground-lock failure in the guide.
let keyEvent;
async function press(keys,hold){
  keyEvent??=require('koffi').load('user32.dll').func('void __stdcall keybd_event(uint8 key, uint8 scan, uint32 flags, uintptr_t extra)');
  for(const key of keys)keyEvent(key,0,0,0);
  await new Promise(resolve=>setTimeout(resolve,hold));
  for(const key of [...keys].reverse())keyEvent(key,0,2,0);
}
process.on('message',message=>{if(message?.press){void press(message.press,message.hold??100).then(()=>process.send?.({pressed:message.id}));return;}
  if(message==='show'){window.show();window.focus();}else if(message==='minimize')window.minimize();else if(message==='quit')app.quit();});
process.on('disconnect',()=>app.quit());
