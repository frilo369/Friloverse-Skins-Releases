// Delta updates (6.3): what goes into a release's RELEASES, shared by build.mjs, publish-release.mjs
// and verify-update.mjs.
//
// Squirrel builds a delta (only the files that changed) when the previous version's full package
// sits in the output folder as it packs the new one. The published RELEASES then lists:
//   1. this version's full package by its bare name, which is a file of the release Squirrel asked;
//   2. the deltas of the last few versions by their whole GitHub address, so a copy one or more
//      versions behind fetches only what changed since its version.
// Squirrel takes every delta newer than the copy when they add up to less than the full package,
// and checks each against its hash; a copy further behind than the deltas reach, or a delta that
// fails, gets the full package instead (Update.exe's own retry without deltas).
import {copyFile,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';

export const REPO='frilo369/Friloverse-Skins-Releases';
export const KEEP_DELTAS=5;
export const githubAsset=(version,name)=>`https://github.com/${REPO}/releases/download/v${version}/${name}`;

const parts=version=>String(version).split('.').map(Number);
export function compareVersions(a,b){
  const [x,y]=[parts(a),parts(b)];
  for(let i=0;i<3;i++)if((x[i]||0)!==(y[i]||0))return (x[i]||0)-(y[i]||0);
  return 0;
}

/**
 * A packager afterInitialize hook. The exe is stamped with Electron's version so it stays the same
 * file between releases, but the packager also writes that appVersion into the copied package.json,
 * which app.getVersion() and Squirrel's package name read: this puts the app's own version back.
 */
export const keepAppVersion=version=>async({buildPath})=>{
  const file=path.join(buildPath,'package.json');
  const pkg=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
  pkg.version=version;
  await writeFile(file,`${JSON.stringify(pkg,null,2)}\n`);
};

/** RELEASES lines: hash, the file (a name or an address), its size, and what the name says. */
export function parseReleases(text){
  return String(text||'').replace(/^\uFEFF/,'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{
    const [sha,file,size]=line.split(/\s+/);
    const name=decodeURIComponent(String(file||'').split(/[?#]/)[0].split('/').pop()||'');
    const found=/-(\d+\.\d+\.\d+)-(full|delta)\.nupkg$/i.exec(name);
    return {sha:String(sha||'').toUpperCase(),file,name,size:Number(size),version:found?.[1]||'',delta:found?.[2]?.toLowerCase()==='delta'};
  });
}

/** The newest earlier build in dist/ that has its RELEASES and full package, or null. */
export async function previousBuild(distRoot,version){
  const found=[];
  for(const entry of await readdir(distRoot,{withFileTypes:true}).catch(()=>[])){
    if(!entry.isDirectory()||!/^\d+\.\d+\.\d+$/.test(entry.name)||compareVersions(entry.name,version)>=0)continue;
    const setup=path.join(distRoot,entry.name,'setup');
    const full=parseReleases(await readFile(path.join(setup,'RELEASES'),'utf8').catch(()=>'')).find(row=>!row.delta&&row.version===entry.name);
    if(full&&await stat(path.join(setup,full.name)).catch(()=>null))found.push({version:entry.name,setup,full});
  }
  return found.sort((a,b)=>compareVersions(b.version,a.version))[0]||null;
}

/** Puts the previous full package where Squirrel looks for it, so packing makes a delta. */
export async function prepareDelta(setupDir,previous){
  if(!previous)return;
  await copyFile(path.join(previous.setup,previous.full.name),path.join(setupDir,previous.full.name));
  await writeFile(path.join(setupDir,'RELEASES'),`${previous.full.sha} ${previous.full.name} ${previous.full.size}`);
}

/**
 * After packing: writes the RELEASES to publish and removes the borrowed previous package.
 * Returns this version's full and delta entries.
 */
export async function finishReleases(setupDir,version,{previous=null,assetUrl=githubAsset,keep=KEEP_DELTAS}={}){
  const built=parseReleases(await readFile(path.join(setupDir,'RELEASES'),'utf8'));
  const full=built.find(row=>!row.delta&&row.version===version);
  if(!full)throw new Error(`Squirrel wrote no full package for ${version}.`);
  const delta=built.find(row=>row.delta&&row.version===version)||null;
  if(previous){
    await rm(path.join(setupDir,previous.full.name),{force:true});
    if(previous.full.name!==full.name&&!delta)throw new Error(`Squirrel made no delta from ${previous.version}.`);
  }
  // Earlier deltas come from the previous release's own published list.
  const earlier=previous?parseReleases(await readFile(path.join(previous.setup,'RELEASES'),'utf8')).filter(row=>row.delta&&row.version!==version):[];
  const deltas=[...earlier,...(delta?[{...delta,file:assetUrl(version,delta.name)}]:[])]
    .sort((a,b)=>compareVersions(a.version,b.version)).slice(-keep);
  const lines=[`${full.sha} ${full.name} ${full.size}`,...deltas.map(row=>`${row.sha} ${row.file} ${row.size}`)];
  await writeFile(path.join(setupDir,'RELEASES'),lines.join('\r\n'));
  return {full,delta};
}
