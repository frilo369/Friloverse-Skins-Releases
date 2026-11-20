// Settings' Send logs (6.0): Friloverse's and LTK Manager's logs from the player's last 3 games,
// zipped and sent to the owner's `friloverse-logs` Worker (logs-worker/), which keeps them in a
// private Cloudflare R2 bucket for 90 days. The player gets a short code to tell the owner.
import {readFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

export const LOG_SERVICE='https://friloverse-logs.ogfryilo.workers.dev/reports';
// A little before the first game's draft, so what led up to it is there too.
const LEAD=2*60*1000;
// With no game in hold.log yet, the last day.
const FALLBACK=24*60*60*1000;
// Per file, the newest part: the Worker takes at most 8 MB, and logs shrink about ten times.
const FILE_LIMIT=12*1024*1024;
const STAMP=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;
// A draft that reached a game: the guard froze it, or Windows refused the freeze.
const GAME=/guard: suspended|guard could not freeze|guard: blocked/;

const timeOf=line=>{const found=STAMP.exec(line);return found?Date.parse(found[1]):NaN;};

/** When the last `games` games began, from hold.log: the draft (guard started) before each one. */
export function gamesStart(holdText,{games=3,now=Date.now()}={}){
  const lines=String(holdText||'').split(/\r?\n/);
  let draft=NaN,starts=[];
  for(const line of lines){
    if(/ guard started$/.test(line))draft=timeOf(line);
    else if(GAME.test(line)&&Number.isFinite(draft)){starts.push(draft);draft=NaN;}
  }
  if(!starts.length)return now-FALLBACK;
  return starts.slice(-games)[0]-LEAD;
}

/** The lines written since `start`. A line with no time of its own (a stack trace) goes with the one before. */
export function linesSince(text,start){
  const kept=[];let keep=false;
  for(const line of String(text||'').split(/\r?\n/)){
    const time=timeOf(line);
    if(Number.isFinite(time))keep=time>=start;
    if(keep&&line)kept.push(line);
  }
  return kept.join('\n')+(kept.length?'\n':'');
}

/** A zip of deflated files, which Windows opens by itself. */
export function zipFiles(files){
  const locals=[],central=[];let offset=0;
  const stamp=dosTime(new Date());
  for(const {name,bytes:raw} of files){
    const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(String(raw),'utf8');
    const packed=zlib.deflateRawSync(bytes,{level:9}),title=Buffer.from(name,'utf8'),crc=zlib.crc32(bytes);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(8,8);
    local.writeUInt16LE(stamp.time,10);local.writeUInt16LE(stamp.date,12);
    local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(title.length,26);
    const record=Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x0800,8);record.writeUInt16LE(8,10);
    record.writeUInt16LE(stamp.time,12);record.writeUInt16LE(stamp.date,14);
    record.writeUInt32LE(crc,16);record.writeUInt32LE(packed.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(title.length,28);
    record.writeUInt32LE(offset,42);
    locals.push(local,title,packed);central.push(record,title);
    offset+=local.length+title.length+packed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
function dosTime(date){
  return {time:(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1),
    date:((date.getFullYear()-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate()};
}

const readText=file=>readFile(file,'utf8').catch(()=>'');
const tail=text=>text.length>FILE_LIMIT?text.slice(-FILE_LIMIT):text;
// File paths name the player's Windows account, and logs/URLs can carry auth/reconnect tokens
// or Windows SIDs. Scrub them thoroughly before any report leaves the PC.
export function sanitizeReportText(text){
  return String(text)
    .replace(/([A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))[^\\\/"'\r\n<>|:*?]+/gi,'$1<user>')
    .replace(/(--(?:remoting-auth-token|riotclient-auth-token|auth-token)=)(?:"[^"]*"|[^\s]+)/gi,'$1<redacted>')
    .replace(/(authorization\s*[:=]\s*(?:basic|bearer)\s+)[A-Za-z0-9+/=_\-.]+/gi,'$1<redacted>')
    .replace(/([?&](?:reconnect|token|auth)=)[A-Za-z0-9._-]+/gi,'$1<redacted>')
    .replace(/(["']?(?:password|token|access_token|refresh_token|auth_token|api_key|apiToken|reconnectToken|puuid)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,'$1<redacted>')
    .replace(/\bS-1-5-21-(?:\d+-){2,3}\d+\b/gi,'<redacted-sid>');
}

/**
 * Everything the owner needs to see what happened in the last games: Friloverse's errors.log and
 * hold.log, LTF bridge/launcher logs, LTK Manager's logs and incidents from that time, and a short
 * summary of this PC.
 */
export async function collectReport({dataDir,ltkDir,games=3,now=Date.now(),summary={},note=''}){
  // The older half first: a game can sit on either side of the move.
  const hold=await readText(path.join(dataDir,'hold.old.log'))+await readText(path.join(dataDir,'hold.log'));
  const start=gamesStart(hold,{games,now});
  const files=[];
  const add=(name,text)=>{if(text)files.push({name,bytes:tail(sanitizeReportText(text))});};
  add('friloverse-hold.log',linesSince(hold,start));
  add('friloverse-errors.log',linesSince(await readText(path.join(dataDir,'errors.log')),start));
  add('friloverse-engine-journal.json',await readText(path.join(dataDir,'engine-journal.json')));
  // LTF launcher and DLL API logs (vital for diagnosing VRF / injection / helper spawn issues).
  const ltfDir=path.join(dataDir,'ltf');
  for(const name of ['ltk_launcher.old.log','ltk_launcher.log','ltk_api.log']){
    const text=await readText(path.join(ltfDir,name));
    if(text)add(`ltf/${name}`,text);
  }
  // LTK starts a new file each day: every one written to since the first game.
  const logs=path.join(ltkDir,'logs');
  for(const name of (await readdir(logs).catch(()=>[])).filter(item=>/\.log$/i.test(item)).sort()){
    const info=await stat(path.join(logs,name)).catch(()=>null);
    if(info&&info.mtimeMs>=start)add(`ltk/${name}`,linesSince(await readText(path.join(logs,name)),start));
  }
  const incidents=path.join(ltkDir,'incidents');
  for(const name of await readdir(incidents).catch(()=>[])){
    const info=await stat(path.join(incidents,name)).catch(()=>null);
    if(info?.isFile()&&info.mtimeMs>=start&&info.size<1024*1024)add(`ltk/incidents/${name}`,await readText(path.join(incidents,name)));
  }
  const pc={windows:`${os.version()} ${os.release()}`,cpu:os.cpus()[0]?.model||'',cores:os.cpus().length,
    memoryGB:Math.round(os.totalmem()/1024**3),freeMemoryGB:Math.round(os.freemem()/1024**3)};
  add('summary.json',JSON.stringify({sent:new Date(now).toISOString(),from:new Date(start).toISOString(),games,note:String(note||'').slice(0,2000),pc,...summary},null,2));
  return {files,start};
}

// A header can only carry plain characters, or fetch refuses the whole request. The log service keeps just these.
const headerName=name=>String(name||'').replace(/[^A-Za-z0-9_-]/g,'');

/** Sends a report and returns its code. Errors are in words a player understands. */
export async function sendReport({zip,version,name,fetchFn=fetch,endpoint=LOG_SERVICE}){
  let response;
  try{
    response=await fetchFn(endpoint,{method:'POST',body:zip,signal:AbortSignal.timeout(60*1000),
      headers:{'content-type':'application/zip','x-friloverse-version':version,'x-friloverse-name':headerName(name)}});
  }catch{throw new Error('The logs could not be sent: no connection to the log service. Try again in a moment.');}
  const answer=await response.json().catch(()=>({}));
  if(!response.ok||!answer.code)throw new Error(answer.error||`The logs could not be sent (${response.status}).`);
  return answer.code;
}
