// Fold the champion-select panel (or dismiss its docked Party view) only on
// a new physical mouse press outside its current screen bounds.
// Only long enough to cover the second press of a double click already under way as the panel
// opens. It was 1.5 s up to 8.6, from when the panel opened as the player clicked through champions;
// it now opens after lock-in, and the owner found clicks outside it ignored (8.7, 2026-11-10).
export const OPENING_GRACE=250;
export function outsideClick({wasDown,down,elapsed,point,bounds}){
  if(wasDown||!down||elapsed<OPENING_GRACE||!point||!bounds)return false;
  return point.x<bounds.x||point.y<bounds.y||point.x>=bounds.x+bounds.width||point.y>=bounds.y+bounds.height;
}
export class OutsideClickWatcher{
  constructor({down,point,onOutside,now=Date.now}){Object.assign(this,{down,point,onOutside,now});this.target=null;this.timer=null;}
  watch(target){
    if(this.target===target)return;
    this.stop();if(!target)return;
    this.target=target;this.opened=this.now();this.wasDown=this.down();
    this.timer=setInterval(()=>this.tick(),15);
  }
  tick(){
    const target=this.target;if(!target)return;
    if(target.isDestroyed()||!target.isVisible()){this.stop();return;}
    const down=this.down();
    const clicked=outsideClick({wasDown:this.wasDown,down,elapsed:this.now()-this.opened,point:down&&!this.wasDown?this.point():null,bounds:target.getBounds()});
    this.wasDown=down;
    if(clicked){this.stop();this.onOutside(target);}
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;this.target=null;}
}
