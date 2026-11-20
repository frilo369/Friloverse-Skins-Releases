// Checks that the guide page causes no Windows Firewall prompt. A prompt only shows
// for a program path Windows has not seen, so this runs a throwaway copy of Electron.
// Windows adds a rule for that path the moment it prompts, even before an answer.
// A failure shows one real prompt; press Cancel. Rules left behind are harmless.
import {spawnSync} from 'node:child_process';
import {cp,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import electron from 'electron';

const project=path.resolve('.');
const folder=await mkdtemp(path.join(tmpdir(),'friloverse-fw-'));
const userData=path.join(folder,'user-data');
const copy=path.join(folder,'electron.exe');
try{
  await cp(path.dirname(electron),folder,{recursive:true});
  const run=spawnSync(copy,[path.join(project,'scripts','verify-firewall.cjs')],{encoding:'utf8',windowsHide:true,timeout:90000,env:{...process.env,
    FRILOVERSE_PROJECT:project,FRILOVERSE_FIREWALL_USER_DATA:userData,FRILOVERSE_FIREWALL_URL:'https://www.metasrc.com/lol/champions/aatrox/build'}});
  if(run.error)throw run.error;
  const page=/page: (.*)/.exec(run.stdout)?.[1]??'';
  if(!/aatrox/i.test(page))throw new Error(`The guide page did not load (${page||'no title'}), so this check proves nothing.`);
  const script=`@(Get-NetFirewallApplicationFilter -Program '${copy.replaceAll("'","''")}' -ErrorAction SilentlyContinue).Count`;
  const rules=spawnSync('powershell',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true});
  if(rules.error||rules.status!==0)throw new Error('Could not read the Windows Firewall rules.');
  if(Number(rules.stdout.trim())!==0)throw new Error('Windows Firewall prompted for the guide page.');
  console.log(`No firewall prompt while loading: ${page}`);
}finally{await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:500}).catch(()=>{});}
