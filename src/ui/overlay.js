let state,champions=[],query='',picked='',tab='',chromasOf='',lastClick={id:'',at:0},optimistic=null,shown='',chromaView='',built=false;
const DOUBLE_CLICK=500,OPTIMISTIC_GRACE=150,OPTIMISTIC_LIMIT=1000;
const PATCHER={idle:'',applying:'Getting your skins ready…',ready:'Ready for this match',failed:'Skins need attention'};
const CHECK='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3ddc84" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
const SEARCH='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a09b8c" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.6-4.6"/></svg>';
const DICE='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/></svg>';
const FOLD='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
const root=document.getElementById('root');
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function championKey(value){
  const key=String(value||'').normalize('NFKD').replace(/[^a-z0-9]/gi,'').toLowerCase();
  return ({wukong:'monkeyking',nunuwillump:'nunu',renataglasc:'renata'})[key]||key;
}
function icon(champion){
  const match=champions.find(item=>championKey(item.id)===championKey(champion)||championKey(item.name)===championKey(champion));
  return `icons/${String(match?.id||champion).replace(/[^a-z0-9]/gi,'')}.png`;
}
function fit(){
  if(!state)return;
  const size=state.mode==='tab'?{width:468,height:58}:{width:1076,height:453};
  const scale=Math.min(innerWidth/size.width,innerHeight/size.height);
  root.style.transform=state.mode==='tab'?'none':`scale(${scale})`;
  root.style.setProperty('--tab-scale',scale);
}
const setText=(element,text)=>{if(element.textContent!==text)element.textContent=text;};
const activeOf=skin=>skin.chromas?.find(chroma=>chroma.enabled)?.id||skin.id;
const matches=skin=>{
  const wanted=query.toLowerCase();
  return !wanted||[skin,...(skin.chromas||[])].some(item=>item.name.toLowerCase().includes(wanted));
};

/*
 * Everything on screen stays on screen: a state update only changes what really changed, so
 * pictures never reload, the search keeps its focus and the list keeps its place. A card is
 * only made once per skin, and moving it between tabs or searches keeps its loaded picture.
 */
