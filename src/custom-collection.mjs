import {createHash,randomBytes} from 'node:crypto';
import {link,mkdir,open,readFile,readdir,rename,stat,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {gitBlobHash} from './git-blob.mjs';
import {isRateLimitResponse,limitedError,readRefs} from './github-refs.mjs';
import {COLLECTIONS} from './withdrawn-skins.mjs';

// The shared custom collections on GitHub. A new PC gets every skin and mod they hold, and
// a skin added or reworked later reaches every player at the next check, with only that
// file downloaded. What one delivered is remembered by its contents, so a skin the player
// deleted is never brought back, a file the player already has (under any name) is never
// downloaded again, and only a file this app delivered is ever replaced.
const BRANCH='main',RECORD='custom-collection.json',LISTS='custom-collection-lists.json',MAX_FILE=512*1024*1024,PARALLEL=3;
const HEADERS={'User-Agent':'Friloverse','Accept':'application/vnd.github+json'};
const PICTURE=/\.(?:webp|jpe?g|png)$/i;
const BAD_NAME=/[<>:"/\\|?*\u0000-\u001f]|[. ]$|^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;
const TEMP=()=>`.friloverse-${randomBytes(8).toString('hex')}.tmp`;
// Windows refuses a rename over a file something has open for a moment (an antivirus scan of
// a file just written, the search indexer): a few short tries, then the error stands (10.5).
async function renameOver(from,to){
  for(let attempt=0;;attempt++){
    try{return await rename(from,to);}
    catch(error){if(attempt>=20||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
}
const rawUrl=(repository,revision,relative)=>`https://raw.githubusercontent.com/${repository}/${revision}/${relative.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Where a collection file goes: `Custom Skins/<Champion>/<name>.fantome` below the custom
 * skins folder, `Custom Mods/<name>.fantome` below the mods folder. Anything else is left out.
 */
export function collectionTarget(repositoryPath){
  const parts=String(repositoryPath).split('/');
  if(!/\.fantome$/i.test(parts.at(-1)||'')||parts.some(part=>!part||part==='.'||part==='..'||BAD_NAME.test(part)))return null;
  const top=parts[0].toLowerCase();
  if(top==='custom skins'&&parts.length>=3&&parts.length<=6)return {kind:'skins',relative:parts.slice(1).join('/')};
  if(top==='custom mods'&&parts.length>=2&&parts.length<=5)return {kind:'mods',relative:parts.slice(1).join('/')};
  return null;
}

/** One repository's tree: its packages and the picture beside each, by contents. */
export function readTree(repository,revision,tree){
  const files=[],pictures=new Map(),artwork={};
  for(const entry of Array.isArray(tree)?tree:[]){
    if(entry?.type!=='blob'||typeof entry.path!=='string')continue;
    if(PICTURE.test(entry.path)){pictures.set(entry.path.replace(PICTURE,'').toLowerCase(),entry.path);continue;}
    const target=collectionTarget(entry.path),sha=String(entry.sha||'').toLowerCase();
    if(!target||!/^[0-9a-f]{40}$/.test(sha)||!Number.isSafeInteger(entry.size)||entry.size<1||entry.size>MAX_FILE)continue;
    files.push({...target,repository,revision,repositoryPath:entry.path,sha,size:entry.size});
  }
  for(const file of files){
    const picture=pictures.get(file.repositoryPath.replace(/\.fantome$/i,'').toLowerCase());
    if(picture&&file.kind==='skins')artwork[file.sha]=rawUrl(repository,revision,picture);
  }
  return {files,artwork};
}

async function github(fetchFn,url){
  const response=await fetchFn(url,{headers:HEADERS,signal:AbortSignal.timeout(30000)});
  if(response.status===403||response.status===429)throw limitedError(response);
  if(!response.ok)throw new Error(`GitHub answered ${response.status}`);
  return response.json();
}

/** Each collection's newest commit: two small requests that cost none of GitHub's API limit (7.2). */
export async function collectionHeads({fetchFn=fetch,repositories=COLLECTIONS,onStep=()=>{}}={}){
  const heads={};
  for(const repository of repositories){
    const revision=(await readRefs(fetchFn,repository)).get(`refs/heads/${BRANCH}`)||'';
    if(!/^[0-9a-f]{40}$/.test(revision))throw new Error('GitHub returned an invalid revision');
    heads[repository]={revision};onStep();
  }
  return heads;
}

async function readLists(file){
  try{
    const saved=JSON.parse(await readFile(file,'utf8'));
    return saved?.version===1&&saved.lists&&typeof saved.lists==='object'?saved.lists:{};
  }catch{return {};}
}

/** Every package the collections hold, the first collection winning a shared path. */
export async function readCollection({fetchFn=fetch,heads,repositories=COLLECTIONS,onStep=()=>{},listsFile=null}){
  const files=new Map(),artwork={},lists=await readLists(listsFile);
  for(const repository of repositories){
    const {revision}=heads[repository];
    // A commit's list never changes, so it is asked for once, and an interrupted sync that
    // tries again every hour does not spend GitHub's API limit doing so.
    if(lists[repository]?.revision!==revision){
      const listing=await github(fetchFn,`https://api.github.com/repos/${repository}/git/trees/${revision}?recursive=1`);
      if(listing?.truncated)throw new Error('the collection is too large for GitHub to list in one piece');
      lists[repository]={revision,tree:(Array.isArray(listing?.tree)?listing.tree:[]).filter(entry=>entry?.type==='blob').map(({type,path:entryPath,sha,size})=>({type,path:entryPath,sha,size}))};
      if(listsFile)await writeAtomic(listsFile,{version:1,lists}).catch(()=>{});
    }
    const read=readTree(repository,revision,lists[repository].tree);
    for(const file of read.files){
      const key=`${file.kind}/${file.relative.toLowerCase()}`;
      if(!files.has(key))files.set(key,file);
    }
    for(const [sha,url] of Object.entries(read.artwork))artwork[sha]??=url;
    onStep();
  }
  return {files:[...files.values()],artwork};
}

/** The packages already here, by path and by size, so only a file of a listed size is hashed. */
async function localPackages(root){
  const paths=new Map(),bySize=new Map();
  const walk=async(dir,depth)=>{
    if(depth>6)return;
    let entries;
    try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}
    for(const entry of entries){
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory()){await walk(file,depth+1);continue;}
      if(!entry.isFile())continue;
      // A download a closed Friloverse left behind: the next one starts it again.
      if(/^\.friloverse-[a-f0-9]+\.tmp$/i.test(entry.name)){await unlink(file).catch(()=>{});continue;}
      if(!/\.fantome$/i.test(entry.name))continue;
      try{
        const {size}=await stat(file),list=bySize.get(size)||[];
        paths.set(path.relative(root,file).split(path.sep).join('/').toLowerCase(),{file,size});
        list.push(file);bySize.set(size,list);
      }catch{}
    }
  };
  await walk(root,0);
  return {paths,bySize};
}

