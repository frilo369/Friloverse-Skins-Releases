// Test copies must not ask Windows for administrator rights (src/elevation.cjs).
process.env.FRILOVERSE_NO_ELEVATE='1';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {resolveLtkExecutable} from '../src/ltk.mjs';
import {processRunning} from '../src/process-list.mjs';

// Compile the actual orchestration with external effects replaced by disposable
// fixtures. No real app is installed, closed, or modified.
const project=path.resolve('.');
const {version}=JSON.parse(await readFile('package.json','utf8'));
const compiler=path.join(project,'artifacts','nsis-tools','nsis-3.11','makensis.exe');
const sevenZip=path.join(project,'node_modules','electron-winstaller','vendor','7z.exe');
const sevenZipDll=path.join(project,'node_modules','electron-winstaller','vendor','7z.dll');
const dir=await mkdtemp(path.join(tmpdir(),'friloverse-setup-verify-'));
try{
const source=await readFile('scripts/complete-setup.nsi','utf8');
await access(compiler);

function command(file,args,options={}){
  const result=spawnSync(file,args,{windowsHide:true,timeout:30000,encoding:'utf8',...options});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`Command failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  return result;
}
async function compile(script,output,defines={}){
  const sourceFile=`${output}.nsi`;
  await writeFile(sourceFile,script);
  command(compiler,[...Object.entries(defines).map(([key,value])=>`/D${key}=${value}`),sourceFile],{cwd:project});
}
const fixtureExe=path.join(dir,'ltk-template.exe');
await compile([
  'Unicode true',
  `OutFile "${fixtureExe}"`,
  'VIProductVersion "1.33.0.0"',
  'VIAddVersionKey "FileVersion" "1.33.0.0"',
  'Section',
  'SectionEnd'
].join('\n'),path.join(dir,'fake-ltk'));
const unsupportedExe=path.join(dir,'old-ltk.exe');
await compile([
  'Unicode true',`OutFile "${unsupportedExe}"`,'VIProductVersion "1.30.0.0"',
  'VIAddVersionKey "FileVersion" "1.30.0.0"','Section','SectionEnd'
].join('\n'),path.join(dir,'fake-unsupported'));
const newerExe=path.join(dir,'newer-ltk.exe');
await compile([
  'Unicode true',`OutFile "${newerExe}"`,'VIProductVersion "1.40.0.0"',
  'VIAddVersionKey "FileVersion" "1.40.0.0"','Section','SectionEnd'
].join('\n'),path.join(dir,'fake-newer'));

const input=path.join(dir,'zip-input');
await mkdir(input);
await writeFile(path.join(input,'RELEASES'),'fixture');
await writeFile(path.join(input,`friloverse-skins-${version}-full.nupkg`),'fixture');
const fakeSetup=path.join(dir,'fake-setup.zip');
command(sevenZip,['a','-tzip',fakeSetup,'RELEASES',`friloverse-skins-${version}-full.nupkg`],{cwd:input});

function replaceOnce(text,old,replacement){
  assert.ok(text.includes(old),`Fixture hook missing: ${old.slice(0,100)}`);
  return text.replace(old,replacement);
}
function replaceFunction(text,name,body){
  const expression=new RegExp(`^Function ${name.replaceAll('.','\\.')}\\r?\\n[\\s\\S]*?^FunctionEnd`,'m');
  assert.match(text,expression);
  return text.replace(expression,`Function ${name}\n${body}\nFunctionEnd`);
}

let mock=source;
mock=replaceOnce(mock,'Var CheckResult','Var CheckResult\nVar TestRoot');
mock=replaceOnce(mock,'!insertmacro MUI_PAGE_LICENSE "ltk-terms.txt"',`!insertmacro MUI_PAGE_LICENSE "${path.join(project,'scripts','ltk-terms.txt')}"`);
mock=replaceOnce(mock,'Icon "..\\src\\ui\\friloverse.ico"',`Icon "${path.join(project,'src','ui','friloverse.ico')}"`);
mock=replaceFunction(mock,'.onInit',[
  '  SetShellVarContext current',
  '  ReadEnvStr $TestRoot "FRILOVERSE_FIXTURE_ROOT"'
].join('\n'));
mock=replaceFunction(mock,'FindLtk',[
  '  StrCpy $LtkDir "$TestRoot\\ltk"',
  '  StrCpy $LtkRegistered ""'
].join('\n'));
for(const name of ['WaitForGame','CloseLtk','CloseFriloverse'])mock=replaceFunction(mock,name,'  Nop');
mock=replaceFunction(mock,'StartFriloverse',['  FileOpen $1 "$TestRoot\\started.txt" w','  FileWrite $1 "mock"','  FileClose $1'].join('\n'));
mock=replaceFunction(mock,'CheckLtkProcess','  StrCpy $CheckResult 0');
mock=replaceFunction(mock,'DownloadLtk',[
  '  FileOpen $1 "$TestRoot\\download-ran.txt" w',
  '  FileWrite $1 "mock"',
  '  FileClose $1',
  '  ReadEnvStr $0 "FRILOVERSE_FIXTURE_DOWNLOAD_FAIL"',
  '  ${If} $0 == "yes"',
  '    Abort',
  '  ${EndIf}'
].join('\n'));
mock=mock.replace(/^\s*MessageBox .*$/gm,'  Nop');
const fakeLtkInstall=(failWhen,marker)=>[
  '  ReadEnvStr $0 "FRILOVERSE_FIXTURE_INSTALL_FAIL"',
  `  FileOpen $1 "$TestRoot\\${marker}.txt" w`,
  '  FileClose $1',
  `  ${failWhen}`,
  '    StrCpy $0 1',
  '  ${Else}',
  '    CreateDirectory "$LtkDir"',
  '    CopyFiles /SILENT "$TestRoot\\ltk-template.exe" "$LtkDir\\ltk-manager.exe"',
  '    StrCpy $0 0',
  '  ${EndIf}'
].join('\n');
mock=replaceOnce(mock,`  ExecShellWait "open" "$PLUGINSDIR\\LTK-Setup.exe" "/S"`,fakeLtkInstall('${If} $0 != "no"','silent-ran'));
mock=replaceOnce(mock,`  ExecShellWait "open" "$PLUGINSDIR\\LTK-Setup.exe"`,fakeLtkInstall('${If} $0 == "yes"','window-ran'));
mock=replaceOnce(mock,[
  '  SetRegView 64',
  '  ReadRegStr $FriloverseDir HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\friloverse-skins" "InstallLocation"',
  '  ReadRegStr $InstalledVersion HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\friloverse-skins" "DisplayVersion"'
].join('\n'),[
  '  ReadEnvStr $FriloverseDir "FRILOVERSE_FIXTURE_EXISTING"',
  '  ReadEnvStr $InstalledVersion "FRILOVERSE_FIXTURE_VERSION"'
].join('\n'));
mock=mock.replaceAll('$LOCALAPPDATA\\friloverse-skins','$TestRoot\\installed');
mock=replaceOnce(mock,`  ExecWait '"$FriloverseDir\\Update.exe" --update "$PLUGINSDIR\\update"' $0`,[
  '  CreateDirectory "$FriloverseDir\\app-${VERSION}"',
  '  FileOpen $1 "$FriloverseDir\\app-${VERSION}\\Friloverse-Skins.exe" w',
  '  FileWrite $1 "mock update"',
  '  FileClose $1',
  '  FileOpen $1 "$TestRoot\\update-ran.txt" w',
  '  FileWrite $1 "mock"',
  '  FileClose $1',
  '  StrCpy $0 0'
].join('\n'));
mock=replaceOnce(mock,`  ExecWait '"$PLUGINSDIR\\Friloverse-Setup.exe"' $0`,[
  '  FileOpen $1 "$TestRoot\\setup-window-ran.txt" w',
  '  FileWrite $1 "mock"',
  '  FileClose $1',
  '  StrCpy $0 1'
].join('\n'));
mock=replaceOnce(mock,`  ExecWait '"$PLUGINSDIR\\Friloverse-Setup.exe" --silent' $0`,[
  '  ReadEnvStr $0 "FRILOVERSE_FIXTURE_SILENT_FAIL"',
  '  ${If} $0 == "yes"',
  '    StrCpy $0 1',
  '  ${Else}',
  '    CreateDirectory "$TestRoot\\installed\\app-${VERSION}"',
  '    FileOpen $1 "$TestRoot\\installed\\Friloverse-Skins.exe" w',
  '    FileWrite $1 "mock launcher"',
  '    FileClose $1',
  '    FileOpen $1 "$TestRoot\\installed\\app-${VERSION}\\Friloverse-Skins.exe" w',
  '    FileWrite $1 "mock install"',
  '    FileClose $1',
  '    StrCpy $0 0',
  '  ${EndIf}'
].join('\n'));
const mockExe=path.join(dir,'mock-setup.exe');
await compile(mock,mockExe,{VERSION:version,FRILOVERSE_SETUP:fakeSetup,OUTPUT_SETUP:mockExe,SEVEN_Z:sevenZip,SEVEN_Z_DLL:sevenZipDll});

async function exists(file){try{await access(file);return true;}catch{return false;}}
async function scenario(name,{legacyDatabase=false,databaseConflict=false,brokenInstall=false,versionUnknown=false,unregistered=false,ltk=true,unsupported=false,newerLtk=false,existingVersion='',downloadFail=false,installFail='no',noLauncher=false,noProgram=false,silentFail=false,leftover=false}={}){
  const root=path.join(dir,name);
  await mkdir(root);
  await writeFile(path.join(root,'ltk-template.exe'),await readFile(fixtureExe));
  if(ltk){
    await mkdir(path.join(root,'ltk'));
    await writeFile(path.join(root,'ltk','ltk-manager.exe'),await readFile(unsupported?unsupportedExe:newerLtk?newerExe:fixtureExe));
  }
  let existing='';
  if(existingVersion){
    existing=path.join(root,'installed');
    await mkdir(existing);
    if(!brokenInstall)await writeFile(path.join(existing,'Update.exe'),'mock');
    // A real Squirrel install: its launcher, and the registered version's program.
    if(!brokenInstall&&!noLauncher)await writeFile(path.join(existing,'Friloverse-Skins.exe'),'mock launcher');
    if(!brokenInstall&&!noProgram){
      await mkdir(path.join(existing,`app-${existingVersion}`));
      await writeFile(path.join(existing,`app-${existingVersion}`,'Friloverse-Skins.exe'),'mock program');
    }
    await writeFile(path.join(existing,'keep.txt'),'untouched');
  }
  if(leftover){
    await mkdir(path.join(root,'installed',`app-${version}`),{recursive:true});
    await writeFile(path.join(root,'installed',`app-${version}`,'Friloverse-Skins.exe'),'from an earlier try');
  }
  if(legacyDatabase){await mkdir(path.join(root,'installed','Database'),{recursive:true});await writeFile(path.join(root,'installed','Database','mine.fantome'),'personal');}
  if(databaseConflict){await mkdir(path.join(root,'installed-data','Database'),{recursive:true});await writeFile(path.join(root,'installed-data','Database','mine.fantome'),'newer');}
  const result=spawnSync(mockExe,['/S'],{windowsHide:true,timeout:30000,encoding:'utf8',env:{...process.env,
    FRILOVERSE_FIXTURE_ROOT:root,FRILOVERSE_FIXTURE_EXISTING:unregistered?'':existing,FRILOVERSE_FIXTURE_VERSION:versionUnknown||unregistered?'':existingVersion,
    FRILOVERSE_FIXTURE_DOWNLOAD_FAIL:downloadFail?'yes':'no',FRILOVERSE_FIXTURE_INSTALL_FAIL:installFail,
    FRILOVERSE_FIXTURE_SILENT_FAIL:silentFail?'yes':'no'}});
  if(result.error)throw result.error;
  const installed=await exists(path.join(root,'installed',`app-${version}`,'Friloverse-Skins.exe'));
  if(existing)assert.equal(await readFile(path.join(existing,'keep.txt'),'utf8'),'untouched');
  return {root,installed,code:result.status,downloaded:await exists(path.join(root,'download-ran.txt')),
    updated:await exists(path.join(root,'update-ran.txt')),started:await exists(path.join(root,'started.txt')),
    silent:await exists(path.join(root,'silent-ran.txt')),window:await exists(path.join(root,'window-ran.txt')),
    setupWindow:await exists(path.join(root,'setup-window-ran.txt')),
    reinstalled:installed&&await readFile(path.join(root,'installed',`app-${version}`,'Friloverse-Skins.exe'),'utf8')==='mock install'};
}

// The real plain setup, unpacked as the real setup does it. A fake zip cannot show this: 7-Zip
// says "Headers Error" and returns 2 for a Squirrel setup, although both files come out whole.
{
  const out=path.join(dir,'real-unpack'),shown=version.replace(/\.0$/,''),nupkg=`friloverse-skins-${version}-full.nupkg`;
  const real=path.join(project,'dist',version,'setup',`Friloverse-${shown}-Setup.exe`);
  const {status}=spawnSync(sevenZip,['x','-tzip','-y',`-o${out}`,real,'RELEASES',nupkg],{encoding:'utf8',windowsHide:true});
  const step=(await readFile(path.join(project,'scripts','complete-setup.nsi'),'utf8')).match(/7z\.exe" x[\s\S]*?MessageBox/)[0];
  const accepted=[...step.matchAll(/\$0 != (\d+)/g)].map(row=>Number(row[1]));
  assert.ok(accepted.includes(status),`the setup refuses 7-Zip's answer ${status} for its own package; it accepts ${accepted}`);
  const [sha,name,size]=(await readFile(path.join(out,'RELEASES'),'utf8')).replace(/^\uFEFF/,'').trim().split(/\s+/);
  assert.equal(name,nupkg);
  const data=await readFile(path.join(out,nupkg));
  assert.equal(data.length,Number(size),'the package came out whole');
  assert.equal(createHash('sha1').update(data).digest('hex').toUpperCase(),sha.toUpperCase(),'the package matches RELEASES');
}

// A clean PC: LTK Manager in the background, no installer window, and Friloverse opens.
const fresh=await scenario('fresh',{ltk:false});
assert.equal(fresh.downloaded,true);assert.equal(fresh.silent,true);assert.equal(fresh.window,false);
assert.equal(fresh.installed,true);assert.equal(fresh.started,true);
const update=await scenario('update',{existingVersion:'0.8.2'});
assert.equal(update.updated,true);assert.equal(update.installed,true);assert.equal(update.started,true);
assert.equal(update.downloaded,false,'a usable LTK Manager is left alone');
const already=await scenario('same-version',{existingVersion:version});
assert.equal(already.updated,false);assert.equal(already.started,true);
const newer=await scenario('newer-version',{existingVersion:'99.0.0'});
assert.equal(newer.code,0);assert.equal(newer.updated,false);assert.equal(newer.installed,false);assert.equal(newer.started,true);
// An old LTK Manager is upgraded rather than stopping setup; a newer one is never replaced.
const unsupported=await scenario('old-ltk',{unsupported:true,existingVersion:'0.8.2'});
assert.equal(unsupported.downloaded,true);assert.equal(unsupported.silent,true);assert.equal(unsupported.updated,true);
const newerLtk=await scenario('newer-ltk',{newerLtk:true,existingVersion:'0.8.2'});
assert.equal(newerLtk.downloaded,false);assert.equal(newerLtk.updated,true);assert.equal(newerLtk.installed,true);
// A background install that fails falls back to LTK Manager's own window.
const fallback=await scenario('silent-failed',{ltk:false,installFail:'silent'});
assert.equal(fallback.window,true);assert.equal(fallback.installed,true);
// Registered as installed, but its Update.exe is gone: replaced, never a dead end.
const broken=await scenario('broken-install',{existingVersion:'0.9.4',brokenInstall:true});
assert.equal(broken.code,0);assert.equal(broken.installed,true);assert.equal(broken.updated,false);
const preserved=await scenario('legacy-database',{existingVersion:'0.9.4',brokenInstall:true,legacyDatabase:true});
assert.equal(preserved.installed,true);
assert.equal(await readFile(path.join(preserved.root,'installed-data','Database','mine.fantome'),'utf8'),'personal');
assert.equal(await exists(path.join(preserved.root,'installed','Database')),false);
const conflict=await scenario('database-conflict',{existingVersion:'0.9.4',brokenInstall:true,legacyDatabase:true,databaseConflict:true});
assert.equal(conflict.installed,false);assert.equal(conflict.started,false);
assert.equal(await readFile(path.join(conflict.root,'installed','Database','mine.fantome'),'utf8'),'personal');
assert.equal(await readFile(path.join(conflict.root,'installed-data','Database','mine.fantome'),'utf8'),'newer');
// What a friend hit: the same leftovers, with no version or no registry entry.
for(const [name,leftover] of [['unknown-version',{versionUnknown:true}],['unregistered',{unregistered:true}]]){
  const result=await scenario(name,{existingVersion:'0.9.4',...leftover});
  assert.equal(result.code,0,name);assert.equal(result.installed,true,name);assert.equal(result.updated,false,name);
}
const failedDownload=await scenario('download-failed',{ltk:false,downloadFail:true});
assert.equal(failedDownload.downloaded,true);
assert.equal(failedDownload.installed,false);
const cancelled=await scenario('ltk-cancelled',{ltk:false,installFail:'yes'});
assert.equal(cancelled.window,true);assert.equal(cancelled.installed,false);assert.equal(cancelled.started,false);
// Registered at this version, but its launcher or its program is gone: installed again, not skipped.
for(const [name,missing] of [['launcher-missing',{noLauncher:true}],['program-missing',{noProgram:true}]]){
  const result=await scenario(name,{existingVersion:version,...missing});
  assert.equal(result.code,0,name);assert.equal(result.installed,true,name);assert.equal(result.updated,false,name);
  assert.equal(result.reinstalled,true,name);assert.equal(result.setupWindow,false,name);assert.equal(result.started,true,name);
}
// A newer registered version whose program is gone is replaced too, never reported as installed.
const newerGone=await scenario('newer-program-missing',{existingVersion:'99.0.0',noProgram:true});
assert.equal(newerGone.code,0);assert.equal(newerGone.reinstalled,true);assert.equal(newerGone.updated,false);
// A failed silent install next to a program left by an earlier try still offers the setup window.
const leftover=await scenario('silent-failed-leftover',{silentFail:true,leftover:true});
assert.equal(leftover.setupWindow,true);assert.notEqual(leftover.code,0);assert.equal(leftover.started,false);

// Exercise the real registry lookup and first-run check without launching apps.
const realHelper=path.join(dir,'real-helper.exe');
const fn=name=>source.match(new RegExp(`^Function ${name}\\r?\\n[\\s\\S]*?^FunctionEnd`,'m'))?.[0];
const report=path.join(dir,'real-helper.txt');
const helper=[
  'Unicode true','RequestExecutionLevel user',`OutFile "${realHelper}"`,
  '!include "LogicLib.nsh"','!include "FileFunc.nsh"','!include "StrFunc.nsh"','${StrRep}',
  'Var LtkDir','Var LtkRegistered','Var LtkVersion','Var CheckResult',
  'Function .onInit','  InitPluginsDir','  Call FindLtk',
  '  ${GetFileVersion} "$LtkDir\\ltk-manager.exe" $LtkVersion',
  '  Call CheckLtkProcess','  StrCpy $4 $CheckResult',
  '  Call CheckFriloverseProcess',`  FileOpen $9 "${report}" w`,
  '  FileWrite $9 "$LtkDir$\\r$\\n$LtkVersion$\\r$\\n$4$\\r$\\n$CheckResult$\\r$\\n"',
  '  FileClose $9','  Quit','FunctionEnd',fn('FindLtk'),
  fn('CheckLtkProcess'),fn('CheckFriloverseProcess'),'Section','SectionEnd'
].join('\n');
await compile(helper,path.join(dir,'real-helper-source'));
const helperResult=spawnSync(realHelper,['/S'],{windowsHide:true,timeout:30000,encoding:'utf8'});
if(helperResult.error)throw helperResult.error;
assert.ok([0,2].includes(helperResult.status),`Read-only helper failed: ${helperResult.status}`);
const [directory,installedVersion,ltkRunning,friloverseRunning]= (await readFile(report,'utf8')).trim().split(/\r?\n/);
assert.equal(path.win32.join(directory,'ltk-manager.exe').toLowerCase(),(await resolveLtkExecutable()).toLowerCase());
assert.match(installedVersion,/^\d+\.\d+\.\d+\.\d+$/);
assert.equal(ltkRunning,await processRunning('ltk-manager.exe')?'0':'1');
assert.equal(friloverseRunning,await processRunning('Friloverse-Skins.exe')?'0':'1');
if(process.argv.includes('--download')){
  // Run the exact download/hash function without ever starting the installer.
  const downloadHelper=path.join(dir,'download-helper.exe');
  const marker=path.join(dir,'download-ok.txt');
  const downloadLog=path.join(dir,'download-result.txt');
  let downloadFunction=fn('DownloadLtk').replace(/^\s*MessageBox .*IDRETRY download_retry$/m,'    Abort');
  downloadFunction=downloadFunction.replace('catch {exit 1}','catch {Write-Output ($$_.Exception.ToString()); exit 1}');
  downloadFunction=replaceOnce(downloadFunction,'  Pop $0\n  ${If} $CheckResult != 0',[
    '  Pop $0',`  FileOpen $9 "${downloadLog}" w`,
    '  FileWrite $9 "$CheckResult$\\r$\\n$0"','  FileClose $9','  ${If} $CheckResult != 0'
  ].join('\n'));
  const downloadScript=[
    'Unicode true','RequestExecutionLevel user',`OutFile "${downloadHelper}"`,
    '!include "LogicLib.nsh"','Var CheckResult',
    'Function .onInit','  InitPluginsDir','FunctionEnd',downloadFunction,
    'Section','  Call DownloadLtk',`  FileOpen $9 "${marker}" w`,
    '  FileWrite $9 "verified"','  FileClose $9','SectionEnd'
  ].join('\n');
  await compile(downloadScript,path.join(dir,'download-helper-source'));
  command(downloadHelper,['/S']);
  assert.equal(await readFile(marker,'utf8'),'verified');
  console.log('Official LTK Manager download and SHA-256 verified by the setup function.');
}
console.log('Complete setup checks passed: new install in the background, fallback to the installer window, LTK Manager upgrade, update, already installed, newer versions, replacing incomplete leftovers, download failure, cancelled LTK Manager installation, and real read-only detection.');
}finally{
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));
  assert.ok(path.basename(dir).startsWith('friloverse-setup-verify-'));
  await rm(dir,{recursive:true,force:true});
}
