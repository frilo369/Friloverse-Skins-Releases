import {packager} from '@electron/packager';
import {mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {finishReleases,keepAppVersion,prepareDelta,previousBuild} from './release-feed.mjs';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import installer from 'electron-winstaller';
import {windowsSignOption,withSquirrelSigning} from './sign.mjs';
// Smart App Control blocks unsigned programs, so everything is signed when a certificate is
// configured (scripts/sign.mjs); otherwise the build says so and goes on unsigned.
const windowsSign=windowsSignOption();
const {version}=JSON.parse(await readFile('package.json','utf8'));
const {version:electronVersion}=JSON.parse(await readFile('node_modules/electron/package.json','utf8'));
const shown=version.replace(/\.0$/,'');
// The packager skips an output folder that already exists. Reusing one would put the
// previous code into this setup under the same version, so every build gets a new number.
const packaged=`dist/${version}/Friloverse-Skins-win32-x64`;
if(existsSync(packaged))throw new Error(`${packaged} already exists, so this build would ship older code. Every build goes up 0.1 (2.8 -> 2.9): set the next version in package.json first.`);
const paths=await packager({dir:'.',name:'Friloverse-Skins',platform:'win32',arch:'x64',out:`dist/${version}`,
  // The exe carries Electron's version, not Friloverse's (6.3): stamped with the app version it
  // changed every release, and Squirrel puts a changed 238 MB exe whole into the delta. This way it
  // stays the same file until Electron itself is upgraded. Friloverse's version is package.json's,
  // which keepAppVersion puts back after the packager writes appVersion into it.
  overwrite:false,prune:true,asar:false,appVersion:electronVersion,buildVersion:electronVersion,
  afterInitialize:[keepAppVersion(version)],
  icon:'src/ui/friloverse.ico',
  // Friloverse's UI is English. Chromium falls back to en-US for other system
  // languages, so the other 54 locale packs (~48 MB) are not shipped.
  afterExtract:[async({buildPath})=>{
    const locales=path.join(buildPath,'locales');
    for(const file of await readdir(locales))if(file!=='en-US.pak')await rm(path.join(locales,file));
  }],
  ignore:[/^\/(?:AGENTS|CLAUDE|CODEX-HANDOFF)\.md$/,/^\/\.gitignore$/,/^\/\.claude(?:\/|$)/,/^\/\.wrangler(?:\/|$)/,/\.log$/i,/^\/dist(?:\/|$)/,/^\/artifacts(?:\/|$)/,/^\/tests(?:\/|$)/,/^\/scripts(?:\/|$)/,/^\/tools(?:\/|$)/,/^\/\.git(?:\/|$)/,/^\/logs-worker(?:\/|$)/,/^\/watch-logs(?:\/|$)/,/^\/logs-reports(?:\/|$)/,/^\/native\/ltf\/.*\.cpp$/],
  win32metadata:{CompanyName:'FrYiLo',FileDescription:'Friloverse champion-select companion',ProductName:'Friloverse'},
  ...(windowsSign?{windowsSign}:{})});
// A clean PC may not have the Visual C++ Redistributable: nothing shipped may need it.
async function assertNoRuntimeNeeded(directory){
  for(const item of await readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,item.name);
    if(item.isDirectory())await assertNoRuntimeNeeded(file);
    else if(/\.(?:exe|dll|node)$/i.test(item.name)&&/VCRUNTIME140|MSVCP140/i.test((await readFile(file)).toString('latin1')))throw new Error(`${file} needs the Visual C++ Runtime, which a clean PC may not have.`);
  }
}
for(const directory of paths){
  await assertNoRuntimeNeeded(directory);
  const shipped=JSON.parse(await readFile(path.join(directory,'resources','app','package.json'),'utf8')).version;
  if(shipped!==version)throw new Error(`The packaged app says it is ${shipped}, not ${version}.`);
  console.log(`${directory}/Friloverse-Skins.exe`);
  const outputDirectory=`dist/${version}/setup`;
  // A delta from the newest earlier build in dist/ (6.3): see release-feed.mjs.
  const previous=await previousBuild('dist',version);
  await mkdir(outputDirectory,{recursive:true});
  await prepareDelta(outputDirectory,previous);
  if(!previous)console.warn('No earlier build in dist/: this release has no delta, so every copy downloads the full package.');
  // Squirrel signs Update.exe and the plain setup (and, by itself, every program again, which
  // withSquirrelSigning keeps from changing the files the packager signed).
  await withSquirrelSigning(signing=>installer.createWindowsInstaller({appDirectory:directory,outputDirectory,authors:'FrYiLo',title:'Friloverse',exe:'Friloverse-Skins.exe',setupExe:`Friloverse-${shown}-Setup.exe`,setupIcon:'src/ui/friloverse.ico',loadingGif:'scripts/installing.gif',noMsi:true,...signing}));
  const {full,delta}=await finishReleases(outputDirectory,version,{previous});
  console.log(`Update packages: full ${(full.size/1048576).toFixed(1)} MB${delta?`, delta from ${previous.version} ${(delta.size/1048576).toFixed(1)} MB`:''}.`);
}
// The setup anyone gets is always the full one (owner's rule), so every build makes it.
const complete=spawnSync(process.execPath,['scripts/build-complete.mjs'],{stdio:'inherit'});
if(complete.status!==0)throw new Error('The complete setup could not be built.');
