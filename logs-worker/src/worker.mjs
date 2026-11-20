// Where Friloverse's Send logs button puts a player's logs: one zip per report in the private
// R2 bucket `friloverse-logs`, named by day, time, a short code and the player's party name.
// `codes/<CODE>` holds the report's key, so a code finds its report without a listing.
// It only accepts reports; reading them back needs the owner's Cloudflare login
// (Logoverse, `node scripts/read-logs.mjs` in the Friloverse repo, or the dashboard).
const MAX_BYTES=8*1024*1024;
// No 0/O or 1/I: a code is read out to someone. 32^4 is about a million codes, and a code still
// in use is never given out again; reports and codes leave the bucket after 90 days.
const CODE_ALPHABET='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH=4;
const VERSION=/^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

export function reportCode(random=crypto.getRandomValues(new Uint8Array(CODE_LENGTH))){
  return Array.from(random,value=>CODE_ALPHABET[value%CODE_ALPHABET.length]).join('');
}
export function cleanName(value){return String(value??'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,16)||'player';}
export function reportKey(now,code,name,version){
  const iso=now.toISOString();
  return `${iso.slice(0,10)}/${iso.slice(11,19).replaceAll(':','')}-${code}-${cleanName(name)}-v${version}.zip`;
}
/**
 * A code no report holds yet, claimed for `keyFor(code)`. The claim writes only where nothing is
 * (`If-None-Match: *`; R2 answers null when the code is already there), so two reports sent at
 * the same moment that draw the same code never both get it (10.5).
 */
export async function claimCode(bucket,keyFor,draw=reportCode){
  for(let attempt=0;attempt<12;attempt++){
    const code=draw();
    if(await bucket.head(`codes/${code}`))continue;
    const key=keyFor(code);
    const claimed=await bucket.put(`codes/${code}`,key,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'text/plain'},customMetadata:{key}});
    if(claimed)return {code,key};
  }
  throw new Error('no free report code');
}

// Divine downloads (12.9, owner): one record per Divine skin a player saved to Local Skins, in the
// private bucket `friloverse-downloads` (no expiry), so the owner can see what players fetch and
// add it to the GitHub collection by hand (`node scripts/read-divine-downloads.mjs`). Nothing
// about the player is kept: no address, name or party, only the skin, its file and a count.
const MAX_RECORD_BYTES=4096,MAX_FILES=10;
const ROUTE=/^\/(?:[\w.~-]|%[\da-f]{2}){1,100}\/(?:[\w.~-]|%[\da-f]{2}){1,150}$/i;
export function downloadKey(route){return `skins/${route.slice(1).toLowerCase()}.json`;}
/** A download as the app sends it, cleaned, or null. */
export function readDownload(value){
  const route=String(value?.route??''),champion=String(value?.champion??'');
  const file=String(value?.file??'').replace(/[\u0000-\u001f\\/]/g,'').slice(0,200);
  const size=value?.size,sha=String(value?.sha??'');
  if(!ROUTE.test(route)||/^\/(?:mods|download)\//i.test(route)||!/^[A-Za-z]{2,24}$/.test(champion)||!file||
    !Number.isSafeInteger(size)||size<1||size>1024**3||!/^[0-9a-f]{40}$/.test(sha))return null;
  return {route,champion,file,size,sha};
}
/** The skin's record after one more download. `added` (the owner's mark) is kept. */
export function downloadRecord(previous,download,version,now=new Date()){
  const when=now.toISOString(),old=previous&&typeof previous==='object'?previous:{};
  const earlier=Array.isArray(old.files)?old.files:[];
  const seen=earlier.find(row=>row?.sha===download.sha);
  const files=[{file:download.file,size:download.size,sha:download.sha,firstSeen:seen?.firstSeen||when,lastSeen:when},
    ...earlier.filter(row=>row?.sha!==download.sha)];
  return {route:download.route,url:`https://divineskins.gg${download.route}`,champion:download.champion,
    count:(Number.isSafeInteger(old.count)?old.count:0)+1,firstSeen:old.firstSeen||when,lastSeen:when,
    lastVersion:version,added:old.added===true,files:files.slice(0,MAX_FILES)};
}
async function saveDownload(request,env){
  if(request.method!=='POST')return json({error:'Only POST.'},405);
  if(!env.DOWNLOADS)return json({error:'Not set up.'},503);
  const ip=request.headers.get('cf-connecting-ip')||'unknown';
  if(env.DOWNLOAD_LIMITER&&!(await env.DOWNLOAD_LIMITER.limit({key:ip})).success)return json({error:'Too many downloads at once.'},429);
  const version=String(request.headers.get('x-friloverse-version')||'');
  if(!VERSION.test(version))return json({error:'Only Friloverse can send downloads here.'},400);
  const text=await request.text();
  if(text.length>MAX_RECORD_BYTES)return json({error:'Too large.'},413);
  let download;
  try{download=readDownload(JSON.parse(text));}catch{download=null;}
  if(!download)return json({error:'That is not a Divine download.'},400);
  const key=downloadKey(download.route);
  let previous=null;
  try{previous=await (await env.DOWNLOADS.get(key))?.json();}catch{previous=null;}
  const record=downloadRecord(previous,download,version);
  await env.DOWNLOADS.put(key,JSON.stringify(record,null,1),{httpMetadata:{contentType:'application/json'}});
  return json({ok:true,count:record.count});
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/health')return new Response('ok');
    if(url.pathname==='/divine-downloads')return saveDownload(request,env);
    if(url.pathname!=='/reports')return json({error:'Not found.'},404);
    if(request.method!=='POST')return json({error:'Only POST.'},405);
    const ip=request.headers.get('cf-connecting-ip')||'unknown';
    if(env.LIMITER&&!(await env.LIMITER.limit({key:ip})).success)return json({error:'Logs were just sent from this PC. Try again in a minute.'},429);
    const version=String(request.headers.get('x-friloverse-version')||'');
    if(!VERSION.test(version))return json({error:'Only Friloverse can send logs here.'},400);
    const declared=Number(request.headers.get('content-length'));
    if(declared>MAX_BYTES)return json({error:'The logs are too large to send.'},413);
    const body=new Uint8Array(await request.arrayBuffer());
    if(body.length>MAX_BYTES)return json({error:'The logs are too large to send.'},413);
    // A zip starts with PK\x03\x04.
    if(body.length<22||body[0]!==0x50||body[1]!==0x4b||body[2]!==3||body[3]!==4)return json({error:'That is not a Friloverse log report.'},400);
    const name=cleanName(request.headers.get('x-friloverse-name')),now=new Date();
    let code,key;
    try{({code,key}=await claimCode(env.LOGS,drawn=>reportKey(now,drawn,name,version)));}
    catch{return json({error:'The log service is busy. Try again in a minute.'},503);}
    try{await env.LOGS.put(key,body,{httpMetadata:{contentType:'application/zip'},customMetadata:{code,name,version}});}
    catch(error){await env.LOGS.delete(`codes/${code}`).catch(()=>{});throw error;}
    return json({code,key});
  },
};
