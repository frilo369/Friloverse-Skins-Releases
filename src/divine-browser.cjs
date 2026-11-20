const {app,BrowserWindow,Menu,session,ipcMain}=require('electron');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {rm}=require('node:fs/promises');
let lastCatalogue='';

// `hidden`: a download window (12.8). It keeps full-speed timers so Divine's countdown runs
// as it would on screen, and its ads stay silent.
function divineWindow(parent,ses,preload,title,allowed,{hidden=false}={}){
  const win=new BrowserWindow({parent,width:1150,height:800,title,backgroundColor:'#10141a',show:!hidden,
    webPreferences:{session:ses,preload:path.join(__dirname,preload),sandbox:true,contextIsolation:true,nodeIntegration:false,webviewTag:false,navigateOnDragDrop:false,
      ...(hidden?{backgroundThrottling:false}:{})}});
  const contents=win.webContents;
  if(hidden)contents.setAudioMuted(true);
  const guard=event=>{
    if((event.isMainFrame&&!allowed(event.url))||!/^https:|^blob:|^about:blank$/i.test(event.url))event.preventDefault();
  };
  contents.on('will-frame-navigate',guard);
  contents.on('will-redirect',guard);
  contents.setWindowOpenHandler(({url})=>{
    if(allowed(url))void contents.loadURL(url).catch(()=>{});
    return {action:'deny'};
  });
  win.on('page-title-updated',event=>event.preventDefault());
  return win;
}

// A hidden download that has not started by then shows its window: Divine may be asking for
// something only the player can do (a check, a changed page). Their own click there still counts.
const SHOW_AFTER=30000,GIVE_UP=90000,GIVE_UP_SHOWN=5*60000;
// Downloads at once, each in its own hidden window.
const MAX_JOBS=3;

// One skin's hidden download page. It opens as soon as the skin page shows its Download button,
// so Divine's free countdown runs while the player looks at the skin; the page's preload waits
// for `divine-go` (the player's click) before it takes the file.
function openDownloadPage({parent,ses,url,site,api}){
  const fileRoute=raw=>raw===url||(api.divineOrigin(raw,{cdn:true})&&(!site(raw)||raw.startsWith('blob:')));
  const win=divineWindow(parent,ses,'divine-download-preload.cjs','Divine download · Friloverse',fileRoute,{hidden:true});
  win.removeMenu();
  const page={win,url,started:false,wait:null,progress:null,loading:win.webContents.loadURL(url)};
  page.loading.catch(()=>{});
  return page;
}

