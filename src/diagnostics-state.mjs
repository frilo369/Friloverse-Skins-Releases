import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {writeAtomic} from './atomic-file.mjs';

// Structured, user-actionable troubleshooting issues persisted across sessions (7 days max).
// Setup issues (`PERSISTENT_CODES`) stay marked as current until explicitly resolved by a passing recheck.
const KEEP_MS=7*24*3600*1000,DEDUPE_MS=3000,MAX_ITEMS=40;
const SETUP_RECHECK_AT_START=new Set(['WINDOWS_ADMIN_SHELL','LEAGUE_ELEVATED']);
const PERSISTENT_CODES=new Set(['LAUNCHER_ELEVATED','LTK_ELEVATED','LTF_MISSING','LTK_MANAGER_MISSING']);

export class DiagnosticsStore{
  constructor({dataDir,now=Date.now}={}){
    this.file=path.join(dataDir,'diagnostics-issues.json');
    this.now=now;
    this.sessionId=randomBytes(4).toString('hex');
    this.items=[];
    this.lastSeen=new Map();
    this.saving=Promise.resolve();
  }
  async load(){
    const cutoff=this.now()-KEEP_MS;
    try{
      const saved=JSON.parse(await readFile(this.file,'utf8'));
      if(Array.isArray(saved)){
        this.items=saved.filter(item=>{
          if(!item||typeof item.code!=='string'||typeof item.title!=='string')return false;
          if(PERSISTENT_CODES.has(item.code))return true;
          if(SETUP_RECHECK_AT_START.has(item.code))return false;
          return Number.isFinite(item.at)&&item.at>=cutoff;
        }).slice(-MAX_ITEMS);
      }
    }catch{this.items=[];}
    this.persist();
    return this.snapshot();
  }
  report({code,title,detail='',fix=''}){
    if(!code||!title)return false;
    const key=`${code}|${title}|${detail}`;
    const at=this.now();
    if(at-(this.lastSeen.get(key)||0)<DEDUPE_MS)return false;
    this.lastSeen.set(key,at);
    // Replace prior entries for setup/persistent codes so the Troubleshooting view stays clean.
    if(PERSISTENT_CODES.has(code)||SETUP_RECHECK_AT_START.has(code)){
      this.items=this.items.filter(item=>item.code!==code);
    }
    this.items.push({
      id:randomBytes(6).toString('hex'),
      code,title:String(title).slice(0,220),
      detail:String(detail||'').slice(0,500),
      fix:String(fix||'').slice(0,600),
      at,session:this.sessionId,
    });
    if(this.items.length>MAX_ITEMS)this.items=this.items.slice(-MAX_ITEMS);
    this.persist();
    return true;
  }
  resolve(code){
    const before=this.items.length;
    this.items=this.items.filter(item=>item.code!==code);
    if(this.items.length!==before){this.persist();return true;}
    return false;
  }
  dismiss(id){
    const before=this.items.length;
    this.items=this.items.filter(item=>item.id!==id);
    if(this.items.length!==before){this.persist();return true;}
    return false;
  }
  clear(){
    if(!this.items.length)return false;
    this.items=[];
    this.persist();
    return true;
  }
  snapshot(){
    return this.items.map(item=>({
      ...item,
      thisSession:item.session===this.sessionId||PERSISTENT_CODES.has(item.code),
    })).reverse();
  }
  persist(){
    const payload=JSON.stringify(this.items,null,2);
    this.saving=this.saving.catch(()=>{}).then(()=>writeAtomic(this.file,payload,{durable:false})).catch(()=>{});
  }
}
