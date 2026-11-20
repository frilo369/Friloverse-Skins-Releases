// Publishes a finished build to frilo369/Friloverse-Skins-Releases, where installed copies
// look for app updates. Run it only after the owner's go-ahead.
//   node scripts/publish-release.mjs              look only: checks the build and GitHub, changes nothing
//   node scripts/publish-release.mjs --publish    creates the repo if missing, uploads, then reads the feed once
//   node scripts/publish-release.mjs --check-feed reads what installed copies are offered right now
// Only what in-app updates need goes up (owner's decision, 2026-11-08): RELEASES, the full .nupkg and
// the delta from the version before (see release-feed.mjs). The Complete Setup is handed out by hand.
// The v7.2.0 release must stay, and no later one may have a file with `-win32-x64` in its name or ending
// in `.exe`. Copies of 6.2 and older, the old Divinity names among them, ask update.electronjs.org, which
// offers the newest release with such a file (src/asset-platform.ts there). That is 7.2, the last version
// with the code that moves them across; it reads GitHub's feed, so it carries them on to the newest.
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {githubAsset,parseReleases} from './release-feed.mjs';

const REPO='frilo369/Friloverse-Skins-Releases',OWNER='frilo369',BRIDGE='v7.2.0';
const {version}=JSON.parse(await readFile('package.json','utf8'));
const shown=version.replace(/\.0$/,''),tag=`v${version}`,folder=path.join('dist',version,'setup');
const complete=path.join(folder,`Friloverse-${shown}-Complete-Setup.exe`);
const releases=path.join(folder,'RELEASES'),nupkg=path.join(folder,`friloverse-skins-${version}-full.nupkg`);
const delta=path.join(folder,`friloverse-skins-${version}-delta.nupkg`);
// What every copy of 6.3 or newer reads.
const latest=`https://github.com/${REPO}/releases/latest/download/RELEASES`;
// What copies of 6.2 and older read, asked as a very old version: it should stay on BRIDGE.
const feed=`https://update.electronjs.org/${REPO}/win32-x64/0.0.1/RELEASES`;

