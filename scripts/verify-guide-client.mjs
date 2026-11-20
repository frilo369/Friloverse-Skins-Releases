// Read-only League client detection; never prints the lockfile or its credentials.
import {GuideWatcher} from '../src/guide-lcu.mjs';
let result=null;
const watcher=new GuideWatcher(value=>{result=value;});
await watcher.poll();watcher.stop();
if(!result){console.log('League client is not currently available.');}
else console.log(`League phase: ${result.phase}; guide mode: ${result.mode||'unknown'}; champion: ${result.champion||'none'}.`);
