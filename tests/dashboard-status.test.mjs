import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// dashboard.js is a page script: these run its own expressions, so what is tested is what ships.
const source=await readFile(new URL('../src/ui/dashboard.js',import.meta.url),'utf8');
const detailCode=/\$\('connection-detail'\)\.textContent=(.+);\r?$/m.exec(source)[1];
const statusDetail=new Function('party','state',`return ${detailCode};`);
const rowsCode=/const markup=rows\.map\((.+?)\)\.join\(''\)/.exec(source)[1];
const modRow=new Function('esc','state',`return ${rowsCode};`)(text=>String(text),{connected:true});
const quiet={connected:true,skins:[]};

test('a pressed update keeps reporting progress and failures after leaving the party',()=>{
  const dialog={open:true,close(){this.open=false;},showModal(){this.open=true;}};
  const els={'update-dialog':dialog,'update-now':{disabled:true},'update-progress':{textContent:''},'update-text':{}};
  const code=/function showUpdatePopup\(state,party\)\{[\s\S]*?\n\}\r?\n/.exec(source)[0];
  const rig=new Function('$',`let updatePressed=true,updateAnswered='';${code};return {showUpdatePopup,pressed:()=>updatePressed};`)(id=>els[id]);
  rig.showUpdatePopup({appUpdateStatus:'Downloading app update…'},{status:'reconnecting'});
  assert.equal(els['update-progress'].textContent,'Downloading app update…');
  assert.equal(els['update-now'].disabled,true);assert.equal(dialog.open,true);
  rig.showUpdatePopup({appUpdateStatus:'Could not check for app updates.'},{status:'idle'});
  assert.equal(els['update-now'].disabled,false);assert.equal(rig.pressed(),false);
  rig.showUpdatePopup({appUpdateStatus:'Could not check for app updates.'},{status:'idle'});
  assert.equal(dialog.open,true,'the error stays visible until dismissed');
  assert.match(els['update-progress'].textContent,/Could not check/);
});

test('a released-game warning remains visible in the lobby after the skin panel closes',()=>{
  const holdWarning='League opened after two restart attempts, but skins could not load for this match.';
  assert.equal(statusDetail({syncStatus:'Ready'},{...quiet,holdWarning,checkResult:'Databases checked.'}),holdWarning);
  assert.equal(statusDetail({},{...quiet,holdWarning:''}),'Ready for champion select.');
});

test('an LTK install failure is not hidden by an old status',()=>{
  const state={...quiet,connected:false,skinUpdateStatus:'Downloaded 12 Riot form files.',riotUpdateStatus:'Riot skins are up to date.',ltkInstallError:'The installer could not start.'};
  assert.equal(statusDetail({},state),'The installer could not start.');
});

test('what the status line said before still holds',()=>{
  assert.equal(statusDetail({},{...quiet,skinUpdateStatus:'Downloaded 2 Riot form files.'}),'Downloaded 2 Riot form files.');
  assert.equal(statusDetail({syncStatus:'Syncing'},{...quiet,ltkInstallError:'x'}),'Syncing');
  assert.equal(statusDetail({},{...quiet}),'Ready for champion select.');
  assert.equal(statusDetail({},{...quiet,champion:'Ahri',skins:[1,2]}),'Ahri · 2 skins');
});

