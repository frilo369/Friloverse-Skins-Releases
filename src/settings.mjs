import {readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {writeAtomic} from './atomic-file.mjs';
import {parseShortcut} from './guide-shortcut.mjs';

// theme (6.4) names a picture in src/ui/themes; the window falls back to Friloverse's own sky for
// one it does not know, so a name from a newer version is kept rather than refused.
// Friloverse is the default until the player picks a theme (themePicked), and their pick then stays through
// updates. 8.1 (owner's request) put every player on it once: a file without themeMoved was saved before that,
// so its theme is set aside. The first save writes the flag, and picks made from then on are kept.
export const DEFAULT_SETTINGS=Object.freeze({startWithWindows:true,guideHotkey:'F1',theme:'friloverse',themePicked:false,themeMoved:true,rememberLastSkin:false,reportDownloads:true});
const valid=(key,value)=>key==='guideHotkey'?!!parseShortcut(value):key==='theme'?typeof value==='string'&&/^[a-z0-9-]{1,40}$/.test(value):typeof value==='boolean';
export class SettingsStore {
  constructor(dataDir){this.file=path.join(dataDir,'settings.json');this.value={...DEFAULT_SETTINGS};this.saving=Promise.resolve();}
  async load(){
    try{
      const saved=JSON.parse(await readFile(this.file,'utf8'));
      for(const key of Object.keys(DEFAULT_SETTINGS))if(valid(key,saved?.[key]))this.value[key]=saved[key];
      if(saved?.themeMoved!==true){this.value.themePicked=false;this.value.themeMoved=true;}
    }catch(error){if(error.code!=='ENOENT')throw new Error('Friloverse settings could not be read.');}
    if(!this.value.themePicked)this.value.theme=DEFAULT_SETTINGS.theme;
    return {...this.value};
  }
  /** One at a time: each save starts from what the one before it wrote, so none of them is lost. */
  async set(key,value){
    if(!Object.hasOwn(DEFAULT_SETTINGS,key)||!valid(key,value))throw new Error('Unknown setting.');
    const turn=this.saving.then(()=>this.write(key,value));
    this.saving=turn.catch(()=>{});
    return turn;
  }
  async write(key,value){
    const next={...this.value,[key]:value,...key==='theme'?{themePicked:true}:{}};
    await writeAtomic(this.file,JSON.stringify(next,null,2),{durable:true});
    this.value=next;
    return {...next};
  }
}

/** The complete setup's privacy page (13.2) leaves this marker when the player unticks "tell the developer which
 *  Divine skins I download". It is taken into the settings once and removed. Returns whether it was there. */
export const DOWNLOAD_REPORTS_OFF_MARKER='download-reports-off';
export async function applyInstallerChoices(store,dataDir){
  const marker=path.join(dataDir,DOWNLOAD_REPORTS_OFF_MARKER);
  try{await readFile(marker);}catch(error){if(error.code==='ENOENT')return false;throw error;}
  await store.set('reportDownloads',false);
  await rm(marker,{force:true});
  return true;
}
