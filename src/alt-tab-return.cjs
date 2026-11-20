// During a game, one Alt+Tab toggles between the open guide and the game, and one from
// League's client reaches the game. A fullscreen League that minimizes while still
// active makes Windows activate another window, and Alt+Tab follows that activation
// history: moving windows in the z-order does not change where it lands (measured,
// Windows 11 26300). So the landing is corrected afterwards. Tabbing more than once
// is a deliberate pick.
const SETTLE=700;

/** Where one Alt+Tab from this window should end up, or null to leave Windows' choice. */
function altTabPlan(from,{guideOpen,ownPid,isGame,isGuide,clientKind,toGame,toGuide}){
  if(isGame(from))return guideOpen?{lands:w=>w.pid!==ownPid,go:toGuide}:null;
  if(guideOpen&&isGuide(from))return {lands:w=>!isGame(w),go:toGame};
  if(from.pid===ownPid||clientKind(from.pid)==='league')return {lands:w=>!!clientKind(w.pid),go:toGame};
  return null;
}

class AltTabReturn{
  constructor({altDown,tabDown,foreground,isSwitcher,planFor,now=Date.now}){
    Object.assign(this,{altDown,tabDown,foreground,isSwitcher,planFor,now});
    this.tabWas=false;this.calm=null;this.clear();
  }
  clear(){this.origin=null;this.plan=null;this.tabs=0;this.settleUntil=0;}
  poll(){
    const alt=this.altDown(),tab=this.tabDown(),pressed=tab&&!this.tabWas;
    this.tabWas=tab;
    // The foreground changes as soon as the switcher opens, so the origin is read before Alt.
    if(!alt)this.calm=this.foreground();
    if(alt&&pressed){
      if(this.tabs&&!this.settleUntil){this.tabs++;return;}
      this.clear();
      const plan=this.calm?this.planFor(this.calm):null;
      if(plan){this.origin=this.calm;this.plan=plan;this.tabs=1;}
      return;
    }
    if(!this.tabs)return;
    if(alt&&!this.settleUntil)return;
    if(!this.settleUntil)this.settleUntil=this.now()+SETTLE;
    const landed=this.foreground();
    if(landed?.pid&&landed.pid!==this.origin.pid&&!this.isSwitcher(landed)&&this.plan.lands(landed)){
      const {plan,tabs}=this;
      this.clear();
      if(tabs===1)plan.go();
      return;
    }
    if(this.now()>this.settleUntil)this.clear();
  }
}
module.exports={AltTabReturn,altTabPlan,SETTLE};
