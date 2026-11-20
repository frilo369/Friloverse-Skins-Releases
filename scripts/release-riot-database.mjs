// Publishes what is on `main` of the Riot skin database as a GitHub release. Copies of 7.2 and
// newer follow the newest release, so an upload reaches nobody until this has been run.
//   node scripts/release-riot-database.mjs            look only: checks the upload, changes nothing
//   node scripts/release-riot-database.mjs --publish  the same checks, then the release (owner's go-ahead only)
// The check that matters: every form's file is in that commit with the contents the list says,
// which is what a half-finished upload fails. Forms are the only files the app downloads (7.3);
// an ordinary skin's row only needs to be in the list.
import {spawnSync} from 'node:child_process';
import {isFormSkin} from '../src/fryilo-catalog/catalog.mjs';
import {latestRelease,readRefs} from '../src/github-refs.mjs';
import {DATABASE_BRANCH,DATABASE_REPO,manifestSkins} from '../src/riot-skins-local.mjs';

const REPO=DATABASE_REPO,publish=process.argv.includes('--publish');
const stop=message=>{console.error(`Stopped: ${message}`);process.exit(1);};
const manifestAt=async revision=>{
  const response=await fetch(`https://raw.githubusercontent.com/${REPO}/${revision}/riot-skins-manifest.json`,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)stop(`the list could not be read at ${revision} (${response.status}).`);
  return response.json();
};

const current=await latestRelease(fetch,REPO),refs=await readRefs(fetch,REPO);
const revision=refs.get(`refs/heads/${DATABASE_BRANCH}`)||'',released=current?refs.get(`refs/tags/${current}`)||'':'';
if(!revision)stop(`${DATABASE_BRANCH} was not found on GitHub.`);
console.log(`${DATABASE_BRANCH}: ${revision}`);
console.log(`Newest release: ${current?`${current} (${released})`:`none yet, so copies follow ${DATABASE_BRANCH}`}`);
if(revision===released){console.log('That commit is already released. Nothing to do.');process.exit(0);}

const saved=await manifestAt(revision),skins=manifestSkins(saved);
const before=released?await manifestAt(released):null;
console.log(`The list: ${skins.length} skins, made ${saved.generatedAt||'at an unknown time'}${before?` (the release has ${before.skins?.length} from ${before.generatedAt})`:''}`);
if(skins.length!==saved.skins.length)stop(`${saved.skins.length-skins.length} rows of the list are damaged.`);

const answer=await fetch(`https://api.github.com/repos/${REPO}/git/trees/${revision}?recursive=1`,{headers:{'User-Agent':'Friloverse','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(120000)});
if(!answer.ok)stop(`GitHub would not list the files (${answer.status}).`);
const listing=await answer.json();
if(listing.truncated)stop('GitHub listed only part of the files, so the upload cannot be checked.');
const files=new Map(listing.tree.filter(entry=>entry.type==='blob').map(entry=>[entry.path,entry]));
const forms=skins.filter(isFormSkin);
const missing=forms.filter(skin=>!files.has(skin.relative));
const different=forms.filter(skin=>files.has(skin.relative)&&(files.get(skin.relative).sha!==skin.sha||files.get(skin.relative).size!==skin.size));
for(const skin of [...missing,...different].slice(0,10))console.log(`  ${files.has(skin.relative)?'different':'missing'}: ${skin.relative}`);
if(missing.length||different.length)stop(`the upload is not finished: ${missing.length} form files missing, ${different.length} different from the list.`);
if(!forms.length)stop('the list names no forms, which cannot be right.');
console.log(`All ${forms.length} form files are there with the contents the list says.`);

if(!publish){console.log('Looked only: nothing was changed. --publish makes the release.');process.exit(0);}
// The environment's GH_TOKEN is a fine-grained token; the owner's own gh login is what publishes.
const {GH_TOKEN:_a,GITHUB_TOKEN:_b,...env}=process.env;
const date=new Date().toISOString().slice(0,10),tag=`list-${date}-${revision.slice(0,7)}`;
const made=spawnSync('gh',['release','create',tag,'--repo',REPO,'--target',revision,'--latest','--title',`Riot skin list ${date}`,'--notes',`${skins.length} skins, list made ${saved.generatedAt||'at an unknown time'}.`],{env,encoding:'utf8',windowsHide:true});
if(made.status!==0)stop(`GitHub refused the release: ${made.stderr||made.error?.message}`);
console.log(`Released ${tag}. Copies of 7.2 and newer pick it up at their next check.`);
