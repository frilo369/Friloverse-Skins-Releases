import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// main.cjs needs Electron to load, so its pick handler runs here on its own, with stand-ins.
const source=(await readFile(new URL('../src/main.cjs',import.meta.url),'utf8')).replaceAll('\r\n','\n');
const code=['handleAction','skinLabel','markPicked'].map(name=>{
  const start=source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('\n}',start)+2);
}).join('\n');

function fixture(){
  let finish;
  const picks=new Map(),personal=[];
  const context=vm.createContext({
    preview:false,actionBusy:false,queuedSkin:null,lastSkinClick:'',tray:null,
    state:{champion:'Ahri',connected:true,error:'',pending:'',skins:[{id:'riot:103001',name:'Dynasty Ahri'}]},
    hold:{choicesOpen:()=>true},guideWatcher:{draftId:1},
    choices:{
      // The build or download a pick waits on.
      choose:(id,champion)=>new Promise(done=>{finish=()=>{picks.set(champion,{id});done();};}),
      drop:champion=>picks.delete(champion),pick:champion=>picks.get(champion)||null,
    },
    engine:{setPersonal:pick=>personal.push(pick)},party:{refreshLocal(){}},
    emitState(){},poll:async()=>{},noGameProcess:async()=>true,
  });
  vm.runInContext(code,context);
  return {context,picks,personal,finish:()=>finish()};
}

test('a pick still building when its draft ends never reaches the next draft (12.6)',async()=>{
  const {context,picks,personal,finish}=fixture();
  const running=context.handleAction({kind:'select',id:'riot:103001'});
  await new Promise(done=>setImmediate(done));
  // A dodge, and a new draft with the same champion, while the skin was still being built.
  context.guideWatcher.draftId=2;
  finish();await running;
  assert.equal(picks.size,0,'the new draft starts with skins off');
  assert.equal(personal.filter(Boolean).length,0,'nothing reached the engine');
});

test('a pick that finishes in its own draft is applied',async()=>{
  const {context,picks,personal,finish}=fixture();
  const running=context.handleAction({kind:'select',id:'riot:103001'});
  await new Promise(done=>setImmediate(done));
  finish();await running;
  assert.equal(picks.get('Ahri')?.id,'riot:103001');
  assert.equal(personal.at(-1)?.id,'riot:103001');
});
