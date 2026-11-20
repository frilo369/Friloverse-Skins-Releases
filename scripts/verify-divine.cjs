// Run with Node. --live clicks Iron Darius's own Download button on the real Divine site.
// Both modes use a disposable session and LocalSkins library.
const electron=require('electron');
const {mkdtempSync,rmSync}=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
if(!process.versions.electron){
  const temp=mkdtempSync(path.join(os.tmpdir(),'friloverse-divine-'));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  try{
    const result=require('node:child_process').spawnSync(electron,[__filename,temp,...process.argv.slice(2)],{env,stdio:'inherit',windowsHide:true,timeout:process.argv.includes('--live')?600000:30000});
    if(result.error)throw result.error;
    process.exitCode=result.status??1;
  }finally{rmSync(temp,{recursive:true,force:true,maxRetries:4});}
  return;
}
const {app,session}=electron;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const dir=process.argv[2];
app.setPath('userData',dir);
app.on('window-all-closed',()=>{});
const live=process.argv.includes('--live');
async function verify(){
  const {browseDivine}=require('../src/divine-browser.cjs');
  const {writeZip}=await import('../src/skin-slots.mjs');
  const {SkinDatabase}=await import('../src/skin-database.mjs');
  const champions=require('../src/ui/champions.json'),root=path.join(dir,'LocalSkins');
  const ses=session.fromPartition('persist:divine-catalogue');
  if(!live){
    // A shared asset alone cannot identify a champion. This has to use the catalogue label.
    const archive=writeZip([{name:'RAW/shared/file',bytes:Buffer.from('test')}]);
    ses.protocol.handle('https',request=>{
      const route=new URL(request.url).pathname;
      if(route==='/file')return new Response(archive,{headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="Sample.fantome"'}});
      // The upsell popup has no usable Close here: the file must not wait for it to go.
      const html=route.startsWith('/download/')?`<aside role="dialog"><h2>Cookies on Divine Skins</h2></aside>
        <div role="dialog"><h2>Tired of waiting?</h2><button aria-label="Close" disabled>Close</button></div>
        <section><div><h3>Download files</h3></div><p id="wait">Sample is ready to download in 1 seconds.</p><button disabled id="file">Download</button>
        <script>setTimeout(()=>{document.getElementById('file').disabled=false;document.getElementById('wait').remove();},650);document.getElementById('file').onclick=()=>location.assign('https://lol-mods.divine-cdn.com/file')</script></section>`
        // The skin page: its own Download button opens Divine's variant popup unless Friloverse takes the click.
        :`<a href="/mods/lol?championName=Ahri">Ahri</a><h1>Sample skin</h1>
        <button onclick="document.body.insertAdjacentHTML('beforeend','<div role=dialog><h2>Choose a variant</h2></div>')">Download</button>`;
      return new Response(html,{headers:{'Content-Type':'text/html'}});
    });
  }
  let catalogue,result;
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let downloader;
  app.on('browser-window-created',(_event,win)=>{if(!catalogue)catalogue=win;else{downloader=win;win.once('show',()=>{downloader.shown=true;});}});
  // Never the owner's real download records: the report is checked here instead.
  const reports=[];
  const browsing=browseDivine({root,champions,onImported:saved=>{result=saved;},reportDownload:row=>{reports.push(row);}});
  try{
    while(!catalogue)await delay(25);
    const contents=catalogue.webContents;
    await contents.loadURL(live?'https://divineskins.gg/Frog/iron-darius':'https://divineskins.gg/Frog/sample');
    const selector='button';
    const point=await until(()=>contents.executeJavaScript(`(()=>{
      const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim()==='Download'&&!b.closest('[role="dialog"]'));if(!b)return null;
      b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();
      const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      if(document.elementFromPoint(x,y)!==b)return false;
      return {x,y};
    })()`));
    // The skin page opens Divine's download page out of sight at once, so its countdown runs
    // while the player looks at the skin. Nothing may download before the click.
    await until(()=>downloader);
    const dwell=Number(process.argv.find(arg=>arg.startsWith('--dwell='))?.slice(8)??(live?12:1.2));
    console.log('Download page opened before the click; looking at the skin for',dwell,'s');
    await delay(dwell*1000);
    assert.equal(result,undefined,'a skin was saved before the click');
    assert.ok(!downloader.isDestroyed(),'the waiting download page closed');
    // Wait for the native window to paint the button before sending input.
    await contents.capturePage().catch(()=>{});
    await delay(250);
    contents.sendInputEvent({type:'mouseMove',...point});
    contents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    contents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    const started=Date.now();
    console.log('Clicked Download on',new URL(contents.getURL()).pathname);
    await until(async()=>{
      const status=await contents.executeJavaScript("document.querySelector('div[role=status]:last-child')?.innerText||''");
      if(/stopped|did not|unsupported|closed/i.test(status)&&!result)throw new Error(status);
      return result;
    },live?125000:dwell>=1?1500:5000);
    assert.equal(result.folder,live?'Darius':'Ahri');
    await until(()=>contents.executeJavaScript("/^Imported /.test(document.querySelector('div[role=status]')?.innerText||'')"));
    assert.equal(await contents.executeJavaScript("[...document.querySelectorAll('[role=dialog] h2')].some(h=>h.textContent==='Choose a variant')"),false,"Divine's variant popup opened");
    assert.ok(downloader,'no download window was made');
    assert.ok(!downloader.shown,'the download window was shown');
    await until(()=>reports.length);
    assert.deepEqual(reports,[{route:live?'/Frog/iron-darius':'/Frog/sample',champion:live?'Darius':'Ahri',file:path.join(root,result.folder,result.name)}]);
    console.log('One Download click saved',result.name,'in',result.folder,'in',((Date.now()-started)/1000).toFixed(1),'s, window hidden');
  }finally{
    if(!catalogue?.isDestroyed())catalogue?.destroy();
    await browsing;
  }
  const db=new SkinDatabase({root,champions,local:true});
  const {skins}=await db.list(result.folder);
  assert.equal(skins.length,1);
  assert.equal(skins[0].broken,false);
  assert.equal(skins[0].source,'local');
  console.log('Verified Local tab card:',skins[0].name,'in',result.folder);
}
async function until(check,timeout=20000){
  const end=Date.now()+timeout;
  do{
    const found=await check();
    if(found)return found;
    await new Promise(resolve=>setTimeout(resolve,150));
  }while(Date.now()<end);
  throw new Error('The expected catalogue control or import did not appear.');
}
app.whenReady().then(verify).then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