const recordKey=file=>`${file.kind}/${file.relative.toLowerCase()}`;
const matches=async(candidate,file,hash)=>{try{return await hash(candidate,file.size)===file.sha;}catch{return false;}};

/**
 * Whether one listed file has to come down: null if not, else `{replace}`, which is true only
 * when the file at its path is an older version this app delivered. A file with contents
 * this app never delivered is the player's own and stays, whatever the collection holds.
 */
async function planFile(file,local,record,{hash,restore}){
  const key=recordKey(file),here=local.paths.get(file.relative.toLowerCase());
  const known=()=>{record.paths[key]=file.sha;record.delivered.add(file.sha);return null;};
  if(here){
    if(here.size===file.size&&(record.paths[key]===file.sha||await matches(here.file,file,hash)))return known();
    let current;
    try{current=await hash(here.file,here.size);}catch{return null;}
    return record.delivered.has(current)?{replace:true}:null;
  }
  // Nothing at its path: either the player deleted it, a rework included, or it is new here.
  if(!restore&&(record.delivered.has(file.sha)||record.paths[key]))return null;
  for(const candidate of local.bySize.get(file.size)||[])if(await matches(candidate,file,hash))return known();
  return {replace:false};
}

async function readRecord(file){
  try{
    const saved=JSON.parse(await readFile(file,'utf8'));
    if(saved?.version===1||saved?.version===2)return {
      heads:saved.heads&&typeof saved.heads==='object'?saved.heads:{},
      // A version 1 record never looked at reworks, so one full look follows the update to 7.0.
      complete:saved.version===2&&saved.complete===true,
      delivered:new Set((Array.isArray(saved.delivered)?saved.delivered:[]).filter(sha=>/^[0-9a-f]{40}$/.test(sha))),
      paths:saved.paths&&typeof saved.paths==='object'?Object.fromEntries(Object.entries(saved.paths).filter(([,sha])=>/^[0-9a-f]{40}$/.test(sha))):{},
    };
  }catch{}
  return {heads:{},complete:false,delivered:new Set(),paths:{}};
}
async function writeAtomic(file,value){
  await mkdir(path.dirname(file),{recursive:true});
  const temp=`${file}.${randomBytes(8).toString('hex')}.tmp`;
  try{await writeFile(temp,JSON.stringify(value),{encoding:'utf8',flag:'wx'});await rename(temp,file);}
  finally{await unlink(temp).catch(()=>{});}
}
const saveRecord=(file,record)=>writeAtomic(file,{version:2,heads:record.heads,complete:record.complete,delivered:[...record.delivered].sort(),paths:record.paths});

