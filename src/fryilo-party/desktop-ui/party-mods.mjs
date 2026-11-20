import {validModKey} from '../party-relay/src/protocol.mjs';

export function makeModKey(file) {
  const key={relative:String(file?.relative ?? '').replaceAll('\\','/'),sha:file?.sha};
  return validModKey(key) ? key : null;
}

export function modSelectionIdentity(mods = []) {
  return JSON.stringify([...new Set(mods.filter(validModKey).map(mod=>mod.sha))].sort());
}

/** Filenames may differ; a same-name package with different contents never matches. */
export function resolvePartyMods(keys, files) {
  const usable=new Map(),skipped=[];
  for(const key of keys) {
    if(!validModKey(key)) continue;
    const file=files.find(file=>file.sha===key.sha);
    if(file) usable.set(key.sha,file); else skipped.push(key);
  }
  return {usable,skipped};
}

/** Track applied imports separately from personal selections to prevent echoing
 * a friend's mod back into the room. Only tracked imports are removed on leave. */
export function createPartyModSync() {
  const applied=new Set();
  return {
    remember(id) { applied.add(id); },
    reset() { applied.clear(); },
    async apply(keys,files,{assertCurrent,enable,disable}) {
      const {usable,skipped}=resolvePartyMods(keys,files);
      const desired=new Set(),failed=[],stuck=[];
      for(const file of usable.values()) {
        await assertCurrent();
        try {
          const id=await enable(file);
          applied.add(id);
          desired.add(id);
        } catch(error) {
          await assertCurrent();
          failed.push({file,error});
        }
      }
      for(const id of [...applied]) {
        if(desired.has(id)) continue;
        await assertCurrent();
        try { await disable(id); applied.delete(id); }
        catch(error) { await assertCurrent(); stuck.push({id,error}); }
      }
      return {skipped,failed,stuck};
    },
  };
}
