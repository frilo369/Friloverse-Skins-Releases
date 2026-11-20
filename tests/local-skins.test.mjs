import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {zip} from './fixtures/zip.mjs';
import {SkinDatabase} from '../src/skin-database.mjs';
import {SkinChoices} from '../src/skin-choices.mjs';
import {skinKey} from '../src/party-coordinator.mjs';
import {LOCAL_SKINS,localSkinsRoot,championFolder,ensureLocalSkinFolders,latestRiotSkins,chooseStandIn} from '../src/local-skins.mjs';
import {setRiotSkinsOff} from '../src/riot-skin-availability.mjs';

// Stand-ins are Riot skins; tests/riot-skins-off.test.mjs covers 10.6, where there are none.
setRiotSkinsOff(false);

const CHAMPIONS=JSON.parse(readFileSync(new URL('../src/ui/champions.json',import.meta.url),'utf8'));
const sha=n=>n.toString(16).padStart(40,'0');
// Ahri's list as the Riot manifest has it: skins one level down, chromas and forms two.
const row=(id,name,parent=null)=>({id,champion:103,name,sha:sha(id),relative:parent?`103/${parent}/${id}/${id}.fantome`:`103/${id}/${id}.fantome`});
const AHRI=[row(103001,'Dynasty Ahri'),row(103027,'Spirit Blossom Ahri'),row(103085,'Risen Legend Ahri'),row(103086,'Risen Legend chroma',103085),
  row(103088,'Spirit Blossom Springs Ahri'),row(103089,'After Hours Spirit Blossom Springs Ahri'),row(103097,'K/DA FIRESTARTER Ahri'),
  row(103098,'K/DA FIRESTARTER chroma',103097),row(103999,'A form',103097),row(103042,'Coven Ahri')];

async function temp(){return mkdtemp(path.join(tmpdir(),'friloverse-local-'));}
async function clean(root){assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}

test('LocalSkins sits in the database and has an empty folder for every champion',async()=>{
  const root=await temp();
  try{
    const local=localSkinsRoot(path.join(root,'Database'));
    assert.equal(local,path.join(root,'Database',LOCAL_SKINS));
    assert.equal(await ensureLocalSkinFolders(local,CHAMPIONS),0);
    const made=await readdir(local);
    assert.equal(made.length,CHAMPIONS.length);
    for(const name of ["Kai'Sa",'Dr. Mundo','Nunu & Willump','Wukong','Aatrox'])assert.ok(made.includes(name),name);
    for(const name of made)assert.deepEqual(await readdir(path.join(local,name)),[]);
    // A later start keeps what the player put there.
    await writeFile(path.join(local,'Aatrox','Mine.fantome'),'mine');
    assert.equal(await ensureLocalSkinFolders(local,CHAMPIONS),0);
    assert.equal(await readFile(path.join(local,'Aatrox','Mine.fantome'),'utf8'),'mine');
  }finally{await clean(root);}
});

test('champion folder names are safe Windows names',()=>{
  assert.equal(championFolder("Kai'Sa"),"Kai'Sa");
  assert.equal(championFolder('Dr. Mundo'),'Dr. Mundo');
  assert.equal(championFolder('Bad:Name?.'),'BadName');
  assert.equal(championFolder('../..'),'');
  assert.equal(championFolder('CON'),'');
});

test('the stand-in comes from the 4 latest skins, never chromas, forms or the base',()=>{
  assert.deepEqual(latestRiotSkins(AHRI).map(skin=>skin.id),[103097,103089,103088,103085]);
  const seen=new Set();
  for(const random of [0,.25,.5,.75,.999999])seen.add(chooseStandIn(AHRI,()=>random).id);
  assert.deepEqual([...seen].sort(),['riot:103085','riot:103088','riot:103089','riot:103097']);
  assert.deepEqual(chooseStandIn(AHRI,()=>0),{id:'riot:103097',key:sha(103097),label:'K/DA FIRESTARTER Ahri'});
  // Fewer than 4 skins: one of those there are. None: no stand-in.
  assert.deepEqual(latestRiotSkins(AHRI.slice(0,2)).map(skin=>skin.id),[103027,103001]);
  assert.equal(chooseStandIn([]),null);
});

async function localLibrary(){
  const root=await temp(),dir=path.join(root,LOCAL_SKINS,'Ahri');
  await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'My Ahri.fantome'),zip({'META/info.json':JSON.stringify({Name:'My Ahri'}),'META/image.png':'png','WAD/Ahri.wad.client':'mine'}));
  const champions=[{id:'Ahri',key:'103',name:'Ahri'}];
  const localDatabase=new SkinDatabase({root:path.join(root,LOCAL_SKINS),champions,local:true});
  const database=new SkinDatabase({root:path.join(root,'Custom Skins'),champions});
  const catalogue={listed:number=>number===103?AHRI:[],forChampion:async number=>number===103?AHRI:[],find:async()=>null};
  return {root,localDatabase,database,catalogue,champions};
}