function build(){
  built=true;
  root.innerHTML=`<div id="open-view" hidden><div class="notch"></div><div class="drawer"><div class="bar">
    <div class="who"><img class="portrait" id="portrait" alt=""><div style="min-width:0"><div class="brand">FRILOVERSE</div><div class="name" id="champion-name"></div></div></div>
    <div id="middle" class="middle"></div>
    <label class="search">${SEARCH}<input id="search" type="text" placeholder="Search skins and chromas..." aria-label="Search skins and chromas"></label>
    <button class="fold random-btn" id="random-skin" type="button" title="Pick a random skin" aria-label="Pick a random skin">${DICE}</button>
    <button class="fold party-open" id="open-party-panel" type="button" aria-label="Open Party Mode">PARTY</button>
    <button class="fold" id="fold" type="button" title="Collapse skins" aria-label="Collapse skins">${FOLD}</button></div>
    <div class="swiftplay-bar" id="swiftplay-bar" hidden></div>
    <div class="reconnect-banner" id="reconnect-banner" role="status" aria-live="assertive" hidden><span class="rb-mark" aria-hidden="true"></span><div class="rb-text"><strong id="rb-title"></strong><span id="rb-detail"></span></div><button class="rb-emergency" id="emergency-disable" type="button" title="Disable your skin and all custom mods for this match if a mod caused a crash">Disable all mods</button></div>
    <div class="grid" id="grid"></div>
    <p class="selection-error" id="selection-error" role="alert" hidden></p>
    <p class="selection-note" id="selection-note" role="status" hidden></p>
    <div class="footer"><span class="footer-actions"><span id="footer-hint"></span><span class="restored-pill" id="restored-pill" hidden><span id="restored-text"></span><button type="button" id="dismiss-restored" title="Turn off restored skin" aria-label="Turn off restored skin">×</button></span><button class="disable-skin" id="disable-skin" hidden>Disable active skin</button></span><span id="footer-status"></span></div></div></div>
    <div id="tab-view" hidden><button class="fold-tab" id="expand"><img id="tab-icon" alt=""><span id="tab-word">SKINS</span></button><button class="fold-tab party-tab" id="open-party" aria-label="Open Party Mode">PARTY</button></div>`;
  $('fold').onclick=()=>window.friloverse.action('collapse');
  $('expand').onclick=()=>window.friloverse.action('expand');
  $('open-party').onclick=$('open-party-panel').onclick=()=>window.friloverse.action('open-party');
  $('random-skin').onclick=()=>{const {showing}=view();window.friloverse.action('random-skin',showing);};
  $('emergency-disable').onclick=()=>window.friloverse.action('emergency-disable-mods');
  $('dismiss-restored').onclick=()=>window.friloverse.action('dismiss-restored');
  $('swiftplay-bar').onclick=event=>{
    const btn=event.target.closest('[data-slot]');
    if(btn)window.friloverse.action('swiftplay-slot',Number(btn.dataset.slot));
  };
  $('disable-skin').onclick=event=>{
    const id=event.currentTarget.dataset.id;
    expect({off:id});
    window.friloverse.action('disable-skin',id);
  };
  $('search').oninput=event=>{query=event.target.value;drawCards();};
  $('middle').onclick=event=>{
    const button=event.target.closest('[data-tab]');
    if(button){tab=button.dataset.tab;chromasOf='';draw();$('grid').scrollTop=0;}
    else if(event.target.closest('#back')){chromasOf='';draw();}
  };
  const grid=$('grid');
  // One listener for all the cards, so a card being moved or added never loses a click.
  grid.onclick=event=>{
    const wheel=event.target.closest('[data-wheel]');
    if(wheel){event.stopPropagation();chromasOf=wheel.dataset.wheel;draw();grid.scrollTop=0;return;}
    const item=event.target.closest('.card[data-id]');
    if(item)clickCard(item,event);
  };
  grid.onkeydown=event=>{
    // The chroma wheel is a button inside the card: its keys open the chromas, and only that.
    if(event.target.closest('[data-wheel]'))return;
    const item=event.target.closest('.card[data-id]');
    if(!item||event.key!=='Enter'&&event.key!==' ')return;
    if(event.key===' ')event.preventDefault();
    toggle(item.dataset.id);
  };
  // Load and error do not bubble; the capture phase sees them for every picture.
  root.addEventListener('load',event=>{if(event.target.classList?.contains('art'))event.target.classList.add('ready');},true);
  root.addEventListener('error',event=>{
    const image=event.target;
    if(!(image instanceof HTMLImageElement))return;
    if(!image.classList.contains('art')){image.style.visibility='hidden';return;}
    const fallback=image.dataset.fallback;
    if(fallback&&image.getAttribute('src')!==fallback){delete image.dataset.fallback;image.src=fallback;return;}
    if(!image.dataset.gaveUp){image.dataset.gaveUp='1';image.src=icon(state.champion);}
  },true);
}
// A double click on a card turns off whichever of its family is on, chroma or skin.
function toggle(id){
  const skin=state.skins.find(item=>item.id===id),chroma=state.skins.flatMap(item=>item.chromas||[]).find(item=>item.id===id);
  if(skin?.broken)return;
  let target=null,on=false;
  if(chromasOf&&chroma){on=!enabledNow(chroma);target=id;}
  else if(skin){on=!enabledNow(skin);target=on?id:activeOf(skin);}
  if(!target)return;
  expect(on?{on:target}:{off:target});
  window.friloverse.action(on?'select':'disable-skin',target);
}
// Shown at once. The real answer follows a moment later, and a skin changed quickly just queues.
let expectTimer=null;
function expect(change){
  optimistic={...change,at:performance.now()};
  drawMarks();
  const settle=()=>{
    if(state?.pending){expectTimer=setTimeout(settle,OPTIMISTIC_LIMIT);return;}
    optimistic=null;drawMarks();
  };
  clearTimeout(expectTimer);expectTimer=setTimeout(settle,OPTIMISTIC_LIMIT);
}
// What a card shows while the click is on its way.
function enabledNow(item){
  if(!optimistic)return !!item.enabled;
  const id=optimistic.on||optimistic.off,owns=item.id===id||!!item.chromas?.some(chroma=>chroma.id===id);
  return optimistic.on?owns:!owns&&!!item.enabled;
}
// A card keeps its place through a re-render, so a double click is told apart here
// and not by the browser, which sees two different elements if a poll redraws them.
function clickCard(card,event){
  const id=card.dataset.id,now=performance.now();
  const twice=event.detail===0||(lastClick.id===id&&now-lastClick.at<DOUBLE_CLICK);
  lastClick=twice?{id:'',at:0}:{id,at:now};
  picked=id;
  root.querySelectorAll('.card.picked').forEach(item=>item.classList.remove('picked'));
  card.classList.add('picked');
  if(twice)toggle(id);
}
const cards=new Map();
function swatchHtml(colors){
  if(!Array.isArray(colors)||!colors.length)return '';
  const safe=colors.filter(c=>/^#[0-9a-f]{3,8}$/i.test(String(c||'')));
  if(!safe.length)return '';
  const bg=safe.length>=2?`linear-gradient(135deg,${safe[0]} 50%,${safe[1]} 50%)`:safe[0];
  return `<span class="swatch-dot" style="background:${bg}" aria-hidden="true"></span>`;
}
function makeCard(skin,kind){
  const holder=document.createElement('template');
  const chromas=skin.chromas?.length||0;
  const wheelLabel=skin.variantKind==='forms'?'Forms':skin.variantKind==='editions'?'Editions':'Chromas';
  const badge=skin.badge?`<span class="card-badge">${esc(skin.badge)}</span>`:'';
  const formIcon=skin.formIcon?`<img class="form-emblem" src="${esc(skin.formIcon)}" alt="" draggable="false">`:'';
  const overlayImg=skin.overlay?`<img class="art-overlay" src="${esc(skin.overlay)}" alt="" draggable="false">`:'';
  const swatch=swatchHtml(skin.colors);
  holder.innerHTML=`<div class="card" role="button" tabindex="0" data-id="${esc(skin.id)}" data-${kind}="1">
    <div class="art-box">${skin.image?`<img class="art" src="${esc(skin.image)}" data-fallback="${esc(skin.fallback||'')}" alt="" decoding="async" draggable="false">`:`<span class="fallback-art">${esc(state.champion.slice(0,2).toUpperCase())}<small>NO SKIN PREVIEW</small></span>`}${overlayImg}${badge}${formIcon}${swatch}
      <div class="marks">${chromas?`<button class="wheel" type="button" data-wheel="${esc(skin.id)}" title="${wheelLabel}" aria-label="${wheelLabel} for ${esc(skin.name)}"></button>`:''}<span class="check" hidden>${CHECK}</span></div>
    </div><span class="label">${esc(skin.name)}</span></div>`;
  return holder.content.firstElementChild;
}
function cardFor(skin,kind){
  const key=`${kind}:${skin.id}`,identity=JSON.stringify([skin.name,skin.image,skin.fallback,skin.chromas?.length||0,skin.badge||'',skin.formIcon||'',skin.overlay||'',skin.variantKind||'',skin.colors||null]);
  let held=cards.get(key);
  if(!held||held.identity!==identity){held={element:makeCard(skin,kind),identity};cards.set(key,held);}
  return held.element;
}
function markCard(element,skin){
  const on=enabledNow(skin);
  element.classList.toggle('enabled',on);
  element.classList.toggle('picked',picked===skin.id);
  element.classList.toggle('pending',state.pending===skin.id);
  element.classList.toggle('broken',!!skin.broken);
  if(skin.broken)element.setAttribute('aria-disabled','true');else element.removeAttribute('aria-disabled');
  const title=skin.broken?'This skin is damaged':`Double-click to ${on?'turn off':'enable'} ${skin.name}`;
  if(element.title!==title)element.title=title;
  const check=element.querySelector('.check');
  if(check.hidden===on)check.hidden=!on;
}
function view(){
  // 10.6: LTK refuses Riot's own skins in game, so they have no tab while that lasts.
  const riot=state.riotSkinsOff?[]:state.skins.filter(skin=>skin.kind==='riot'),local=state.skins.filter(skin=>skin.source==='local');
  const custom=state.skins.filter(skin=>skin.kind!=='riot'&&skin.source!=='local');
  // Riot skins first, unless this champion only has custom or local ones.
  const chosen=state.riotSkinsOff&&tab==='riot'?'':tab;
  const showing=chosen||(riot.length?'riot':custom.length||!local.length?'custom':'local');
  const list=showing==='riot'?riot:showing==='local'?local:custom;
  return {riot,custom,local,showing,list,opened:list.find(skin=>skin.id===chromasOf&&skin.chromas?.length)||null};
}
function drawCards(){
  const {showing,list,opened}=view(),grid=$('grid');
  const items=(opened?opened.chromas:list).filter(matches),kind=opened?'chroma':'skin';
  const elements=items.map(item=>cardFor(item,kind));
  let empty=null;
  if(!elements.length){
    empty=grid.querySelector('.empty')||document.createElement('p');
    empty.className='empty';
    setText(empty,(opened?opened.chromas.length:list.length)?'No skins or chromas match your search.':showing==='riot'?`No skins for ${state.champion} in the skin database yet.`
      :showing==='local'?`No local skins for ${state.champion} yet. Put your own in its folder: Custom Mods → Local Skins on the dashboard.`
      :`No custom skins for ${state.champion} yet.`);
    elements.push(empty);
  }
  const same=elements.length===grid.children.length&&elements.every((element,index)=>grid.children[index]===element);
  if(!same)grid.replaceChildren(...elements);
  if(!empty)items.forEach((item,index)=>markCard(elements[index],item));
}
function drawMiddle(){
  const {riot,custom,local,showing,opened}=view(),middle=$('middle');
  const off=!!state.riotSkinsOff,identity=opened?`chroma:${opened.id}:${opened.variantKind||''}`:`tabs:${off}`;
  const variantTitle=opened?.variantKind==='forms'?'FORMS':opened?.variantKind==='editions'?'EDITIONS':'CHROMAS';
  if(chromaView!==identity){
    chromaView=identity;
    const riotTab=off?'':'<button class="tab" data-tab="riot" type="button">Skins <span class="count" id="count-riot"></span></button>';
    const localTitle=off?'Your own skins, from the LocalSkins folder. Friends in your party see the skin you chose in League instead.'
      :'Your own skins, from the LocalSkins folder. Friends in your party see one of this champion&#39;s latest skins instead.';
    middle.innerHTML=opened
      ?`<button class="back" type="button" id="back">‹ BACK</button><div class="chroma-title">${esc(opened.name)}<small>${variantTitle}</small></div>`
      :`<div class="tabs">${riotTab}<button class="tab" data-tab="custom" type="button">Custom <span class="count" id="count-custom"></span></button><button class="tab" data-tab="local" type="button" title="${localTitle}">Local <span class="count" id="count-local"></span></button></div>`;
  }
  if(!opened){
    middle.querySelectorAll('[data-tab]').forEach(button=>button.classList.toggle('active',button.dataset.tab===showing));
    if(!off)setText($('count-riot'),String(riot.length));
    setText($('count-custom'),String(custom.length));setText($('count-local'),String(local.length));
  }
  $('search').disabled=false;
  $('random-skin').hidden=!!opened;
}
function drawMarks(){
  if(state?.mode!=='open')return;
  const {list,opened}=view();
  for(const item of opened?opened.chromas:list.filter(matches)){
    const held=cards.get(`${opened?'chroma':'skin'}:${item.id}`);
    if(held)markCard(held.element,item);
  }
  const selected=state.skins.find(enabledNow),button=$('disable-skin');
  button.hidden=!selected;
  if(selected){button.dataset.id=activeOf(selected);button.disabled=!!state.preview;}
}
/**
 * League's Reconnect screen, after the player left a running game: one large banner says whether
 * pressing Reconnect now gets the chosen skin (`state.reconnectSafe`, from GameHold), or to wait.
 * Null outside that screen.
 */
function reconnectStage(){
  if(!state.reconnect||typeof state.reconnectSafe!=='boolean')return '';
  return state.reconnectSafe&&!state.pending?'safe':'wait';
}
function chosenName(){
  const skin=state.skins.find(enabledNow);
  if(!skin)return '';
  const chroma=skin.chromas?.find(enabledNow);
  return chroma?`${skin.name} (${chroma.name})`:skin.name;
}
function drawReconnect(){
  const banner=$('reconnect-banner'),stage=reconnectStage();
  banner.hidden=!stage;
  if(!stage)return;
  banner.classList.toggle('safe',stage==='safe');banner.classList.toggle('wait',stage==='wait');
  const name=chosenName(),problem=state.error||state.patcherError;
  setText($('rb-title'),stage==='safe'?'SAFE TO RECONNECT':'WAIT — DON’T RECONNECT YET');
  setText($('rb-detail'),stage==='wait'?`Loading ${name||'your skin'} into League… This panel turns green when it is done.`
    :problem?'Your skin did not load (see below). Reconnecting now plays without it.'
    :name?`Press Reconnect in League now. ${name} is loaded.`
    :'No skin chosen. Double-click one first, or press Reconnect to play without one.');
}
// What the open panel's footer says, so that the folded tab flags the same errors.
const shownProblem=s=>s.error||s.databaseError||s.patcherError||'';
function drawFooter(){
  const problem=shownProblem(state);
  const error=$('selection-error'),note=$('selection-note');
  setText(error,problem);error.hidden=!problem;
  // The banner says it louder on the Reconnect screen.
  const shownNote=reconnectStage()?'':state.holdNote||'';
  setText(note,shownNote);note.hidden=!shownNote;
  const hint=$('footer-hint');
  setText(hint,state.preview?'LAYOUT PREVIEW':'Double-click a skin to enable or disable it');
  hint.classList.toggle('preview-label',!!state.preview);
  const pill=$('restored-pill');
  const restored=state.restoredSkin?.label||'';
  pill.hidden=!restored;
  if(restored)setText($('restored-text'),`Restored: ${restored}`);
  setText($('footer-status'),state.pending?'Applying…':state.preview?'Friloverse preview':!state.connected?state.connection||'LTK Manager is not ready':reconnectStage()==='safe'?'Ready: press Reconnect in League':PATCHER[state.patcher]||'');
}
function drawTab(){
  const expand=$('expand'),stage=reconnectStage();
  const problem=shownProblem(state);
  expand.classList.toggle('failed',!!problem&&!stage);
  // Folded on the Reconnect screen, the tab still says whether it is safe.
  expand.classList.toggle('wait',stage==='wait');expand.classList.toggle('safe',stage==='safe');
  expand.title=stage==='safe'?'Safe to reconnect':stage==='wait'?'Wait: your skin is loading':problem||'Open skins';
  expand.setAttribute('aria-label',stage==='safe'?'Safe to reconnect. Open skins.':stage==='wait'?'Wait, your skin is still loading. Open skins.':problem?'Skins have a problem. Open to view the error.':'Open skins');
  const source=icon(state.champion);
  if($('tab-icon').getAttribute('src')!==source){$('tab-icon').style.visibility='';$('tab-icon').src=source;}
  setText($('tab-word'),stage==='safe'?'SAFE ✓':stage==='wait'?'WAIT…':problem?'SKINS !':'SKINS');
}
function drawSwiftplay(){
  const bar=$('swiftplay-bar');
  const sp=state?.swiftplay;
  if(!sp?.active||!sp.slots?.length){bar.hidden=true;return;}
  bar.hidden=false;
  const html=`<span class="sp-label">SWIFTPLAY</span>`+sp.slots.map(slot=>`<button type="button" class="sp-slot${slot.index===sp.activeSlot?' active':''}${slot.pickedLabel?' picked':''}" data-slot="${slot.index}"><span class="sp-idx">${slot.index+1}</span><span class="sp-name">${esc(slot.name)}</span>${slot.pickedLabel?`<span class="sp-skin">· ${esc(slot.pickedLabel)}</span>`:''}</button>`).join('');
  if(bar.dataset.html!==html){bar.dataset.html=html;bar.innerHTML=html;}
}
function draw(){
  if(!built)build();
  const mode=state?.mode||'hidden';
  if(root.className!==mode)root.className=mode;
  $('open-view').hidden=mode!=='open';$('tab-view').hidden=mode!=='tab';
  fit();
  // The next draft starts clean, even on the same champion.
  if(!state.champion){shown='';return;}
  const key=championKey(state.champion);
  if(key!==shown){
    shown=key;query='';picked='';tab='';chromasOf='';lastClick={id:'',at:0};optimistic=null;chromaView='';
    cards.clear();$('grid').replaceChildren();$('search').value='';$('grid').scrollTop=0;
  }
  if(mode==='tab'){drawTab();return;}
  if(mode!=='open')return;
  const source=icon(state.champion);
  if($('portrait').getAttribute('src')!==source){$('portrait').style.visibility='';$('portrait').src=source;}
  setText($('champion-name'),state.champion);
  drawSwiftplay();drawMiddle();drawCards();drawMarks();drawReconnect();drawFooter();
}
function receive(next){
  if(Array.isArray(next.champions))champions=next.champions;
  state=next;
  // The click has its answer: real state from here on.
  if(optimistic&&(state.error||!state.pending&&performance.now()-optimistic.at>OPTIMISTIC_GRACE))optimistic=null;
  draw();
}
window.addEventListener('resize',fit);
window.addEventListener('keydown',event=>{
  if(event.key!=='Escape')return;
  // Escape empties a search first; the next one folds the panel.
  const box=event.target;
  if(box?.id==='search'&&box.value){box.value='';box.dispatchEvent(new Event('input'));return;}
  window.friloverse.action('collapse');
});
window.friloverse.onState(receive);
window.friloverse.ready().then(receive);
