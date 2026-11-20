import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {signIfConfigured} from './sign.mjs';

// The official NSIS zip, mirrored by Tauri, matches the upstream SHA-256.
const nsisUrl='https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip';
const nsisHash='c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1';
const root=path.resolve('.');
const tools=path.join(root,'artifacts','nsis-tools');
const zip=path.join(tools,'nsis-3.11.zip');
const compiler=path.join(tools,'nsis-3.11','makensis.exe');
const sevenZip=path.join(root,'node_modules','electron-winstaller','vendor','7z.exe');
const sevenZipDll=path.join(root,'node_modules','electron-winstaller','vendor','7z.dll');
const {version}=JSON.parse(await readFile('package.json','utf8'));
const shown=version.replace(/\.0$/,'');
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('A numeric three-part version is required.');
const setup=path.join(root,'dist',version,'setup',`Friloverse-${shown}-Setup.exe`);
const output=path.join(root,'dist',version,'setup',`Friloverse-${shown}-Complete-Setup.exe`);
await access(setup);
await access(sevenZip);
await access(sevenZipDll);
try{await access(output);throw new Error(`Complete setup already exists: ${output}`);}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(tools,{recursive:true});
let data,downloaded=false;
try{data=await readFile(zip);}catch(error){
  if(error.code!=='ENOENT')throw error;
  const response=await fetch(nsisUrl,{signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error(`Could not download NSIS: HTTP ${response.status}`);
  data=Buffer.from(await response.arrayBuffer());
  downloaded=true;
}
if(createHash('sha256').update(data).digest('hex')!==nsisHash)throw new Error('NSIS archive SHA-256 does not match the official release.');
if(downloaded)await writeFile(zip,data);
try{await access(compiler);}catch{
  const extracted=spawnSync(sevenZip,['x','-y',zip,`-o${tools}`],{stdio:'inherit'});
  if(extracted.status!==0)throw new Error('Could not extract NSIS.');
}
const result=spawnSync(compiler,[`/DVERSION=${version}`,`/DSHOWN=${shown}`,`/DFRILOVERSE_SETUP=${setup}`,`/DOUTPUT_SETUP=${output}`,`/DSEVEN_Z=${sevenZip}`,`/DSEVEN_Z_DLL=${sevenZipDll}`,path.join(root,'scripts','complete-setup.nsi')],{stdio:'inherit'});
if(result.status!==0)throw new Error('Complete setup compilation failed.');
await access(output);
// Smart App Control also judges the setup itself (scripts/sign.mjs).
await signIfConfigured(output);
console.log(`Complete setup: ${output}`);
