import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

const {finishOldInstall,insideOldInstall,moveOldInstall,prepareInstall}=createRequire(import.meta.url)('../src/old-name.cjs');

function put(file,text='x'){mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,text);}
function pc(){
  const base=mkdtempSync(path.join(tmpdir(),'friloverse-old-name-'));
  const env={LOCALAPPDATA:path.join(base,'Local'),APPDATA:path.join(base,'Roaming')};
  mkdirSync(env.LOCALAPPDATA);mkdirSync(env.APPDATA);
  return {base,env,uninstalled:[],closed:0};
}
const move=(it,extra={})=>moveOldInstall({env:it.env,desktop:path.join(it.base,'Desktop'),closeOld:()=>{it.closed++;},uninstall:root=>it.uninstalled.push(root),...extra});

test('a PC that never had the old name is left alone',()=>{
  const it=pc();
  assert.equal(move(it),false);
  assert.equal(it.closed,0);
});

test('the player\'s data and skins move, and only then the old copy is uninstalled',()=>{
  const it=pc();
  const oldRoot=path.join(it.env.LOCALAPPDATA,'divinity');
  put(path.join(it.env.APPDATA,'divinity','settings.json'),'{"mine":1}');
  put(path.join(it.env.APPDATA,'divinity','lockfile'));
  put(path.join(oldRoot,'Update.exe'));
  put(path.join(oldRoot,'Database','Custom Skins','Ahri','a.fantome'),'skin');
  put(path.join(it.env.LOCALAPPDATA,'FrYiLoCo','Riot Skins Converted','Divinity','m.json'));
  put(path.join(it.base,'Desktop','Divinity.lnk'));
  put(path.join(it.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','FrYiLo','Divinity.lnk'));
  assert.equal(move(it),true);
  assert.equal(it.closed,1);
  assert.equal(readFileSync(path.join(it.env.APPDATA,'friloverse-skins','settings.json'),'utf8'),'{"mine":1}');
  assert.equal(readFileSync(path.join(it.env.LOCALAPPDATA,'friloverse-skins','Database','Custom Skins','Ahri','a.fantome'),'utf8'),'skin');
  assert.ok(existsSync(path.join(it.env.LOCALAPPDATA,'FrYiLoCo','Riot Skins Converted','Friloverse','m.json')));
  assert.ok(!existsSync(path.join(it.env.APPDATA,'divinity')));
  assert.ok(!existsSync(path.join(oldRoot,'Database')));
  assert.ok(!existsSync(path.join(it.base,'Desktop','Divinity.lnk')));
  assert.deepEqual(it.uninstalled,[oldRoot]);
});

test('what the new folders already have is kept, and the rest still arrives',()=>{
  const it=pc();
  put(path.join(it.env.APPDATA,'divinity','Local State'),'old');
  put(path.join(it.env.APPDATA,'divinity','party-profile.json'),'profile');
  put(path.join(it.env.APPDATA,'friloverse-skins','Local State'),'new');
  put(path.join(it.env.LOCALAPPDATA,'divinity','Database','Custom Mods','a.fantome'),'a');
  put(path.join(it.env.LOCALAPPDATA,'divinity','Database','Custom Mods','b.fantome'),'old b');
  put(path.join(it.env.LOCALAPPDATA,'friloverse-skins','Database','Custom Mods','b.fantome'),'new b');
  move(it);
  const data=path.join(it.env.APPDATA,'friloverse-skins'),mods=path.join(it.env.LOCALAPPDATA,'friloverse-skins','Database','Custom Mods');
  assert.equal(readFileSync(path.join(data,'Local State'),'utf8'),'new');
  assert.equal(readFileSync(path.join(data,'party-profile.json'),'utf8'),'profile');
  assert.equal(readFileSync(path.join(mods,'a.fantome'),'utf8'),'a');
  assert.equal(readFileSync(path.join(mods,'b.fantome'),'utf8'),'new b');
});

test('a finished uninstall leaves nothing behind, and an unfinished one is not touched',()=>{
  const it=pc();
  const oldRoot=path.join(it.env.LOCALAPPDATA,'divinity'),oldData=path.join(it.env.APPDATA,'divinity');
  put(path.join(oldRoot,'Update.exe'));
  put(path.join(oldRoot,'Database','Custom Skins','a.fantome'));
  put(path.join(oldData,'settings.json'));
  finishOldInstall(it.env);
  assert.ok(existsSync(path.join(oldRoot,'Database','Custom Skins','a.fantome')));
  assert.ok(existsSync(path.join(oldData,'settings.json')));
  put(path.join(oldRoot,'.dead'));
  finishOldInstall(it.env);
  assert.ok(!existsSync(oldRoot));
  assert.ok(!existsSync(oldData));
});

test('the program knows when it is running inside the old install',()=>{
  assert.equal(insideOldInstall(String.raw`C:\Users\a\AppData\Local\divinity\app-4.0.0\Friloverse-Skins.exe`),true);
  assert.equal(insideOldInstall(String.raw`C:\Users\a\AppData\Local\friloverse-skins\app-4.0.0\Friloverse-Skins.exe`),false);
});

test('the install folder holds what Squirrel\'s own setup would give it',()=>{
  const it=pc(),root=path.join(it.base,'root'),temp=path.join(it.base,'temp');
  put(path.join(root,'Update.exe'),'update');
  put(path.join(root,'packages','friloverse-skins-4.0.0-full.nupkg'),'package');
  prepareInstall({root,version:'4.0.0',temp});
  const sha=createHash('sha1').update('package').digest('hex').toUpperCase();
  assert.equal(readFileSync(path.join(temp,'RELEASES'),'utf8'),`${sha} friloverse-skins-4.0.0-full.nupkg 7`);
  assert.equal(readFileSync(path.join(temp,'Update.exe'),'utf8'),'update');
});