/**
 * One package, written beside where it goes and named only once it is exactly the file
 * GitHub lists. A file that appeared at that name meanwhile is kept and the download dropped,
 * unless `replace` says it is an older version of this one.
 */
const DOWNLOAD_ATTEMPTS=3,PLAN_WORKERS=6;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));

export async function downloadPackage(file,destination,{fetchFn=fetch,onBytes=()=>{},replace=false,attempts=DOWNLOAD_ATTEMPTS,pause=sleep}={}){
  await mkdir(path.dirname(destination),{recursive:true});
  for(let attempt=1;;attempt++){
    const temp=path.join(path.dirname(destination),TEMP());
    let counted=0;
    try{
      const response=await fetchFn(rawUrl(file.repository,file.revision,file.repositoryPath),{headers:{'User-Agent':'Friloverse'},signal:AbortSignal.timeout(20*60*1000)});
      if(isRateLimitResponse(response))throw limitedError(response);
      if(!response.ok)throw Object.assign(new Error(`GitHub answered ${response.status}`),{status:response.status});
      const hash=createHash('sha1').update(`blob ${file.size}\0`),out=await open(temp,'wx');
      let bytes=0,head=Buffer.alloc(0);
      try{
        for await(const piece of response.body){
          const chunk=Buffer.from(piece);
          bytes+=chunk.length;
          if(bytes>file.size)throw new Error('it is larger than the collection lists');
          if(head.length<2)head=Buffer.concat([head,chunk.subarray(0,2)]);
          hash.update(chunk);await out.write(chunk);counted+=chunk.length;onBytes(chunk.length);
        }
      }finally{await out.close();}
      if(bytes!==file.size||hash.digest('hex')!==file.sha)throw new Error('it did not download completely');
      // A Fantome is a zip. Anything else (a Git LFS pointer, say) is no skin.
      if(head.toString('latin1')!=='PK')return 'not a skin package';
      // `replace` may ask, right before the swap, whether the file there is still the old
      // version: the player can put a copy of their own there while the download runs.
      if(replace){
        if(typeof replace==='function'&&!await replace())return 'a file the player put there meanwhile is kept';
        await renameOver(temp,destination);return '';
      }
      try{await link(temp,destination);}
      catch(error){if(error.code==='EEXIST')return 'a file with its name is already there';throw error;}
      return '';
    }catch(error){
      if(counted)onBytes(-counted);
      const nonRetryable=error?.limited||error?.status===403||error?.status===404||error?.status===429;
      if(nonRetryable||attempt>=attempts)throw error;
      await pause(500*attempt);
    }finally{await unlink(temp).catch(()=>{});}
  }
}

/**
 * Brings what the collections hold and this PC was never given into the custom folders,
 * and replaces a package the collection has reworked. Nothing unchanged is downloaded.
 * `canContinue` is asked before each file: a match or a game stops it, and the next check
 * carries on. Returns what happened; a failed file is tried again at the next check.
 */
