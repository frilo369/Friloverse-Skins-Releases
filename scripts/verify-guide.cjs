const {app,protocol}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
protocol.registerSchemesAsPrivileged([{scheme:'friloverse-guide',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.setPath('userData',process.env.FRILOVERSE_GUIDE_USER_DATA||path.join(os.tmpdir(),`friloverse-guide-test-${process.pid}`));
app.on('window-all-closed',event=>event.preventDefault());
const output=path.resolve(process.argv[2]);
const appRoot=path.resolve(process.env.FRILOVERSE_GUIDE_APP_ROOT||path.join(__dirname,'..'));
const live=process.env.FRILOVERSE_GUIDE_LIVE==='1';
const liveMeta=process.env.FRILOVERSE_GUIDE_META_LIVE==='1';
async function waitFor(fn,label){
  for(let i=0;i<160;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}
  throw new Error(`Timed out waiting for ${label}`);
}
async function screenshot(win,file){
  let last;
  for(let i=0;i<5;i++){
    try{await new Promise(r=>setTimeout(r,250));await fs.writeFile(file,(await win.webContents.capturePage()).toPNG());return;}
    catch(error){last=error;}
  }
  throw last;
}
app.whenReady().then(async()=>{
  const {GuideController}=require(path.join(appRoot,'src/guide.cjs'));
  const {guideTarget,guideReady}=await import(pathToFileURL(path.join(appRoot,'src/guide-match.mjs')));
  const {parseShortcut,systemHotkeyWord}=await import(pathToFileURL(path.join(appRoot,'src/guide-shortcut.mjs')));
  const {MayhemData}=await import(pathToFileURL(path.join(appRoot,'src/guide-data.mjs')));
  const tracker=require(path.join(appRoot,'src/windows.cjs'));
  const champions=JSON.parse(await fs.readFile(path.join(appRoot,'src/ui/champions.json'),'utf8'));
  const guide=new GuideController({app,tracker,champions,guideTarget,guideReady,parseShortcut,systemHotkeyWord,MayhemData,preview:true});
  await guide.initialize();guide.setShortcut('F1');
  await fs.mkdir(output,{recursive:true});
  const build=JSON.parse(await fs.readFile(path.join(__dirname,'../tests/fixtures/mayhem-annie.json'),'utf8'));
  const rankings=JSON.parse(await fs.readFile(path.join(__dirname,'../tests/fixtures/mayhem-rankings.json'),'utf8'));
  if(!live)guide.data.fetch=async url=>{
    if(url.includes('fuwen_aram_hero_rank_v2'))return rankings;
    if(url.includes('fuwen_hero_rank'))return build;
    throw new Error('Offline fixture');
  };
  const installFixtures=()=>guide.guideSession.protocol.handle('https',async request=>{
    const u=new URL(request.url);
    if(u.hostname==='www.metasrc.com'&&u.pathname.includes('/champions/ahri/build')){
      const mode=u.pathname.includes('/arena/')?'arena':u.pathname.includes('/aram/')?'aram':'rift';
      const html=await fs.readFile(path.join(__dirname,`../tests/fixtures/metasrc/${mode}-ahri.html`));
      return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8'}});
    }
    return new Response('Unavailable in fixture',{status:404});
  });
  if(!live&&!liveMeta)await installFixtures();
  guide.observe({phase:'GameStart',mode:'mayhem',champion:1});
  assert.equal(guide.win.isVisible(),false,'background preparation must stay hidden');
  await guide.open();
  await waitFor(()=>tracker.foregroundPid()===process.pid,'guide foreground');
  await waitFor(()=>guide.win.webContents.executeJavaScript("!document.querySelector('#guide-content').hidden"),'Mayhem recommendations');
  assert.equal(await guide.win.webContents.executeJavaScript("document.querySelector('#champion-name').textContent"),'Annie');
  assert.ok(await guide.win.webContents.executeJavaScript("document.querySelectorAll('.augment-row').length")>0);
  if(live)await waitFor(()=>guide.win.webContents.executeJavaScript("Array.from(document.images).some(image=>image.naturalWidth>0)"),'live CommunityDragon artwork');
  await screenshot(guide.win,path.join(output,'mayhem.png'));
  const filtered=await guide.win.webContents.executeJavaScript("(()=>{const input=document.querySelector('#augment-search');input.value='Eureka';input.dispatchEvent(new Event('input',{bubbles:true}));return document.querySelector('#prismatic-rows').textContent;})()");
  assert.match(filtered,/Eureka/i);
  await guide.win.webContents.executeJavaScript("(()=>{const input=document.querySelector('#augment-search');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  const refusal=await guide.win.webContents.executeJavaScript("window.friloverseGuide.invoke('unexpected').then(result=>result.ok)");
  assert.equal(refusal,false);
  const first=guide.win;first.destroy();guide.lastOpen=0;await guide.open();
  await waitFor(()=>guide.win.webContents.executeJavaScript("!document.querySelector('#guide-content').hidden"),'Mayhem reopening');
  assert.notEqual(guide.win,first);
  if(live&&!liveMeta)await installFixtures();
  for(const mode of ['rift','aram','arena']){
    const prior=guide.win;
    guide.observe({phase:'InProgress',mode,champion:103});
    assert.equal(guide.win,prior,'a visible guide must not be replaced under the player');
    prior.hide();guide.observe({phase:'InProgress',mode,champion:103});
    assert.equal(guide.win.isVisible(),false,'a changed mode must prepare in the background');
    guide.lastOpen=0;await guide.open();
    try{await waitFor(()=>guide.win.webContents.executeJavaScript("!!document.querySelector('fryiloco-guide')"),`${mode} presentation`);}
    catch(error){
      if(!liveMeta)throw error;
      const page=await guide.win.webContents.executeJavaScript("({title:document.title,text:document.body?.innerText?.slice(0,300)})");
      await screenshot(guide.win,path.join(output,`${mode}-source.png`));
      console.log(`Live MetaSRC ${mode} did not supply a readable guide:`,JSON.stringify(page));
      break;
    }
    const details=await guide.win.webContents.executeJavaScript("({name:document.querySelector('fryiloco-guide').shadowRoot.querySelector('#champion-name').textContent,privileged:typeof window.friloverseGuide})");
    assert.equal(details.name,'Ahri');assert.equal(details.privileged,'undefined');
    await screenshot(guide.win,path.join(output,`${mode}.png`));
    if(liveMeta&&mode==='rift'){
      const changed=await guide.win.webContents.executeJavaScript("(()=>{const root=document.querySelector('fryiloco-guide').shadowRoot;const button=root.querySelector('[data-build-style][aria-pressed=false]');if(!button)return '';const value=button.dataset.buildStyle;button.click();return value;})()");
      assert.ok(changed,'MetaSRC should offer another source build');
      await waitFor(()=>guide.win.webContents.executeJavaScript(`Array.from(document.querySelector('fryiloco-guide').shadowRoot.querySelectorAll('[data-build-style]')).some(button=>button.dataset.buildStyle===${JSON.stringify(changed)}&&button.getAttribute('aria-pressed')==='true')`),'live MetaSRC build selection');
    }
  }
  // The guide stays available through Reconnect (owner's choice, AGENTS.md 9.9); the lobby closes it.
  guide.observe({phase:'Reconnect',mode:'arena',champion:103});assert.ok(guide.win&&!guide.win.isDestroyed(),'Reconnect keeps the guide');
  guide.observe({phase:'Lobby',mode:null,champion:null});assert.equal(guide.win,null);
  guide.dispose();
  console.log(`Guide fixture verification passed; screenshots: ${output}`);
  app.exit(0);
}).catch(error=>{console.error(error.stack||error);app.exit(1);});
