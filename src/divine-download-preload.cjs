// Follow the publisher's own free download flow for one skin, in a hidden window that opens as
// soon as its skin page is on screen. Divine's countdown stays (skipping it is what Divine+
// sells) and runs while the player looks at the skin. Nothing else waits: popups never hold the
// file list up, and once the player clicked Download (`divine-go`) the first offered file (the
// current version) is taken the moment Divine enables it.
const {ipcRenderer}=require('electron');

if(process.isMainFrame){
  let go=false,check=()=>{};
  ipcRenderer.on('divine-go',()=>{go=true;check();});
  window.addEventListener('DOMContentLoaded',()=>{
    if(location.origin!=='https://divineskins.gg'||!location.pathname.startsWith('/download/'))return;
    const visible=el=>el.checkVisibility()&&el.getClientRects().length>0;
    let requested=false,told=-1;
    check=()=>{
      if(requested)return;
      for(const popup of document.querySelectorAll('[role="dialog"],dialog[open]')){
        if(popup.querySelector('h2')?.textContent.trim()!=='Tired of waiting?'||!visible(popup))continue;
        const close=popup.querySelector('button[aria-label="Close"],button[title="Close"]')||
          [...popup.querySelectorAll('button')].find(b=>b.textContent.trim()==='Close');
        if(close&&!close.disabled&&visible(close))close.click();
      }
      const heading=[...document.querySelectorAll('h3')].find(h=>h.textContent.trim()==='Download files');
      if(!heading)return;
      // Find the nearest enclosing file list, without reaching other calls to action on the page.
      let group=heading.parentElement;
      for(let depth=0;group&&depth<4;depth++,group=group.parentElement){
        const button=[...group.querySelectorAll('button')].find(b=>b.textContent.trim()==='Download'&&visible(b));
        if(!button){
          // Still counting: "… is ready to download in 7 seconds."
          const seconds=Number(/ready to download in (\d+)\s*sec/i.exec(group.textContent)?.[1]);
          if(Number.isSafeInteger(seconds)&&seconds!==told){told=seconds;ipcRenderer.send('divine-wait',seconds);}
          continue;
        }
        if(button.disabled||button.getAttribute('aria-disabled')==='true')return;
        if(told!==0){told=0;ipcRenderer.send('divine-wait',0);}
        if(!go)return;
        requested=true;observer.disconnect();clearInterval(timer);button.click();return;
      }
    };
    // The page re-renders when the countdown ends: react at once, with a short poll as a fallback.
    const observer=new MutationObserver(()=>check());
    observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['disabled','aria-disabled']});
    const timer=setInterval(()=>check(),250);
    window.addEventListener('pagehide',()=>{observer.disconnect();clearInterval(timer);},{once:true});
    check();
  });
}
