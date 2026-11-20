// Friloverse runs elevated (owner's decision, 2026-11-20), as Rose does: the game guard, the
// process checks and LTK's launcher all work better with administrator rights. The program itself
// stays "as invoker", so Squirrel's stub, the setup and the update restart can still start it
// without error 740; a normal start that finds itself unelevated asks Windows to start it again
// as administrator and leaves. Declining the prompt keeps the old unelevated behaviour, and
// `--elevation-tried` makes sure the question is only asked once per start.
//
// The bundled ltk_launcher.exe already starts LTK Manager unelevated when its caller is elevated
// (`--as-user-child`, see native/ltf), which LTK's own host check requires.
const {execFile}=require('node:child_process');

const FLAG='--elevation-tried';

/** Whether this start should ask for administrator rights. `elevated` is true, false or null (unknown). */
function shouldElevate({packaged,preview,platform=process.platform,argv=process.argv,env=process.env,elevated,squirrelEvent=false}){
  if(platform!=='win32'||!packaged||preview||squirrelEvent)return false;
  if(elevated!==false)return false; // Already elevated, or it could not be told: never prompt blindly.
  if(env.FRILOVERSE_NO_ELEVATE==='1'||argv.includes(FLAG)||argv.includes('--no-elevate'))return false;
  return true;
}

/** The arguments to start again with: the original ones plus the once-only flag, quoted for a command line. */
function relaunchArgs(argv=process.argv){
  const rest=argv.slice(1).filter(arg=>arg!==FLAG);
  return [...rest,FLAG].map(arg=>/[\s"]/.test(arg)?`"${arg.replace(/"/g,'\\"')}"`:arg);
}

/**
 * Starts `exe` again through Windows' consent prompt. Resolves true once it was started, false
 * when the player declined or Windows refused. Paths and arguments travel in environment
 * variables, so nothing has to be quoted for PowerShell.
 */
function relaunchElevated({exe=process.execPath,argv=process.argv,run=execFile,timeout=10*60*1000}={}){
  return new Promise(resolve=>{
    const command='$a = ConvertFrom-Json $env:FRILOVERSE_ELEVATE_ARGS; Start-Process -FilePath $env:FRILOVERSE_ELEVATE_EXE -ArgumentList $a -Verb RunAs';
    try{
      run('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',command],
        {windowsHide:true,timeout,env:{...process.env,FRILOVERSE_ELEVATE_EXE:exe,FRILOVERSE_ELEVATE_ARGS:JSON.stringify(relaunchArgs(argv))}},
        error=>resolve(!error));
    }catch{resolve(false);}
  });
}

module.exports={FLAG,shouldElevate,relaunchArgs,relaunchElevated};
