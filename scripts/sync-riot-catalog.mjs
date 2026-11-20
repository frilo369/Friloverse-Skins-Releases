// Refresh Friloverse's copy of how FrYiLoCo names its Riot skins: which number is which
// champion, skin and chroma, and the art for the forms Riot has no chroma picture for.
// Run from the Friloverse root with the sibling FrYiLoCo checkout beside it, after that
// checkout's `npm run assets` has refreshed champions.json for a new League patch.
import {copyFile,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';

const source=path.resolve('..','FrYiLoCo Skins','desktop-ui');
const code=path.resolve('src','fryilo-catalog');
const forms=path.resolve('src','ui','forms');
await mkdir(code,{recursive:true});
await mkdir(forms,{recursive:true});
await copyFile(path.join(source,'catalog.mjs'),path.join(code,'catalog.mjs'));
await copyFile(path.join(source,'public','champions.json'),path.join(code,'champions.json'));
const art=await readdir(path.join(source,'public','forms'));
for(const file of art)await copyFile(path.join(source,'public','forms',file),path.join(forms,file));
console.log(`Updated the Riot skin catalogue and ${art.length} form pictures.`);
