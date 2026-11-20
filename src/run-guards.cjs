/**
 * One look at League at a time. A look that never comes back is given up on after `limit`, and a
 * newer one starts, but the old one may still wake up later: it is told so (`run.live` is false),
 * so it neither writes its out-of-date answer over the newer one nor ends the newer one's turn.
 */
class PollGate{
  constructor({limit=30000,now=Date.now,onStuck=()=>{}}={}){Object.assign(this,{limit,now,onStuck});this.current=null;}
  /** A run to carry out, or null while one is still going. */
  begin(){
    if(this.current){
      if(this.now()-this.current.since<=this.limit)return null;
      this.current.live=false;this.onStuck();
    }
    return this.current={since:this.now(),live:true};
  }
  /** True when this run was still the current one. */
  end(run){
    if(this.current!==run)return false;
    this.current=null;run.live=false;
    return true;
  }
}

/** A retry of which there is only ever one: setting it again replaces the one waiting. */
function oneTimer(run){
  let handle=null;
  return {
    get pending(){return handle!==null;},
    set(delay){clearTimeout(handle);handle=setTimeout(()=>{handle=null;run();},delay);handle.unref?.();},
    cancel(){clearTimeout(handle);handle=null;},
  };
}

/**
 * Something that was there, looked at again now and then: LTK Manager can be uninstalled or moved
 * while Friloverse runs. One look failing (an update swapping the file, say) is not gone yet: it
 * takes `misses` in a row, the later ones `soon` apart. Only one look runs at a time.
 */
function stillThere(look,{every=60000,soon=5000,misses=2,now=Date.now}={}){
  let next=now()+every,missed=0,looking=false;
  return {
    get due(){return !looking&&now()>=next;},
    /** True once it has really gone. */
    async check(){
      looking=true;
      try{await look();missed=0;next=now()+every;return false;}
      catch{
        if(++missed<misses){next=now()+soon;return false;}
        missed=0;next=now()+every;return true;
      }finally{looking=false;}
    },
  };
}

/**
 * How long until the next try after a check that did not finish. GitHub limiting this network
 * doubles the wait with each limited check in a row, and never asks before the time GitHub gave.
 */
function retryDelay({limitedRuns=0,retryAt=0,now=Date.now(),base=5*60*1000,most=60*60*1000}={}){
  if(limitedRuns<1)return base;
  return Math.min(most,Math.max(base*2**(limitedRuns-1),retryAt-now+30*1000));
}

/** Waits for `work`, but no longer than `limit`; true if it finished in time. A failure counts as finished. */
function finishWithin(work,limit){
  let timer;
  const late=new Promise(resolve=>{timer=setTimeout(()=>resolve(false),limit);});
  return Promise.race([Promise.resolve(work).then(()=>true,()=>true),late]).finally(()=>clearTimeout(timer));
}

/**
 * Writes log lines in order. Past `limit` bytes the file moves to `old` and a new one starts, so a
 * log kept for years stays small and the last games are still there. A log failure is never a problem.
 */
function rotatingLog(file,old,{limit=1024*1024,io=require('node:fs/promises')}={}){
  let queue=Promise.resolve(),size=null;
  return line=>{
    queue=queue.then(async()=>{
      if(size===null)size=await io.stat(file).then(info=>info.size,()=>0);
      const bytes=Buffer.byteLength(line);
      if(size&&size+bytes>limit)await io.rename(file,old).then(()=>{size=0;},()=>{});
      await io.appendFile(file,line);size+=bytes;
    }).catch(()=>{});
    return queue;
  };
}

module.exports={PollGate,oneTimer,stillThere,retryDelay,finishWithin,rotatingLog};
