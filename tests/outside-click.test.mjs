import test from 'node:test';
import assert from 'node:assert/strict';
import {outsideClick,OutsideClickWatcher} from '../src/outside-click.mjs';

test('only a fresh press outside a visible panel after its opening grace folds it',()=>{
  const input={wasDown:false,down:true,elapsed:251,point:{x:99,y:150},bounds:{x:100,y:100,width:200,height:100}};
  assert.equal(outsideClick(input),true);
  for(const override of [
    {wasDown:true},{down:false},{elapsed:249},{elapsed:100},{point:null},{bounds:null},
    {point:{x:100,y:100}},{point:{x:299,y:199}}
  ])assert.equal(outsideClick({...input,...override}),false);
  assert.equal(outsideClick({...input,point:{x:300,y:150}}),true);
  assert.equal(outsideClick({...input,point:{x:150,y:200}}),true);
});
test('switching watched windows and held opening clicks cannot dismiss the wrong view',()=>{
  let now=0,down=true,point={x:-5,y:10},dismissed=[];
  const win=()=>({isDestroyed:()=>false,isVisible:()=>true,getBounds:()=>({x:0,y:0,width:100,height:100})});
  const first=win(),second=win();
  const watch=new OutsideClickWatcher({down:()=>down,point:()=>point,now:()=>now,onOutside:target=>dismissed.push(target)});
  try{
    watch.watch(first);now=1600;watch.tick();assert.equal(dismissed.length,0);
    down=false;watch.tick();down=true;watch.tick();assert.deepEqual(dismissed,[first]);
    watch.watch(second);now=3200;watch.tick();assert.equal(dismissed.length,1);
    down=false;watch.tick();point={x:10,y:10};down=true;watch.tick();assert.equal(dismissed.length,1);
    down=false;watch.tick();point={x:110,y:10};down=true;watch.tick();assert.deepEqual(dismissed,[first,second]);
  }finally{watch.stop();}
});
test('a click outside folds the panel a moment after it opened, not 1.5 s later',()=>{
  let now=0,down=false,dismissed=[];
  const panel={isDestroyed:()=>false,isVisible:()=>true,getBounds:()=>({x:100,y:100,width:200,height:100})};
  const watch=new OutsideClickWatcher({down:()=>down,point:()=>({x:90,y:150}),now:()=>now,onOutside:target=>dismissed.push(target)});
  try{
    watch.watch(panel);
    // A double click already under way as the panel opens is not a click outside it.
    now=120;down=true;watch.tick();down=false;watch.tick();assert.equal(dismissed.length,0);
    now=300;watch.watch(panel);down=true;watch.tick();assert.deepEqual(dismissed,[panel]);
  }finally{watch.stop();}
});
