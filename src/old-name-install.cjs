// Runs as a plain Node process, apart from the old copy's update (see old-name.cjs): installs the
// new version from the prepared folder the way Squirrel's setup does, then starts it in the tray.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {NEW}=require('./old-name.cjs');

const temp=process.argv[2];
const log=message=>{try{fs.appendFileSync(path.join(os.tmpdir(),`${NEW.folder}-move.log`),`${new Date().toISOString()} ${message}\n`);}catch{}};
// What installing starts must be the app itself, not another plain Node process.
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;

const result=spawnSync(path.join(temp,'Update.exe'),['--install',temp,'--silent'],{cwd:temp,env,windowsHide:true,stdio:'ignore',timeout:10*60*1000});
log(`install exit ${result.status}${result.error?` ${result.error.message}`:''}`);
const program=path.join(process.env.LOCALAPPDATA,NEW.folder,NEW.exe);
if(fs.existsSync(program)){
  spawn(program,['--startup'],{detached:true,stdio:'ignore',env}).unref();
  log('started');
}else log(`${program} is missing`);
