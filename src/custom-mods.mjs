import {mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';

/**
 * Which Custom Mods the player wants on. It stays as they set it, match after match;
 * the files only reach LTK Manager for the length of each match.
 */
export class CustomMods{
  constructor({database,dataDir}){
    this.database=database;this.dataDir=dataDir;this.file=path.join(dataDir,'custom-mods.json');this.enabled=new Set();
  }
  async load(){
    try{
      const saved=JSON.parse(await readFile(this.file,'utf8'));
      if(Array.isArray(saved?.enabled))this.enabled=new Set(saved.enabled.filter(id=>typeof id==='string'&&id.startsWith('moddb:')));
    }catch{/* None chosen yet. */}
  }
  async save(){
    await mkdir(this.dataDir,{recursive:true});
    const temp=`${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try{await writeFile(temp,JSON.stringify({enabled:[...this.enabled]}),{encoding:'utf8',flag:'wx'});await rename(temp,this.file);}
    finally{await unlink(temp).catch(()=>{});}
  }
  async list(){
    const result=await this.database.list('');
    return {available:result.available,mods:result.skins.map(mod=>({...mod,enabled:this.enabled.has(mod.id)}))};
  }
  async setEnabled(id,enabled){
    if(typeof id!=='string'||typeof enabled!=='boolean')throw new Error('Choose whether to enable or disable the mod.');
    await this.database.list('');
    await this.database.resolve(id);
    if(enabled)this.enabled.add(id);else this.enabled.delete(id);
    await this.save();
  }
  /** Enabled mods whose files are still there and whole. A missing or damaged one stays chosen. */
  async files(){
    const {mods}=await this.list(),files=[];
    for(const mod of mods){
      if(!mod.enabled||mod.broken)continue;
      try{files.push(await this.database.resolve(mod.id));}catch{/* It changed while being read: the next look finds it. */}
    }
    return files;
  }
}
