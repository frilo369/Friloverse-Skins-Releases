// An isolated preload for Divine's catalogue. The page never receives a Friloverse API.
// 12.8 (owner): a skin page's own Download button imports the skin into LocalSkins. Divine's
// "Choose a variant" popup never opens and there is no separate Import button.
const {ipcRenderer}=require('electron');

if(process.isMainFrame){
  window.addEventListener('DOMContentLoaded',()=>{
    if(!['https://divineskins.gg','https://www.divineskins.gg'].includes(location.origin))return;
    // One line per skin the player is downloading (up to three run at once).
    const lines=new Map(),busy=new Set(),timers=new Map();
    let status,announced='',scheduled=false;
    function render(){
      if(!status?.isConnected){
        status=document.createElement('div');status.setAttribute('role','status');
        status.style.cssText='position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:9999;max-width:90vw;border:1px solid #dbb566;border-radius:12px;background:#101925;color:white;padding:10px 18px;font:600 14px system-ui;line-height:1.5;pointer-events:none;white-space:pre-line';
        document.body.append(status);
      }
      status.textContent=[...lines.values()].join('\n');
      status.hidden=!lines.size;
    }
    function show(key,text,{stay=false}={}){
      lines.delete(key);lines.set(key,text);
      clearTimeout(timers.get(key));
      if(!stay)timers.set(key,setTimeout(()=>{lines.delete(key);render();},6000));
      render();
    }
    const label=route=>{
      let slug=route.split('/').filter(Boolean).at(-1)||'';
      try{slug=decodeURIComponent(slug);}catch{}
      return slug.replace(/[-_]+/g,' ').trim().replace(/\b\p{Ll}/gu,letter=>letter.toUpperCase())||'Skin';
    };
    ipcRenderer.on('divine-progress',(_event,update)=>{
      if(typeof update?.route==='string'&&typeof update.text==='string'&&busy.has(update.route))show(update.route,`${label(update.route)}: ${update.text}`,{stay:true});
    });
    function skinPage(){
      const route=location.pathname.replace(/\/$/,'');
      if(!/^\/[^/]+\/[^/]+$/.test(route)||/^\/(?:mods|download)\//.test(route))return null;
      const link=document.querySelector('a[href*="/mods/lol?championName="]');
      const champion=link&&new URL(link.href).searchParams.get('championName');
      return champion?{route,champion}:null;
    }
    // The skin page's main Download button (never one inside a popup, or "Download Celestial").
    function isDownload(button){return !!button&&button.textContent.trim()==='Download'&&!button.closest('[role="dialog"],dialog');}
    function skinDownload(target){
      const button=target instanceof Element?target.closest('button'):null;
      return isDownload(button)?skinPage():null;
    }
    // As soon as a skin page shows its Download button, Friloverse opens Divine's download page
    // out of sight, so its free countdown runs while the player looks at the skin.
    function announce(){
      scheduled=false;
      const page=skinPage();
      if(!page||announced===page.route||![...document.querySelectorAll('button')].some(isDownload))return;
      announced=page.route;
      ipcRenderer.send('divine-skin-page',page.route);
    }
    new MutationObserver(()=>{if(!scheduled){scheduled=true;setTimeout(announce,120);}}).observe(document.body,{childList:true,subtree:true});
    announce();
    // Capture phase, so the page's own handlers (and its variant popup) never see the press.
    for(const type of ['pointerdown','mousedown'])window.addEventListener(type,event=>{
      if(skinDownload(event.target))event.stopImmediatePropagation();
    },true);
    window.addEventListener('click',async event=>{
      const pick=skinDownload(event.target);
      if(!pick)return;
      event.preventDefault();event.stopImmediatePropagation();
      if(!event.isTrusted)return;
      if(busy.has(pick.route)){show(pick.route,`${label(pick.route)}: already downloading.`,{stay:true});return;}
      busy.add(pick.route);
      show(pick.route,`${label(pick.route)}: getting the latest file…`,{stay:true});
      try{
        const result=await ipcRenderer.invoke('divine-card-import',pick);
        busy.delete(pick.route);
        show(pick.route,result?.saved?result.message:`${label(pick.route)}: ${result?.message||'the download was closed.'}`);
      }catch{busy.delete(pick.route);show(pick.route,`${label(pick.route)}: the download stopped. Click Download to try again.`);}
    },true);
  });
}
