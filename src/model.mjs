export function championKey(name) {
  const key=String(name ?? '').normalize('NFKD').replace(/[^a-z0-9]/gi, '').toLowerCase();
  // League's internal champion IDs differ from their displayed names here.
  return ({wukong:'monkeyking',nunuwillump:'nunu',renataglasc:'renata'})[key]||key;
}

const PHASE_WORDS={None:'Home',Lobby:'Lobby',Matchmaking:'In queue',ReadyCheck:'Ready check',ChampSelect:'Champion select',GameStart:'Game starting',InProgress:'In game',Reconnect:'Reconnecting',WaitingForStats:'Game ended',PreEndOfGame:'Game ended',EndOfGame:'Game ended'};
/** The client's phase in the player's words. A phase Riot adds later shows as it is. */
export const phaseLabel=phase=>PHASE_WORDS[phase]||String(phase??'');

export function matchingSkins(library, champion) {
  const key = championKey(champion);
  return key ? (library?.mods ?? []).filter(m => !m.creatorHub && championKey(m.champion) === key) : [];
}

export function nextView(previous, status) {
  let champion=null;
  const reconnect=status?.phase==='Reconnect'&&status.reconnect===true;
  const swiftplay=status?.swiftplay===true&&['Lobby','Matchmaking','ReadyCheck'].includes(status?.phase);
  if(status?.connected&&(status.phase==='ChampSelect'||reconnect||swiftplay))champion=status.championName;
  // No locked-in champion means no overlay at all, also in a draft (owner, 2026-11-09).
  if (!champion) return { champion: null, mode: 'hidden' };
  const returned=reconnect&&(!previous.reconnect||status.reconnectRun!==previous.reconnectRun);
  return { champion, mode: championKey(champion) !== championKey(previous.champion) || previous.mode === 'hidden' || returned ? 'open' : previous.mode };
}

// One champion's custom cards. A problem with that folder must not cost the player their Riot
// cards, so it comes back as `error`, with the last good list for this champion if there is one.
export async function readCustomCards(list,name,wanted,previous,at=Date.now()){
  try{return {champion:wanted,at,skins:(await list(name)).skins,error:''};}
  catch(error){return {champion:wanted,at,skins:previous?.champion===wanted?previous.skins:[],error:error.message};}
}

// Whether a window really stands in front of the League client: seen, and over a good part of it.
// Nothing in front, a hidden window (LTK Manager starting) or one on another monitor does not count.
export function clientCovered(client,front,{ownPid=0,overlayFocused=false}={}){
  if(!client||!front||front.pid===client.pid)return false;
  if(front.pid===ownPid&&overlayFocused)return false;
  if(!front.visible||!front.rect)return false;
  const width=Math.min(client.x+client.width,front.rect.x+front.rect.width)-Math.max(client.x,front.rect.x);
  const height=Math.min(client.y+client.height,front.rect.y+front.rect.height)-Math.max(client.y,front.rect.y);
  return width>0&&height>0&&width*height>=client.width*client.height*.25;
}

// A freeze can arrive before League reports GameStart. Latch it through the rest of that
// draft, including a temporary lost connection, until a new champion select starts.
// Reconnect is a separate selection window, confirmed by GameHold after the process exits.
export class DraftVisibility {
  phase=''; active=false; ended=false; draftRun=undefined;
  observe({phase='',connected=false,frozen=false,reconnect=false,swiftplay=false,run}={}){
    if(phase&&phase!==this.phase){
      this.phase=phase;
      if(phase==='ChampSelect')this.ended=false;
    }
    // A new guard means a new draft even if a slow poll missed the intervening lobby.
    if(phase==='ChampSelect'&&run!==this.draftRun){this.draftRun=run;this.ended=false;}
    if(frozen)this.ended=true;
    const active=connected&&(phase==='ChampSelect'&&!this.ended||phase==='Reconnect'&&reconnect&&!frozen||swiftplay&&!frozen);
    const closed=this.active&&!active;
    this.active=active;
    return {active,closed};
  }
}
// The League corner launcher (owner, 2026-11-11, 9.3): in the client's lobby, queue and after a
// game, so Friloverse is one click away; in an active draft too. Hidden from the draft's end
// (freeze or GameStart) until the match is over or a confirmed Reconnect opens selection.
const MATCH_PHASES=new Set(['GameStart','InProgress','Reconnect']);
export function launcherAllowed({phase='',draftActive=false}={}){
  if(draftActive)return true;
  return phase!=='ChampSelect'&&!MATCH_PHASES.has(phase);
}
// In a room, or on the way back to one. Leaving or being kicked makes it idle.
export function inParty(party){return !!party?.code&&party.status!=='idle';}

// FrYiLoCo's measured placement on a 1672 x 941 League client, in screen pixels.
export function overlayBounds(rect, mode) {
  // The folded bar stands over League's center button. Smaller or lower cuts the button in half (7.5).
  const ratios = mode === 'tab' ? [.36, .842, .28, .062] : [.1782, .4304, .6435, .4816];
  return { x: Math.round(rect.x + rect.width * ratios[0]), y: Math.round(rect.y + rect.height * ratios[1]),
    width: Math.round(rect.width * ratios[2]), height: Math.round(rect.height * ratios[3]) };
}

// FrYiLoCo's launcher placement: centred over League's top-left logo, 72 pixels
// across on a 1600 x 900 client, in screen pixels.
export function launcherBounds(rect){
  const scale=Math.min(Math.max(Math.min(rect.width/1600,rect.height/900),.75),1.5);
  const size=Math.min(Math.max(Math.round(72*scale),54),108);
  return {x:rect.x+Math.round(20*scale),y:rect.y+Math.round(12*scale),width:size,height:size};
}
/** Centre a window on the client; one larger than the client starts at its top-left. */
export function centeredOn(rect,size){
  return {x:rect.x+Math.max(Math.round((rect.width-size.width)/2),0),y:rect.y+Math.max(Math.round((rect.height-size.height)/2),0)};
}

export function unwrap(result) {
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
    if (!result.ok) {
      const detail=result.error??result;
      const error=new Error(typeof detail==='string'?detail:typeof detail?.message==='string'?detail.message:JSON.stringify(detail));
      if(typeof detail?.code==='string')error.code=detail.code;
      throw error;
    }
    return result.value;
  }
  return result;
}

/** Versions go 1.5, 1.6 ... 1.9, 2.0. Squirrel and the update feed need three parts. */
export function shownVersion(version){return String(version).replace(/\.0$/,'');}
