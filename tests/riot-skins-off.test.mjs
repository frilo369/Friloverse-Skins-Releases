import test from 'node:test';
import assert from 'node:assert/strict';
import * as riotCatalogue from '../src/riot-skins-local.mjs';
import {RIOT_SKINS_OFF,riotSkinUnavailable,setRiotSkinsOff} from '../src/riot-skin-availability.mjs';
import {riotCards} from '../src/riot-skins-local.mjs';
import {SkinChoices} from '../src/skin-choices.mjs';

// 10.6: LTK's in-game patcher refuses Riot's own skins and then turns every mod off for the game,
// so no Riot skin may reach LTK, by the panel, a Local Skins stand-in or a friend's pick.
const ahri={id:'Ahri',key:'103',name:'Ahri',skins:[{id:'103000',num:0,name:'default'},{id:'103001',num:1,name:'Dynasty Ahri'}]};
const row={id:103001,champion:103,parent:null,relative:'103/103001/103001.fantome',sha:'a'.repeat(40),size:10,name:'Dynasty Ahri'};
const untouchable=()=>{throw new Error('a Riot skin must not be read or built while they are off');};
const catalogue={forChampion:untouchable,ensure:untouchable,find:untouchable,listed:()=>[row]};
const mine='c'.repeat(40);
const database={findArchive:async(_champion,sha)=>sha===mine?'db:1':null,resolve:async id=>({id,key:mine,file:'C:/mine.fantome',label:'Mine'})};
const localDatabase={resolve:async id=>({id,key:'l',file:'C:/LocalSkins/Ahri/My Ahri.fantome',label:'My Ahri'})};
const choices=()=>new SkinChoices({database,localDatabase,catalogue,champions:[{id:'Ahri',key:'103',name:'Ahri'}]});

test('Riot skins are off, and the reason names LTK',()=>{
  assert.equal(RIOT_SKINS_OFF,true);
  assert.match(riotSkinUnavailable(103001),/LTK Manager no longer loads Riot's own skins/);
});

test('the catalogue module exposes the switch main uses when Rose is available',()=>{
  assert.equal(typeof riotCatalogue.setRiotSkinsOff,'function');
  assert.equal(riotCatalogue.RIOT_SKINS_OFF,true);
});

test('Winterblessed Hecarim stays out while Rose makes Riot skins available again',()=>{
  setRiotSkinsOff(false);
  try{
    assert.match(riotSkinUnavailable(120031),/Winterblessed Hecarim/);
    assert.match(riotSkinUnavailable(120040),/Winterblessed Hecarim/);
    assert.equal(riotSkinUnavailable(120030),'');
    assert.equal(riotSkinUnavailable(234994),'');
    assert.equal(riotSkinUnavailable(234043),'');
  }finally{setRiotSkinsOff(true);}
});

test('the panel gets no Riot cards',()=>{
  assert.deepEqual(riotCards(ahri,[row]),[]);
});

test('a Riot pick is refused before anything is read or built',async()=>{
  await assert.rejects(choices().choose('riot:103001','Ahri'),/no longer loads Riot's own skins/);
});

test('a friend\'s Riot pick is never looked up, while a custom skin this PC has still loads',async()=>{
  const picks=choices();
  assert.equal(await picks.findByContents('ahri',row.sha),null);
  assert.equal((await picks.findByContents('ahri',mine)).file,'C:/mine.fantome');
});

test('friends are told nothing for a local skin, so they keep the skin chosen in League',async()=>{
  const picks=choices();
  await picks.choose('local:Ahri/My Ahri.fantome','Ahri','My Ahri');
  assert.equal(picks.pick('Ahri').local,true);
  assert.equal(picks.partyPick('Ahri'),null);
});
