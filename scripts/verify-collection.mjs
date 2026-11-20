// Read-only check of Friloverse's local custom database and artwork.
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {SkinDatabase} from '../src/skin-database.mjs';
import {friloverseDatabaseRoot,loadCustomArtwork} from '../src/custom-database.mjs';
const champions=JSON.parse(await readFile(new URL('../src/ui/champions.json',import.meta.url),'utf8'));
const local=process.env.LOCALAPPDATA||path.join(process.env.USERPROFILE||'','AppData','Local');
const root=friloverseDatabaseRoot(local);
const db=new SkinDatabase({root:path.join(root,'Custom Skins'),champions});
db.setArtwork(await loadCustomArtwork({dataDir:path.join(process.env.APPDATA||'', 'friloverse-skins'),databaseRoot:root}));
const result=await db.list('Aatrox');
assert.equal(result.available,true,'The Friloverse Custom Skins database folder must exist for this check.');
let total=0;const without=[];
for(const entry of await readdir(db.root,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.isSymbolicLink())continue;
  const found=await db.list(entry.name);total+=found.skins.length;
  for(const skin of found.skins)if(!skin.image)without.push(`${entry.name}: ${skin.name}`);
}
console.log(`Friloverse custom database: ${total} skins; ${total-without.length}/${total} have artwork.`);
if(without.length)console.log(`Missing artwork: ${without.join('; ')}`);
