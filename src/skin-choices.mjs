import {championKey} from './model.mjs';
import {isFormSkin} from './fryilo-catalog/catalog.mjs';
import {chooseStandIn} from './local-skins.mjs';
import {RIOT_SKINS_OFF,riotSkinUnavailable} from './riot-skin-availability.mjs';

/**
 * The skin chosen for each champion in this draft, so swapping back keeps it. They
 * are only held here, which is why every champion select starts with skins off.
 */
export class SkinChoices{
  constructor({database,localDatabase=null,catalogue,champions=[],random=Math.random}){
    Object.assign(this,{database,localDatabase,catalogue,champions,random});this.picks=new Map();
  }
  championNumber(champion){
    const key=championKey(champion);
    const row=this.champions.find(item=>championKey(item.id)===key||championKey(item.name)===key);
    return row?Number(row.key):null;
  }
  /** The champion's internal name: how League spells its archives and skin files. */
  alias(champion){
    const key=championKey(champion);
    return this.champions.find(item=>championKey(item.id)===key||championKey(item.name)===key)?.id||null;
  }
  /** The file behind a card, with whose it is. */
  async resolve(id,champion,label=''){
    return {...await this.locate(id,champion,label),alias:this.alias(champion)};
  }
  /** A Riot skin is read from the converted local database and checked first. */
  async locate(id,champion,label=''){
    if(id.startsWith('riot:')){
      const skinId=Number(id.slice(5)),number=this.championNumber(champion);
      // Before anything is built: a refused skin turns LTK's whole overlay off in game.
      const unavailable=riotSkinUnavailable(skinId);
      if(unavailable)throw new Error(unavailable);
      if(!number||!(await this.catalogue.forChampion(number)).some(skin=>skin.id===skinId))throw new Error('This skin does not belong to the selected champion.');
      const ready=await this.catalogue.ensure(number,skinId);
      return {id,key:ready.sha,file:ready.file,label:label||'Riot skin',trusted:true,repair:isFormSkin({id:skinId})};
    }
    if(id.startsWith('local:')){
      if(!this.localDatabase)throw new Error('Local skins are not available.');
      return {...await this.localDatabase.resolve(id,champion),local:true};
    }
    return this.database.resolve(id,champion);
  }
  async choose(id,champion,label=''){
    const pick=await this.resolve(id,champion,label),before=this.pick(champion);
    // Choosing the same local skin again keeps what the party was shown.
    if(pick.local&&before?.local&&before.id===pick.id&&before.standIn)pick.standIn=before.standIn;
    this.picks.set(championKey(champion),pick);
    return pick;
  }
  pick(champion){return this.picks.get(championKey(champion))||null;}
  /**
   * What the party is told about this player's pick. Friends have no copy of a local skin, so
   * they get one of the champion's 4 latest Riot skins, drawn once per pick (owner's request,
   * 10.0). Null, so friends see League's own choice, while the Riot list has none for it, and
   * always while Riot skins are off (10.6): every Riot skin is filtered out below.
   */
  partyPick(champion){
    const pick=this.pick(champion);
    if(!pick?.local)return pick;
    const number=this.championNumber(champion),listed=number?this.catalogue.listed?.(number)||[]:[];
    // A new Riot list that no longer has it (another hash) would leave friends looking for it: draw again.
    if(pick.standIn&&listed.length&&!listed.some(skin=>skin.sha===pick.standIn.key))pick.standIn=null;
    if(!pick.standIn)pick.standIn=chooseStandIn(listed.filter(skin=>!riotSkinUnavailable(skin.id)),this.random);
    return pick.standIn;
  }
  drop(champion){this.picks.delete(championKey(champion));}
  clear(){this.picks.clear();}
  /** A friend's skin, found by the hash of its contents and never by its name. */
  async findByContents(champion,sha){
    const number=this.championNumber(champion);
    // A friend on an older Friloverse can still pick a Riot skin; a blocked one would turn
    // this PC's whole overlay off. Look it up by hash for every champion, not just Viego.
    const known=RIOT_SKINS_OFF||!number?null:(this.catalogue.listed?.(number)||[]).find(skin=>skin.sha===sha);
    const unavailable=known&&riotSkinUnavailable(known.id);
    if(unavailable)throw new Error(unavailable);
    const local=await this.database.findArchive(champion,sha).catch(()=>null);
    if(local)return {...await this.database.resolve(local,champion),alias:this.alias(champion)};
    if(RIOT_SKINS_OFF)return null;
    const ready=number?await this.catalogue.find(number,sha):null;
    if(!ready)return null;
    const blocked=riotSkinUnavailable(ready.id);
    if(blocked)throw new Error(blocked);
    return {id:`riot:${ready.id}`,key:ready.sha,file:ready.file,label:'Riot skin',trusted:true,repair:isFormSkin({id:ready.id}),alias:this.alias(champion)};
  }
}
