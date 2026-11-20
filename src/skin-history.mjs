import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {writeAtomic} from './atomic-file.mjs';
import {championKey} from './model.mjs';

/** Opt-in per-champion skin history (Historic Mode): remembers the last skin picked for each champion. */
export class SkinHistory{
  constructor(dataDir){
    this.file=path.join(dataDir,'skin-history.json');
    this.entries={};
    this.saving=Promise.resolve();
  }
  async load(){
    try{
      const saved=JSON.parse(await readFile(this.file,'utf8'));
      if(saved&&typeof saved==='object'&&!Array.isArray(saved)){
        for(const [champ,entry] of Object.entries(saved)){
          const key=championKey(champ);
          if(key&&typeof entry?.id==='string'&&entry.id){
            this.entries[key]={id:entry.id,label:String(entry.label||'').slice(0,140),updatedAt:Number(entry.updatedAt)||0};
          }
        }
      }
    }catch{this.entries={};}
    return {...this.entries};
  }
  get(champion){
    const key=championKey(champion);
    return key&&this.entries[key]?{...this.entries[key]}:null;
  }
  set(champion,{id,label=''}){
    const key=championKey(champion);
    if(!key||typeof id!=='string'||!id)return;
    const prev=this.entries[key];
    if(prev&&prev.id===id&&prev.label===label)return;
    this.entries[key]={id,label:String(label||'').slice(0,140),updatedAt:Date.now()};
    this.persist();
  }
  clear(champion){
    const key=championKey(champion);
    if(!key||!this.entries[key])return;
    delete this.entries[key];
    this.persist();
  }
  persist(){
    const payload=JSON.stringify(this.entries,null,2);
    this.saving=this.saving.catch(()=>{}).then(()=>writeAtomic(this.file,payload,{durable:true})).catch(()=>{});
  }
}
