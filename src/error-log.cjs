const fs=require('node:fs');
const path=require('node:path');

// Every error field a Friloverse screen shows. All of them reach a screen through emitState.
const FIELDS=['error','patcherError','databaseError','importError','riotSkinsError','modsError','ltkInstallError'];
const MAX_BYTES=512*1024,MAX_TEXT=2000;
const oneLine=value=>String(value).replace(/\s+/g,' ').trim().slice(0,MAX_TEXT);

/**
 * Screens only show an error for a moment and the reason is otherwise lost, so each one is
 * written to errors.log in the data folder, once per appearance, with what was going on.
 * Writing it may never break the app. The previous file stays as errors.old.log.
 */
function createErrorLog({dir,version='',now=()=>new Date()}){
  const file=path.join(dir,'errors.log'),old=path.join(dir,'errors.old.log');
  const showing=new Map();
  const write=(where,message,details={})=>{
    try{
      fs.mkdirSync(dir,{recursive:true});
      if(fs.statSync(file,{throwIfNoEntry:false})?.size>=MAX_BYTES)fs.renameSync(file,old);
      const context=Object.entries(details).filter(([,value])=>value).map(([key,value])=>`${key}=${oneLine(value)}`).join('; ');
      fs.appendFileSync(file,`${now().toISOString()} ${version} ${where}: ${oneLine(message)}${context?` | ${context}`:''}\n`);
    }catch{}
  };
  return {
    file,
    /** Call with the state about to go to the screens: writes what has newly appeared. */
    shown(state,extra={}){
      const current=[...FIELDS.map(field=>[field,state[field]]),['party',state.party?.error]];
      for(const [field,value] of current){
        const message=value?oneLine(value):'';
        if(message===(showing.get(field)||''))continue;
        showing.set(field,message);
        if(message)write(field,message,{champion:state.champion,skin:extra.skin,patcher:state.patcher,connection:state.connection});
      }
    },
    /** Not an error, but what explains something a player saw happen by itself. */
    note(where,message){write(`note ${where}`,message);},
    /** A request from a screen that failed: the screen shows this itself. Never the request's values. */
    failed(kind,error){write(`action ${oneLine(kind||'unknown')}`,error?.message||error||'unknown error',{code:error?.code});},
  };
}

module.exports={createErrorLog};