// The GH_TOKEN in the environment is a fine-grained token that GitHub refused to
// let create this repo. The owner's own gh login has the `repo` permission.
const {GH_TOKEN:_a,GITHUB_TOKEN:_b,...env}=process.env;
const gh=(...args)=>spawnSync('gh',args,{env,encoding:'utf8',windowsHide:true});
const exists=file=>stat(file).then(info=>info,()=>null);
async function sha1(file){const hash=createHash('sha1');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex').toUpperCase();}

async function readFeed(){
  // Its first line becomes an address with the tag in it.
  const old=await fetch(feed,{signal:AbortSignal.timeout(15000)}).catch(error=>({ok:false,status:error.message}));
  const oldOffered=old.ok?/releases\/download\/(v[^/]+)\//.exec((await old.text()).split(/\r?\n/)[0])?.[1]||'':'';
  // GitHub's newest release: its first line names the full package.
  const now=await fetch(latest,{signal:AbortSignal.timeout(15000)}).catch(error=>({ok:false,status:error.message}));
  const full=now.ok?parseReleases(await now.text()).find(row=>!row.delta):null;
  const newOffered=full?`v${full.version}`:'';
  return {ok:newOffered===tag&&oldOffered===BRIDGE,
    detail:`GitHub offers ${newOffered||`nothing (${now.status})`}; the old feed offers ${oldOffered||`nothing (${old.status})`} and should offer ${BRIDGE}`};
}

if(process.argv.includes('--check-feed')){
  const result=await readFeed();
  console.log(`${result.ok?'OK':'Not yet'}: ${result.detail} (this build is ${tag}).`);
  process.exit(result.ok?0:1);
}

const problems=[],notes=[];
// The owner's scheme: 1.5, 1.6 ... 1.9, 2.0, and 10.x ran to 10.12, and from 12.0 on x.0 to x.9 then the next major.
// The feed itself needs three numeric parts, the patch always 0.
if(!/^\d+\.\d+\.0$/.test(version))problems.push(`Version ${version} is not in the x.y.0 scheme (three numeric parts, patch 0).`);
for(const file of [releases,nupkg])if(!await exists(file))problems.push(`Missing ${file}. Run npm run build first.`);
if(!await exists(complete))notes.push(`No ${complete} yet: run npm run build:complete before handing a setup to anyone. Updates do not need it.`);
const hasDelta=!!await exists(delta);
if(await exists(releases)&&await exists(nupkg)){
  // First this version's full package by its bare name, then deltas by their GitHub address, this
  // version's matching its file.
  const [first,...rest]=parseReleases(await readFile(releases,'utf8'));
  if(!first||first.delta||first.file!==path.basename(nupkg))problems.push('RELEASES must start with this version\'s full package, by its name.');
  else{
    if(first.size!==(await stat(nupkg)).size)problems.push('RELEASES lists a different size for the full package.');
    if(first.sha!==await sha1(nupkg))problems.push('RELEASES lists a different hash for the full package: they are not from the same build.');
  }
  for(const row of rest){
    if(!row.delta||row.file!==githubAsset(row.version,row.name))problems.push(`RELEASES has a line that is not a delta by its GitHub address: ${row.file}`);
    else if(row.version===version){
      if(!hasDelta)problems.push(`RELEASES lists ${row.name}, which is missing.`);
      else if(row.size!==(await stat(delta)).size||row.sha!==await sha1(delta))problems.push('RELEASES lists a different size or hash for this version\'s delta.');
    }
  }
  if(hasDelta&&!rest.some(row=>row.version===version))problems.push('This version\'s delta is not in RELEASES.');
  if(!hasDelta)notes.push('No delta for this version: every copy downloads the full package.');
}
if(spawnSync('git',['status','--porcelain'],{encoding:'utf8'}).stdout.trim())notes.push('This folder has uncommitted changes: commit them so the release matches a commit.');

const login=gh('api','user','--jq','.login');
if(login.status!==0)problems.push('Not signed in to gh: run gh auth login.');
else if(login.stdout.trim()!==OWNER)problems.push(`gh is signed in as ${login.stdout.trim()}, not ${OWNER}.`);
const repoFound=login.status===0&&gh('repo','view',REPO,'--json','visibility,name').status===0;
if(repoFound){
  const visibility=gh('repo','view',REPO,'--json','visibility','--jq','.visibility').stdout.trim();
  if(visibility!=='PUBLIC')problems.push(`${REPO} is ${visibility}: the update service only reads public repos.`);
  if(gh('release','view',tag,'--repo',REPO,'--json','tagName').status===0)problems.push(`${tag} is already released. Every release needs a new version number.`);
  if(gh('release','view',BRIDGE,'--repo',REPO,'--json','tagName').status!==0)problems.push(`${BRIDGE} is missing: copies of 6.2 and older have no other way forward.`);
}

// What Squirrel needs, nothing more.
const files=[releases,nupkg,...(hasDelta?[delta]:[])];
console.log(`Friloverse ${shown}`);
console.log(repoFound?`Repo: ${REPO} exists.`:`Repo: ${REPO} does not exist yet; --publish creates it as public.`);
for(const file of files){const info=await exists(file);console.log(`  ${file}${info?` (${(info.size/1048576).toFixed(1)} MB)`:' MISSING'}`);}
for(const note of notes)console.log(`Note: ${note}`);
if(problems.length){for(const problem of problems)console.error(`Problem: ${problem}`);process.exit(1);}
if(!process.argv.includes('--publish')){console.log('All checks passed. Nothing was changed. Add --publish to release it.');process.exit(0);}

function must(step,result){
  if(result.status===0)return;
  console.error(`${step} failed:\n${result.stderr||result.stdout}`);
  process.exit(1);
}
if(!repoFound){
  // A release needs a commit to attach its tag to, so the repo starts with a README.
  must('Creating the repo',gh('repo','create',REPO,'--public','--add-readme','--description','Installers and app updates for Friloverse.'));
  console.log(`Created ${REPO}.`);
}
// gh uploads to a draft and publishes last, so the feed never sees a half-uploaded release.
must('Creating the release',gh('release','create',tag,...files,'--repo',REPO,'--title',`Friloverse ${shown}`,'--notes',`In-app update. Installed copies of Friloverse update themselves from this release.`));
console.log(`Released: https://github.com/${REPO}/releases/tag/${tag}`);
// One look, no waiting: installed copies check hourly anyway. --check-feed looks again.
await delay(5000);
const result=await readFeed();
console.log(result.ok?`Feed is live: ${result.detail}.`:`Uploaded. ${result.detail}. GitHub can take a moment (check with --check-feed).`);
