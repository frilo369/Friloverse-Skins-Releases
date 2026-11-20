const partyIconTools=window.FriloversePartyIcons;
let partyIcons=[],partyIconAliases={},partyIconById=new Map(),iconCategory='all',iconsSaving=0,namesSaving=0,nameTimer=null,kickTimer=null;
let current,icons=[],chosenIcon='',iconReady=false,editingName=false,armedKick='',quickMarkup='',modsMarkup='',avatarMarkup='',actionError='',settingsError='',modsActionError='',guideCapturing=false,memberSlots=[],updateAnswered='',updatePressed=false;
const KEY_WORDS={BracketLeft:'[',BracketRight:']',Semicolon:';',Quote:"'",Backslash:'\\',Comma:',',Period:'.',Slash:'/',Backquote:'`',Minus:'-',Equal:'=',ArrowUp:'Up',ArrowDown:'Down',ArrowLeft:'Left',ArrowRight:'Right',NumpadAdd:'Num +',NumpadSubtract:'Num -',NumpadMultiply:'Num *',NumpadDivide:'Num /',NumpadDecimal:'Num .',NumpadEnter:'Num Enter',Super:'Win'};
// A shortcut as the player reads it: "Ctrl+[", not "Ctrl+BracketLeft".
const hotkeyLabel=value=>String(value||'F1').split('+').map(part=>KEY_WORDS[part]||part.replace(/^Key([A-Z])$/,'$1').replace(/^Digit([0-9])$/,'$1').replace(/^Numpad([0-9])$/,'Num $1')).join('+');
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iconFor=key=>icons.find(icon=>icon.key===String(key));
// One line for every update Friloverse can be doing at once.
const updateLine=()=>[settingsError,current?.importError,current?.appUpdateStatus,current?.databaseStatus,current?.riotUpdateStatus,current?.riotSkinsError,current?.skinUpdateStatus].filter(Boolean).join(' · ');
// The top-left panel: one card for each task in flight (6.0). A card stays and only what changed
// is touched, so a download's bar glides instead of being redrawn several times a second.
const DOWNLOAD_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-5-5m5 5 5-5M5 20h14"/></svg>';
// Enough digits that a small download visibly moves: one decimal showed "0.4 MB of 0.4 MB" for all of a 0.43 MB update (7.1).
const megabytes=bytes=>bytes>=1024**3?`${(bytes/1024**3).toFixed(2)} GB`:bytes>=100*1024**2?`${Math.round(bytes/1024**2)} MB`:bytes>=1024**2?`${(bytes/1024**2).toFixed(bytes>=10*1024**2?1:2)} MB`:`${Math.round(bytes/1024)} KB`;
function timeLeft(seconds){
  if(!Number.isFinite(seconds)||seconds<=0)return '';
  if(seconds<60)return `${Math.max(1,Math.round(seconds/5)*5)} s left`;
  if(seconds<3600)return `about ${Math.round(seconds/60)} min left`;
  return `about ${Math.floor(seconds/3600)} h ${Math.round(seconds%3600/60)} min left`;
}
function taskWords(task){
  const max=Number(task.max),value=Number(task.value)||0;
  const known=!task.indeterminate&&Number.isFinite(max)&&max>0;
  const parts=[];
  if(task.unit==='bytes'&&known){
    parts.push(`${megabytes(value)} of ${megabytes(max)}`);
    if(task.rate>0)parts.push(task.rate>=1024**2?`${(task.rate/1024**2).toFixed(1)} MB/s`:`${Math.round(task.rate/1024)} KB/s`);
    const left=timeLeft(task.eta);if(left)parts.push(left);
  }else if(task.unit==='bytes'&&value>0)parts.push(`${megabytes(value)} downloaded`);
  if(task.detail)parts.push(task.detail);
  else if(known&&task.unit!=='bytes')parts.push(`${value} of ${max}`);
  return {known,percent:known?Math.max(0,Math.min(100,value/max*100)):0,line:parts.join(' · ')||'This can take a moment'};
}
function renderTasks(tasks){
  const box=$('tasks');
  if(!box)return;
  const list=Array.isArray(tasks)?tasks:[];
  box.hidden=!list.length;
  const keep=new Set(list.map(task=>task.key));
  for(const card of [...box.children])if(!keep.has(card.dataset.key))card.remove();
  list.forEach((task,index)=>{
    let card=[...box.children].find(item=>item.dataset.key===task.key);
    if(!card){
      card=document.createElement('div');card.className='task';card.dataset.key=task.key;
      card.innerHTML='<span class="task-icon"></span><div class="task-body"><div class="task-top"><span class="task-label"></span><span class="task-percent"></span></div><div class="task-bar"><span class="task-fill"></span></div><div class="task-detail"></div></div>';
    }
    if(box.children[index]!==card)box.insertBefore(card,box.children[index]||null);
    const {known,percent,line}=taskWords(task),download=task.unit==='bytes';
    card.classList.toggle('moving',!known);card.classList.toggle('download',download);card.classList.toggle('first',index===0);
    const icon=card.querySelector('.task-icon'),kind=download?'download':'spin';
    if(icon.dataset.kind!==kind){icon.dataset.kind=kind;icon.innerHTML=download?DOWNLOAD_ICON:'';}
    const set=(selector,text)=>{const node=card.querySelector(selector);if(node.textContent!==text)node.textContent=text;};
    set('.task-label',task.label||'Working…');set('.task-percent',known?`${Math.floor(percent)}%`:'');set('.task-detail',line);
    const width=known?`${percent.toFixed(1)}%`:'';
    const fill=card.querySelector('.task-fill');if(fill.style.width!==width)fill.style.width=width;
  });
}
function championKey(value){
  const key=String(value||'').normalize('NFKD').replace(/[^a-z0-9]/gi,'').toLowerCase();
  return ({wukong:'monkeyking',nunuwillump:'nunu',renataglasc:'renata'})[key]||key;
}
const championFor=id=>{
  const target=championKey(id);
  return icons.find(icon=>championKey(icon.id)===target||championKey(icon.name)===target);
};
// Party icons work as in FrYiLoCo. An old saved ID can still be a champion's key.
const iconById=id=>partyIconById.get(partyIconAliases[id]??id);
const knownIcon=id=>Boolean(iconById(id)||iconFor(id));
function iconImage(key,lazy=false){
  const icon=iconById(key),lazily=lazy?' loading="lazy"':'';
  if(icon?.summonerId!==undefined)return `<img src="friloverse-icon://summoner/${esc(icon.summonerId)}" alt=""${lazily} data-party-icon="${esc(icon.summonerId)}">`;
  if(icon)return `<img src="${esc(icon.path)}" alt=""${lazily}>`;
  const champion=iconFor(key);
  if(champion)return `<img src="icons/${esc(champion.id)}.png" alt=""${lazily}>`;
  // A friend's icon can be newer than this PC's League patch.
  const summoner=Number(key)-1000000000;
  return summoner>0?`<img src="friloverse-icon://summoner/${summoner}" alt=""${lazily} data-party-icon="${summoner}">`:'✦';
}
const portrait=key=>iconImage(key);
const iconName=key=>iconById(key)?.name||iconFor(key)?.name||'Party icon';
// A League icon that cannot be read falls back to its public copy, then a placeholder.
document.addEventListener('error',event=>{
  const image=event.target;
  if(!(image instanceof HTMLImageElement))return;
  if(!image.classList.contains('member-art')){partyIconTools.advancePartyIconFallback(image);return;}
  // A skin's picture, then its fallback, then just the card.
  const fallback=image.dataset.fallback;
  if(fallback&&image.getAttribute('src')!==fallback){delete image.dataset.fallback;image.src=fallback;}
  else image.classList.remove('ready');
},true);
document.addEventListener('load',event=>{if(event.target.classList?.contains('member-art'))event.target.classList.add('ready');},true);
function selectIcon(id){
  chosenIcon=partyIconAliases[id]??id;
  avatarMarkup=portrait(chosenIcon);$('avatar').innerHTML=avatarMarkup;
  // Counted before drawing, so the recent icons already put this one first.
  iconsSaving++;
  quickMarkup='';drawQuickIcons();
  void action('party-profile',{name:$('name').value,icon:chosenIcon,rememberIcon:true}).finally(()=>{iconsSaving--;});
}
function drawQuickIcons(){
  const profile=current?.party?.profile;
  // The selected icon leads, then earlier choices, most recent first.
  const recent=partyIconTools.recentPartyIcons((profile?.recentIcons||[]).filter(knownIcon),iconsSaving?chosenIcon:profile?.icon||'',partyIconAliases).filter(knownIcon);
  const markup=Array.from({length:6},(_,index)=>{
    const id=recent[index];
    return !id?'<button type="button" class="empty" data-empty-icon title="Browse party icons" aria-label="Browse party icons"></button>':`<button type="button" class="${chosenIcon===id?'selected':''}" data-quick-icon="${esc(id)}" title="${esc(iconName(id))}" aria-label="Select recent party icon: ${esc(iconName(id))}" aria-pressed="${chosenIcon===id}">${portrait(id)}</button>`;
  }).join('');
  if(markup===quickMarkup)return;quickMarkup=markup;$('quick-icons').innerHTML=markup;
  $('quick-icons').querySelectorAll('[data-quick-icon]').forEach(button=>button.onclick=()=>selectIcon(button.dataset.quickIcon));
  $('quick-icons').querySelectorAll('[data-empty-icon]').forEach(button=>button.onclick=openIconPicker);
}
function drawIcons(){
  const categories=[{id:'all',label:'All icons'},...partyIconTools.PARTY_ICON_CATEGORIES];
  $('icon-categories').innerHTML=categories.map(category=>`<button type="button" class="${category.id===iconCategory?'active':''}" data-icon-category="${esc(category.id)}" aria-pressed="${category.id===iconCategory}">${esc(category.label)}</button>`).join('');
  $('icon-categories').querySelectorAll('[data-icon-category]').forEach(button=>button.onclick=()=>{
    iconCategory=button.dataset.iconCategory;drawIcons();$('icon-grid').scrollTop=0;
  });
  const selected=partyIconAliases[chosenIcon]??chosenIcon;
  const sections=partyIconTools.partyIconSections(partyIcons,$('icon-search').value,iconCategory);
  $('icon-grid').innerHTML=sections.map(section=>`<section aria-label="${esc(section.label)}"><div class="icon-section-heading"><h3>${esc(section.label)}</h3><span>${section.icons.length}</span></div><p>${esc(section.description)}</p><div class="icon-tiles">${section.icons.map(icon=>`<button type="button" class="${icon.id===selected?'selected':''}" data-icon="${esc(icon.id)}" title="${esc(icon.name)}" aria-label="${esc(icon.name)}" aria-pressed="${icon.id===selected}">${iconImage(icon.id,true)}</button>`).join('')}</div></section>`).join('')||'<p class="icon-none">No icons match that search.</p>';
}
// One listener: the list can hold thousands of icons and is redrawn on every search key.
$('icon-grid').onclick=event=>{
  const button=event.target.closest('[data-icon]');
  if(button){$('icon-dialog').close();selectIcon(button.dataset.icon);}
};
function openIconPicker(){$('icon-search').value='';drawIcons();$('icon-dialog').showModal();$('icon-grid').scrollTop=0;$('icon-search').focus();}
async function loadPartyIcons(){
  try{
    const catalogue=await window.friloverse.partyIcons();
    partyIcons=catalogue.icons;partyIconAliases=catalogue.aliases;
    partyIconById=new Map(partyIcons.map(icon=>[icon.id,icon]));
    avatarMarkup='';quickMarkup='';for(const slot of memberSlots)slot.markup='';
    if(current)receive(current);
    // A picker opened before the catalogue arrived shows it now, not "no icons match".
    if($('icon-dialog').open)drawIcons();
  }catch(error){console.error('Party icons could not be loaded.',error);}
}
// Where a member's skin stands, in the words and the three steps a card shows.
const STAGES={
  selected:null,
  syncing:{word:'Getting skins',tone:'busy',steps:2},
  preparing:{word:'Applying skin',tone:'busy',steps:2},
  armed:{word:'Ready',tone:'ready',steps:3},
  prepared:{word:'Ready',tone:'ready',steps:3},
  partial:{word:'Ready, a skin is missing',tone:'warn',steps:3},
  active:{word:'In game',tone:'ready',steps:3},
  error:{word:'Skin failed',tone:'bad',steps:2},
};
function memberStage(member,party,missing){
  if(party.status!=='connected')return {word:'Reconnecting…',tone:'idle',steps:0};
  if(member.hidden)return {word:'In the party',tone:'idle',steps:0};
  if(!member.playing)return {word:'In lobby',tone:'idle',steps:0};
  const stage=STAGES[member.preparation]||{word:member.skin?'Skin selected':'Base skin',tone:'idle',steps:member.skin?1:0};
  return missing?{...stage,word:`${stage.word} · not on this PC`,tone:stage.tone==='bad'?'bad':'warn'}:stage;
}
const memberSteps=stage=>`<span class="stage-steps" aria-hidden="true">${[1,2,3].map(step=>`<i class="${step<=stage.steps?'on':''}"></i>`).join('')}</span>`;
function memberMarkup(member,party,host){
  const champ=championFor(member.playing||member.skin?.championId);
  const title=champ?.name||member.playing||'No champion selected';
  const self=member.id===party.selfId,armed=armedKick===member.id;
  const kick=host&&!self&&!member.host?`<button type="button" class="kick${armed?' armed':''}" data-kick="${esc(member.id)}" title="Remove ${esc(member.name)} from the party">${armed?'Confirm?':'Kick'}</button>`:'';
  const missing=!self&&member.skin&&(party.missing||[]).some(item=>championKey(item.champion)===championKey(member.skin.championId));
  const detail=member.hidden?'Hidden by Stealth':member.skin?member.skin.relative||'Custom skin':member.playing?'No skin chosen':'Waiting for selection';
  const stage=memberStage(member,party,missing);
  // A member announcing no version, or an older one than someone here, has an update waiting.
  const behind=party.members.some(other=>other.version&&(!member.version||compareParts(other.version,member.version)>0));
  return `<div class="member-top">${self?`<button type="button" class="member-avatar change-icon" data-change-icon title="Change your party icon" aria-label="Change your party icon">${portrait(member.icon)}</button>`:`<span class="member-avatar">${portrait(member.icon)}</span>`}<div><div class="member-name">${esc(member.name)}</div>${member.host?'<span class="badge">HOST</span>':''}${self?'<span class="badge">YOU</span>':''}${behind?'<span class="badge behind" title="This player is on an older version">OLD</span>':''}</div></div>${kick}<div class="member-foot"><div class="member-skin">${member.hidden?'Hidden':esc(title)}</div><div class="member-detail">${esc(detail)}</div><div class="member-stage ${stage.tone}"><span class="stage-word">${esc(stage.word)}</span>${memberSteps(stage)}</div></div>`;
}
const compareParts=(left,right)=>{
  const a=String(left).split('.').map(Number),b=String(right).split('.').map(Number);
  for(let index=0;index<3;index++){const difference=(a[index]||0)-(b[index]||0);if(difference)return difference;}
  return 0;
};
// The eight cards are made once and only what changed is touched, so a member's picture never
// reloads or flashes when their status moves on.
function ensureMemberSlots(){
  if(memberSlots.length)return;
  const box=$('members');
  for(let index=0;index<8;index++){
    const root=document.createElement('article');root.className='member vacant';
    const art=document.createElement('img');art.className='member-art';art.alt='';art.draggable=false;art.decoding='async';art.hidden=true;
    const body=document.createElement('div');body.className='member-body';
    root.append(art,body);box.append(root);
    memberSlots.push({root,art,body,markup:'',source:''});
  }
  box.addEventListener('click',event=>{
    if(event.target.closest('[data-change-icon]')){openIconPicker();return;}
    const button=event.target.closest('[data-kick]');
    if(!button)return;
    const id=button.dataset.kick;
    clearTimeout(kickTimer);kickTimer=null;
    if(armedKick===id){armedKick='';memberCards(current.party);void action('party-kick',id);}
    else{
      // Each arming gets its own 4 s; an earlier one's timer cannot disarm it early.
      armedKick=id;memberCards(current.party);
      kickTimer=setTimeout(()=>{kickTimer=null;if(armedKick===id){armedKick='';memberCards(current.party);}},4000);
    }
  });
}
function memberPicture(member){
  if(member?.hidden)return null;
  if(member?.art?.image)return {image:member.art.image,fallback:member.art.fallback||'',chosen:true};
  const champ=championFor(member?.playing||member?.skin?.championId);
  // A friend's skin this PC has no picture for still shows who they are playing.
  return champ?{image:`https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${champ.id}_0.jpg`,fallback:'',chosen:!!member.skin}:null;
}
function memberCards(party){
  ensureMemberSlots();
  const members=party.members||[];
  const host=members.some(m=>m.id===party.selfId&&m.host);
  memberSlots.forEach((slot,index)=>{
    const member=members[index];
    const markup=member?memberMarkup(member,party,host):'<span>✧ &nbsp; Waiting for player…</span>';
    if(markup!==slot.markup){slot.markup=markup;slot.body.innerHTML=markup;}
    const picture=member?memberPicture(member):null,source=picture?.image||'';
    slot.root.classList.toggle('vacant',!member);
    slot.root.classList.toggle('no-skin',!!member&&!picture?.chosen);
    if(source!==slot.source){
      slot.source=source;
      slot.art.classList.remove('ready');slot.art.hidden=!source;
      if(source){slot.art.dataset.fallback=picture.fallback;slot.art.src=source;}
      else{delete slot.art.dataset.fallback;slot.art.removeAttribute('src');}
    }
  });
}
// Someone here is on a newer version: the pop-up names it, and its button does the update.
function showUpdatePopup(state,party){
  const dialog=$('update-dialog'),version=party.updateTo||'';
  const asked=`${party.code||''}:${version}`;
  // An update belongs to the app once pressed, even if the party drops or is left.
  const updating=updatePressed;
  if(updatePressed){
    const status=state.appUpdateStatus||'';
    const working=!status||/Checking|Downloading|downloaded/.test(status);
    $('update-progress').textContent=status==='Friloverse is up to date.'?'The update is not ready to download yet. Try again in a few minutes.':status||'Checking for the update…';
    $('update-now').disabled=working;
    if(!working)updatePressed=false;
  }
  if(!version||party.status!=='connected'){
    if(dialog.open&&!updating&&!$('update-progress').textContent)dialog.close();
    return;
  }
  $('update-now').textContent=`UPDATE TO ${version}`;
  $('update-text').textContent=`Someone in this party has Friloverse ${version}, and you have ${state.version||'an older one'}. Friloverse closes, updates and reopens by itself. Join again with code ${party.code||''} afterwards.`;
  if(!dialog.open&&updateAnswered!==asked)dialog.showModal();
}
$('update-now').onclick=()=>{
  updatePressed=true;$('update-now').disabled=true;$('update-progress').textContent='Checking for the update…';
  void action('check-updates');
};
$('update-later').onclick=()=>{
  updateAnswered=`${current?.party?.code||''}:${current?.party?.updateTo||''}`;updatePressed=false;
  $('update-now').disabled=false;$('update-progress').textContent='';$('update-dialog').close();
};
$('update-dialog').addEventListener('cancel',event=>{event.preventDefault();$('update-later').click();});
function receive(state){
  current=state;
  renderTasks(state.tasks||(state.progress?[{key:'task',...state.progress}]:[]));
  if(!iconReady&&Array.isArray(state.champions)){icons=state.champions;iconReady=true;}
  const party=state.party||{status:'idle',members:[],profile:{name:'',icon:''}};
  // A name still being saved is kept: an icon picked meanwhile sends the name in the box.
  if(!editingName&&!namesSaving&&document.activeElement!==$('name'))$('name').value=party.profile?.name||'';
  if(!$('icon-dialog').open&&!iconsSaving){const saved=party.profile?.icon||icons.find(item=>item.id==='MasterYi')?.key||'';chosenIcon=partyIconAliases[saved]??saved;}
  const avatar=portrait(chosenIcon);if(avatar!==avatarMarkup){avatarMarkup=avatar;$('avatar').innerHTML=avatar;}drawQuickIcons();
  const active=['connected','connecting','reconnecting'].includes(party.status);
  $('setup').hidden=active;$('room').hidden=!active;$('stage').classList.toggle('in-room',active);
  $('room-code').textContent=party.code||'----';$('member-count').textContent=String(party.members?.length||0);
  if(active)memberCards(party);
  else if(armedKick){armedKick='';clearTimeout(kickTimer);kickTimer=null;}
  showUpdatePopup(state,party);
  const hosting=(party.members||[]).some(member=>member.id===party.selfId&&member.host);
  $('stealth').hidden=!hosting;$('stealth').classList.toggle('active',!!party.stealth);$('stealth').setAttribute('aria-pressed',String(!!party.stealth));
  $('stealth-badge').hidden=hosting||!party.stealth;
  showWarning();
  $('version').textContent=state.version||'';
  $('close-docked').hidden=!state.partyDocked;
  $('connection').textContent=state.connection;
  $('connection-detail').textContent=state.holdWarning||state.checkResult||party.syncStatus||state.ltkInstallError||state.riotSkinsError||(state.champion?`${state.champion} · ${state.skins.length} skins`:state.importError||state.riotUpdateStatus||state.skinUpdateStatus||state.ltkNotice||(state.connected?'Ready for champion select.':'Friloverse starts LTK Manager for you.'));
  $('dot').classList.toggle('connected',!!state.leagueConnected);
  $('connection-pill').textContent=state.preview?'Preview':!state.connected?'LTK needed':state.leagueConnected?'Connected':'Waiting';
  $('connection-pill').classList.toggle('offline',!state.leagueConnected);
  $('connect').hidden=state.connected||state.preview;$('connect').disabled=!!state.ltkInstalling;
  $('retry').hidden=!party.syncFailed;
  const settings=state.settings||{};
  applyTheme(settings.theme);
  $('start-with-windows').checked=settings.startWithWindows!==false;
  $('remember-last-skin').checked=settings.rememberLastSkin===true;
  if(!guideCapturing)$('guide-key').textContent=`${hotkeyLabel(settings.guideHotkey)} · Change`;
  renderIssues(state);
  $('update-status').textContent=updateLine();
  $('check-databases').disabled=!!state.databaseChecking||!!state.preview;
  $('check-databases').textContent=state.databaseChecking?'Checking databases…':'Check databases';
  $('send-logs').disabled=!!state.logsSending||!!state.preview;
  $('send-logs').textContent=state.logsSending?'Sending…':'Send logs';
  $('logs-status').textContent=state.logsStatus||'';
  $('logs-status').classList.toggle('sent',!!state.logsCode&&/^Sent\./.test(state.logsStatus||''));
  // The note stays until the report is really sent, so a failed send can be tried again.
  if(state.logsCode&&state.logsCode!==noteClearedFor&&/^Sent\./.test(state.logsStatus||'')){noteClearedFor=state.logsCode;$('logs-note').value='';}
  showCopyCode();
  const rows=state.mods||[];
  const markup=rows.map(mod=>`<div class="mod-row"><span><strong>${esc(mod.name)}</strong><small>${esc(mod.author||'Custom mod')}${mod.enabled?' · Enabled':''}${mod.broken?' · This file is damaged':''}</small></span><button class="small-button" data-mod-id="${esc(mod.id)}" ${state.modsPending||!state.connected||state.preview||mod.broken&&!mod.enabled?'disabled':''}>${state.modsPending===mod.id?'Working…':mod.enabled?'Disable':'Enable'}</button></div>`).join('')||'<p class="dialog-subtitle">No custom mods found in the Friloverse database.</p>';
  if(markup!==modsMarkup){modsMarkup=markup;$('mods-list').innerHTML=markup;$('mods-list').querySelectorAll('[data-mod-id]').forEach(button=>button.onclick=()=>{const mod=current.mods.find(item=>item.id===button.dataset.modId);if(mod)void action('toggle-custom-mod',{id:mod.id,enabled:!mod.enabled});});}
  $('mods-message').textContent=modsLine(state);
  $('divine-browse').disabled=!!state.divineBusy;
  $('divine-status').textContent=state.divineMessage||'';
}
let issuesMarkup='';
function renderIssues(state){
  const list=Array.isArray(state?.issues)?state.issues:[];
  const currentCount=list.filter(item=>item.thisSession).length;
  $('open-settings').classList.toggle('has-issues',currentCount>0);
  const badge=$('troubleshooting-badge');
  badge.hidden=!currentCount;
  if(currentCount)badge.textContent=String(currentCount);
  $('run-diagnostics').disabled=!!state?.diagnosticsBusy||!!state?.preview;
  $('diag-run-now').disabled=!!state?.diagnosticsBusy||!!state?.preview;
  $('diag-status').textContent=state?.diagnosticsStatus||'';
  $('diag-clear-all').hidden=!list.length;
  const markup=list.length
    ?list.map(item=>`<article class="issue-card${item.thisSession?' current':''}"><div class="issue-head"><strong>${esc(item.title)}</strong><button type="button" class="issue-dismiss" data-dismiss-issue="${esc(item.id)}" title="Dismiss">×</button></div>${item.detail?`<p class="issue-detail">${esc(item.detail)}</p>`:''}${item.fix?`<p class="issue-fix"><strong>Fix:</strong> ${esc(item.fix)}</p>`:''}</article>`).join('')
    :'<p class="dialog-subtitle">No setup or LTK Manager issues detected.</p>';
  if(markup!==issuesMarkup){
    issuesMarkup=markup;
    $('issues-list').innerHTML=markup;
    $('issues-list').querySelectorAll('[data-dismiss-issue]').forEach(btn=>btn.onclick=()=>void action('dismiss-issue',btn.dataset.dismissIssue));
  }
}
// Without LTK every mod button is off, so the panel says why.
function modsLine(s){return modsActionError||s?.modsError||s?.modsNotice||(s&&!s.connected&&!s.preview?'Install LTK Manager to turn mods on or off.':'');}
// Themes (6.4): pictures in themes/, shown behind the panels. Friloverse is the lobby's own sky.
const THEMES=[
  {id:'friloverse',name:'Friloverse',file:''},
  {id:'divinity',name:'Divinity',file:'divinity.webp'},
  {id:'black-hole',name:'Black Hole',file:'black-hole.webp'},
  {id:'green-nebula',name:'Green Nebula',file:'green-nebula.webp'},
  {id:'rinne-sharingan',name:'Rinne Sharingan',file:'rinne-sharingan.webp'},
  {id:'spirit-blossom-ahri',name:'Spirit Blossom Ahri',file:'spirit-blossom-ahri.webp'},
  {id:'acheron',name:'Acheron',file:'acheron.webp'},
  {id:'astro',name:'Astro',file:'astro.webp'},
  {id:'ichigo',name:'Ichigo',file:'ichigo.webp'},
];
let shownTheme=null,pickedTheme=null,themeClick=0;
// Friloverse is the default (7.6), also for a name this version does not know.
const themeFor=id=>THEMES.find(theme=>theme.id===id)||THEMES[0];
function applyTheme(id){
  const theme=themeFor(pickedTheme??id);
  if(theme.id===shownTheme)return;
  shownTheme=theme.id;
  try{localStorage.setItem('friloverse-theme',theme.id);}catch{}
  document.documentElement.style.setProperty('--theme-art',theme.file?`url("themes/${theme.file}")`:'none');
  document.body.classList.toggle('themed',!!theme.file);
  for(const card of $('theme-grid').children){
    const on=card.dataset.theme===theme.id;
    card.setAttribute('aria-checked',String(on));card.querySelector('.theme-in-use').hidden=!on;
  }
}
// Cards are built once; each shows its theme's picture.
for(const theme of THEMES){
  const card=document.createElement('button');
  card.type='button';card.className='theme-card';card.dataset.theme=theme.id;card.setAttribute('role','radio');card.setAttribute('aria-checked','false');
  const art=document.createElement('span');art.className='theme-art';
  // The theme's whole picture (6.7, owner's request), not the lobby over it.
  art.style.backgroundImage=theme.file?`url("themes/${theme.file}")`:'url("home-sky.webp")';
  const name=document.createElement('span');name.className='theme-name';name.textContent=theme.name;
  const using=document.createElement('span');using.className='theme-in-use';using.textContent='✓ In use';using.hidden=true;
  name.append(using);card.append(art,name);
  card.onclick=async()=>{
    // Shown at once; what was saved wins once the answer comes back.
    const click=++themeClick;
    pickedTheme=theme.id;applyTheme();
    await action('set-setting',{key:'theme',value:theme.id});
    // Only the newest click's answer counts, or a slow older one would flash its theme back.
    if(click!==themeClick)return;
    pickedTheme=null;shownTheme=null;applyTheme(current?.settings?.theme);
  };
  $('theme-grid').append(card);
}
$('theme-grid').addEventListener('keydown',event=>{
  const cards=[...$('theme-grid').children],at=cards.indexOf(document.activeElement);
  const columns=getComputedStyle($('theme-grid')).gridTemplateColumns.split(' ').length||1;
  const step={ArrowLeft:-1,ArrowRight:1,ArrowUp:-columns,ArrowDown:columns}[event.key];
  if(at<0||!step)return;
  event.preventDefault();cards[Math.max(0,Math.min(cards.length-1,at+step))].focus();
});
// The theme last shown comes up at once, so the default sky does not flash before the settings arrive.
let savedTheme;try{savedTheme=localStorage.getItem('friloverse-theme');}catch{}
applyTheme(savedTheme);
function showWarning(){
  const party=current?.party||{};
  const warning=party.error||party.notice||(party.missing?.length?`Not available on this PC: ${party.missing.map(m=>m.name).join(', ')}.`:'')||actionError;
  $('party-message').hidden=!warning;$('party-message').textContent=warning;
}
async function action(kind,value,{keepError=false}={}){
  try{const result=await window.friloverse.action(kind,value);if(actionError&&!keepError){actionError='';showWarning();}return result;}
  catch(error){actionError=String(error.message||error);showWarning();}
}
let entering=false;
function enter(mode){
  if(entering)return;
  entering=true;editingName=false;clearTimeout(nameTimer);
  // A second press while the relay answers would start a second party.
  const label=$(mode).lastChild,was=label.textContent;
  $('join').disabled=$('create').disabled=true;label.textContent=mode==='join'?'JOINING…':'CREATING…';
  return action('party-enter',{mode,name:$('name').value,icon:chosenIcon,code:$('code').value}).finally(()=>{
    entering=false;$('join').disabled=$('create').disabled=false;label.textContent=was;
  });
}
// An empty box never forgets the name: the last one comes back.
$('name').addEventListener('blur',()=>{editingName=false;if(!$('name').value.trim())$('name').value=current?.party?.profile?.name||'';});
const saveName=()=>{
  clearTimeout(nameTimer);if(!$('name').value.trim())return;
  namesSaving++;
  void action('party-profile',{name:$('name').value,icon:chosenIcon},{keepError:true}).finally(()=>{namesSaving--;});
};
// Saved while typing, so a name is kept even if the window closes before it loses focus.
$('name').addEventListener('input',()=>{editingName=true;clearTimeout(nameTimer);nameTimer=setTimeout(saveName,500);});
$('name').addEventListener('change',saveName);
$('code').addEventListener('input',()=>{$('code').value=$('code').value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);});
$('code').addEventListener('keydown',event=>{if(event.key==='Enter')void enter('join');});
$('paste-code').onclick=async()=>{const value=await action('paste-code');if(typeof value==='string')$('code').value=value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);};
$('join').onclick=()=>enter('join');$('create').onclick=()=>enter('create');
let stealthAt=0;
// The relay drops a burst of changes, and what shows is always what it confirmed.
$('stealth').onclick=()=>{if(Date.now()-stealthAt<400)return;stealthAt=Date.now();void action('party-stealth',!current?.party?.stealth);};
$('leave').onclick=()=>action('party-leave');let copiedTimer=null;
$('copy').onclick=async()=>{
  await action('party-copy');
  if(actionError)return;
  $('copy').textContent='Copied';clearTimeout(copiedTimer);
  copiedTimer=setTimeout(()=>{$('copy').textContent='Copy code';},1500);
};
$('connect').onclick=()=>action('connect');$('retry').onclick=()=>action('party-retry');
$('close-docked').onclick=()=>action('close-party');
$('minimize-window').onclick=()=>action('minimize-window');$('hide-window').onclick=()=>action('hide-window');
$('open-settings').onclick=()=>$('settings-dialog').showModal();$('close-settings').onclick=()=>$('settings-dialog').close();
$('open-troubleshooting').onclick=()=>{$('settings-dialog').close();$('troubleshooting-dialog').showModal();};
$('close-troubleshooting').onclick=()=>$('troubleshooting-dialog').close();
$('run-diagnostics').onclick=$('diag-run-now').onclick=()=>void action('run-diagnostics');
$('diag-clear-all').onclick=()=>void action('clear-issues');
$('open-logs-folder').onclick=()=>void action('open-logs');
$('open-mods').onclick=()=>{modsActionError='';void action('refresh-custom-mods');$('mods-dialog').showModal();};$('close-mods').onclick=()=>$('mods-dialog').close();
$('open-themes').onclick=()=>$('themes-dialog').showModal();$('close-themes').onclick=()=>$('themes-dialog').close();
// A click outside a dialog, on its dimmed backdrop, closes it (6.1, owner's request). The press must be
// outside too, so selecting text in a box and letting go outside keeps the dialog open.
for(const id of ['settings-dialog','troubleshooting-dialog','mods-dialog','icon-dialog','themes-dialog']){
  const dialog=$(id);let pressedOutside=false;
  const outside=event=>{const box=dialog.getBoundingClientRect();return event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom;};
  dialog.addEventListener('pointerdown',event=>{pressedOutside=event.target===dialog&&outside(event);});
  dialog.addEventListener('click',event=>{
    if(pressedOutside&&event.target===dialog&&outside(event)&&!guideCapturing)dialog.close();
    pressedOutside=false;
  });
}
$('refresh-mods').onclick=()=>{modsActionError='';void action('refresh-custom-mods');};
$('divine-browse').onclick=()=>void action('divine-browse');
// LocalSkins (10.0): Friloverse makes the folder and a folder per champion if they are missing.
$('open-local-skins').onclick=async()=>{
  try{await window.friloverse.action('open-library-folder','local');modsActionError='';}
  catch(error){modsActionError=String(error.message||error);}
  $('mods-message').textContent=modsLine(current);
};
$('open-mods-folder').onclick=async()=>{
  try{await window.friloverse.action('open-library-folder','mods');modsActionError='';}
  catch(error){modsActionError=String(error.message||error);}
  $('mods-message').textContent=modsLine(current);
};
for(const [id,key] of [['start-with-windows','startWithWindows'],['remember-last-skin','rememberLastSkin']])$(id).onchange=async()=>{
  try{await window.friloverse.action('set-setting',{key,value:$(id).checked});settingsError='';}
  catch(error){settingsError=String(error.message||error);$(id).checked=key==='startWithWindows'?current?.settings?.[key]!==false:current?.settings?.[key]===true;}
  $('update-status').textContent=updateLine();
};
// Both checks show their progress in the top-left panel, so Settings closes out of the way (6.2).
$('check-updates').onclick=()=>{$('settings-dialog').close();void action('check-updates');};
$('check-databases').onclick=()=>{$('settings-dialog').close();void action('check-databases');};
// Copy Code appears once a report is sent, and says Copied for that code once pressed (6.2).
var copiedCode='',noteClearedFor='';// var: render may run before this line
function showCopyCode(){
  const code=current?.logsCode||'',copied=!!code&&copiedCode===code;
  $('copy-logs-code').hidden=!code;
  $('copy-logs-code').textContent=copied?'Copied':'Copy Code';
  $('copy-logs-code').classList.toggle('copied',copied);
}
$('copy-logs-code').onclick=()=>{if(!current?.logsCode)return;copiedCode=current.logsCode;void action('copy-logs-code');showCopyCode();};
$('send-logs').onclick=()=>{action('send-logs',$('logs-note').value.trim());};
$('open-skins-folder').onclick=async()=>{
  try{await window.friloverse.action('open-library-folder','skins');settingsError='';}
  catch(error){settingsError=String(error.message||error);}
  $('update-status').textContent=updateLine();
};
$('guide-key').onclick=async()=>{guideCapturing=true;$('guide-key').textContent='Press shortcut…';$('guide-key-status').textContent='Press a key or combination. Escape cancels.';await action('guide-capture',true);};
async function endGuideCapture(value){
  guideCapturing=false;
  try{if(value){await window.friloverse.action('set-setting',{key:'guideHotkey',value});$('guide-key-status').textContent='Shortcut saved.';}else $('guide-key-status').textContent='Shortcut unchanged.';}
  catch(error){$('guide-key-status').textContent=String(error.message||error);}
  finally{await action('guide-capture',false);receive(current);}
}
$('guide-reset').onclick=()=>endGuideCapture('F1');
window.addEventListener('keydown',event=>{
  if(!guideCapturing)return;
  event.preventDefault();event.stopPropagation();
  if(event.key==='Escape'){void endGuideCapture();return;}
  if(event.repeat||event.isComposing)return;
  const code=event.code;
  if(!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Arrow(Up|Down|Left|Right)|Numpad([0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|Space|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(code))return;
  const mods=[];if(event.ctrlKey)mods.push('Ctrl');if(event.altKey)mods.push('Alt');if(event.shiftKey)mods.push('Shift');if(event.metaKey)mods.push('Super');
  void endGuideCapture([...mods,code].join('+'));
},true);
window.addEventListener('blur',()=>{if(guideCapturing)void endGuideCapture();});
$('settings-dialog').addEventListener('close',()=>{if(guideCapturing)void endGuideCapture();});
$('avatar').onclick=openIconPicker;
// A search redraws thousands of icons, so it waits until typing pauses.
let iconSearchTimer=null;
$('close-icons').onclick=()=>$('icon-dialog').close();$('icon-search').oninput=()=>{clearTimeout(iconSearchTimer);iconSearchTimer=setTimeout(drawIcons,60);};
// The whole stage is scaled to the window and centred.
function fitStage(){
  const stage=$('stage'),scale=Math.min(innerWidth/1672,innerHeight/941);
  stage.style.zoom=String(scale);stage.style.setProperty('--stage-scale',String(scale));
  stage.style.left=`${(innerWidth-1672*scale)/2/scale}px`;stage.style.top=`${(innerHeight-941*scale)/2/scale}px`;
}
window.addEventListener('resize',fitStage);fitStage();
window.friloverse.onState(receive);window.friloverse.ready().then(receive);
void loadPartyIcons();
