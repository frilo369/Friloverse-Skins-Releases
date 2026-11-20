// What players downloaded from Divine Skins into their Local Skins (12.9), from the private R2
// bucket `friloverse-downloads` (logs-worker/), using CLOUDFLARE_API_TOKEN from the environment.
// One record per skin: its Divine link, champion, how many downloads, and its newest files.
//   node scripts/read-divine-downloads.mjs                 skins not yet marked added, most downloaded first
//   node scripts/read-divine-downloads.mjs --all           every skin, added ones too
//   node scripts/read-divine-downloads.mjs --added <link>  marks a skin added to the collection (hides it)
//   node scripts/read-divine-downloads.mjs --not-added <link>
// <link> is the Divine page (https://divineskins.gg/Frog/iron-darius) or just Frog/iron-darius.
// "In collection" compares the newest file's Git blob hash with the collection list this PC last
// downloaded (Database\custom-collection-lists.json), so a converted file shows as not in it.
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const BUCKET='friloverse-downloads';
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token){console.error('CLOUDFLARE_API_TOKEN is not set in this shell.');process.exit(1);}
const api=async(route,init={})=>{
  const response=await fetch(`https://api.cloudflare.com/client/v4${route}`,{...init,headers:{authorization:`Bearer ${token}`,...init.headers}});
  if(!response.ok)throw new Error(`Cloudflare answered ${response.status} for ${route.split('?')[0]}`);
  return response;
};
const account=(await (await api('/accounts')).json()).result?.[0]?.id;
if(!account)throw new Error('No Cloudflare account for this token.');
const objectPath=key=>`/accounts/${account}/r2/buckets/${BUCKET}/objects/${key.split('/').map(encodeURIComponent).join('/')}`;

async function keys(){
  const rows=[];let cursor='';
  do{
    const page=await (await api(`/accounts/${account}/r2/buckets/${BUCKET}/objects?per_page=1000&prefix=skins/${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`)).json();
    rows.push(...(page.result||[]).map(row=>row.key));
    cursor=page.result_info?.is_truncated?page.result_info.cursor:'';
  }while(cursor);
  return rows;
}
const read=async key=>JSON.parse(await (await api(objectPath(key))).text());
// The Worker's key for a skin: skins/<artist>/<slug>.json, lower case.
function keyFor(link){
  const route=String(link||'').replace(/^https?:\/\/(?:www\.)?divineskins\.gg/i,'').replace(/^\/?/,'/').replace(/[?#].*$/,'').replace(/\/$/,'');
  if(!/^\/[^/]+\/[^/]+$/.test(route))throw new Error(`Not a Divine skin link: ${link}`);
  return `skins/${route.slice(1).toLowerCase()}.json`;
}

const mark=process.argv.includes('--added')?true:process.argv.includes('--not-added')?false:null;
if(mark!==null){
  const link=process.argv[process.argv.indexOf(mark?'--added':'--not-added')+1];
  const key=keyFor(link),record=await read(key);
  record.added=mark;
  await api(objectPath(key),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(record,null,1)});
  console.log(`${record.url}: ${mark?'marked added; hidden from the list':'no longer marked added'}.`);
  process.exit(0);
}

// The collection's packages this PC last listed, by Git blob hash.
const inCollection=new Set();
try{
  const listsFile=path.join(process.env.LOCALAPPDATA||'','friloverse-skins-data','Database','custom-collection-lists.json');
  const {lists}=JSON.parse(await readFile(listsFile,'utf8'));
  for(const {tree} of Object.values(lists||{}))for(const entry of tree||[])if(/\.fantome$/i.test(entry.path))inCollection.add(entry.sha);
}catch{}

const all=process.argv.includes('--all');
const records=[];
for(const key of await keys()){
  try{records.push(await read(key));}catch(error){console.error(`${key}: ${error.message}`);}
}
const shown=records.filter(record=>all||!record.added).sort((a,b)=>b.count-a.count||String(b.lastSeen).localeCompare(String(a.lastSeen)));
if(!shown.length){console.log(records.length?'Every downloaded skin is marked added. --all lists them.':'No Divine downloads recorded yet.');process.exit(0);}
console.log(`${shown.length} skin${shown.length===1?'':'s'}${all?'':' not yet added'} (of ${records.length} recorded):\n`);
for(const record of shown){
  const newest=record.files?.[0]||{};
  const flags=[record.added?'ADDED':'',inCollection.has(newest.sha)?'in collection':''].filter(Boolean).join(', ');
  console.log(`${String(record.count).padStart(4)}×  ${record.champion.padEnd(13)} ${record.url}${flags?`  [${flags}]`:''}`);
  console.log(`       last ${String(record.lastSeen).slice(0,10)}, first ${String(record.firstSeen).slice(0,10)}; newest file ${newest.file} (${((newest.size||0)/1048576).toFixed(1)} MB)`);
}
