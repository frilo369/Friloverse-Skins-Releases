import {randomBytes} from 'node:crypto';
import {mkdir,open,rename,unlink} from 'node:fs/promises';
import path from 'node:path';

const BUSY=new Set(['EPERM','EACCES','EBUSY']);
const wait=ms=>new Promise(done=>setTimeout(done,ms));

/** Rename `from` onto `to`, retrying briefly when Windows AV/indexers hold a transient lock. */
export async function renameOver(from,to,{attempts=20,pause=wait}={}){
  for(let attempt=0;;attempt++){
    try{await rename(from,to);return;}
    catch(error){
      if(!BUSY.has(error?.code)||attempt+1>=attempts)throw error;
      await pause(Math.min(25*(attempt+1),250));
    }
  }
}

/**
 * Atomically write `data` (string or Buffer) to `file` via a sibling temp file, optional fsync
 * (`durable`), and AV-lock-tolerant rename. Never leaves a half-written state file behind.
 */
export async function writeAtomic(file,data,{durable=true,encoding='utf8'}={}){
  await mkdir(path.dirname(file),{recursive:true});
  const temp=`${file}.${randomBytes(8).toString('hex')}.tmp`;
  let handle=null;
  try{
    handle=await open(temp,'wx');
    if(Buffer.isBuffer(data))await handle.writeFile(data);
    else await handle.writeFile(String(data),encoding);
    if(durable)await handle.sync().catch(()=>{});
    await handle.close();handle=null;
    await renameOver(temp,file);
  }finally{
    if(handle)await handle.close().catch(()=>{});
    await unlink(temp).catch(()=>{});
  }
}
