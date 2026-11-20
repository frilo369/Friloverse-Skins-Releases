// Read-only Mayhem sources and bounded last-good caches, adapted from FrYiLoCo.
import https from 'node:https';
import path from 'node:path';
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {tencentPayload} from './ui/guide/mayhem-data.mjs';

const TENCENT='https://mlol.qt.qq.com/go/battle_info/odp_proxy/';
const ENGLISH='https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/';
const TENCENT_AUGMENTS='https://game.gtimg.cn/images/lol/act/img/js/kiwi/kiwi_augments.json';
const MAX_BYTES=6*1024*1024,MAX_AGE=7*24*60*60;
export function buildDate(value){
  const data=tencentPayload(value),date=data.dtstatdate;
  if(typeof date!=='string'||!/^\d{8}$/.test(date)||
     ![data.augment_json_irank,data.augment_json,data.itemone_json].some(x=>typeof x==='string'&&x.length))throw new Error('Tencent has no Mayhem build for this champion yet.');
  const year=Number(date.slice(0,4)),month=Number(date.slice(4,6)),day=Number(date.slice(6,8));
  const parsed=new Date(Date.UTC(year,month-1,day));
  if(parsed.getUTCFullYear()!==year||parsed.getUTCMonth()!==month-1||parsed.getUTCDate()!==day)throw new Error('Tencent returned an invalid date.');
  return date;
}
function validate(value,kind){
  if(kind==='build')return buildDate(value);
  if(kind==='rankings'){
    if(!tencentPayload(value).listcollect)throw new Error('Tencent has no rankings for this date.');
  }else if(kind==='tencent-augments'){
    if(!Array.isArray(value)||value.length<100||!value.every(row=>row&&typeof row==='object'))throw new Error('Tencent\'s augment list is incomplete.');
  }else if(!Array.isArray(value)||value.length<100)throw new Error('The English game catalogue is incomplete.');
}
export function fetchJson(url){
  return new Promise((resolve,reject)=>{
    let settled=false,connectTimer,pooled=null;
    // Node keeps HTTPS sockets alive: a reused one is already connected and never says
    // secureConnect again, so only a new connection gets the 5 s connect limit, and the
    // listener comes off the socket when this request ends.
    const connected=()=>clearTimeout(connectTimer);
    const finish=(error,value)=>{
      if(settled)return;settled=true;clearTimeout(totalTimer);clearTimeout(connectTimer);
      pooled?.removeListener('secureConnect',connected);
      error?reject(error):resolve(value);
    };
    const req=https.get(url,{headers:{'User-Agent':'Friloverse/MayhemGuide'}},res=>{
      connected();
      if(res.statusCode!==200){res.resume();finish(new Error(`Mayhem source returned HTTP ${res.statusCode}.`));return;}
      if(Number(res.headers['content-length'])>MAX_BYTES){res.resume();finish(new Error('Mayhem response exceeded its size limit.'));return;}
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>MAX_BYTES){req.destroy();finish(new Error('Mayhem response exceeded its size limit.'));}else chunks.push(chunk);});
      res.on('end',()=>{try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(new Error('Mayhem source returned invalid data.'));}});
      res.on('error',error=>finish(error));
    });
    const totalTimer=setTimeout(()=>{req.destroy();finish(new Error('Mayhem source timed out.'));},12000);
    req.on('socket',socket=>{
      if(!socket.connecting)return;
      connectTimer=setTimeout(()=>{req.destroy();finish(new Error('Mayhem source connection timed out.'));},5000);
      pooled=socket;socket.once('secureConnect',connected);
    });
    req.on('error',error=>finish(error));
  });
}
export class MayhemData{
  constructor(root,{fetch=fetchJson,now=()=>Date.now()/1000}={}){this.root=root;this.fetch=fetch;this.now=now;this.pending=new Map();}
  async read(file,url,kind,ttl){
    const key=`${url}:${ttl}`;if(this.pending.has(key))return this.pending.get(key);
    const promise=this.readOnce(file,url,kind,ttl).finally(()=>this.pending.delete(key));
    this.pending.set(key,promise);return promise;
  }
  async readOnce(file,url,kind,ttl){
    const target=path.join(this.root,file),now=this.now();let previous=null;
    try{
      const raw=await readFile(target);
      if(raw.length<=MAX_BYTES){
        const saved=JSON.parse(raw.toString('utf8')),age=now-saved.fetchedAt;
        if(saved.url===url&&Number.isFinite(age)&&age>=0&&age<=MAX_AGE){validate(saved.value,kind);previous=saved;}
      }
    }catch{}
    if(previous&&now-previous.fetchedAt<ttl)return {...previous,stale:false};
    try{
      const value=await this.fetch(url);validate(value,kind);
      const document={url,fetchedAt:Math.floor(this.now()),value,stale:false};
      const tmp=`${target}.${randomBytes(6).toString('hex')}.tmp`;
      try{await mkdir(this.root,{recursive:true});await writeFile(tmp,JSON.stringify(document),{flag:'wx'});await rename(tmp,target);}
      catch{}finally{await unlink(tmp).catch(()=>{});}
      return document;
    }catch(error){if(previous)return {...previous,stale:true};throw error;}
  }
  async guide(championId,forceRefresh=false){
    if(!Number.isSafeInteger(championId)||championId<=0||championId>10000||typeof forceRefresh!=='boolean')throw new Error('Choose a valid champion.');
    const ttl=forceRefresh?0:15*60;
    const build=await this.read(`build-${championId}.json`,`${TENCENT}fuwen_hero_rank?championid=${championId}`,'build',ttl);
    const rankingDate=buildDate(build.value),notices=[];
    let rankings=null;
    try{
      rankings=await this.read('rankings.json',`${TENCENT}fuwen_aram_hero_rank_v2?dtstatdate=${rankingDate}`,'rankings',ttl);
      const data=tencentPayload(rankings.value);
      // Tencent can answer another day's rankings; the guide's date check needs the date kept.
      if(data.dtstatdate&&String(data.dtstatdate)!==rankingDate)throw new Error('The Mayhem ranking and build dates do not match.');
      const rows=String(data.listcollect).split('#').map(row=>row.split('_').slice(0,5).join('_')).join('#');
      rankings={...rankings,value:{listcollect:rows,...(data.dtstatdate?{dtstatdate:String(data.dtstatdate)}:{})}};
    }catch{rankings=null;notices.push('Champion rankings are temporarily unavailable. Build recommendations are still shown.');}
    return {championId,build,rankings,rankingDate,notices};
  }
  /** The installed League's own copy of a list, or null; this.local is set by the guide window. */
  async localList(name,kind){
    try{const value=await this.local?.(name);validate(value,kind);return {value,stale:false};}catch{return null;}
  }
  async catalogue(){
    const english=async(file,name,kind)=>await this.localList(name,kind)??this.read(file,`${ENGLISH}${name}`,kind,86400);
    const entries=await Promise.all([
      english('champions.json','champion-summary.json','champions'),
      english('items.json','items.json','items'),
      english('augments.json','cherry-augments.json','augments'),
    ]);
    // Tencent's Mayhem list has the right picture for a few augments Riot's data gives another's.
    // Only a help: without it the guide is complete.
    const tencent=await this.read('tencent-augments.json',TENCENT_AUGMENTS,'tencent-augments',86400).catch(()=>null);
    return {
      sources:{...Object.fromEntries(['champions','items','augments'].map((name,i)=>[name,entries[i].value])),tencentAugments:tencent?.value??[]},
      stale:entries.some(item=>item.stale),
    };
  }
}
