// Reads real icons from the installed League, without changing anything.
import {LeagueIcons} from '../src/league-icons.mjs';
import {ensureZstdRuntime} from './lib/runtime.mjs';

ensureZstdRuntime(import.meta.url);
const icons=new LeagueIcons();
const catalogue=await icons.catalogue();
if(!catalogue?.length)throw new Error('League\'s icon catalogue could not be read.');
const sample=[...catalogue.slice(0,40),...catalogue.slice(-40)];
let read=0,failed=[];
const started=Date.now();
for(const {id} of sample){const icon=await icons.read(id);if(icon?.bytes?.length)read++;else failed.push(id);}
console.log(`Catalogue: ${catalogue.length} icons. Read ${read} of ${sample.length} in ${Date.now()-started} ms.`);
if(failed.length)console.log(`Not in the archives: ${failed.join(', ')}`);
if(read<sample.length*.9)throw new Error('Too many icons could not be read.');
