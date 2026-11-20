// Reads the Riot skin database the way the app does with its bundled bridge: Riot skins on,
// GitHub's manifest, then every card's name and art.
import {readFile} from 'node:fs/promises';
import {RiotCatalogue,riotCards} from '../src/riot-skins-local.mjs';
import {riotSkinUnavailable,setRiotSkinsOff} from '../src/riot-skin-availability.mjs';

// The app turns Riot skins on when it finds the bundled LTF bridge (main.cjs, 10.8). Without
// this the run would only prove that every file is hidden, not that it has a named card.
setRiotSkinsOff(false);
const {champions}=JSON.parse(await readFile(new URL('../src/fryilo-catalog/champions.json',import.meta.url),'utf8'));
const catalogue=new RiotCatalogue();
await catalogue.load();
const update=await catalogue.checkRemote();
if(!catalogue.ready)throw new Error(catalogue.remoteError||catalogue.lastError||'The Riot skin database could not be read.');
await catalogue.refreshNames();
console.log(`Riot database ${catalogue.commit}${update.changed?' (new manifest)':''}: ${catalogue.root}`);
let cards=0,chromas=0,files=0,unavailable=0,lost=0;const unnamed=[];
for(const champion of champions){
  const list=await catalogue.forChampion(Number(champion.key)),built=riotCards(champion,list);
  cards+=built.length;chromas+=built.reduce((sum,card)=>sum+card.chromas.length,0);files+=list.length;
  for(const card of built){
    if(/^Skin \d+$|^\d+$/.test(card.name))unnamed.push(`${champion.name} ${card.id}`);
    for(const chroma of card.chromas)if(/^(?:Chroma |Version )?\d{3,}$/.test(chroma.name))unnamed.push(`${champion.name} ${chroma.id}`);
  }
  const seen=new Set(built.flatMap(card=>[card.id,...card.chromas.map(chroma=>chroma.id)]));
  unavailable+=list.filter(skin=>riotSkinUnavailable(skin.id)).length;
  lost+=list.filter(skin=>!riotSkinUnavailable(skin.id)&&!seen.has(`riot:${skin.id}`)).length;
}
console.log(`Champions ${champions.length}, files ${files}, cards ${cards}, chromas and forms ${chromas}, hidden picks ${unavailable}, missing cards ${lost}`);
console.log(`Cards and chromas without a real name: ${unnamed.length}${unnamed.length?` (${unnamed.slice(0,8).join(', ')})`:''}`);
if(lost||unnamed.length)process.exitCode=1;