test('an import problem is shown and lasts, but not over a draft',()=>{
  const importError='2 old custom files could not be imported.';
  assert.equal(statusDetail({},{...quiet,importError,skinUpdateStatus:'Added 1 custom skin from GitHub.'}),importError);
  assert.equal(statusDetail({},{...quiet,importError,champion:'Ahri',skins:[1]}),'Ahri · 1 skins');
  assert.match(source,/updateLine=\(\)=>\[settingsError,current\?\.importError/);
});

test('a damaged mod says so, cannot be turned on, and can be turned off',()=>{
  const off=modRow({id:'moddb:a',name:'A',enabled:false,broken:true});
  assert.match(off,/This file is damaged/);assert.match(off,/data-mod-id="moddb:a" disabled>/);
  const on=modRow({id:'moddb:b',name:'B',enabled:true,broken:true});
  assert.doesNotMatch(on,/ disabled>/);
  const whole=modRow({id:'moddb:c',name:'C',enabled:false,broken:false});
  assert.doesNotMatch(whole,/damaged| disabled>/);
});

test('the answer to a check made from Settings comes first, as Settings has closed',()=>{
  assert.equal(statusDetail({syncStatus:'Syncing'},{...quiet,checkResult:'Friloverse is up to date.'}),'Friloverse is up to date.');
  assert.equal(statusDetail({},{...quiet,champion:'Ahri',skins:[1],checkResult:'Databases checked: nothing is missing.'}),'Databases checked: nothing is missing.');
});
test('small lobby text has a floor that follows the window, and the full-size design is unchanged',()=>{
  assert.match(source,/setProperty\('--stage-scale',String\(scale\)\)/);
});

function fakeButton(text){return {disabled:false,lastChild:{textContent:text}};}
function enterRig(){
  const els={join:fakeButton('JOIN PARTY'),create:fakeButton('CREATE PARTY'),name:{value:'Ann'},code:{value:'AB12'}};
  const code=/function enter\(mode\)\{[\s\S]*?\n\}\r?\n/.exec(source)[0];
  const calls=[];let finish;
  const enter=new Function('$','action','clearTimeout','chosenIcon','nameTimer','editingName',`let entering=false;${code};return enter;`)(
    id=>els[id],(kind,value)=>{calls.push([kind,value]);return new Promise(resolve=>{finish=resolve;});},()=>{},'',0,false);
  return {els,calls,enter,finish:()=>finish()};
}

test('a second press on Join or Create waits for the first answer',async()=>{
  const {els,calls,enter,finish}=enterRig();
  const first=enter('create');enter('create');enter('join');
  assert.equal(calls.length,1);
  assert.equal(els.create.lastChild.textContent,'CREATING…');
  assert.equal(els.join.disabled,true);assert.equal(els.create.disabled,true);
  finish();await first;
  assert.equal(els.create.lastChild.textContent,'CREATE PARTY');
  assert.equal(els.join.disabled,false);assert.equal(els.create.disabled,false);
  const second=enter('join');
  assert.equal(calls.length,2);assert.equal(els.join.lastChild.textContent,'JOINING…');
  finish();await second;
});

test('Copied is only said when the copy worked',async()=>{
  const code=/\$\('copy'\)\.onclick=(async\(\)=>\{[\s\S]*?\n\});/.exec(source)[1];
  const box={textContent:'Copy code'};
  const run=error=>new Function('$','action','clearTimeout','setTimeout','copiedTimer','actionError',`return ${code};`)(()=>box,async()=>{},()=>{},()=>0,null,error)();
  await run('The clipboard is busy.');
  assert.equal(box.textContent,'Copy code');
  await run('');
  assert.equal(box.textContent,'Copied');
});

test('saving the name does not wipe a Join or Create error',async()=>{
  const code=/async function action\(kind,value,\{keepError=false\}=\{\}\)\{[\s\S]*?\n\}\r?\n/.exec(source)[0];
  let shown=0;
  const rig=new Function('window','showWarning',`let actionError='Enter your name first.';${code};return {action,error:()=>actionError};`)({friloverse:{action:async()=>1}},()=>{shown++;});
  await rig.action('party-profile',{},{keepError:true});
  assert.equal(rig.error(),'Enter your name first.');assert.equal(shown,0);
  await rig.action('party-enter',{});
  assert.equal(rig.error(),'');assert.equal(shown,1);
  assert.match(source,/action\('party-profile',\{name:\$\('name'\)\.value,icon:chosenIcon\},\{keepError:true\}\)/);
});

test('the log note stays until the report was really sent',()=>{
  assert.match(source,/\$\('send-logs'\)\.onclick=\(\)=>\{action\('send-logs',\$\('logs-note'\)\.value\.trim\(\)\);\};/);
  assert.match(source,/state\.logsCode!==noteClearedFor&&\/\^Sent/);
});

test('a kick redraws at once, so the armed look does not linger',()=>{
  assert.match(source,/if\(armedKick===id\)\{armedKick='';memberCards\(current\.party\);void action\('party-kick',id\);\}/);
});

test('with no LTK the pill and the mods panel say what is needed',()=>{
  const pill=new Function('state',`return ${/\$\('connection-pill'\)\.textContent=(.+);\r?$/m.exec(source)[1]};`);
  assert.equal(pill({connected:false}),'LTK needed');
  assert.equal(pill({connected:true,leagueConnected:true}),'Connected');
  const line=/function modsLine\(s\)\{.+\}\r?$/m.exec(source)[0];
  const modsLine=error=>new Function('modsActionError',`${line};return modsLine;`)(error);
  assert.match(modsLine('')({connected:false}),/Install LTK Manager/);
  assert.equal(modsLine('')({connected:false,preview:true}),'');
  assert.equal(modsLine('')({connected:true}),'');
  assert.equal(modsLine('')({connected:true,modsNotice:'Saved.'}),'Saved.');
  assert.equal(modsLine('')({connected:true,modsError:'Bad',modsNotice:'Saved.'}),'Bad');
  assert.equal(modsLine('Own')({connected:false,modsError:'Bad'}),'Own');
});

test('shortcuts read as keys, not as key codes',()=>{
  const hotkeyLabel=new Function(`${/const KEY_WORDS=[\s\S]*?\nconst hotkeyLabel=.+;/.exec(source)[0]};return hotkeyLabel;`)();
  assert.equal(hotkeyLabel('Ctrl+BracketLeft'),'Ctrl+[');
  assert.equal(hotkeyLabel('Super+KeyG'),'Win+G');
  assert.equal(hotkeyLabel('Alt+Digit3'),'Alt+3');
  assert.equal(hotkeyLabel('Shift+Numpad5'),'Shift+Num 5');
  assert.equal(hotkeyLabel('NumpadAdd'),'Num +');
  assert.equal(hotkeyLabel('ArrowUp'),'Up');
  assert.equal(hotkeyLabel('F12'),'F12');
  assert.equal(hotkeyLabel(''),'F1');
});

test('only the newest theme click resets the picked theme',async()=>{
  const body=/card\.onclick=(async\(\)=>\{[\s\S]*?\n  \})/.exec(source.replaceAll('\r\n','\n'))[1];
  const answers=[];
  // The cards share one counter, so both clicks run in one rig.
  const shared=new Function('action','applyTheme',`let themeClick=0,pickedTheme=null,shownTheme=null,current=null,theme;const handler=${body};return {press:id=>{theme={id};return handler();},picked:()=>pickedTheme};`)(async()=>new Promise(done=>answers.push(done)),()=>{});
  const first=shared.press('astro');const second=shared.press('acheron');
  answers[0]();await first;
  assert.equal(shared.picked(),'acheron','the older answer must not clear the newer pick');
  answers[1]();await second;
  assert.equal(shared.picked(),null);
});

test('window buttons explain themselves and a long message grows upward',async()=>{
  const html=await readFile(new URL('../src/ui/dashboard.html',import.meta.url),'utf8');
  for(const [id,title] of [['close-docked','Return to champion select'],['minimize-window','Minimize to tray'],['hide-window','Close to tray'],['close-icons','Close'],['close-settings','Close'],['close-mods','Close'],['close-themes','Close']])
    assert.match(html,new RegExp(`id="${id}"[^>]* title="${title}"`),id);
  const css=await readFile(new URL('../src/ui/dashboard.css',import.meta.url),'utf8');
  assert.match(css,/\.message\{left:50%;bottom:127px;/);
});
