import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// overlay.js is a page script: these run its own code, so what is tested is what ships.
const source=await readFile(new URL('../src/ui/overlay.js',import.meta.url),'utf8');
const keyCode=/grid\.onkeydown=(event=>\{[\s\S]*?\n  \});/.exec(source)[1];
const shownProblem=new Function(`return ${/const shownProblem=(.+);\r?$/m.exec(source)[1]};`)();
function press(key,onWheel){
  const toggled=[];let prevented=false;
  const handler=new Function('toggle',`return ${keyCode};`)(id=>toggled.push(id));
  handler({key,preventDefault(){prevented=true;},target:{closest:selector=>selector==='[data-wheel]'?(onWheel?{}:null):{dataset:{id:'skin'}}}});
  return {toggled,prevented};
}

test('keys on the chroma wheel only open the chromas',()=>{
  for(const key of ['Enter',' ']){
    const {toggled,prevented}=press(key,true);
    assert.deepEqual(toggled,[]);
    assert.equal(prevented,false,'the button must still get its own click');
  }
});

test('keys on a card still toggle its skin',()=>{
  assert.deepEqual(press('Enter',false).toggled,['skin']);
  const space=press(' ',false);
  assert.deepEqual(space.toggled,['skin']);assert.equal(space.prevented,true);
  assert.deepEqual(press('a',false).toggled,[]);
});

test('the folded tab flags every error the open panel shows',()=>{
  assert.equal(shownProblem({error:'a',databaseError:'b',patcherError:'c'}),'a');
  assert.equal(shownProblem({error:'',databaseError:'b',patcherError:'c'}),'b');
  assert.equal(shownProblem({error:'',databaseError:'',patcherError:'c'}),'c');
  assert.equal(shownProblem({}),'');
  assert.doesNotMatch(source,/toggle\('failed',!!state\.error/);
});

function escapeKey(target){
  const collapsed=[];
  const handlers={};
  const fakeWindow={addEventListener:(name,handler)=>{handlers[name]=handler;},friloverse:{action:kind=>collapsed.push(kind)}};
  const code=/window\.addEventListener\('keydown',event=>\{[\s\S]*?\n\}\);/.exec(source)[0];
  new Function('window','Event',code)(fakeWindow,class{constructor(type){this.type=type;}});
  handlers.keydown({key:'Escape',target});
  return collapsed;
}

test('Escape empties a search first, then folds the panel',()=>{
  const fired=[];
  const box={id:'search',value:'star',dispatchEvent:event=>fired.push(event.type)};
  assert.deepEqual(escapeKey(box),[]);
  assert.equal(box.value,'');assert.deepEqual(fired,['input']);
  assert.deepEqual(escapeKey(box),['collapse']);
  assert.deepEqual(escapeKey({id:'grid'}),['collapse']);
});
