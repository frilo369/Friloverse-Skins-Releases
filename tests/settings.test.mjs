import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SettingsStore,applyInstallerChoices} from '../src/settings.mjs';

test('startup, shortcut and theme settings have defaults and persist explicit choices',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-settings-'));
  try{
    const store=new SettingsStore(dir);assert.deepEqual(await store.load(),{startWithWindows:true,guideHotkey:'F1',theme:'friloverse',themePicked:false,themeMoved:true,rememberLastSkin:false,reportDownloads:true});
    await store.set('theme','green-nebula');assert.equal((await new SettingsStore(dir).load()).theme,'green-nebula');
    // A pick, Friloverse included, stays; another save keeps it.
    await store.set('theme','friloverse');await store.set('startWithWindows',true);
    assert.deepEqual(await new SettingsStore(dir).load(),{startWithWindows:true,guideHotkey:'F1',theme:'friloverse',themePicked:true,themeMoved:true,rememberLastSkin:false,reportDownloads:true});
    await assert.rejects(store.set('theme','../outside'),/Unknown setting/);
    await assert.rejects(store.set('theme',true),/Unknown setting/);
    await store.set('startWithWindows',false);assert.equal((await new SettingsStore(dir).load()).startWithWindows,false);
    await store.set('rememberLastSkin',true);assert.equal((await new SettingsStore(dir).load()).rememberLastSkin,true);
    await store.set('rememberLastSkin',false);
    await store.set('guideHotkey','Ctrl+KeyG');assert.equal((await new SettingsStore(dir).load()).guideHotkey,'Ctrl+KeyG');
    await assert.rejects(store.set('guideHotkey','NotAKey'),/Unknown setting/);
    await assert.rejects(store.set('unexpected',true),/Unknown setting/);
    // 8.1 put everyone on Friloverse once: a file from before that loses its theme, whatever it was.
    await writeFile(path.join(dir,'settings.json'),JSON.stringify({startWithWindows:false,guideHotkey:'F1',theme:'astro',themePicked:true}));
    assert.deepEqual(await new SettingsStore(dir).load(),{startWithWindows:false,guideHotkey:'F1',theme:'friloverse',themePicked:false,themeMoved:true,rememberLastSkin:false,reportDownloads:true});
    // After it, a pick stays.
    await writeFile(path.join(dir,'settings.json'),JSON.stringify({startWithWindows:true,guideHotkey:'F1',theme:'astro',themePicked:true,themeMoved:true}));
    assert.deepEqual(await new SettingsStore(dir).load(),{startWithWindows:true,guideHotkey:'F1',theme:'astro',themePicked:true,themeMoved:true,rememberLastSkin:false,reportDownloads:true});
    const moved=new SettingsStore(dir);
    await writeFile(path.join(dir,'settings.json'),JSON.stringify({startWithWindows:true,guideHotkey:'F1',theme:'astro',themePicked:true}));
    await moved.load();await moved.set('theme','green-nebula');
    assert.deepEqual(await new SettingsStore(dir).load(),{startWithWindows:true,guideHotkey:'F1',theme:'green-nebula',themePicked:true,themeMoved:true,rememberLastSkin:false,reportDownloads:true});
    await writeFile(path.join(dir,'settings.json'),'{bad');
    await assert.rejects(new SettingsStore(dir).load(),/could not be read/);
  }finally{assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));await rm(dir,{recursive:true,force:true});}
});

test('settings saved at the same moment are all kept',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-settings-'));
  try{
    const store=new SettingsStore(dir);await store.load();
    const answers=await Promise.all([store.set('startWithWindows',false),store.set('theme','astro'),store.set('guideHotkey','Ctrl+KeyG')]);
    assert.deepEqual(answers.at(-1),{startWithWindows:false,guideHotkey:'Ctrl+KeyG',theme:'astro',themePicked:true,themeMoved:true,rememberLastSkin:false,reportDownloads:true});
    assert.deepEqual(await new SettingsStore(dir).load(),{startWithWindows:false,guideHotkey:'Ctrl+KeyG',theme:'astro',themePicked:true,themeMoved:true,rememberLastSkin:false,reportDownloads:true});
  }finally{assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));await rm(dir,{recursive:true,force:true});}
});

test('a save that fails does not stop the next one, and changes nothing',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-settings-'));
  try{
    const store=new SettingsStore(dir);await store.load();
    await mkdir(path.join(dir,'settings.json'));
    await assert.rejects(store.set('startWithWindows',false));
    assert.equal(store.value.startWithWindows,true);
    await rm(path.join(dir,'settings.json'),{recursive:true});
    await store.set('theme','astro');
    assert.equal((await new SettingsStore(dir).load()).theme,'astro');
  }finally{assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));await rm(dir,{recursive:true,force:true});}
});

test('download reports are on by default, can be turned off, and the installer marker turns them off once',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'friloverse-settings-'));
  try{
    const store=new SettingsStore(dir);
    assert.equal((await store.load()).reportDownloads,true);
    assert.equal(await applyInstallerChoices(store,dir),false);
    await writeFile(path.join(dir,'download-reports-off'),'');
    assert.equal(await applyInstallerChoices(store,dir),true);
    assert.equal((await new SettingsStore(dir).load()).reportDownloads,false);
    assert.equal(await applyInstallerChoices(store,dir),false);
    await store.set('reportDownloads',true);
    assert.equal((await new SettingsStore(dir).load()).reportDownloads,true);
    await assert.rejects(store.set('reportDownloads','no'),/Unknown setting/);
  }finally{assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));await rm(dir,{recursive:true,force:true});}
});
