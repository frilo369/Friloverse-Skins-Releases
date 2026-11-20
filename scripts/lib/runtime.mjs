// Shared runtime helpers for Friloverse maintenance and verification scripts:
//   - automatic Node 24 (zstd) selection via Electron's bundled Node runtime
//   - real-machine safety guard so LTK/League checks never run during a draft or match
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';
import {noGameProcess} from '../../src/lcu-safety.mjs';
import {leagueConnection,leagueGet} from '../../src/league-client.mjs';
import {ltkRunning} from '../../src/ltk.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');
const ELECTRON=path.join(ROOT,'node_modules','electron','dist','electron.exe');
export const DEFAULT_IDLE_PHASES=['None','Lobby','EndOfGame'];

/** Best available Node executable with zstd support (current Node 24+, or bundled Electron). */
export function zstdNode(){
  if(typeof zlib.zstdDecompressSync==='function')return {execPath:process.execPath,env:process.env,hasZstd:true};
  if(existsSync(ELECTRON))return {execPath:ELECTRON,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},hasZstd:true};
  return {execPath:process.execPath,env:process.env,hasZstd:false};
}

/**
 * Relaunches the calling script under Electron's bundled Node 24 when the current runtime
 * lacks zstd support (needed to read League's WAD files and .modpkg archives).
 */
export function ensureZstdRuntime(metaUrl){
  if(typeof zlib.zstdDecompressSync==='function')return;
  if(process.env.FRILOVERSE_ZSTD_RELAUNCH!=='1'&&existsSync(ELECTRON)){
    const script=fileURLToPath(metaUrl);
    const child=spawnSync(ELECTRON,[script,...process.argv.slice(2)],{
      cwd:process.cwd(),stdio:'inherit',
      env:{...process.env,ELECTRON_RUN_AS_NODE:'1',FRILOVERSE_ZSTD_RELAUNCH:'1'},
    });
    if(child.error)throw child.error;
    process.exit(child.status??1);
  }
  console.error('This script needs a Node runtime with zstd support (Node 24 or Electron as Node).');
  process.exit(2);
}

/** Empty when League is idle and no game process is running; otherwise a short reason. */
export async function leagueBusyReason(allowedPhases=DEFAULT_IDLE_PHASES){
  const phase=await leagueConnection().then(client=>leagueGet(client,'/lol-gameflow/v1/gameflow-phase')).catch(()=>'None');
  if(!allowedPhases.includes(phase))return `League is in ${phase}`;
  if(!await noGameProcess())return 'a League game is running';
  return '';
}

/** Exits with code 2 when League is in a draft/match or (unless allowed) LTK Manager is open. */
export async function assertMachineIdle({allowLtk=false,allowedPhases=DEFAULT_IDLE_PHASES}={}){
  const busy=await leagueBusyReason(allowedPhases);
  if(busy){console.error(`Refused: ${busy}.`);process.exit(2);}
  if(!allowLtk&&await ltkRunning()){console.error('Refused: LTK Manager is already open.');process.exit(2);}
}
