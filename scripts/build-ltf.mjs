// Builds the bundled LTF bridge (ltk_launcher.exe + LeagueToolFlop.dll) from the
// sources in native/ltf. Maintainer-only; the built files are committed so a normal
// build and install need no Visual Studio. Rose's build_ltf.py is the reference.
//   node scripts/build-ltf.mjs
import {execFileSync} from 'node:child_process';
import {mkdir,readdir,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const root=process.cwd();
const source=path.join(root,'native','ltf');
const output=path.join(root,'src','native','ltf');
const LAUNCHER='ltk_launcher.exe',DLL='LeagueToolFlop.dll';
const COMMON='/nologo /std:c++20 /O2 /EHsc /MT /utf-8';
const DLL_LIBS='ws2_32.lib psapi.lib user32.lib advapi32.lib shell32.lib bcrypt.lib userenv.lib';

function vcvars(){
  const vswhere=path.join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','Microsoft Visual Studio','Installer','vswhere.exe');
  if(!existsSync(vswhere))throw new Error('vswhere.exe was not found; install the Visual Studio C++ build tools.');
  const found=execFileSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
  for(const folder of found){
    const file=path.join(folder.trim(),'VC','Auxiliary','Build','vcvars64.bat');
    if(existsSync(file))return file;
  }
  throw new Error('MSVC x64 build tools were not found.');
}

for(const file of ['LeagueToolFlop-inj.cpp','LeagueToolFlop_dll.cpp'])if(!existsSync(path.join(source,file)))throw new Error(`Missing ${file} in native/ltf.`);
await mkdir(output,{recursive:true});
const work=path.join(tmpdir(),`friloverse-ltf-${process.pid}`);
await rm(work,{recursive:true,force:true});await mkdir(work,{recursive:true});
try{
  const objects=`/Fo"${work}\\\\"`;
  const script=path.join(work,'build.bat');
  await writeFile(script,[
    '@echo off\r\n',
    `call "${vcvars()}" >nul || exit /b 1\r\n`,
    `cd /d "${source}"\r\n`,
    `cl ${COMMON} ${objects} LeagueToolFlop-inj.cpp /link /OUT:"${path.join(output,LAUNCHER)}" || exit /b 1\r\n`,
    `cl ${COMMON} /LD ${objects} LeagueToolFlop_dll.cpp /link /OUT:"${path.join(output,DLL)}" ${DLL_LIBS} || exit /b 1\r\n`,
  ].join(''),'utf8');
  execFileSync('cmd',['/d','/c',script],{cwd:work,stdio:'inherit'});
}finally{await rm(work,{recursive:true,force:true});}
for(const file of [LAUNCHER,DLL]){
  const info=await readdir(output);
  if(!info.includes(file))throw new Error(`The build did not produce ${file}.`);
}
console.log(`Built ${path.join(output,LAUNCHER)}`);
console.log(`Built ${path.join(output,DLL)}`);