async function downloadSkin({page,dir,root,champion,champions,ses,api,onProgress=()=>{}}){
  const {win,url}=page,file=path.join(dir,'skin-'+randomUUID()+'.part');
  let active=null,closed=false;
  try{
    const downloaded=await new Promise((resolve,reject)=>{
      if(win.isDestroyed()||win.webContents.isCrashed()){reject(new Error('The download window closed unexpectedly. Click Download to try again.'));return;}
      const fail=message=>{clearTimeout(timer);clearTimeout(reveal);reject(new Error(message));};
      let timer=setTimeout(()=>fail('Divine did not start the download. Click Download to try again.'),GIVE_UP);
      const reveal=setTimeout(()=>{
        if(active||closed||win.isDestroyed())return;
        clearTimeout(timer);timer=setTimeout(()=>fail('Divine did not start the download. Click Download to try again.'),GIVE_UP_SHOWN);
        win.webContents.setAudioMuted(false);win.show();
        onProgress('Divine needs you in the window that opened to finish this download.');
      },SHOW_AFTER);
      const contents=win.webContents;
      function download(event,item,source){
        if(source!==contents)return; // The catalogue and file windows use the same session.
        if(active||new URL(contents.getURL()).pathname!==new URL(url).pathname||!api.divineOrigin(item.getURL(),{cdn:true})||item.getTotalBytes()>api.MAX_DOWNLOAD){
          event.preventDefault();fail('Divine returned an unsupported download.');return;
        }
        clearTimeout(timer);clearTimeout(reveal);
        active=item;
        const name=item.getFilename();
        item.setSavePath(file);
        win.setTitle('Downloading '+name+' · Friloverse');
        let shown=-1;
        const progress=()=>{
          const total=item.getTotalBytes(),percent=total>0?Math.floor(item.getReceivedBytes()*100/total):-1;
          if(percent===shown)return;
          shown=percent;onProgress(percent<0?'Downloading…':`Downloading… ${percent}%`);
        };
        progress();
        item.on('updated',()=>{
          const received=item.getReceivedBytes(),total=item.getTotalBytes();
          if(received>api.MAX_DOWNLOAD)item.cancel();
          else if(!closed){win.setProgressBar(total>0?received/total:2);progress();}
        });
        item.once('done',(_event,state)=>{
          active=null;
          if(state==='completed')resolve(name);
          else fail('The download stopped. Click Download to try again.');
        });
      }
      ses.on('will-download',download);
      win.once('closed',()=>{
        closed=true;clearTimeout(timer);clearTimeout(reveal);ses.removeListener('will-download',download);
        resolve(null);active?.cancel();
      });
      contents.once('render-process-gone',()=>fail('The download window closed unexpectedly. Click Download to try again.'));
      page.loading.catch(error=>{if(error.code!=='ERR_ABORTED')fail('Divine Skins could not be reached.');});
      // The countdown may already be over: then the file is taken right away.
      onProgress(page.wait>0?`Ready in ${page.wait} s…`:'Getting the latest file…');
      contents.send('divine-go');
    });
    if(!downloaded||closed)return null;
    onProgress('Checking the file…');
    const skin=await api.inspectDownload(file,downloaded,champions);
    if(closed)return null;
    return await api.saveDivineSkin(root,{...skin,file},champions,champion.id);
  }finally{
    if(!win.isDestroyed())win.destroy();
    await rm(file,{force:true}).catch(()=>{});
  }
}