test('local skins get their own cards, picture address and pick, and are never a friend\'s skin',async()=>{
  const f=await localLibrary();
  try{
    const {skins}=await f.localDatabase.list('Ahri');
    assert.equal(skins.length,1);
    assert.match(skins[0].id,/^local:[0-9a-f]{64}$/);
    assert.equal(skins[0].source,'local');assert.equal(skins[0].kind,'custom');
    assert.equal(skins[0].image,`friloverse-icon://local/${skins[0].id.slice(6)}`);
    assert.equal(f.localDatabase.embeddedImage(skins[0].id.slice(6)).bytes.toString(),'png');
    const choices=new SkinChoices({database:f.database,localDatabase:f.localDatabase,catalogue:f.catalogue,champions:f.champions});
    const pick=await choices.choose(skins[0].id,'Ahri','My Ahri');
    assert.equal(pick.local,true);assert.equal(pick.label,'My Ahri');assert.match(pick.key,/^[0-9a-f]{40}$/);
    // Friends never look through LocalSkins for a skin sent to them.
    assert.equal(await f.localDatabase.findArchive('Ahri',pick.key),null);
    assert.equal(await choices.findByContents('Ahri',pick.key),null);
  }finally{await clean(f.root);}
});

test('the party is told about a random latest Riot skin for a local pick, drawn once per pick',async()=>{
  const f=await localLibrary();
  try{
    const draws=[.9,0,.5];let calls=0;
    const choices=new SkinChoices({database:f.database,localDatabase:f.localDatabase,catalogue:f.catalogue,champions:f.champions,random:()=>{calls++;return draws.shift();}});
    const {skins}=await f.localDatabase.list('Ahri');
    await choices.choose(skins[0].id,'Ahri','My Ahri');
    const told=choices.partyPick('Ahri');
    assert.equal(told.id,'riot:103085');
    // The same each time it is asked, and when the same local skin is chosen again.
    assert.equal(choices.partyPick('Ahri'),told);
    await choices.choose(skins[0].id,'Ahri','My Ahri');
    assert.equal(choices.partyPick('Ahri'),told);
    assert.equal(calls,1);
    // What travels is a Riot skin a friend's PC finds in its own Riot list.
    assert.deepEqual(skinKey('Ahri',told),{source:'custom',championId:'ahri',relative:'Risen Legend Ahri',sha:sha(103085)});
    // The player's own engine still gets the local file.
    assert.equal(choices.pick('Ahri').local,true);assert.ok(choices.pick('Ahri').file.endsWith('My Ahri.fantome'));
    // Turning it off and choosing it again is a new pick, with a new draw.
    choices.drop('Ahri');assert.equal(choices.partyPick('Ahri'),null);
    await choices.choose(skins[0].id,'Ahri','My Ahri');
    assert.equal(choices.partyPick('Ahri').id,'riot:103097');assert.equal(calls,2);
  }finally{await clean(f.root);}
});

test('a local pick waits for the Riot list, and other picks travel as they are',async()=>{
  const f=await localLibrary();
  try{
    let list=[];
    const catalogue={listed:()=>list,forChampion:async()=>AHRI,ensure:async(_,id)=>({sha:sha(id),file:'riot.fantome'})};
    const choices=new SkinChoices({database:f.database,localDatabase:f.localDatabase,catalogue,champions:f.champions,random:()=>0});
    const {skins}=await f.localDatabase.list('Ahri');
    await choices.choose(skins[0].id,'Ahri','My Ahri');
    // No Riot list yet: friends keep League's own choice for now.
    assert.equal(choices.partyPick('Ahri'),null);
    list=AHRI;
    assert.equal(choices.partyPick('Ahri').id,'riot:103097');
    // A Riot list without that skin's hash draws again; one that still has it keeps it.
    list=AHRI.map(skin=>skin.id===103097?{...skin,sha:sha(1)}:skin);
    assert.equal(choices.partyPick('Ahri').key,sha(1));
    list=AHRI.filter(skin=>skin.id!==103097);
    assert.equal(choices.partyPick('Ahri').id,'riot:103089');
    assert.equal(choices.partyPick('Ahri').id,'riot:103089');
    const riot=await choices.choose('riot:103027','Ahri','Spirit Blossom Ahri');
    assert.equal(choices.partyPick('Ahri'),riot);
  }finally{await clean(f.root);}
});
