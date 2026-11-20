import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// main.cjs needs Electron to load, and the preview skips these branches, so their shape is checked here.
const source=(await readFile(new URL('../src/main.cjs',import.meta.url),'utf8')).replaceAll('\r\n','\n');
const openParty=/if\(kind==='open-party'\) \{[\s\S]*?return;\n  \}/.exec(source)[0];
const dock=/function dockDashboard\(\)\{[\s\S]*?\n\}/.exec(source)[0];

test('Party opened by the player does not stay above other programs',()=>{
  assert.doesNotMatch(openParty,/setAlwaysOnTop/);
});
test('with no League window the dashboard is not marked as docked',()=>{
  assert.match(dock,/if\(!client\)return false;/);
  assert.match(dock,/return true;/);
  assert.match(openParty,/state\.partyDocked=preview\|\|dockDashboard\(\);/);
});
test('quitting has a limit, and it is more than the old 5 seconds',()=>{
  assert.ok(Number(/const QUIT_LIMIT=(\d+);/.exec(source)[1])>5000);
  assert.match(source,/finishWithin\(restore\(\),QUIT_LIMIT\)/);
});

test('the mods notice is not an error, and is not logged as one',async()=>{
  const main=await readFile(new URL('../src/main.cjs',import.meta.url),'utf8');
  const log=await readFile(new URL('../src/error-log.cjs',import.meta.url),'utf8');
  assert.match(main,/state\.modsNotice='Saved\. This applies from the next match\.'/);
  assert.doesNotMatch(main,/state\.modsError='Saved/);
  assert.doesNotMatch(log,/modsNotice/);
});

test('the lobby stays where the player dragged it, and only a drag counts',async()=>{
  const main=await readFile(new URL('../src/main.cjs',import.meta.url),'utf8');
  assert.match(main,/dashboard\.on\('will-move',\(\)=>\{if\(!state\.partyDocked\)dashboardMoved=true;\}\)/);
  assert.match(main,/if\(client&&!dashboardMoved\)dashboard\.setPosition/);
});

test('a first run shows one balloon that says both things',async()=>{
  const main=await readFile(new URL('../src/main.cjs',import.meta.url),'utf8');
  assert.match(main,/Skins download in the background\./);
  assert.match(main,/if\(!resumedFromUpdate&&!firstRun\)try\{tray\.displayBalloon\(\{title:'Friloverse is downloading skins'/);
});

test('players read the new name and plain words',async()=>{
  const read=file=>readFile(new URL(`../${file}`,import.meta.url),'utf8');
  for(const file of ['src/ui/guide/mayhem.js','src/ui/guide/metasrc-guide.js'])assert.doesNotMatch(await read(file),/FrYiLoCo/,file);
  const sync=await read('scripts/sync-guide-assets.mjs');
  assert.equal(sync.match(/replaceAll\('· FrYiLoCo`','· Friloverse`'\)/g).length,2,'a re-sync must not bring the old name back');
  for(const file of ['src/main.cjs','src/party-coordinator.mjs'])assert.doesNotMatch(await read(file),/Enter a party name/,file);
  assert.match(await read('src/ui/dashboard.html'),/sr-only">Your name</);
});