// Only this window's isolated main-frame preload can request an import. The trusted main
// process chooses the URL and destination; the dashboard preload is never used on Divine.
// `reportDownload` (12.9): records each saved skin for the owner; tests pass their own.
async function browseDivine({parent,root,champions,onImported=()=>{},reportDownload}){
  const api=await import('./divine-skins.mjs');
  reportDownload??=row=>api.reportDivineDownload({...row,version:app.getVersion()});
  const ses=session.fromPartition('persist:divine-catalogue');
  ses.setPermissionCheckHandler(()=>false);
  ses.setPermissionRequestHandler((_contents,_permission,reply)=>reply(false));
  const dir=await api.prepareDownload(root);
  const site=url=>api.divineOrigin(url);
  const win=divineWindow(parent,ses,'divine-catalogue-preload.cjs','Divine Skins · Friloverse',site);
  const contents=win.webContents;
  // Download pages by URL: at most one waiting for a click (the skin on screen), plus the
  // downloads the player started.
  const pages=new Map(),jobs=new Set();
  const navigate=url=>contents.loadURL(url);
  const fromCatalogue=event=>event.sender===contents&&event.senderFrame===contents.mainFrame&&site(event.senderFrame.url);
  const drop=page=>{if(pages.get(page.url)===page)pages.delete(page.url);if(!page.win.isDestroyed())page.win.destroy();};
  // Leaving a skin page closes its waiting download page; downloads already started go on.
  const dropWaiting=(keep='')=>{for(const page of [...pages.values()])if(!page.started&&page.url!==keep)drop(page);};
  const remember=(_event,raw)=>{
    const url=new URL(raw);
    if(url.origin==='https://divineskins.gg'&&/^\/mods\/lol(?:\/champion\/[\w-]+)?\/?$/.test(url.pathname))lastCatalogue=url.href;
    let keep='';
    try{keep=api.divineDownloadUrl(url.pathname.replace(/\/$/,''));}catch{}
    dropWaiting(keep);
  };
  contents.on('did-navigate',remember);
  contents.on('did-navigate-in-page',(event,url,main)=>{if(main)remember(event,url);});
  win.setMenu(Menu.buildFromTemplate([
    {label:'Back',click:()=>{if(contents.navigationHistory.canGoBack())contents.navigationHistory.goBack();}},
    {label:'Champion catalogue',click:()=>void navigate(api.DIVINE_CATALOGUE).catch(()=>{})},
    {label:'Reload',role:'reload'}
  ]));
  const blockOtherDownloads=(event,_item,source)=>{
    if(![...pages.values()].some(page=>page.started&&!page.win.isDestroyed()&&source===page.win.webContents))event.preventDefault();
  };
  ses.on('will-download',blockOtherDownloads);
  const progressTo=route=>text=>{if(!contents.isDestroyed())contents.send('divine-progress',{route,text});};
  const pageFor=url=>{
    let page=pages.get(url);
    if(page&&(page.win.isDestroyed()||page.win.webContents.isCrashed())){drop(page);page=null;}
    if(!page){
      const opened=page=openDownloadPage({parent:win,ses,url,site,api});
      page.win.webContents.once('render-process-gone',()=>{if(!opened.started)drop(opened);});
      pages.set(url,page);
    }
    return page;
  };
  // The skin page on screen shows its Download button: start Divine's countdown now.
  const onSkinPage=(event,route)=>{
    if(!fromCatalogue(event))return;
    let url;
    try{url=api.divineDownloadUrl(route);}catch{return;}
    if(new URL(contents.getURL()).pathname.replace(/\/$/,'')!==route)return;
    dropWaiting(url);
    if(jobs.size<MAX_JOBS)pageFor(url);
  };
  // The download page's countdown, shown to the player once they clicked.
  const onWait=(event,seconds)=>{
    const page=[...pages.values()].find(row=>!row.win.isDestroyed()&&event.sender===row.win.webContents);
    if(!page||!Number.isSafeInteger(seconds)||seconds<0||seconds>600)return;
    page.wait=seconds;
    if(page.started&&seconds>0)page.progress?.(`Ready in ${seconds} s…`);
  };
  ipcMain.on('divine-skin-page',onSkinPage);
  ipcMain.on('divine-wait',onWait);
  ipcMain.handle('divine-card-import',async(event,pick)=>{
    if(!fromCatalogue(event))throw new Error('Unknown catalogue window.');
    let page;
    try{
      const {url,champion}=api.divineSelection(pick,champions);
      if(pages.get(url)?.started)return {message:`${api.divineSkinLabel(pick.route)} is already downloading.`};
      if(jobs.size>=MAX_JOBS)return {message:'Three skins are already downloading. Click again when one is done.'};
      page=pageFor(url);
      page.started=true;page.progress=progressTo(pick.route);
      const job=downloadSkin({page,dir,root,champion,champions,ses,api,onProgress:page.progress});
      jobs.add(job);
      try{
        const saved=await job;
        if(!saved)return {message:'The download was closed.'};
        const message=saved.already?`Already in ${saved.folder}’s Local Skins.`:`Imported ${saved.name} into ${saved.folder}’s Local Skins.`;
        onImported(saved,message);
        void Promise.resolve().then(()=>reportDownload({route:pick.route,champion:champion.id,file:path.join(root,saved.folder,saved.name)})).catch(()=>{});
        return {saved:true,message};
      }finally{jobs.delete(job);}
    }catch(error){return {message:error.message};}
    finally{if(page)drop(page);}
  });
  try{
    await new Promise((resolve,reject)=>{
      win.once('closed',resolve);
      contents.once('render-process-gone',()=>reject(new Error('The Divine Skins window closed unexpectedly.')));
      navigate(lastCatalogue||api.DIVINE_CATALOGUE).catch(error=>{if(error.code!=='ERR_ABORTED')reject(new Error('Divine Skins could not be opened. Check your connection and try again.'));});
    });
  }finally{
    ipcMain.removeHandler('divine-card-import');
    ipcMain.removeListener('divine-skin-page',onSkinPage);
    ipcMain.removeListener('divine-wait',onWait);
    for(const page of [...pages.values()])drop(page);
    await Promise.allSettled([...jobs]);
    ses.removeListener('will-download',blockOtherDownloads);
    if(!win.isDestroyed())win.destroy();
  }
}
module.exports={browseDivine};
