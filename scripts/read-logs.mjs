// Reads the reports players sent with Settings' Send logs, from the private R2 bucket
// `friloverse-logs` (logs-worker/), using CLOUDFLARE_API_TOKEN from the environment.
//   node scripts/read-logs.mjs              the newest 20 reports: when, code, name, version, size
//   node scripts/read-logs.mjs <CODE>       downloads that report and unpacks it into logs-reports/<key>/
//   node scripts/read-logs.mjs --all        every report kept (the bucket deletes them after 90 days)
// The Cloudflare dashboard shows them too: R2 → friloverse-logs.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';

const BUCKET='friloverse-logs';
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token){console.error('CLOUDFLARE_API_TOKEN is not set in this shell.');process.exit(1);}
const api=async(route,{raw=false}={})=>{
  const response=await fetch(`https://api.cloudflare.com/client/v4${route}`,{headers:{authorization:`Bearer ${token}`}});
  if(!response.ok)throw new Error(`Cloudflare answered ${response.status} for ${route.split('?')[0]}`);
  return raw?Buffer.from(await response.arrayBuffer()):response.json();
};
const account=(await api('/accounts')).result?.[0]?.id;
if(!account)throw new Error('No Cloudflare account for this token.');

async function list(){
  const rows=[];let cursor='';
  do{
    const page=await api(`/accounts/${account}/r2/buckets/${BUCKET}/objects?per_page=1000${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);
    rows.push(...(page.result||[]));
    cursor=page.result_info?.is_truncated?page.result_info.cursor:'';
  }while(cursor);
  // codes/<CODE> only points at a report.
  return rows.filter(row=>!String(row.key).startsWith('codes/')).sort((a,b)=>String(b.key).localeCompare(String(a.key)));
}
// 2026-11-08/031535-K7M2-Frilo-v6.1.0.zip (6.0 gave six-letter codes)
const parts=key=>{const found=/^(\d{4}-\d{2}-\d{2})\/(\d{2})(\d{2})(\d{2})-([A-Z0-9]{4}|[A-Z0-9]{6})-(.+)-v([\d.]+)\.zip$/.exec(key);return found?{when:`${found[1]} ${found[2]}:${found[3]}:${found[4]} UTC`,code:found[5],name:found[6],version:found[7]}:null;};

async function unzipTo(buffer,folder){
  const zip=await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true},(error,file)=>error?reject(error):resolve(file)));
  await new Promise((resolve,reject)=>{
    zip.on('entry',entry=>{
      const target=path.join(folder,entry.fileName);
      if(!target.startsWith(folder+path.sep)||/\/$/.test(entry.fileName)){zip.readEntry();return;}
      zip.openReadStream(entry,async(error,stream)=>{
        if(error)return reject(error);
        const chunks=[];
        for await(const chunk of stream)chunks.push(chunk);
        await mkdir(path.dirname(target),{recursive:true});await writeFile(target,Buffer.concat(chunks));
        zip.readEntry();
      });
    });
    zip.on('end',resolve);zip.on('error',reject);zip.readEntry();
  });
}

const wanted=process.argv[2]&&!process.argv[2].startsWith('--')?process.argv[2].toUpperCase():'';
const rows=await list();
if(!wanted){
  if(!rows.length){console.log('No reports yet.');process.exit(0);}
  for(const row of process.argv.includes('--all')?rows:rows.slice(0,20)){
    const info=parts(row.key);
    console.log(info?`${info.when}  ${info.code}  ${info.name.padEnd(16)} v${info.version.padEnd(7)} ${(row.size/1024).toFixed(0).padStart(6)} KB`:row.key);
  }
  console.log('\nOpen one with: node scripts/read-logs.mjs <CODE>');
}else{
  const row=rows.find(item=>parts(item.key)?.code===wanted);
  if(!row){console.error(`No report with code ${wanted}.`);process.exit(1);}
  const zip=await api(`/accounts/${account}/r2/buckets/${BUCKET}/objects/${row.key.split('/').map(encodeURIComponent).join('/')}`,{raw:true});
  const folder=path.resolve('logs-reports',row.key.replace(/\.zip$/,'').replaceAll('/','_'));
  await mkdir(folder,{recursive:true});
  await writeFile(`${folder}.zip`,zip);await unzipTo(zip,folder);
  console.log(`${wanted}: ${folder}`);
}
