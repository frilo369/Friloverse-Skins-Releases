// The go-between for SignPath signing in GitHub Actions (.github/workflows/release.yml).
//
// SignPath signs a zip of files that a workflow uploads, not one file at a time, so the build never
// calls a signer. With FRILOVERSE_SIGN_EXTERNAL=1 (scripts/sign.mjs) it asks the signed-copy cache
// for each program and, for one that is not there, copies it to FRILOVERSE_SIGN_COLLECT under its
// cache key. The workflow signs that folder, and this script puts the signed files back:
//   node scripts/signpath.mjs import <folder>   signed files named <key>.exe/.dll/.node -> the cache
//   node scripts/signpath.mjs apply <file...>   replaces each file by its cached signed copy
// A signed copy that has no signature, or a name that is not a cache key, stops everything.
import {copyFile,mkdir,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CACHE,hasSignature,signFile,signingConfig} from './sign.mjs';

const KEYED=/^[0-9a-f]{64}\.(?:exe|dll|node)$/i;

async function listFiles(directory){
  const found=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())found.push(...await listFiles(file));
    else found.push(file);
  }
  return found;
}

/** Puts every signed file of a folder into the cache. Returns how many. */
export async function importSigned(directory,{cache=CACHE}={}){
  const files=await listFiles(directory);
  if(!files.length)throw new Error(`${directory} holds no signed files.`);
  // Check everything before keeping anything.
  for(const file of files){
    const name=path.basename(file);
    if(!KEYED.test(name))throw new Error(`${name} is not named like a file this build collected.`);
    if(!hasSignature(await readFile(file)))throw new Error(`${name} came back from signing without a signature.`);
  }
  await mkdir(cache,{recursive:true});
  for(const file of files)await copyFile(file,path.join(cache,path.basename(file).toLowerCase()));
  return files.length;
}

/** Replaces each file by its signed copy from the cache; a file with none fails. */
export async function applySigned(files,{config=signingConfig({FRILOVERSE_SIGN_EXTERNAL:'1'}),cache=CACHE}={}){
  for(const file of files){
    const result=await signFile(file,{config,cache});
    if(result==='collected')throw new Error(`${file} has no signed copy.`);
    console.log(`${result==='skipped'?'already signed':'signed copy put in'} ${path.basename(file)}`);
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,...args]=process.argv.slice(2);
  try{
    if(command==='import'&&args.length===1)console.log(`${await importSigned(args[0])} signed file(s) kept.`);
    else if(command==='apply'&&args.length)await applySigned(args);
    else{console.error('Usage: signpath.mjs import <folder> | apply <file...>');process.exit(2);}
  }catch(error){console.error(error.message);process.exit(1);}
}
