// Squirrel reads RELEASES and the packages straight from the newest GitHub release.
export const FEED='https://github.com/frilo369/Friloverse-Skins-Releases/releases/latest/download';
// Downloads can be slow, but a check that never answers must not end all later ones.
const STUCK_AFTER=60*60*1000;
// How long the databases wait behind the app's own check: an answer, then a download once one is found.
const ANSWER_WITHIN=60*1000,DOWNLOAD_WITHIN=15*60*1000;
// A failed check is usually a moment's network trouble, so it gets one more try before the hourly one.
const RETRY_AFTER=5*60*1000;
// GitHub has nothing to offer: asking again in five minutes would change nothing.
const NO_RELEASE=/404|not found|Remote release File/i;
// The first line that says what went wrong: Squirrel's errors are whole .NET stack traces.
export function shortProblem(error){
  const text=String(error?.message||error||'');
  const found=/remote server returned an error: [^.\r\n]*/i.exec(text)||/remote name could not be resolved[^.\r\n]*/i.exec(text)||/unable to connect[^.\r\n]*/i.exec(text);
  return found?found[0]:text.split(/\r?\n/)[0].slice(0,200);
}

export class AppUpdater {
  constructor({updater,installed,version,onStatus,onProblem=()=>{},canApply,beforeApply,cancelApply=async()=>{},now=Date.now,retryAfter=RETRY_AFTER}){
    Object.assign(this,{updater,installed,version,onStatus,onProblem,canApply,beforeApply,cancelApply,now,retryAfter});
    this.checkedAt=0;this.checking=false;this.ready=false;this.applying=false;this.manual=false;this.atStart=false;this.waiters=[];this.retryTimer=null;this.retrying=false;this.installing=false;
    updater.on('checking-for-update',()=>this.onStatus('Checking for app updates…'));
    updater.on('update-available',()=>{this.onStatus('Downloading app update…');for(const waiter of this.waiters)waiter.wait(waiter.downloadWithin);});
    updater.on('update-not-available',()=>{this.checking=false;this.retrying=false;this.onStatus('Friloverse is up to date.');this.manual=false;this.settle('none');});
    updater.on('error',error=>{
      // Squirrel can refuse the update after quitAndInstall: Friloverse stays open, so it
      // undoes beforeApply and keeps the downloaded update for the next safe moment.
      if(this.installing){
        this.installing=false;this.ready=true;console.error('App update:',error.message);this.onProblem(error);
        void this.cancelApply().catch(()=>{});
        this.onStatus('Could not apply the app update. Friloverse tries again later.');this.manual=false;
        return;
      }
      this.checking=false;console.error('App update:',error.message);this.onProblem(error);this.onStatus(NO_RELEASE.test(error.message)?'App update feed has no published release yet.':'Could not check for app updates. Friloverse tries again later.');this.manual=false;this.settle('failed');this.retryOnce(error);});
    updater.on('update-downloaded',()=>{this.checking=false;this.retrying=false;this.ready=true;this.onStatus('App update downloaded; waiting for a safe moment.');this.settle('downloaded');void this.applyWhenSafe();});
    this.feed=FEED;
    if(installed)updater.setFeedURL({url:this.feed});
  }
  check({manual=false}={}){
    clearTimeout(this.retryTimer);this.retryTimer=null;
    if(manual)this.manual=true;
    if(!this.installed){this.onStatus('Install Friloverse to enable automatic app updates.');this.manual=false;return;}
    if(this.ready){if(manual)void this.applyWhenSafe();return;}
    if(this.checking&&this.now()-this.checkedAt<STUCK_AFTER)return;
    this.checking=true;this.checkedAt=this.now();
    try{this.updater.checkForUpdates();}catch(error){this.checking=false;this.onProblem(error);this.onStatus('Could not check for app updates. Friloverse tries again later.');this.manual=false;this.settle('failed');this.retryOnce(error);}
  }
  /** One more try soon after a failed check. If that fails too, the hourly check carries on. */
  retryOnce(error){
    const again=!this.retrying&&!NO_RELEASE.test(error?.message||'');
    this.retrying=false;
    if(!again)return;
    this.retryTimer=setTimeout(()=>{this.retryTimer=null;this.retrying=true;this.check();},this.retryAfter);
    this.retryTimer.unref?.();
  }
  /** Everyone waiting for this check, told how it ended. */
  settle(outcome){
    for(const waiter of this.waiters.splice(0)){clearTimeout(waiter.timer);waiter.resolve(outcome);}
  }
  /**
   * The same check, answering when it is over: 'none', 'failed', 'downloaded', 'not-installed' or
   * 'timeout'. The databases wait for it (7.1), so the app is always looked at first.
   */
  checkAndWait({manual=false,answerWithin=ANSWER_WITHIN,downloadWithin=DOWNLOAD_WITHIN}={}){
    if(!this.installed){this.check({manual});return Promise.resolve('not-installed');}
    if(this.ready){this.check({manual});return Promise.resolve('downloaded');}
    return new Promise(resolve=>{
      const waiter={resolve,timer:null,downloadWithin,wait:ms=>{
        clearTimeout(waiter.timer);
        waiter.timer=setTimeout(()=>{this.waiters=this.waiters.filter(item=>item!==waiter);resolve('timeout');},ms);
        waiter.timer.unref?.();
      }};
      this.waiters.push(waiter);waiter.wait(answerWithin);
      this.check({manual});
    });
  }
  async applyWhenSafe(){
    if(!this.ready||this.applying)return;
    this.applying=true;let attempted=false;
    try{
      if(!await this.canApply({manual:this.manual}))return;
      attempted=true;if(await this.beforeApply()===false)return;
      this.ready=false;this.installing=true;this.updater.quitAndInstall();
    }catch(error){this.installing=false;this.ready=true;if(attempted)await this.cancelApply().catch(()=>{});this.onProblem(error);this.onStatus('Could not apply the app update. Friloverse tries again later.');}
    finally{this.applying=false;}
  }
}