export async function syncCollection({skinsRoot,modsRoot,databaseRoot,fetchFn=fetch,hash=gitBlobHash,withdrawn=[],
  canContinue=async()=>true,onStatus=()=>{},onArtwork=async()=>{},repositories=COLLECTIONS,restore=false}){
  const recordFile=path.join(databaseRoot,RECORD),record=await readRecord(recordFile);
  // Each collection's commit, then its list: steps the strip counts, never a bar stuck at 0 (6.3).
  const steps=repositories.length*2;let step=0;
  const stepDone=()=>onStatus({phase:'checking',step:++step,steps});
  onStatus({phase:'checking',step:0,steps});
  const heads=await collectionHeads({fetchFn,repositories,onStep:stepDone});
  // `restore` is the player pressing Check databases: anything missing comes back, even a
  // skin they deleted. The automatic checks only bring what this PC never had.
  const unchanged=!restore&&record.complete&&repositories.every(repository=>record.heads[repository]?.revision===heads[repository].revision);
  if(unchanged)return {added:[],updated:[],skipped:[],failed:[],artwork:null,complete:true,offered:null};
  const {files,artwork}=await readCollection({fetchFn,heads,repositories,onStep:stepDone,listsFile:path.join(databaseRoot,LISTS)});
  // Pictures first, so each skin has its card's art the moment it lands.
  await onArtwork(artwork);
  const blocked=new Set(withdrawn.map(row=>`${row.sha}:${row.size}`));
  const roots={skins:skinsRoot,mods:modsRoot},local={skins:await localPackages(skinsRoot),mods:await localPackages(modsRoot)};
  const wanted=[];
  const candidates=files.filter(file=>!blocked.has(`${file.sha}:${file.size}`));
  let planIndex=0;
  const planWorker=async()=>{
    while(planIndex<candidates.length){
      const file=candidates[planIndex++];
      const plan=await planFile(file,local[file.kind],record,{hash,restore});
      if(plan)wanted.push({...file,...plan});
    }
  };
  await Promise.all(Array.from({length:Math.min(PLAN_WORKERS,candidates.length||1)},planWorker));
  // Skins before mods, smallest first: the most skins show up soonest.
  wanted.sort((a,b)=>(a.kind===b.kind?0:a.kind==='skins'?-1:1)||a.size-b.size);
  const added=[],updated=[],skipped=[],failed=[],total=wanted.reduce((sum,file)=>sum+file.size,0);
  let doneBytes=0,doneFiles=0,stopped=false,limited=null,next=0,saving=Promise.resolve();
  // Parallel downloads take turns: Windows refuses two renames onto one file at once.
  const save=()=>(saving=saving.catch(()=>{}).then(()=>saveRecord(recordFile,record)));
  const report=()=>onStatus({phase:'downloading',files:doneFiles,count:wanted.length,bytes:doneBytes,total});
  if(wanted.length)report();
  const worker=async()=>{
    while(!stopped&&!limited&&next<wanted.length){
      if(!await canContinue()){stopped=true;break;}
      const file=wanted[next++],destination=path.join(roots[file.kind],...file.relative.split('/'));
      let counted=0;
      try{
        // Still an older version this app delivered? Gone (the player deleted it) counts as no.
        const stillOld=async()=>{try{return record.delivered.has(await hash(destination,(await stat(destination)).size));}catch{return false;}};
        const problem=await downloadPackage(file,destination,{fetchFn,replace:file.replace&&stillOld,onBytes:bytes=>{counted+=bytes;doneBytes+=bytes;report();}});
        if(problem)skipped.push({file:file.repositoryPath,problem});
        else{(file.replace?updated:added).push(file);record.paths[recordKey(file)]=file.sha;record.delivered.add(file.sha);}
        await save().catch(()=>{});
      }catch(error){
        doneBytes-=counted;
        failed.push({file:file.repositoryPath,problem:error.message});
        // Every other file would be refused too, and each refusal counts against this network.
        if(error.limited)limited=error;
      }
      doneFiles++;report();
    }
  };
  await Promise.all(Array.from({length:Math.min(PARALLEL,wanted.length)},worker));
  const finished=!stopped&&!failed.length;
  // A package left out was not delivered: the next hourly check looks at it again. It is no
  // reason for the 5-minute retry, which is for downloads that broke off.
  record.complete=finished&&!skipped.length;
  record.heads=record.complete?heads:record.heads;
  await save();
  return {added,updated,skipped,failed,artwork,complete:finished,stopped,offered:files.length,...(limited?{limited}:{})};
}

/** The pictures the collections hold, added to what the app already knows. */
export async function saveArtwork(databaseRoot,artwork){
  const file=path.join(databaseRoot,'custom-artwork.json');
  let saved={};
  try{const value=JSON.parse(await readFile(file,'utf8'));if(value?.version===1&&value.artwork)saved=value.artwork;}catch{}
  const merged={...saved,...artwork};
  if(Object.keys(merged).length!==Object.keys(saved).length||Object.entries(artwork).some(([sha,url])=>saved[sha]!==url))await writeAtomic(file,{version:1,artwork:merged});
  return merged;
}
