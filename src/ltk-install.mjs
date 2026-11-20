import {createHash,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {promisify} from 'node:util';
import {resolveLtkExecutable} from './ltk.mjs';

const run=promisify(execFile);
// The same file as scripts/complete-setup.nsi; a test keeps the two together.
export const LTK_INSTALLER={
  url:'https://github.com/LeagueToolkit/ltk-manager/releases/download/v1.33.0/LTK.Manager_x64-setup.exe',
  sha256:'d615a752940061e683e032506c432851df79e8b39f3732a9576fbedfdc6b5920',
};

async function sha256(file){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}
/** It installs for every user of this PC, so Windows asks the player for permission. */
function runElevated(file){
  // The path comes from an environment variable, so nothing has to be quoted.
  return run('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',
    "Start-Process -FilePath $env:FRILOVERSE_LTK_SETUP -ArgumentList '/S' -Verb RunAs -Wait"],
  {windowsHide:true,timeout:5*60*1000,env:{...process.env,FRILOVERSE_LTK_SETUP:file}});
}

/**
 * For anyone who reached this version by an app update: nobody has to find or run
 * another setup. Only the official installer with the expected hash is ever started.
 */
export async function installLtk({dir,fetchFn=fetch,elevate=runElevated,resolve=resolveLtkExecutable,installer=LTK_INSTALLER,onProgress=()=>{}}){
  await mkdir(dir,{recursive:true});
  const file=path.join(dir,`LTK-Setup-${randomBytes(6).toString('hex')}.exe`);
  try{
    const response=await fetchFn(installer.url,{signal:AbortSignal.timeout(5*60*1000)});
    if(!response.ok||!response.body)throw new Error(`LTK Manager could not be downloaded (${response.status}).`);
    // How far the download is, for the dashboard's top-left strip.
    const total=Number(response.headers?.get?.('content-length'))||0;let bytes=0;
    onProgress({phase:'download',bytes,total});
    const counted=new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;onProgress({phase:'download',bytes,total});done(null,chunk);}});
    await pipeline(Readable.fromWeb(response.body),counted,createWriteStream(file,{flags:'wx'}));
    onProgress({phase:'install'});
    if(await sha256(file)!==installer.sha256)throw new Error('The LTK Manager download was damaged, so it was not run.');
    try{await elevate(file);}
    catch{throw new Error('LTK Manager was not installed. Windows needs your permission for this: press Install and choose Yes.');}
    return await resolve();
  }finally{await unlink(file).catch(()=>{});}
}

/** Friloverse used to start Celestial itself, and it must not overlay a game alongside LTK. */
export async function retireCelestial({running,kill=()=>run('taskkill',['/F','/T','/IM','celestial.exe'],{windowsHide:true,timeout:5000})}){
  if(await running())await kill().catch(()=>{});
}
