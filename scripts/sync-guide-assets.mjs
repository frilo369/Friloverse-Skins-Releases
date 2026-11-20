// Replace Friloverse's guide presentation with the one in the sibling FrYiLoCo
// checkout. The guide pages are maintained here since the 2026-11-10 layout
// redesign, so this overwrites that work: it only runs with --force.
// Run from the Friloverse root with the sibling FrYiLoCo checkout installed.
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';

if(!process.argv.includes('--force')){
  console.error('Refused: this would overwrite the guide pages in src/ui/guide (mayhem.html, mayhem.css, mayhem.js,\n'
    +'guide-theme.css, metasrc-guide.css, metasrc-guide.js and the data files) with the FrYiLoCo copies,\n'
    +'which do not have the Friloverse layout. Commit first, then run again with --force if that is what you want.');
  process.exit(1);
}

const source=path.resolve('..','FrYiLoCo Skins','desktop-ui');
const target=path.resolve('src','ui','guide');
const require=createRequire(path.join(source,'package.json'));
const {transformSync}=require('esbuild');
await mkdir(target,{recursive:true});
for(const file of ['mayhem.css','guide-theme.css','mayhem-data.mjs','mayhem-cache.mjs','metasrc-guide.css','metasrc-guide.js'])
  await copyFile(path.join(source,file),path.join(target,file));
await copyFile(path.join(source,'public','mayhem-catalogue.json'),path.join(target,'mayhem-catalogue.json'));
const metasrc=path.join(target,'metasrc-guide.js');
await writeFile(metasrc,(await readFile(metasrc,'utf8')).replaceAll('· FrYiLoCo`','· Friloverse`'));
let html=await readFile(path.join(source,'mayhem.html'),'utf8');
html=html.replaceAll('href="/mayhem.css"','href="mayhem.css"').replaceAll('href="/guide-theme.css"','href="guide-theme.css"')
  .replace('src="/mayhem.ts"','src="mayhem.js"').replaceAll('FrYiLoCo · ARAM: Mayhem','Friloverse · ARAM: Mayhem')
  .replace('<meta charset="UTF-8" />','<meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: https://raw.communitydragon.org; connect-src \'self\';">');
await writeFile(path.join(target,'mayhem.html'),html);
let script=await readFile(path.join(source,'mayhem.ts'),'utf8');
script=script.replace("import { invoke } from '@tauri-apps/api/core';","import { invoke } from './mayhem-ipc.mjs';")
  .replace("'__TAURI_INTERNALS__' in window","'friloverseGuide' in window").replaceAll('· FrYiLoCo`','· Friloverse`');
await writeFile(path.join(target,'mayhem.js'),transformSync(script,{loader:'ts',format:'esm',target:'es2022'}).code);
console.log('Updated the bundled guide presentation.');
