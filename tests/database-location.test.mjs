import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import location from '../src/database-location.cjs';
const {databaseRoot,migrateDatabase}=location;
function fixture(t){
  const local=fs.mkdtempSync(path.join(tmpdir(),'friloverse-location-'));
  t.after(()=>{assert.equal(path.dirname(local),tmpdir());fs.rmSync(local,{recursive:true,force:true});});
  const old=path.join(local,'friloverse-skins','Database'),root=databaseRoot(local);
  const put=(base,name,value)=>{const file=path.join(base,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
  return {local,old,root,put};
}
test('uninstalling the install tree cannot remove migrated player libraries',t=>{
  const f=fixture(t);f.put(f.old,'Custom Mods/mine.fantome','personal');
  assert.deepEqual(migrateDatabase(f.local),{root:f.root,recovered:null});
  const install=path.dirname(f.old);assert.equal(path.dirname(install),f.local);
  fs.rmSync(install,{recursive:true,force:true});
  assert.equal(fs.readFileSync(path.join(f.root,'Custom Mods/mine.fantome'),'utf8'),'personal');
  assert.deepEqual(migrateDatabase(f.local),{root:f.root,recovered:null});
});
test('an interrupted merge resumes and preserves both conflicting files',t=>{
  const f=fixture(t);f.put(f.old,'Custom Mods/mine','old');f.put(f.old,'Custom Mods/missing','extra');f.put(f.root,'Custom Mods/mine','new');
  const {recovered}=migrateDatabase(f.local);
  assert.equal(fs.readFileSync(path.join(f.root,'Custom Mods/mine'),'utf8'),'new');
  assert.equal(fs.readFileSync(path.join(f.root,'Custom Mods/missing'),'utf8'),'extra');
  assert.equal(fs.readFileSync(path.join(recovered,'Custom Mods/mine'),'utf8'),'old');
  assert.equal(fs.existsSync(f.old),false);
});
test('a junction at the destination is refused without changing its contents',t=>{
  const f=fixture(t);f.put(f.old,'mine','safe');
  const other=path.join(f.local,'other');fs.mkdirSync(other);
  fs.symlinkSync(other,path.dirname(f.root),'junction');
  assert.throws(()=>migrateDatabase(f.local),/cannot use/);
  assert.equal(fs.readFileSync(path.join(f.old,'mine'),'utf8'),'safe');
  assert.deepEqual(fs.readdirSync(other),[]);
});
test('a failed move leaves recoverable sources and resumes on the next start',t=>{
  const f=fixture(t);f.put(f.old,'a','first');f.put(f.old,'b','second');f.put(f.root,'existing','current');
  const rename=fs.renameSync;
  const hook=t.mock.method(fs,'renameSync',(from,to)=>{if(from===path.join(f.old,'b'))throw Object.assign(Error('locked'),{code:'EACCES'});return rename(from,to);});
  assert.throws(()=>migrateDatabase(f.local),/locked/);
  assert.equal(fs.readFileSync(path.join(f.root,'a'),'utf8'),'first');
  assert.equal(fs.readFileSync(path.join(f.old,'b'),'utf8'),'second');
  hook.mock.restore();migrateDatabase(f.local);
  assert.equal(fs.readFileSync(path.join(f.root,'b'),'utf8'),'second');
  assert.equal(fs.readFileSync(path.join(f.root,'existing'),'utf8'),'current');
});
