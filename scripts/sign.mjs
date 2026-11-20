// Authenticode signing for the build (2026-11-20). Windows Smart App Control blocks unsigned
// programs with no reputation, and every release recompiles ltk_launcher.exe and
// LeagueToolFlop.dll, so an unsigned build can stop skins on a player's PC.
//
// Signing is off until a certificate is configured, so a plain `npm run build` still works.
// Set ONE of these in the shell that runs the build (never commit them):
//   FRILOVERSE_SIGN_THUMBPRINT  certificate in the Windows store or on a token (SHA-1 thumbprint)
//   FRILOVERSE_SIGN_PFX + FRILOVERSE_SIGN_PASSWORD  a .pfx file
//   FRILOVERSE_SIGN_PARAMS      everything signtool needs between `sign` and the file name, for
//                               cloud signing (Azure Artifact Signing's /dlib and /dmdf, a token's /csp)
// Optional: FRILOVERSE_SIGN_TIMESTAMP (default http://timestamp.digicert.com; any RFC 3161 server),
//           FRILOVERSE_SIGNTOOL (signtool.exe; default the one bundled with @electron/windows-sign),
//           FRILOVERSE_REQUIRE_SIGNING=1 (the build fails instead of warning when nothing is configured).
//
// build.mjs hands this file to the packager and Squirrel as a per-file hook, and signs the
// complete setup with it too.
//
// Two rules keep updates small and the files trustworthy:
//  - A file that already carries a signature (Microsoft's d3dcompiler) is left alone.
//  - A signature includes the signing time, so signing the 250 MB Electron exe again every release
//    would make it differ each time and put it whole into Squirrel's delta (6.3: deltas are
//    under 1 MB because the exe stays the same file). A signed copy is kept in
//    artifacts/signed-cache by the hash of the unsigned file and the signing identity, and put back
//    on the next build instead of signing again.
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {copyFile,mkdir,readFile,rm,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const CACHE=path.join(root,'artifacts','signed-cache');
const DEFAULT_TIMESTAMP='http://timestamp.digicert.com';

/** The signing setup from the environment, or null when none is configured. */
export function signingConfig(env=process.env){
  const thumbprint=(env.FRILOVERSE_SIGN_THUMBPRINT||'').replace(/\s+/g,'');
  const pfx=env.FRILOVERSE_SIGN_PFX||'';
  const password=env.FRILOVERSE_SIGN_PASSWORD||'';
  const params=(env.FRILOVERSE_SIGN_PARAMS||'').trim();
  if(!thumbprint&&!pfx&&!params)return null;
  if(pfx&&!thumbprint&&!params&&!password)throw new Error('FRILOVERSE_SIGN_PFX needs FRILOVERSE_SIGN_PASSWORD.');
  return {thumbprint,pfx,password,params,timestamp:env.FRILOVERSE_SIGN_TIMESTAMP||DEFAULT_TIMESTAMP,
    signtool:env.FRILOVERSE_SIGNTOOL||path.join(root,'node_modules','@electron','windows-sign','vendor','signtool.exe')};
}

/** signtool's arguments for one file (SHA-256 file digest and timestamp digest, RFC 3161). */
export function signArgs(config,file){
  const stamp=['/tr',config.timestamp,'/td','sha256'];
  let selection;
  // Quoted parts may hold spaces (a path to a dlib or a metadata file).
  if(config.params)return ['sign',...(config.params.match(/"[^"]*"|\S+/g)||[]).map(part=>part.replace(/^"|"$/g,'')),file];
  if(config.thumbprint)selection=['/sha1',config.thumbprint];
  else selection=['/f',path.resolve(config.pfx),'/p',config.password];
  return ['sign','/fd','sha256',...stamp,...selection,file];
}

/** What identifies the signer, so a changed certificate does not reuse another one's cache.
 *  The password is not part of it. */
export function identity(config){
  return createHash('sha256').update([config.thumbprint,config.pfx&&path.resolve(config.pfx),config.params,config.timestamp].join('\n')).digest('hex').slice(0,16);
}

/** Whether a PE file already has an Authenticode certificate table (data directory 4). */
export function hasSignature(buffer){
  if(buffer.length<0x40||buffer.readUInt16LE(0)!==0x5a4d)return false;
  const pe=buffer.readUInt32LE(0x3c);
  if(pe+0x18>buffer.length||buffer.readUInt32LE(pe)!==0x00004550)return false;
  const magic=buffer.readUInt16LE(pe+0x18);
  const directories=pe+0x18+(magic===0x20b?112:96);
  const entry=directories+4*8;
  if(entry+8>buffer.length)return false;
  return buffer.readUInt32LE(entry)!==0&&buffer.readUInt32LE(entry+4)!==0;
}

function run(program,args){
  return new Promise((resolve,reject)=>{
    const child=spawn(program,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';
    child.stdout.on('data',data=>{output+=data;});
    child.stderr.on('data',data=>{output+=data;});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve(output):reject(new Error(`signtool exited with ${code}:\n${output.trim()}`)));
  });
}

export const stats={signed:0,cached:0,skipped:0};

/** Signs one file in place. `exec` is replaceable for tests. */
export async function signFile(file,{config=signingConfig(),exec=run,cache=CACHE}={}){
  if(!config)throw new Error('No signing certificate is configured.');
  const data=await readFile(file);
  if(hasSignature(data)){stats.skipped++;return 'skipped';}
  const key=createHash('sha256').update(data).update(identity(config)).digest('hex');
  const cached=path.join(cache,`${key}${path.extname(file).toLowerCase()}`);
  if(existsSync(cached)){
    await copyFile(cached,file);
    stats.cached++;
    return 'cached';
  }
  if(!existsSync(config.signtool))throw new Error(`signtool.exe was not found at ${config.signtool}. Set FRILOVERSE_SIGNTOOL.`);
  await exec(config.signtool,signArgs(config,file));
  // signtool exits 0 only when the signature was written, but make sure before keeping a copy.
  if(!hasSignature(await readFile(file)))throw new Error(`${file} has no signature after signtool ran.`);
  await mkdir(cache,{recursive:true});
  await copyFile(file,cached);
  stats.signed++;
  return 'signed';
}

/** The hook @electron/windows-sign calls for every file it wants signed. */
export default async function hook(file){
  const name=path.basename(file);
  const result=await signFile(file);
  if(result==='signed')console.log(`signed ${name}`);
}

export const hookModulePath=fileURLToPath(import.meta.url);

/** For build.mjs: the windowsSign option when a certificate is configured; otherwise a warning
 *  (or an error with FRILOVERSE_REQUIRE_SIGNING=1) and undefined. */
export function windowsSignOption(env=process.env){
  const config=signingConfig(env);
  if(config)return {hookModulePath};
  const message='No signing certificate is configured: this build is unsigned, and Smart App Control may block it on some PCs. See scripts/sign.mjs.';
  if(env.FRILOVERSE_REQUIRE_SIGNING==='1')throw new Error(message);
  console.warn(message);
  return undefined;
}

/** Runs `build(extraOptions)` (a createWindowsInstaller call) with Squirrel's signing going through
 *  the hook. Squirrel signs every program in the package with the signtool.exe of
 *  electron-winstaller's vendor folder, whatever its state, which would replace the cached
 *  signatures and change the Electron exe every release. So for the call that file is a small
 *  single-executable program (built by @electron/windows-sign 2.x, outside the nested 1.x copy
 *  electron-winstaller uses, which cannot spawn from a path with a space) that hands each file to
 *  the hook, and the original is put back afterwards, even after a failure or a killed build.
 *  Without a certificate it just runs `build({})`. */
export async function withSquirrelSigning(build){
  if(!signingConfig())return build({});
  const {createSeaSignTool}=await import('@electron/windows-sign');
  const vendor=path.join(root,'node_modules','electron-winstaller','vendor','signtool.exe');
  const backup=`${vendor}.friloverse-original`;
  // A build that was killed while the replacement was in place left the original in the backup.
  if(existsSync(backup)){await copyFile(backup,vendor);await rm(backup,{force:true});}
  const seaPath=path.join(root,'artifacts','sea-signtool','signtool.exe');
  await mkdir(path.dirname(seaPath),{recursive:true});
  await createSeaSignTool({path:seaPath,windowsSign:{hookModulePath}});
  await copyFile(vendor,backup);
  try{
    await copyFile(seaPath,vendor);
    // Only the last argument (the file) is read; /fd keeps electron-winstaller from adding a
    // certificate (and its password) to the command line.
    return await build({signWithParams:'/fd sha256'});
  }finally{
    await copyFile(backup,vendor);
    await rm(backup,{force:true});
  }
}

/** Signs a finished file (the complete setup) if a certificate is configured. */
export async function signIfConfigured(file){
  if(!signingConfig())return false;
  await stat(file);
  const result=await signFile(file);
  console.log(`${result==='skipped'?'already signed':result} ${path.basename(file)}`);
  return true;
}
