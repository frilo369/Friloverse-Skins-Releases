// How far an app update's download is (6.0). Squirrel reports nothing while it downloads, so this
// reads the packages' sizes from the feed's RELEASES and watches the files grow in Squirrel's
// `packages` folder, where they are written as they arrive. Unknown stays unknown: the strip then
// shows a moving bar instead of a made-up number.
import {readdir,stat} from 'node:fs/promises';
import path from 'node:path';

const parts=version=>String(version).split('.').map(Number);
const newer=(a,b)=>{const [x,y]=[parts(a),parts(b)];for(let i=0;i<3;i++)if((x[i]||0)!==(y[i]||0))return (x[i]||0)>(y[i]||0);return false;};

/**
 * Every package a RELEASES file lists: file name, size, version, and whether it is a delta. A line
 * can name its package by its whole download address (`https://github.com/.../x-6.2.0-full.nupkg`),
 * and Squirrel saves it under the last part of that address; up to 6.2 the address was taken as the
 * file name, so the bar never moved.
 */
export function releaseEntries(text){
  const rows=[];
  for(const line of String(text||'').replace(/^\uFEFF/,'').split(/\r?\n/)){
    const found=/^[0-9A-F]{40}\s+(\S+)\s+(\d+)\s*$/i.exec(line.trim());
    if(!found)continue;
    let name=found[1].split(/[?#]/)[0].split('/').pop()||'';
    try{name=decodeURIComponent(name);}catch{}
    if(!/\.nupkg$/i.test(name)||/[\\/]/.test(name))continue;
    const kind=/-(\d+\.\d+\.\d+)-(full|delta)\.nupkg$/i.exec(name);
    rows.push({name,size:Number(found[2]),version:kind?.[1]||'',delta:kind?.[2]?.toLowerCase()==='delta'});
  }
  return rows;
}
/** The full package a RELEASES file lists. */
export function releaseEntry(text){
  const rows=releaseEntries(text);
  const row=rows.find(item=>!item.delta&&/-full\.nupkg$/i.test(item.name))||rows[0];
  return row?{name:row.name,size:row.size}:null;
}
/**
 * What Squirrel will download for a copy of `version` (its own rule): every newer delta when they
 * add up to less than the newest full package, otherwise that full package.
 */
export function expectedDownloads(rows,version){
  const ahead=rows.filter(row=>row.version&&(!version||newer(row.version,version)));
  const full=ahead.filter(row=>!row.delta).sort((a,b)=>newer(a.version,b.version)?-1:1)[0]||(!version?rows.find(row=>!row.delta):null);
  const deltas=ahead.filter(row=>row.delta),sum=deltas.reduce((total,row)=>total+row.size,0);
  if(full&&sum>0&&sum<full.size)return deltas;
  return full?[full]:[];
}

export function watchUpdateDownload({feed,version='',packagesDir,onProgress,fetchFn=fetch,every=500,setTimer=setInterval,clearTimer=clearInterval,now=Date.now}){
  let timer=null,stopped=false;
  const startedAt=now();
  void (async()=>{
    let wanted=[];
    try{
      const response=await fetchFn(`${feed.replace(/\/$/,'')}/RELEASES`,{signal:AbortSignal.timeout(15000)});
      if(response.ok)wanted=expectedDownloads(releaseEntries(await response.text()),version);
    }catch{/* No size: the bar keeps moving instead. */}
    if(stopped||!wanted.length)return;
    const total=wanted.reduce((sum,row)=>sum+row.size,0);
    // Should Squirrel ever name a full package otherwise, the package it started writing since the watch began.
    const growing=async()=>{
      let best=null;
      for(const name of await readdir(packagesDir).catch(()=>[])){
        if(!/\.nupkg$/i.test(name))continue;
        const info=await stat(path.join(packagesDir,name)).catch(()=>null);
        if(info&&info.mtimeMs>=startedAt-5000&&(!best||info.mtimeMs>best.mtimeMs))best=info;
      }
      return best;
    };
    const look=async()=>{
      let bytes=0;
      for(const row of wanted){
        const found=await stat(path.join(packagesDir,row.name)).catch(()=>null);
        // A finished file left by an earlier attempt is not this download's progress (7.1).
        const named=found&&found.mtimeMs>=startedAt-5000?found:null;
        const info=named||(wanted.length===1&&!row.delta?await growing():null);
        bytes+=Math.min(info?.size||0,row.size);
      }
      if(!stopped)onProgress({bytes,total});
    };
    await look();
    if(!stopped)timer=setTimer(()=>{void look();},every);
  })();
  return ()=>{stopped=true;if(timer)clearTimer(timer);};
}
