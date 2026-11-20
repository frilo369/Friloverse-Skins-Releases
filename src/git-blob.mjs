import {createHash} from 'node:crypto';
import {lstat,open} from 'node:fs/promises';

/**
 * Feeds a file to a hash in pieces, so a large package is never all in memory at once, through
 * a handle closed before this returns: a read stream closes a moment after its last piece, and
 * Windows refuses to rename over a file that is still open (10.5).
 */
async function feed(file,hash){
  const handle=await open(file,'r'),buffer=Buffer.allocUnsafe(1<<20);
  try{for(let read;(read=(await handle.read(buffer,0,buffer.length,null)).bytesRead)>0;)hash.update(buffer.subarray(0,read));}
  finally{await handle.close();}
  return hash;
}

/** A file's hash. */
export async function fileHash(file,algorithm){
  return (await feed(file,createHash(algorithm))).digest('hex');
}

/** Git's blob object hash for a local package, used as the stable skin identity. */
export async function gitBlobHash(file,size){
  const before=await lstat(file);
  if(!before.isFile()||before.isSymbolicLink()||before.size!==size)throw new Error('A local package changed while being checked.');
  const hash=createHash('sha1');hash.update(`blob ${size}\0`);
  await feed(file,hash);
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size!==size||info.mtimeMs!==before.mtimeMs)throw new Error('A local package changed while being checked.');
  return hash.digest('hex');
}
